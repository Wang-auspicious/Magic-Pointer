import assert from 'node:assert/strict';
import { DocumentOperationBackend } from '../electron/runtime/actions';
import { ExcelLiveReader } from '../electron/runtime/context_excel_live';
import type { SourceRef } from '../electron/runtime/context';
import { closeDesktop, runPowerShellJson } from '../electron/runtime/desktop';

async function main() {
  const existing = await runPowerShellJson("@{count=@(Get-Process EXCEL -ErrorAction SilentlyContinue).Count} | ConvertTo-Json -Compress");
  assert.equal(existing.count, 0, 'isolated acceptance requires no existing Excel process');
  let setup: Record<string, unknown> | undefined;
  try {
    setup = await runPowerShellJson(String.raw`
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class MpAcceptancePid { [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid); }
"@
$app=New-Object -ComObject Excel.Application
$app.Visible=$false; $app.DisplayAlerts=$false
$book=$app.Workbooks.Add()
$sheet=$book.Worksheets.Item(1)
$sheet.Range('B2').Value2=120
$sheet.Range('C2').Value2='neighbor untouched'
$win=$book.Windows.Item(1)
$ownerPid=[uint32]0
[MpAcceptancePid]::GetWindowThreadProcessId([IntPtr][int64]$win.HWND,[ref]$ownerPid) | Out-Null
@{hwnd=[int64]$win.HWND;pid=[int64]$ownerPid;workbook=[string]$book.FullName;sheet=[string]$sheet.Name;saved=[bool]$book.Saved;visible=[bool]$app.Visible;diskExists=(Test-Path -LiteralPath $book.FullName)} | ConvertTo-Json -Compress`, undefined, 30000);
    assert.equal(setup.visible, false);
    assert.equal(setup.diskExists, false);
    const source: SourceRef = {
      sourceId: 'native-excel-hidden-accept', taskId: 'native-excel-hidden-accept', kind: 'document',
      title: String(setup.workbook), identity: { host: 'excel', hwnd: Number(setup.hwnd), pid: Number(setup.pid),
        workbookPath: String(setup.workbook), processName: 'EXCEL.EXE' },
      revision: { authority: 'live' }, capabilities: ['read', 'search', 'follow', 'patch'],
      origin: 'user-pointed', parentSourceId: null,
    };
    const reader = new ExcelLiveReader();
    const initial = await reader.read(source);
    assert.equal(initial.fragments.find(item => item.metadata.address === 'B2')?.metadata.value, 120, JSON.stringify(initial));
    assert.equal(initial.fragments.find(item => item.metadata.address === 'C2')?.metadata.value, 'neighbor untouched');
    const operation = { operationId: 'native-excel-cell-change', operation: 'set_cell_values' as const,
      sourceId: source.sourceId, referenceId: 'B2', locator: { kind: 'cell-range', value: { sheet: String(setup.sheet), range: 'B2' } },
      before: [[120]], after: [[210]] };
    const write = await new DocumentOperationBackend([source]).execute(operation);
    assert.equal(write.ok, true, JSON.stringify(write));
    const reread = await reader.read(source);
    assert.equal(reread.fragments.find(item => item.metadata.address === 'B2')?.metadata.value, 210, JSON.stringify(reread));
    assert.equal(reread.fragments.find(item => item.metadata.address === 'C2')?.metadata.value, 'neighbor untouched');
    const independent = await runPowerShellJson(String.raw`
$app=[Runtime.InteropServices.Marshal]::GetActiveObject('Excel.Application')
$book=@($app.Workbooks) | Where-Object { [string]$_.FullName -eq '${String(setup.workbook).replaceAll("'", "''")}' } | Select-Object -First 1
if($null -eq $book){throw 'acceptance_workbook_missing'}
$sheet=$book.Worksheets.Item('${String(setup.sheet).replaceAll("'", "''")}')
@{target=$sheet.Range('B2').Value2;neighbor=[string]$sheet.Range('C2').Value2;saved=[bool]$book.Saved;visible=[bool]$app.Visible;diskExists=(Test-Path -LiteralPath $book.FullName)} | ConvertTo-Json -Compress`);
    assert.equal(independent.target, 210);
    assert.equal(independent.neighbor, 'neighbor untouched');
    assert.equal(independent.saved, false);
    assert.equal(independent.visible, false);
    assert.equal(independent.diskExists, false);
    console.log(JSON.stringify({ ok: true, scope: 'hidden_unsaved_excel_B2_only', readBackend: initial.usedBackend,
      writeBackend: write.usedBackend, readbackBackend: reread.usedBackend, target: independent.target,
      neighbor: independent.neighbor, saved: independent.saved, visible: independent.visible }));
  } finally {
    if (setup) await runPowerShellJson(String.raw`
$app=[Runtime.InteropServices.Marshal]::GetActiveObject('Excel.Application')
$bound=$null
foreach($book in @($app.Workbooks)){
 if(-not [string]::Equals([string]$book.FullName,'${String(setup.workbook).replaceAll("'", "''")}',[StringComparison]::OrdinalIgnoreCase)){continue}
 foreach($win in @($book.Windows)){if([int64]$win.HWND -eq ${Number(setup.hwnd)}){$bound=$book;break}}
 if($bound){break}
}
if($bound){$bound.Close($false);if([int]$app.Workbooks.Count -eq 0){$app.Quit()}}
@{ok=[bool]$bound} | ConvertTo-Json -Compress`, undefined, 20000).catch(error => console.error(`Excel cleanup failed: ${String(error)}`));
    closeDesktop();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
