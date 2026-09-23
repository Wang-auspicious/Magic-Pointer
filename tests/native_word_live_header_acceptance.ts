import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DocumentOperationBackend } from '../electron/runtime/actions';
import { WordLiveReader } from '../electron/runtime/context_surfaces';
import type { SourceRef } from '../electron/runtime/context';
import { closeDesktop, configureDesktop, listWindows, runPowerShellJson } from '../electron/runtime/desktop';

const before = 'Bold Header target tail';
const after = 'Bold Header revised tail';

async function main() {
  configureDesktop(resolve(__dirname, '..'));
  let created = false;
  const started = performance.now();
  try {
    const existing = await runPowerShellJson("@{count=@(Get-Process WINWORD -ErrorAction SilentlyContinue).Count} | ConvertTo-Json -Compress");
    assert.equal(existing.count, 0, 'Native acceptance requires no pre-existing Word process');
    created = true;
    const setup = await runPowerShellJson(String.raw`
$app=New-Object -ComObject Word.Application
$app.Visible=$true; $app.DisplayAlerts=0
$doc=$app.Documents.Add()
$doc.Content.Text='Body remains'
$header=$doc.Sections.Item(1).Headers.Item(1)
$header.Range.Text='Bold Header target tail'
$prefix=$header.Range.Duplicate
$prefix.SetRange([int]$header.Range.Start,[int]$header.Range.Start+4)
$prefix.Font.Bold=-1
$tail=$header.Range.Duplicate
$tail.SetRange([int]$header.Range.Start+19,[int]$header.Range.Start+23)
$tail.Font.Italic=-1
@{hwnd=[int64]$app.ActiveWindow.Hwnd;document=[string]$doc.FullName;header=[string]$header.Range.Text} | ConvertTo-Json -Compress`, undefined, 30000);
    assert.match(String(setup.header), /Bold Header target tail/);
    let window: Awaited<ReturnType<typeof listWindows>>[number] | undefined;
    for (let attempt = 0; attempt < 12 && !window; attempt++) {
      window = (await listWindows()).find(item => item.hwnd === setup.hwnd);
      if (!window) await delay(500);
    }
    assert.ok(window, `Word window ${setup.hwnd} was not enumerated`);
    const source: SourceRef = {
      sourceId: 'native-word-live-header', taskId: 'native-word-live-header', kind: 'document',
      title: String(setup.document),
      identity: { host: 'word', documentPath: String(setup.document), hwnd: window.hwnd,
        pid: window.pid, processName: window.process_name },
      revision: { authority: 'live' }, capabilities: ['read', 'search', 'follow', 'patch'],
      origin: 'user-pointed', parentSourceId: null,
    };
    const reader = new WordLiveReader();
    const initial = await reader.read(source);
    const header = initial.fragments.find(item => item.locator.value.story === 'header' && item.text === before);
    assert.ok(header, JSON.stringify(initial));
    const operation = { operationId: 'native-word-live-header-write', operation: 'replace_text' as const,
      sourceId: source.sourceId, referenceId: 'header', locator: header.locator, before, after };
    const result = await new DocumentOperationBackend([source]).execute(operation);
    assert.equal(result.ok, true, JSON.stringify(result));
    const reread = await reader.read(source);
    assert.ok(reread.fragments.some(item => item.locator.value.story === 'header' && item.text === after), JSON.stringify(reread));
    assert.ok(reread.fragments.some(item => item.locator.value.story === 'body' && item.text === 'Body remains'));
    const format = await runPowerShellJson(String.raw`
$app=[Runtime.InteropServices.Marshal]::GetActiveObject('Word.Application')
$doc=$app.ActiveDocument; $header=$doc.Sections.Item(1).Headers.Item(1)
$prefix=$header.Range.Duplicate
$prefix.SetRange([int]$header.Range.Start,[int]$header.Range.Start+4)
$tail=$header.Range.Duplicate
$tail.SetRange([int]$header.Range.Start+20,[int]$header.Range.Start+24)
@{header=[string]$header.Range.Text;body=[string]$doc.Content.Text;bold=[int]$prefix.Font.Bold;italic=[int]$tail.Font.Italic;saved=[bool]$doc.Saved} | ConvertTo-Json -Compress`);
    assert.match(String(format.header), /Bold Header revised tail/);
    assert.match(String(format.body), /Body remains/);
    assert.equal(format.bold, -1);
    assert.equal(format.italic, -1);
    assert.equal(format.saved, false);
    console.log(JSON.stringify({ ok: true, scope: 'native_word_live_header_read_write_readback',
      readBackend: initial.usedBackend, writeBackend: result.usedBackend, readbackBackend: reread.usedBackend,
      header: after, body: 'Body remains', formattingPreserved: true,
      elapsedMs: Math.round(performance.now() - started) }));
  } finally {
    if (created) await runPowerShellJson(String.raw`
$app=[Runtime.InteropServices.Marshal]::GetActiveObject('Word.Application')
foreach($doc in @($app.Documents)){$doc.Close(0)}
$app.Quit()
@{ok=$true} | ConvertTo-Json -Compress`, undefined, 20000).catch(error => console.error(`Word cleanup failed: ${String(error)}`));
    closeDesktop();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
