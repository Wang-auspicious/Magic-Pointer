// Read-only audit probes. These assertions document CURRENT defective behavior;
// they are not acceptance tests and must be inverted when implementing fixes.
// Run: node --import tsx docs/research/audit-2026-09-20-desktop-repro.ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import { transformSync } from 'esbuild';
import { applyFigmaNodePatch } from '../../integrations/figma/patch';
import { FigmaLoopbackBridge } from '../../electron/figma_bridge';
import { createPythonBridgeRunner } from '../../electron/python_bridge_runner';
import { createConversationStore } from '../../electron/conversation_store';
import { createTaskWatcher } from '../../electron/task_watcher';
import { parseGitEnvironment } from '../../electron/project_environment';
import { readProjectText } from '../../electron/project_inspector';
import { createUpdateManager } from '../../electron/update_manager';
import { normalizeBrowserUrl } from '../../electron/browser_view_policy';
const { attachContentsHardening } = require('../../electron/security_hardening');
const { createArtifactEditor } = require('../../electron/renderer/artifact_editor');
const { createContextTrackerRuntime, readFileObservation, observationsEqual } = require('../../electron/context_trackers');
const findings: Record<string, unknown> = {};
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function textNode(value: string): any {
  return {
    id: '1:2', type: 'TEXT', characters: value, fontName: { family: 'Inter', style: 'Regular' },
    deleteCharacters(start: number, end: number) { this.characters = this.characters.slice(0, start) + this.characters.slice(end); },
    insertCharacters(start: number, text: string) { this.characters = this.characters.slice(0, start) + text + this.characters.slice(start); },
  };
}
function request(operations: any[]) { return { taskId: 'task-a', documentSessionId: 'doc-a', operations }; }
function context(node: any, loadFont = async () => {}) { return { documentSessionId: 'doc-a', getNodeById: async () => node, loadFont }; }
const replace = (start: number, end: number, before: string, after: string): any => ({ op: 'replace_text', nodeId: '1:2', start, end, before, after });

