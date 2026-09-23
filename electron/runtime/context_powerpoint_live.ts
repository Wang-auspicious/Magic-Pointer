import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyRead, record, type Json, type ReadOptions, type ReadResult, type SourceReader, type SourceRef } from './context';
import { DocumentReader } from './context_documents';
import { runPowerShellJson } from './desktop';
import { POWERPOINT_NATIVE_WINDOW_SCRIPT } from './desktop_scripts';

type PowerPointProbe = (source: SourceRef, copyPath: string, signal?: AbortSignal) => Promise<Json>;

async function copyCurrentPresentation(source: SourceRef, copyPath: string, signal?: AbortSignal): Promise<Json> {
  const { hwnd, pid, presentationPath } = source.identity;
  const encoded = Buffer.from(JSON.stringify({ hwnd, pid, presentationPath, copyPath })).toString('base64');
  return runPowerShellJson(String.raw`
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class MpPowerPointProcess {
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
}
"@
${POWERPOINT_NATIVE_WINDOW_SCRIPT}
$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')) | ConvertFrom-Json
$windowPid=[uint32]0
[MpPowerPointProcess]::GetWindowThreadProcessId([IntPtr][int64]$p.hwnd,[ref]$windowPid) | Out-Null
if([int64]$windowPid -ne [int64]$p.pid){throw 'powerpoint-window-identity-changed'}
$window=[MpPowerPointWindow]::FromHandle([int64]$p.hwnd)
if($null -eq $window){throw 'bound-powerpoint-window-not-found'}
$presentation=$window.Presentation
if($null -eq $presentation -or -not [string]::Equals([string]$presentation.FullName,[string]$p.presentationPath,[StringComparison]::OrdinalIgnoreCase)){throw 'bound-powerpoint-presentation-changed'}
$presentation.SaveCopyAs([string]$p.copyPath)
@{ok=$true;hwnd=[int64]$p.hwnd;pid=[int64]$windowPid;presentation=[string]$presentation.FullName;presentationSaved=[bool]$presentation.Saved} | ConvertTo-Json -Depth 5 -Compress`, signal, 120000);
}

export class PowerPointLiveReader implements SourceReader {
  constructor(private probe: PowerPointProbe = copyCurrentPresentation) {}

  async read(source: SourceRef, options: ReadOptions = {}): Promise<ReadResult> {
    const started = performance.now();
    let backend = 'office.com.powerpoint.savecopyas';
    const expectedHwnd = Number(source.identity.hwnd);
    const expectedPid = Number(source.identity.pid);
    const presentationPath = String(source.identity.presentationPath ?? '');
    if (source.kind !== 'document' || source.revision.authority !== 'live' ||
      source.identity.host !== 'powerpoint' || !Number.isSafeInteger(expectedHwnd) || expectedHwnd <= 0 ||
      !Number.isSafeInteger(expectedPid) || expectedPid <= 0 || !presentationPath)
      return emptyRead(source, backend, 'powerpoint-live-source-identity-incomplete', started);

    const copyPath = join(tmpdir(), `magic-pointer-powerpoint-live-${randomUUID()}.pptx`);
    try {
      const response = record(await this.probe(source, copyPath, options.signal));
      if (response.ok !== true)
        return emptyRead(source, backend, String(response.error ?? 'powerpoint-live-read-failed'), started);
      if (Number(response.hwnd) !== expectedHwnd || Number(response.pid) !== expectedPid ||
        String(response.presentation ?? '').toLowerCase() !== presentationPath.toLowerCase())
        return emptyRead(source, backend, 'powerpoint-live-presentation-identity-changed', started);

      backend += '+document.pptx.ooxml';
      const result = await new DocumentReader().read({
        ...source,
        identity: { absolutePath: copyPath },
      }, options);
      return {
        ...result,
        fragments: result.fragments.map(item => ({
          ...item,
          metadata: { ...item.metadata, live: true, presentationPath,
            presentationSaved: response.presentationSaved === true },
        })),
        usedBackend: backend,
        latencyMs: performance.now() - started,
        structure: { ...result.structure, readFrom: 'live', presentation: presentationPath,
          presentationSaved: response.presentationSaved === true },
      };
    } catch (error) {
      options.signal?.throwIfAborted();
      return emptyRead(source, backend, `powerpoint-live-read-failed:${String(error)}`, started);
    } finally {
      await unlink(copyPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  }
}
