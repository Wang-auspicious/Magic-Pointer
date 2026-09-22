'use strict';

const { app, BrowserWindow, ipcMain, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '..');
const STARTED_AT = Date.now();
const OUTPUT = path.resolve(process.argv[2] || path.join(ROOT, 'artifacts/selection-live-acceptance'));
const PROFILE = path.join(ROOT, 'data/runtime/acceptance', `selection-live-${process.pid}`);
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6f8AAAAASUVORK5CYII=';
fs.mkdirSync(OUTPUT, { recursive: true });
fs.mkdirSync(PROFILE, { recursive: true });
const IMAGE_FILE = path.join(PROFILE, 'recorded image.png');
fs.writeFileSync(IMAGE_FILE, Buffer.from(PNG_BASE64, 'base64'));
process.env.MAGIC_POINTER_USER_DATA_DIR = PROFILE;
app.setPath('userData', PROFILE);
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');

const originalWhenReady = app.whenReady.bind(app);
let skippedStartup = 0;
app.whenReady = () => ({ then() { skippedStartup++; } });
const MAIN_PATH = path.join(ROOT, 'build/electron/main.js');
const productionMain = new Module(MAIN_PATH, module);
productionMain.filename = MAIN_PATH;
productionMain.paths = Module._nodeModulePaths(path.dirname(MAIN_PATH));
productionMain._compile(fs.readFileSync(MAIN_PATH, 'utf8') + `
module.exports.acceptance = {
  selectionSessions, activeSessionChildren, stageLiveTurns, pendingQuestions,
  beginStageLiveTurn, appendStageLiveProgress, recordConversationTurn,
  updateStage, stageEventFromBridge, dismissTemporarySurfaces, conversations,
  bindWindows(stage, dashboard) {
    stageWindow = stage; dashboardWindow = dashboard;
    fabricSettings = defaultSettings();
    fabricSettings.interaction.voice_enabled = false;
  },
  setActiveToken(token) { activeSelectionSessionToken = token; },
  flush: flushConversations,
};
`, MAIN_PATH);
app.whenReady = originalWhenReady;
const main = productionMain.exports.acceptance;

const externalBoundaries = {
  'models:catalog': { ok: true, catalog: { current: 'Recorded read-only fixture', groups: [] } },
  'models:quota': { ok: false, error: 'fixture_no_network' },
  'slash:directory': { ok: true, entries: [] },
  'runtime-snapshot:get': {},
  'dashboard:model-health-refresh': {},
  'projects:environment': { ok: true, git: null, entries: [] },
  'projects:tree': { ok: true, entries: [] },
  'stash:list': [],
  'figma:status': { ok: true, connected: false },
  'conversations:suggest': { ok: true, suggestion: '把这份结论整理为可编辑笔记。' },
};
for (const [channel, value] of Object.entries(externalBoundaries)) {
  ipcMain.removeHandler(channel);
  ipcMain.handle(channel, () => value);
}

