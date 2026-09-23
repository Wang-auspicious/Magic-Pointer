import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { record, emptyRead, type Json, type ReadOptions, type ReadResult, type SourceReader, type SourceRef } from './context';
import { DocumentReader } from './context_documents';
import { runPowerShellJson } from './desktop';

type ExcelProbe = (source: SourceRef, copyPath: string, signal?: AbortSignal) => Promise<Json>;

async function copyCurrentExcelWorkbook(source: SourceRef, copyPath: string, signal?: AbortSignal): Promise<Json> {
  const { hwnd, pid, workbookPath } = source.identity;
  const encoded = Buffer.from(JSON.stringify({ hwnd, pid, workbookPath, copyPath })).toString('base64');
  return runPowerShellJson(String.raw`
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class MpExcelWindow {
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
}
"@
$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')) | ConvertFrom-Json
$windowPid=[uint32]0
[MpExcelWindow]::GetWindowThreadProcessId([IntPtr][int64]$p.hwnd,[ref]$windowPid) | Out-Null
if([int64]$windowPid -ne [int64]$p.pid){throw 'excel-window-identity-changed'}
$app=[Runtime.InteropServices.Marshal]::GetActiveObject('Excel.Application')
$win=@($app.Windows) | Where-Object { [int64]$_.HWND -eq [int64]$p.hwnd } | Select-Object -First 1
if($null -eq $win){throw 'bound-excel-window-not-found'}
$selection=$win.RangeSelection
if($null -eq $selection){throw 'bound-excel-worksheet-not-found'}
$book=$selection.Worksheet.Parent
if(-not [string]::Equals([string]$book.FullName,[string]$p.workbookPath,[StringComparison]::OrdinalIgnoreCase)){throw 'bound-excel-workbook-changed'}
$book.SaveCopyAs([string]$p.copyPath)
@{ok=$true;hwnd=[int64]$win.HWND;pid=[int64]$windowPid;workbook=[string]$book.FullName;workbookSaved=[bool]$book.Saved} | ConvertTo-Json -Depth 5 -Compress`, signal, 120000);
}

export class ExcelLiveReader implements SourceReader {
  constructor(private probe: ExcelProbe = copyCurrentExcelWorkbook) {}

  async read(source: SourceRef, options: ReadOptions = {}): Promise<ReadResult> {
    const started = performance.now();
    let backend = 'office.com.excel.savecopyas';
    const expectedHwnd = Number(source.identity.hwnd);
    const expectedPid = Number(source.identity.pid);
    const workbookPath = String(source.identity.workbookPath ?? '');
    if (source.kind !== 'document' || source.revision.authority !== 'live' ||
      source.identity.host !== 'excel' || !Number.isSafeInteger(expectedHwnd) || expectedHwnd <= 0 ||
      !Number.isSafeInteger(expectedPid) || expectedPid <= 0 || !workbookPath)
      return emptyRead(source, backend, 'excel-live-source-identity-incomplete', started);

    const copyPath = join(tmpdir(), `magic-pointer-excel-live-${randomUUID()}.xlsx`);
    try {
      const response = record(await this.probe(source, copyPath, options.signal));
      if (response.ok !== true)
        return emptyRead(source, backend, String(response.error ?? 'excel-live-read-failed'), started);
      if (Number(response.hwnd) !== expectedHwnd || Number(response.pid) !== expectedPid ||
        String(response.workbook ?? '').toLowerCase() !== workbookPath.toLowerCase())
        return emptyRead(source, backend, 'excel-live-workbook-identity-changed', started);

      backend += '+document.xlsx.ooxml';
      const document = new DocumentReader();
      const result = await document.read({
        ...source,
        identity: { absolutePath: copyPath },
      }, options);
      return {
        ...result,
        fragments: result.fragments.map(item => ({
          ...item,
          metadata: { ...item.metadata, live: true, workbookPath,
            workbookSaved: response.workbookSaved === true },
        })),
        usedBackend: backend,
        latencyMs: performance.now() - started,
        structure: { ...result.structure, readFrom: 'live', workbook: workbookPath,
          workbookSaved: response.workbookSaved === true },
      };
    } catch (error) {
      options.signal?.throwIfAborted();
      return emptyRead(source, backend, `excel-live-read-failed:${String(error)}`, started);
    } finally {
      await unlink(copyPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  }
}
