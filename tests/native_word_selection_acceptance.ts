import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ActionBroker } from '../electron/runtime/actions_delivery';
import { FrameCaptureService } from '../electron/runtime/desktop_capture';
import { captureSnapshot, closeOcr, handleSelection } from '../electron/runtime/desktop_perception';
import { closeDesktop, configureDesktop, listWindows, runPowerShellJson } from '../electron/runtime/desktop';

const { stageEventFromBridge } = require('../electron/stage_contract') as { stageEventFromBridge: (value: unknown) => { result: Record<string, any> } };
const original = 'rough words', replacement = 'clear words', prefix = 'Bold ', suffix = ' tail';
const script = (data: unknown, body: string) => `$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(JSON.stringify(data)).toString('base64')}'))|ConvertFrom-Json\n${body}`;

async function main() {
  const repository = resolve(__dirname, '..'), temporary = await mkdtemp(join(tmpdir(), 'mp-word-selection-native-'));
  const document = join(temporary, 'selection-acceptance.docx');
  configureDesktop(repository);
  process.env.MAGIC_POINTER_USER_DATA_DIR = temporary;
  let created = false;
  const started = performance.now();
  try {
    const existing = await runPowerShellJson(`@{count=@(Get-Process WINWORD -ErrorAction SilentlyContinue).Count} | ConvertTo-Json -Compress`);
    assert.equal(existing.count, 0, 'Native acceptance requires no pre-existing Word process');
    created = true;
    const setup = await runPowerShellJson(script({ document, text: prefix + original + suffix, start: prefix.length, end: prefix.length + original.length, suffixStart: prefix.length + original.length, suffixEnd: prefix.length + original.length + suffix.length },
      `$app=New-Object -ComObject Word.Application
$app.Visible=$true; $app.DisplayAlerts=0
$doc=$app.Documents.Add(); $doc.Content.Text=[string]$p.text
$doc.Range(0,[int]$p.start).Bold=-1
$doc.Range([int]$p.start,[int]$p.end).Underline=1
$doc.Range([int]$p.suffixStart,[int]$p.suffixEnd).Italic=-1
$doc.SaveAs2([string]$p.document); $doc.Activate()
$app.Selection.SetRange([int]$p.start,[int]$p.end)
@{hwnd=[int64]$app.ActiveWindow.Hwnd; document=[string]$doc.FullName; selected=[string]$app.Selection.Text} | ConvertTo-Json -Compress`,
      ), undefined, 30000);
    assert.equal(setup.selected, original);
    let window: Awaited<ReturnType<typeof listWindows>>[number] | undefined;
    for (let attempt = 0; attempt < 12 && !window; attempt++) {
      window = (await listWindows()).find(item => item.hwnd === setup.hwnd);
      if (!window) await delay(500);
    }
    assert.ok(window, `Word window ${setup.hwnd} was not enumerated`);
    const capture = new FrameCaptureService(temporary);
    capture.arm({ epochId: 'word-selection-native', displayId: 'word-selection-native', scaleFactor: 1,
      surfaceBoundsPx: window.bbox, targetWindow: { hwnd: window.hwnd, processId: window.pid,
        processName: window.process_name, title: window.title } });
    await delay(700);
    const frame = await capture.commit({ epochId: 'word-selection-native', gesture: { coordinateSpace: 'physical_screen_pixels', strokes: [] } });
    const captured = await captureSnapshot({ frameLease: frame, uploadScreenshots: false });
    assert.equal(captured.ok, true, captured.error);
    const snapshot = captured.selectionSnapshot;
    assert.equal(snapshot.status, 'ok', JSON.stringify({ trace: snapshot.perception_trace, conflicts: snapshot.conflicts }));
    assert.equal(snapshot.context.adapter, 'office');
    assert.equal(snapshot.context.content, original);
    assert.equal(snapshot.structured_covers_mark, true);
    assert.equal(snapshot.perception_trace.liveIdentityMatched, true);
    const proposalResult = await handleSelection({ command: '润色选中文字', selectionSnapshot: snapshot,
      selectionSessionId: 'word-selection-native' }, { runRuntime: async request => {
      assert.match(String(request.instruction), /只输出替换文本本身/);
      return { ok: true, answer: replacement, hasPendingWork: false, usedBackend: 'acceptance.fixture_model' };
    } });
    assert.match(String(proposalResult.answer), /原文预览：rough words/);
    assert.match(String(proposalResult.answer), /替换为：clear words/);
    assert.equal(proposalResult.actionProposals.length, 1);
    const proposal = proposalResult.actionProposals[0];
    const stage = stageEventFromBridge({ ...proposalResult, actionProposals: [{ ...proposal, action_token: 'native-preview' }] });
    assert.equal(stage.result.kind, 'text-draft');
    assert.equal(stage.result.original, original);
    assert.equal(stage.result.proposed, replacement);
    const before = await runPowerShellJson(script({ document },
      `$app=[Runtime.InteropServices.Marshal]::GetActiveObject('Word.Application'); $doc=$app.ActiveDocument
@{text=[string]$doc.Range(0,$doc.Content.End-1).Text; selected=[string]$app.Selection.Text; document=[string]$doc.FullName} | ConvertTo-Json -Compress`));
    assert.equal(before.text, prefix + original + suffix);
    assert.equal(before.selected, original);
    const execution = await new ActionBroker('word-selection-native', { root: temporary, userDataDir: temporary }).execute(proposal, true);
    assert.equal(execution.status, 'succeeded', execution.error);
    const after = await runPowerShellJson(script({ document, prefixEnd: prefix.length, replacementEnd: prefix.length + replacement.length, suffixEnd: prefix.length + replacement.length + suffix.length },
      `$app=[Runtime.InteropServices.Marshal]::GetActiveObject('Word.Application'); $doc=$app.ActiveDocument
@{document=[string]$doc.FullName; text=[string]$doc.Range(0,$doc.Content.End-1).Text; prefixBold=[int]$doc.Range(0,[int]$p.prefixEnd).Bold; replacementUnderline=[int]$doc.Range([int]$p.prefixEnd,[int]$p.replacementEnd).Underline; suffixItalic=[int]$doc.Range([int]$p.replacementEnd,[int]$p.suffixEnd).Italic} | ConvertTo-Json -Compress`));
    assert.equal(after.document, document);
    assert.equal(after.text, prefix + replacement + suffix);
    assert.equal(after.prefixBold, -1);
    assert.equal(after.replacementUnderline, 1);
    assert.equal(after.suffixItalic, -1);
    console.log(JSON.stringify({ ok: true, scope: 'native_com_selection_to_confirmed_word_write',
      frozenGesturePixelsVerified: false, frameSource: frame.source, snapshotBackend: snapshot.usedBackend, selectionBackend: snapshot.context.method,
      modelBackend: proposalResult.usedBackend, actionBackend: execution.output?.com_prog_id,
      preview: { original: stage.result.original, proposed: stage.result.proposed },
      readback: after, elapsedMs: Math.round(performance.now() - started) }));
  } finally {
    if (created) {
      await runPowerShellJson(script({ document },
        `$app=[Runtime.InteropServices.Marshal]::GetActiveObject('Word.Application')
foreach($doc in @($app.Documents)) { if([string]$doc.FullName -ieq [string]$p.document) { $doc.Close(0); break } }
$app.Quit(); @{ok=$true} | ConvertTo-Json -Compress`), undefined, 20000).catch(error => console.error(`Word cleanup failed: ${String(error)}`));
    }
    closeOcr(); closeDesktop();
    const owned = relative(tmpdir(), temporary);
    if (!owned.startsWith('..') && !owned.includes('..') && owned.startsWith('mp-word-selection-native-')) {
      await rm(temporary, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 })
        .catch(error => { console.error(`Temporary acceptance cleanup failed: ${String(error)}`); process.exitCode = 1; });
    }
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