const report = {
  kind: 'actual-main-preload-two-renderer-acceptance',
  provider: 'recorded read-only progress fixture; no AI/network request',
  usedBackend: 'recorded.fixture.read_only',
  surfaceMode: 'two real offscreen BrowserWindows; native visibility and focus suppressed',
  imageBoundary: 'HTTP/HTTPS image responses are local recorded PNG bytes supplied by Electron protocol handlers; no network.',
  skippedStartup, externalBoundaries: Object.keys(externalBoundaries),
  profile: PROFILE, screenshots: [], checks: {}, consoleErrors: [],
};
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function waitFor(label, predicate, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(70);
  }
  throw new Error(`Timed out: ${label}`);
}
const evaluate = (window, source) => window.webContents.executeJavaScript(source);
async function screenshot(window, name, rect) {
  await evaluate(window, 'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  window.webContents.invalidate();
  await delay(120);
  const image = await window.webContents.capturePage(rect);
  const destination = path.join(OUTPUT, name + '.png');
  fs.writeFileSync(destination, image.toPNG());
  report.screenshots.push(destination);
}
function collectErrors(window, surface) {
  window.webContents.on('console-message', (...args) => {
    const detail = typeof args[1] === 'object' ? args[1] : null;
    const level = detail?.level ?? args[1];
    const message = String(detail?.message ?? args[2] ?? '');
    if ((level === 'error' || level === 3) && !message.includes('favicon')) report.consoleErrors.push({ surface, message });
  });
  window.webContents.on('preload-error', (_event, _file, error) => report.consoleErrors.push({ surface, message: String(error) }));
}

originalWhenReady().then(async () => {
  let stage;
  let studio;
  try {
    for (const scheme of ['http', 'https']) session.defaultSession.protocol.handle(scheme, request => {
      if (request.url !== `${scheme}://acceptance.invalid/fixture.png`) return Response.error();
      return new Response(Buffer.from(PNG_BASE64, 'base64'), { headers: { 'content-type': 'image/png' } });
    });
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => callback({ cancel: !/^https?:\/\/acceptance\.invalid\/fixture\.png$/.test(details.url) }));
    const preferences = {
      preload: path.join(ROOT, 'build/electron/preload.js'),
      offscreen: true, contextIsolation: true, nodeIntegration: false,
      sandbox: true, backgroundThrottling: false,
    };
    stage = new BrowserWindow({ width: 1250, height: 900, show: false, frame: false, webPreferences: preferences });
    studio = new BrowserWindow({ width: 1400, height: 1000, show: false, webPreferences: preferences });
    let visibilityRequests = 0;
    stage.showInactive = () => { visibilityRequests++; };
    stage.focus = () => {};
    main.bindWindows(stage, studio);
    collectErrors(stage, 'stage'); collectErrors(studio, 'studio');
    await Promise.all([
      stage.loadFile(path.join(ROOT, 'build/electron/renderer/stage.html')),
      studio.loadFile(path.join(ROOT, 'build/electron/renderer/studio.html'), { query: { view: 'chat' } }),
    ]);
    await waitFor('Studio boot finished', () => evaluate(studio, `document.activeElement?.classList.contains('mpw-input') === true`));
    const entry = main.selectionSessions.create({ reason: 'acceptance-recorded-read-only' });
    main.selectionSessions.attachSnapshot(entry.token, {
      selectionSnapshot: { snapshot_id: 'acceptance-read-only-1', context: { app: 'Fixture document', content: 'Recorded read-only material' } },
      captureSummary: { app: 'Fixture document', label: '实时任务验收材料' },
    });
    const requestId = main.selectionSessions.startRequest(entry.token);
    assert.ok(requestId);
    main.setActiveToken(entry.token);
    let killRequests = 0;
    main.activeSessionChildren.set(entry.token, { killed: false, kill() { killRequests++; } });
    const question = '概括这份材料，并解释核对过程。';
    main.pendingQuestions.set(entry.token, question);
    main.beginStageLiveTurn(entry.token, { command: question });
    const conversationId = main.stageLiveTurns.get(entry.token).conversationId;
    report.conversationId = conversationId;
    report.requestId = requestId;
    stage.webContents.send('stage:show', {
      selectionSessionToken: entry.token, taskId: entry.taskId, groundingReady: true,
      targetAppLabel: '实时任务验收材料', targetGeometryKind: 'pointer_only',
      pointer: { x: 420, y: 200 }, target: { x: 80, y: 100, width: 400, height: 280 },
      eventSequence: [
        { type: 'FREEZE' }, { type: 'OPEN_CAPSULE', mode: 'text' }, { type: 'SUBMIT', command: question },
      ],
    });
    await waitFor('Stage processing turn', () => evaluate(stage, `document.querySelector('.thread-turn[data-status="pending"]') !== null`));
    await waitFor('Conversation sidebar row', () => evaluate(studio, `Boolean(document.querySelector('[data-open=${JSON.stringify(conversationId)}]'))`));
    await evaluate(studio, `document.querySelector('[data-open=${JSON.stringify(conversationId)}]').click(); true`);
    await waitFor('Studio live turn', () => evaluate(studio, `Boolean(document.querySelector('.mp-chat-flow-item .mp-chat-live-turn, .mp-chat-flow-item.mp-chat-live-turn'))`));
    const emit = record => main.appendStageLiveProgress(entry.token, record);
    const chunk = (phase, text) => emit({ phase, fields: { b64: Buffer.from(text).toString('base64') } });
    emit({ phase: 'model_request', fields: { turn: '1' } });
    emit({ phase: 'tool_call', fields: { id: 'fixture-read-1', name: 'Read', args: '{"path":"acceptance-notes.txt"}' } });
    chunk('reasoning_chunk', '先核对材料中的日期和任务归属。');
    chunk('answer_chunk', '材料显示：');
    await waitFor('both receive first chunks', async () => (await Promise.all([stage, studio].map(window => evaluate(window,
      `document.querySelector('.mp-chat-stream-live')?.textContent === '材料显示：' && document.querySelector('.mp-chat-think-body')?.textContent.includes('核对材料')`)))).every(Boolean));
    for (const window of [stage, studio]) await evaluate(window, `
      window.__liveNodes = { answer: document.querySelector('.mp-chat-stream-live'), think: document.querySelector('.mp-chat-think'), body: document.querySelector('.mp-chat-think-body') };
      document.querySelector('.mp-chat-think .mp-chat-row').click();
      true;
    `);
    emit({ phase: 'tool_result', fields: { id: 'fixture-read-1', name: 'Read', args: '{"path":"acceptance-notes.txt"}', state: 'ok', result: '日期：2026-09-18；归属：产品团队。', backend: 'recorded.fixture.read_only', latency_ms: '12' } });
    chunk('reasoning_chunk', '\n日期一致，继续整理结论并保留引用。');
    chunk('answer_chunk', '项目负责人已确认当前范围。');
    await waitFor('both receive second chunks', async () => (await Promise.all([stage, studio].map(window => evaluate(window,
      `document.querySelector('.mp-chat-stream-live')?.textContent === '材料显示：项目负责人已确认当前范围。'`)))).every(Boolean));
    const snapshots = await Promise.all([stage, studio].map(window => evaluate(window, `({
      answer: document.querySelector('.mp-chat-stream-live').textContent,
      thinking: document.querySelector('.mp-chat-think-body').textContent,
      status: document.querySelector('.mp-chat-turn-status-label').textContent,
      statusMeta: document.querySelector('.mp-chat-turn-status-meta').textContent,
      sharedSpark: Boolean(document.querySelector('.mp-chat-thinking-mark svg')),
      stableAnswer: window.__liveNodes.answer === document.querySelector('.mp-chat-stream-live'),
      stableThink: window.__liveNodes.think === document.querySelector('.mp-chat-think'),
      stableThinkBody: window.__liveNodes.body === document.querySelector('.mp-chat-think-body'),
      thinkOpen: document.querySelector('.mp-chat-think').dataset.open === 'true',
      toolResult: document.querySelector('.mp-chat-tool').textContent.includes('产品团队'),
      visible: document.querySelector('.mp-chat-stream-live').getBoundingClientRect().height > 0,
    })`)));
    assert.deepEqual(snapshots[0], snapshots[1]);
    for (const flag of ['stableAnswer', 'stableThink', 'stableThinkBody', 'thinkOpen', 'toolResult', 'visible', 'sharedSpark']) assert.equal(snapshots[0][flag], true, flag);
    report.checks.live = snapshots;
    emit({ phase: 'tool_result', fields: { id: 'fixture-edit-failed', name: 'Edit', args: JSON.stringify({ file_path: 'acceptance-notes.txt', old_string: 'Original line', new_string: 'Revised line\nWith evidence' }), state: 'error', result: 'The selected original text was not found.\nRecorded detail: the source changed before this attempted edit.' } });
    await waitFor('both receive failed Edit diff', async () => (await Promise.all([stage, studio].map(window => evaluate(window, `Boolean(document.querySelector('.mp-chat-tool[data-state="error"] .mp-chat-diff-stat'))`)))).every(Boolean));
    for (const window of [stage, studio]) {
      await evaluate(window, `document.querySelector('.mp-chat-tool[data-state="error"] .mp-chat-row').click(); true`);
      assert.equal(await evaluate(window, `document.querySelector('.mp-chat-tool[data-state="error"] .mp-chat-diff-line[data-kind="del"]')?.textContent.includes('Original line') && document.querySelector('.mp-chat-tool[data-state="error"] .mp-chat-tool-output')?.getBoundingClientRect().height>0`), true);
    }
    report.checks.failedEdit = { headerDiffCounts: true, expandedDiff: true, fullErrorVisible: true, bothSurfaces: true };
    const stageRect = await evaluate(stage, `(() => { const r=document.getElementById('stage-thread').getBoundingClientRect(); return {x:Math.floor(r.x),y:Math.floor(r.y),width:Math.ceil(r.width),height:Math.ceil(r.height)} })()`);
    await screenshot(stage, 'stage-midrun', stageRect);
    await screenshot(studio, 'studio-midrun');
    const closePoint = await evaluate(stage, `(() => { const r=document.getElementById('thread-close').getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)} })()`);
    stage.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...closePoint });
    stage.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...closePoint });
    await waitFor('actual close click detaches surface', () => main.selectionSessions.get(entry.token)?.stageAttached === false);
    await waitFor('Stage hide finishes', () => evaluate(stage, `document.getElementById('stage').hidden === true`));
    assert.equal(main.selectionSessions.isCurrentRequest(entry.token, requestId), true);
    assert.equal(killRequests, 0);
    const showsAfterClose = visibilityRequests;
    chunk('answer_chunk', '\n小窗关闭后，任务继续完成。');
    await waitFor('GUI continues after close', () => evaluate(studio, `document.querySelector('.mp-chat-stream-live')?.textContent.includes('小窗关闭后') === true`));
    assert.equal(visibilityRequests, showsAfterClose);
    assert.equal(await evaluate(stage, `document.getElementById('stage').hidden`), true);
    const finalAnswer = '最终答案：项目负责人已确认当前范围，日期为 2026-09-18。小窗关闭后任务仍已完成。'
      + `\n\n![HTTPS fixture](https://acceptance.invalid/fixture.png)\n![HTTP fixture](http://acceptance.invalid/fixture.png)\n![Local fixture](<${IMAGE_FILE}>)\n![Data fixture](data:image/png;base64,${PNG_BASE64})`;
    const parsed = {
      ok: true, answer: finalAnswer, thinking: snapshots[0].thinking,
      agentSessionId: entry.taskId, usedBackend: 'recorded.fixture.read_only', timingMs: 1234,
      trajectory: [{ kind: 'tool', name: 'Read', callId: 'fixture-read-1', text: '{"path":"acceptance-notes.txt"}', result: '日期：2026-09-18；归属：产品团队。', state: 'done' }],
    };
    main.selectionSessions.finishRequest(entry.token, requestId);
    main.activeSessionChildren.delete(entry.token);
    const finalEvent = main.stageEventFromBridge(parsed);
    main.updateStage({ selectionSessionToken: entry.token, event: finalEvent });
    const finalVisibleText = finalAnswer.split('\n')[0];
    await waitFor('final answer appears without manual reopen', () => evaluate(studio, `document.querySelector('#stream')?.textContent.includes(${JSON.stringify(finalVisibleText)}) === true`));
    const finalState = await evaluate(studio, `({
      finalVisible: document.querySelector('#stream').textContent.includes(${JSON.stringify(finalVisibleText)}),
      streamingNodes: document.querySelectorAll('.mp-chat-stream-live').length,
      questionCount: [...document.querySelectorAll('.mp-chat-user')].filter(n => n.textContent.includes(${JSON.stringify(question)})).length,
      busy: document.getElementById('composer-form').getAttribute('aria-busy'),
    })`);
    assert.equal(finalState.finalVisible, true); assert.equal(finalState.streamingNodes, 0);
    assert.equal(finalState.questionCount, 1); assert.equal(finalState.busy, null);
    assert.equal(main.stageLiveTurns.has(entry.token), false);
    assert.equal(visibilityRequests, showsAfterClose);
    assert.equal(await evaluate(stage, `document.getElementById('stage').hidden`), true);
    main.flush();
    report.checks.close = { detached: true, requestSurvived: true, killRequests, latePatchDidNotReopen: true };
    report.checks.final = finalState;
    report.checks.persistedAnswer = main.conversations().get(conversationId).turns[0].answer;
    await waitFor('all four actual image sources decode', () => evaluate(studio, `document.querySelectorAll('#stream .mp-chat-image').length===4 && [...document.querySelectorAll('#stream .mp-chat-image')].every(img=>img.complete&&img.naturalWidth>0)`));
    report.checks.markdownImages = await evaluate(studio, `([...document.querySelectorAll('#stream .mp-chat-image')].map(img=>({alt:img.alt,source:img.src.split(':')[0],naturalWidth:img.naturalWidth})))`);
    await screenshot(studio, 'studio-completed-after-stage-close');
    await evaluate(studio, `refreshComposerSuggestion([{question:'Fixture question',answer:'Fixture answer'}],{}).then(()=>true)`);
    const turnsBeforeSuggestion = main.conversations().get(conversationId).turns.length;
    await evaluate(studio, `document.querySelector('#composer-form textarea').focus(); true`);
    studio.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
    studio.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
    await waitFor('Tab accepts editable suggestion', () => evaluate(studio, `document.querySelector('#composer-form textarea').value==='把这份结论整理为可编辑笔记。'`));
    assert.equal(main.conversations().get(conversationId).turns.length, turnsBeforeSuggestion);
    await screenshot(studio, 'studio-tab-suggestion');
    await evaluate(studio, `(() => {const ta=document.querySelector('#composer-form textarea');ta.value=Array.from({length:45},(_,i)=>'Long editable line '+i).join(String.fromCharCode(10));ta.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    const longComposer = await evaluate(studio, `(() => {const ta=document.querySelector('#composer-form textarea');return {height:ta.getBoundingClientRect().height,maxHeight:parseFloat(getComputedStyle(ta).maxHeight),scrollHeight:ta.scrollHeight,clientHeight:ta.clientHeight};})()`);
    assert.ok(longComposer.height > 336 && longComposer.height <= longComposer.maxHeight + 1 && longComposer.scrollHeight > longComposer.clientHeight);
    report.checks.composer = { tabAcceptsEditableText: true, noSubmission: true, longComposer };
    await screenshot(studio, 'studio-long-composer');
    await evaluate(studio, `(() => {const ta=document.querySelector('#composer-form textarea');ta.value='';ta.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    const approvalRequestId = main.selectionSessions.startRequest(entry.token);
    assert.ok(approvalRequestId);
    main.pendingQuestions.set(entry.token, '把结论保存为笔记。');
    main.beginStageLiveTurn(entry.token, { command: '把结论保存为笔记。' });
    assert.equal(main.stageLiveTurns.get(entry.token).conversationId, conversationId);
    await waitFor('follow-up starts in current GUI', () => evaluate(studio, `document.querySelectorAll('.mp-chat-live-turn').length === 1`));
    main.selectionSessions.finishRequest(entry.token, approvalRequestId);
    main.updateStage({ selectionSessionToken: entry.token, event: main.stageEventFromBridge({
      ok: true, answer: '保存笔记前需要你的确认。', agentSessionId: entry.taskId,
      usedBackend: 'recorded.fixture.read_only', timingMs: 18,
      pendingInput: { kind: 'permission', tool: 'write_file', prefix: 'notes', question: '允许保存这份笔记吗？' },
      hasPendingWork: true,
    }) });
    await waitFor('external pending permission appears without reopening', () => evaluate(studio, `
      document.getElementById('composer-permission-ask')?.hidden === false
      && document.getElementById('composer-permission-ask')?.dataset.mode === 'permission'
      && document.getElementById('composer-permission-ask')?.textContent.includes('允许保存这份笔记吗？')
    `));
    report.checks.pendingPermission = await evaluate(studio, `({
      question: document.querySelector('.mpw-perm-ask-question').textContent,
      buttonCount: document.querySelectorAll('.mpw-perm-ask-btn').length,
      streamingNodes: document.querySelectorAll('.mp-chat-stream-live').length,
      busy: document.getElementById('composer-form').getAttribute('aria-busy'),
    })`);
    assert.equal(report.checks.pendingPermission.buttonCount, 3);
    assert.equal(report.checks.pendingPermission.busy, null);
    assert.equal(visibilityRequests, showsAfterClose);
    await screenshot(studio, 'studio-permission-after-stage-close');
    const stopEntry = main.selectionSessions.create({ reason: 'acceptance-explicit-stop' });
    main.selectionSessions.attachSnapshot(stopEntry.token, {
      selectionSnapshot: { snapshot_id: 'acceptance-stop-1', context: { app: 'Fixture document', content: 'Recorded stop target' } },
      captureSummary: { app: 'Fixture document', label: '显式停止验收' },
    });
    const stopRequestId = main.selectionSessions.startRequest(stopEntry.token);
    assert.ok(stopRequestId);
    main.activeSessionChildren.set(stopEntry.token, { killed: false, kill() {} });
    main.pendingQuestions.set(stopEntry.token, '验收显式停止按钮。');
    main.beginStageLiveTurn(stopEntry.token, { command: '验收显式停止按钮。' });
    const stopConversationId = main.stageLiveTurns.get(stopEntry.token).conversationId;
    await waitFor('stop fixture sidebar row', () => evaluate(studio, `Boolean(document.querySelector('[data-open=${JSON.stringify(stopConversationId)}]'))`));
    await evaluate(studio, `document.querySelector('[data-open=${JSON.stringify(stopConversationId)}]').click(); true`);
    await waitFor('stop fixture GUI running', () => evaluate(studio, `document.getElementById('composer-form').getAttribute('aria-busy') === 'true'`));
    assert.equal(main.stageLiveTurns.get(stopEntry.token).progress.requestId, stopRequestId);
    const stopPoint = await evaluate(studio, `(() => {const r=document.querySelector('#composer-form button[type="submit"]').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
    studio.webContents.sendInputEvent({ type: 'mouseMove', ...stopPoint });
    studio.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...stopPoint });
    studio.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...stopPoint });
    await waitFor('GUI Stop reaches its selection child', () => !main.activeSessionChildren.has(stopEntry.token), 3000);
    assert.equal(await evaluate(studio, `document.querySelector('[data-stop-requested="true"]') !== null`), true);
    report.checks.explicitGuiStop = { requestId: stopRequestId, routedToSelectionChild: true };
    main.flush();
    assert.deepEqual(report.consoleErrors, []);
    report.ok = true;
  } catch (error) {
    report.ok = false;
    report.error = error.stack || String(error);
    for (const [name, window] of [['stage-failure', stage], ['studio-failure', studio]]) {
      if (window && !window.isDestroyed()) {
        try { await screenshot(window, name); } catch { /* report original failure */ }
      }
    }
  } finally {
    report.timingMs = Date.now() - STARTED_AT;
    fs.writeFileSync(path.join(OUTPUT, 'acceptance.json'), JSON.stringify(report, null, 2) + '\n');
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    app.exit(report.ok ? 0 : 1);
  }
});