async function main() {
  const original = { artifactId: 'a', revision: 1, content: 'summary', kind: 'document_patch', state: 'generated', patchPayload: { operations: [{ after: 'old' }] } };
  let accepted = false;
  const editor = createArtifactEditor({
    read: async () => ({ ok: true, artifact: original }),
    edit: async () => { throw new Error('should not save'); },
    accept: async () => { accepted = true; return { ok: true, artifact: { ...original, acceptedRevision: 1 } }; },
    apply: async () => ({ ok: true }),
  });
  await editor.select('c', 'a');
  editor.updatePatchPayload({ operations: [{ after: 'new' }] });
  editor.updateContent('summary');
  assert.equal(editor.state().dirty, false);
  await editor.accept();
  assert.equal(accepted, true);
  assert.equal(editor.state().patchPayload.operations[0].after, 'old');
  findings.patchDirtyLost = { dirtyAfterContentReset: false, acceptedOldRevision: accepted, after: editor.state().patchPayload.operations[0].after };

  const studio = fs.readFileSync(path.resolve(__dirname, '../../electron/renderer/studio.ts'), 'utf8');
  let fieldHandler: ((event: any) => void) | undefined;
  const sandbox: any = {
    artifactEditor: editor,
    document: { getElementById: () => ({ addEventListener: (_event: string, handler: any) => { fieldHandler = handler; } }) },
    renderArtifactEditor() {},
  };
  const valueFn = studio.slice(studio.indexOf('function artifactValueText('), studio.indexOf('\nfunction renderArtifactPatchPreview('));
  const changeHandler = studio.slice(studio.indexOf("document.getElementById('artifact-patch-changes')?.addEventListener('change'"), studio.indexOf("document.getElementById('artifact-patch-changes')?.addEventListener('click'"));
  vm.runInNewContext(transformSync(valueFn + '\n' + changeHandler, { loader: 'ts' }).code, sandbox);
  let validation = '';
  const field = { dataset: { artifactOperationIndex: '0' }, value: sandbox.artifactValueText('更短的说明'), setCustomValidity(value: string) { validation = value; }, reportValidity() {} };
  fieldHandler!({ target: { closest: () => field } });
  assert.ok(validation.includes('JSON'));
  findings.plainTextPatchRejected = { visibleText: field.value, error: validation };

  let resolveSelection: ((value: any) => void) | undefined;
  const retargetSource = studio.slice(studio.indexOf('async function retargetFigmaArtifact('), studio.indexOf('\nfunction artifactValueText('));
  const oldState: any = { conversationId: 'c-a', artifactId: 'a', patchPayload: { marker: 'patch-a', operations: [{}] } };
  let liveState: any = oldState;
  const retargetSandbox: any = {
    artifactEditor: { state: () => liveState, updatePatchPayload: (payload: any) => { liveState.patchPayload = payload; } },
    ArtifactEditor: { retargetFigmaPatch: (payload: any) => ({ ...payload, retargeted: true }) },
    Data: { inspectFigmaSelection: () => new Promise((resolve) => { resolveSelection = resolve; }) },
    figmaPatchCoordinates: () => ({ key: 'a:1', documentSessionId: 'doc-a' }), figmaArtifactPreviews: new Map(),
    renderArtifactPatchPreview() {}, renderArtifactEditor() {}, refreshFigmaArtifactPreviews: async () => {},
  };
  vm.runInNewContext(transformSync(retargetSource, { loader: 'ts' }).code, retargetSandbox);
  const retargetPending = retargetSandbox.retargetFigmaArtifact(0);
  liveState = { conversationId: 'c-b', artifactId: 'b', patchPayload: { marker: 'patch-b', operations: [] } };
  resolveSelection!({ ok: true, result: { selectionIds: ['1:2'], nodes: [{ id: '1:2' }] } });
  await retargetPending;
  assert.equal(liveState.artifactId, 'b'); assert.equal(liveState.patchPayload.marker, 'patch-a');
  findings.lateRetargetOverwritesOtherArtifact = { selectedArtifact: liveState.artifactId, patchMarker: liveState.patchPayload.marker };

  let node = textNode('abcdef');
  await applyFigmaNodePatch(context(node), request([replace(0, 1, 'a', 'AAAA'), replace(4, 6, 'ef', 'ZZ')]));
  assert.equal(node.characters, 'AAAAZZdef');
  findings.figmaBatchOffsets = { actual: node.characters, expected: 'AAAAbcdZZ' };

  node = textNode('abc');
  node.insertCharacters = () => { throw new Error('native insertion failed'); };
  await assert.rejects(applyFigmaNodePatch(context(node), request([replace(0, 1, 'a', 'Z')])), /figma_patch_apply_failed/);
  assert.equal(node.characters, 'bc');
  findings.figmaPartialRollback = { actual: node.characters, expected: 'abc', caveat: 'injected native failure; no native Figma acceptance claimed' };

  node = textNode('abc');
  await applyFigmaNodePatch(context(node, async () => { node.characters = 'xyz'; }), request([replace(0, 3, 'abc', 'NEW')]));
  assert.equal(node.characters, 'NEW');
  findings.figmaChangedDuringFontLoad = { result: node.characters, expected: 'reject base change, preserve xyz' };

  const child: any = new EventEmitter();
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
  child.stdin.write = () => {}; child.stdin.end = () => {}; child.kill = () => {};
  let bridgeResult: any = null;
  let progressCount = 0;
  createPythonBridgeRunner({ spawnImpl: () => child, setTimeoutImpl: () => 0, clearTimeoutImpl: () => {} }).run({ onComplete: (result) => { bridgeResult = result; }, onProgress: () => { progressCount += 1; } });
  const line = '@@mp phase=tool_result ms=1 b64=' + Buffer.from(JSON.stringify({ id: 'read', name: 'Read', state: 'done', result: '文'.repeat(32000) })).toString('base64') + '\n';
  child.stderr.emit('data', line); child.stderr.emit('data', line); child.stderr.emit('data', line);
  assert.equal(bridgeResult?.error, 'bridge_output_limit');
  findings.bridgeProgressCeiling = { ...bridgeResult, progressCount, bytesPerValidRecord: Buffer.byteLength(line) };

  let nextPoll: (() => void) | undefined;
  const patches: any[] = [];
  let phase = 'reading';
  const watcher = createTaskWatcher({
    probe: async () => ({ status: 'running', result: { steps: [{ label: 'read', note: phase, state: phase === 'reading' ? 'running' : 'done' }] } }),
    onPatch: (event) => patches.push(event.patch),
    schedule: (callback) => { nextPoll = callback; return {}; }, cancelSchedule: () => {},
  });
  watcher.watch({ taskId: 't' }); await tick();
  phase = 'complete'; nextPoll!(); await tick(); watcher.stopAll();
  assert.equal(patches.length, 1);
  findings.taskWatcherDropsStepUpdate = { patchCount: patches.length, shownNote: patches[0].steps[0].note, actualNote: phase };

  let observationReads = 0; let runs = 0;
  const tracker = createContextTrackerRuntime({
    loadTrackers: () => [{ trackerId: 'audit', task: 'read changes', sourceIds: ['source:attachment:D:/work/a.txt'], folderRoot: '', outputType: 'draft', enabled: true, trigger: { kind: 'filesystem', paths: ['D:/work/a.txt'], debounceMs: 200 }, lastObserved: { observedAtMs: 1, entries: { 'D:/work/a.txt': { exists: true, size: 1, mtimeMs: 1 } } }, lastRun: null }],
    persistTrackers: () => {}, watchPath: () => ({ close() {} }),
    readObservation: async () => { observationReads += 1; return { observedAtMs: 2, entries: { 'D:/work/a.txt': { exists: true, size: 2, mtimeMs: 2 } } }; },
    runTask: async () => { runs += 1; return { ok: true }; },
  });
  await tracker.start(); await tracker.idle(); await tracker.stop();
  assert.equal(observationReads, 0); assert.equal(runs, 0);
  findings.offlineTrackerChangeSkipped = { observationReads, runs };

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-audit-desktop-'));
  try {
    const gitRoot = path.join(root, 'git'); fs.mkdirSync(gitRoot);
    execFileSync('git', ['init', '--quiet'], { cwd: gitRoot });
    fs.writeFileSync(path.join(gitRoot, '报告.md'), 'report');
    const gitOutput = execFileSync('git', ['-c', 'core.quotepath=true', 'status', '--porcelain=v1', '--branch'], { cwd: gitRoot, encoding: 'utf8' });
    const parsedGit = parseGitEnvironment({ root: gitRoot, branchOutput: gitOutput });
    const shownPath = parsedGit.fileChanges[0].path;
    assert.notEqual(shownPath, '报告.md'); assert.equal(fs.existsSync(path.join(gitRoot, shownPath)), false);
    findings.quotedGitPathBroken = { actualFile: '报告.md', shownPath, exists: false };

    fs.writeFileSync(path.join(root, 'large.txt'), 'x'.repeat(1024 * 1024));
    const originalRead = fs.readFileSync;
    let actualReadBytes = 0;
    try {
      (fs as any).readFileSync = (...args: any[]) => { const data = (originalRead as any)(...args); actualReadBytes = data.length; return data; };
      const preview = readProjectText(root, 'large.txt', 32);
      assert.equal(preview.text.length, 32); assert.equal(actualReadBytes, 1024 * 1024);
      findings.previewReadsWholeFile = { returnedBytes: preview.text.length, actualReadBytes };
    } finally { fs.readFileSync = originalRead; }

    const tree = path.join(root, 'watched'); fs.mkdirSync(path.join(tree, 'sub'), { recursive: true });
    const nested = path.join(tree, 'sub', 'a.txt'); fs.writeFileSync(nested, 'old');
    const before = await readFileObservation([tree]); fs.writeFileSync(nested, 'longer new content');
    const after = await readFileObservation([tree]);
    assert.equal(observationsEqual(before, after), true);
    findings.nestedFolderChangeInvisible = { observationsEqual: true, actualContent: fs.readFileSync(nested, 'utf8') };

    let now = 1000;
    const store = createConversationStore({ baseDir: path.join(root, 'history'), now: () => ++now, deferPersist: true, persistDebounceMs: 100000 });
    const first = store.appendTurn({ question: 'q0', answer: 'a0', outcome: 'completed', agentSessionId: 'agent-original', taskContext: { sources: [{ sourceId: 'source-a' }], references: [], revision: 1 }, artifacts: [{ artifactId: 'artifact-a' }] } as any);
    const branch = store.branch(first.id, 0)!;
    assert.equal(branch.agentSessionId, undefined); assert.equal(branch.taskContext, undefined);
    findings.branchDropsContext = { agentSessionId: branch.agentSessionId ?? null, taskContext: branch.taskContext ?? null, artifactsStillVisible: branch.turns[0].artifacts };
    for (let i = 1; i <= 200; i++) store.appendTurn({ conversationId: first.id, question: 'q' + i, answer: 'a' + i, outcome: 'completed' });
    assert.equal(store.get(first.id)!.turns.length, 200); assert.equal(store.get(first.id)!.turns[0].question, 'q1');
    store.flush();
    findings.historyTrim = { count: store.get(first.id)!.turns.length, firstQuestion: store.get(first.id)!.turns[0].question };

    const originalWrite = fs.writeFile;
    let release: (() => void) | undefined;
    try {
      (fs as any).writeFile = (...args: any[]) => { release = () => (originalWrite as any)(...args); };
      const slow = createConversationStore({ baseDir: path.join(root, 'slow'), now: () => ++now, deferPersist: true, persistDebounceMs: 10 });
      const c = slow.appendTurn({ question: 'first', outcome: 'completed' });
      for (let i = 0; !release && i < 100; i++) await pause(2);
      assert.ok(release);
      slow.appendTurn({ conversationId: c.id, question: 'second', outcome: 'completed' });
      await pause(40); release!(); await pause(80); slow.flush();
      const disk = JSON.parse(fs.readFileSync(path.join(root, 'slow', 'conversations.json'), 'utf8'));
      const diskItems = Array.isArray(disk) ? disk : disk.conversations;
      assert.equal(diskItems[0].turns.length, 1);
      findings.pendingPersistLost = { memoryTurns: slow.get(c.id)!.turns.length, diskTurnsAfterFlush: diskItems[0].turns.length };
    } finally { fs.writeFile = originalWrite; }
  } finally {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('mp-audit-desktop-'));
    fs.rmSync(root, { recursive: true, force: true });
  }

  const bridge = new FigmaLoopbackBridge({ port: 0 });
  const address = await bridge.start();
  try {
    bridge.openPairing('task-a', '123456');
    const pair: any = await (await fetch(address.baseUrl + '/pair', { method: 'POST', body: JSON.stringify({ pairCode: '123456', documentSessionId: 'doc-a' }) })).json();
    await assert.rejects(bridge.request('task-a', 'doc-a', 'apply_patch', { operations: [] }, { timeoutMs: 100, pollIntervalMs: 10 }), /figma_command_timed_out/);
    const pulled: any = await (await fetch(address.baseUrl + '/commands', { headers: { Authorization: 'Bearer ' + pair.pluginToken } })).json();
    assert.equal(pulled.commands.length, 1); assert.equal(pulled.commands[0].operation, 'apply_patch');
    findings.timedOutWriteStillDispatches = { commandCount: pulled.commands.length, operation: pulled.commands[0].operation };
    await fetch(address.baseUrl + '/results', { method: 'POST', headers: { Authorization: 'Bearer ' + pair.pluginToken }, body: JSON.stringify({ commandId: pulled.commands[0].commandId, taskId: 'task-a', documentSessionId: 'doc-a', ok: true, result: { base64: 'A'.repeat(1000) } }) });
    await fetch(address.baseUrl + '/results/' + pulled.commands[0].commandId, { headers: { Authorization: 'Bearer ' + bridge.controlToken } });
    bridge.closeConnection('task-a', 'doc-a');
    assert.equal((bridge as any).commands.size, 1);
    findings.completedFigmaResultRetained = { afterReadAndDisconnect: (bridge as any).commands.size };
  } finally { await bridge.stop(); }

  const updater: any = new EventEmitter();
  let installCalls = 0;
  updater.quitAndInstall = () => { installCalls += 1; };
  updater.checkForUpdates = async () => ({}); updater.downloadUpdate = async () => {};
  const updateManager = createUpdateManager({ app: { isPackaged: true, getVersion: () => '1.0.49' }, updater, dialog: { showMessageBox: async () => ({ response: 1 }) } });
  updateManager.start({ automatic: false });
  updater.emit('update-downloaded', { version: '1.0.50' }); await tick();
  assert.equal(updater.autoInstallOnAppQuit, false); assert.equal(installCalls, 0);
  findings.deferredUpdateNotScheduled = { autoInstallOnAppQuit: updater.autoInstallOnAppQuit, installCalls };
  updateManager.dispose();

  const browserContents: any = new EventEmitter();
  browserContents.getURL = () => 'https://example.test/first';
  browserContents.setWindowOpenHandler = () => {};
  browserContents.session = {};
  const externalUrls: string[] = [];
  attachContentsHardening(browserContents, () => {}, { shell: { openExternal: async (url: string) => { externalUrls.push(url); } } });
  browserContents.on('will-navigate', (event: any, url: string) => { try { normalizeBrowserUrl(url); } catch { event.preventDefault(); } });
  let prevented = false;
  browserContents.emit('will-navigate', { preventDefault() { prevented = true; } }, 'https://example.test/second');
  assert.equal(prevented, true); assert.deepEqual(externalUrls, ['https://example.test/second']);
  findings.embeddedBrowserNavigationEscapes = { prevented, externalUrls };
  console.log(JSON.stringify(findings, null, 2));
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
