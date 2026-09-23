'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const output = path.resolve('data/runtime/stage-input-20260921');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'profile'));
app.disableHardwareAcceleration();
const deadline = setTimeout(() => app.exit(1), 30000);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1280, height: 1000, show: false,
    webPreferences: { offscreen: true, sandbox: false, contextIsolation: false,
      preload: path.resolve('scripts/probe_stage_input_preload.cjs') } });
  const failures = [];
  win.webContents.on('console-message', event => {
    if (event.level === 'error') process.stderr.write(`${event.message} (${event.sourceId}:${event.lineNumber})\n`);
  });
  const check = (value, message) => { if (!value) failures.push(message); };
  const evaluate = source => win.webContents.executeJavaScript(source);
  const click = async selector => {
    const point = await evaluate(`(async () => {
      await Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity)
        .map(animation => animation.finished.catch(() => {})));
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node) throw new Error('Missing control: ' + ${JSON.stringify(selector)});
      node.scrollIntoView({ block: 'center', behavior: 'instant' });
      await new Promise(resolve => requestAnimationFrame(resolve));
      const box = node.getBoundingClientRect();
      return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) }; })()`);
    win.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 });
    await evaluate('new Promise(resolve => setTimeout(resolve, 30))');
  };
  try {
    await win.loadFile(path.resolve('build/electron/renderer/stage.html'));
    await evaluate(`window.__showRequest = (token, pendingInput) => __stageProbe.show({
      selectionSessionToken: token, groundingReady: true,
      target: { x: 180, y: 150, width: 120, height: 40 },
      eventSequence: [{ type: 'FREEZE' }, { type: 'OPEN_CAPSULE', mode: 'text' },
        { type: 'SUBMIT', command: '原任务' }, { type: 'RESULT', result: { ok: true,
          awaitingUserInput: true, pendingInput, answer: '需要你的决定' } }]
    });
    __showRequest('selection-one', { requestId: 'ask-one', questions: [
      { question: '选择范围', options: [{ label: 'A' }, { label: 'B' }] },
      { question: '补充要求', options: [{ label: '简短' }, { label: '详细' }] }
    ] });`);
    await click('#stage-decision [data-option-index="1"]');
    await click('#stage-decision [data-question-next]');
    await click('#stage-decision textarea');
    await win.webContents.insertText('保留全部来源');
    await click('#stage-decision [data-question-submit]');
    let sent = await evaluate('__stageProbe.calls[0]');
    check(sent?.response?.answers?.['选择范围'] === 'B', 'first question answer was lost');
    check(sent?.response?.answers?.['补充要求'] === '保留全部来源', 'custom answer was lost');
    check(await evaluate('document.querySelectorAll(".thread-turn").length === 1'), 'response appended a new turn');
    await evaluate(`__stageProbe.resolve(0, { ok: false, accepted: false, error: '保存失败，请重试' });`);
    await evaluate('new Promise(resolve => setTimeout(resolve, 30))');
    check(await evaluate('document.querySelector("#stage-decision textarea").value === "保留全部来源"'), 'retry lost custom answer');
    check(await evaluate('document.querySelector(".thread-turn").dataset.status === "awaiting"'), 'unaccepted failure did not restore waiting turn');
    await click('#stage-decision [data-question-submit]');
    await evaluate(`__stageProbe.progress({ requestId: __stageProbe.calls[1].requestToken,
      record: { phase: 'user_input_accepted', fields: { inputRequestId: 'ask-one' } } });`);
    check(await evaluate('document.getElementById("stage-decision").hidden'), 'accepted event did not remove the question');
    await evaluate(`__stageProbe.reject(1, 'provider disconnected');`);
    await evaluate('new Promise(resolve => setTimeout(resolve, 30))');
    check(await evaluate('document.querySelector(".thread-turn").dataset.status === "failed" && document.getElementById("stage-decision").hidden'), 'provider failure revived accepted question');

    await evaluate(`__showRequest('selection-old', { requestId: 'permission-old', kind: 'permission', tool: 'Bash', question: '允许运行?' });`);
    await click('#stage-decision [data-decision="once"]');
    sent = await evaluate('__stageProbe.calls[2]');
    check(sent?.response?.decision === 'once', 'permission is not a structured response');
    await evaluate(`__showRequest('selection-new', { requestId: 'permission-new', kind: 'permission', tool: 'Write', question: '允许写入?' });
      __stageProbe.resolve(2, { ok: true, accepted: true, answer: '旧结果' });`);
    await evaluate('new Promise(resolve => setTimeout(resolve, 30))');
    check(await evaluate('document.getElementById("stage-decision").textContent.includes("允许写入") && document.querySelector(".thread-turn").dataset.status === "awaiting"'), 'late result settled the new selection');
    await click('#stage-decision [data-decision="deny"]');
    await evaluate(`__stageProbe.resolve(3, { ok: true, accepted: true, answer: '草稿已准备',
      artifacts: [{ artifactId: 'draft-one', name: '工作摘要', kind: 'markdown', state: 'generated', revision: 1 }] });`);
    await evaluate('new Promise(resolve => setTimeout(resolve, 30))');
    await click('[data-artifact-id="draft-one"]');
    check(await evaluate('__stageProbe.calls.at(-1).openArtifact?.artifactId === "draft-one" && __stageProbe.calls.at(-1).openArtifact?.selectionSessionToken === "selection-new"'), 'artifact click did not open the real session artifact API');
    await evaluate(`__showRequest('selection-wrap', { requestId: 'daily-scope', kind: 'permission', harnessPermission: true, tool: 'DailyWrap.read',
      question: 'Allow DailyWrap.read?', options: ['仅这一次允许', '拒绝'],
      action: { tool: 'DailyWrap.read', arguments: { from_ms: 1789228800000, to_ms: 1789315200000,
        conversation_ids: [], limit: 12 } } });`);
    await evaluate('new Promise(resolve => setTimeout(resolve, 50))');
    check(await evaluate('document.querySelector("#stage-decision [data-decision=once]")?.disabled === true'),
      'DailyWrap approved the model history scope before the user selected sources');
    await click('#stage-decision [data-history-source-mode="selected"]');
    await click('#stage-decision [data-history-source-id="selected-task"]');
    await click('#stage-decision [data-decision="once"]');
    sent = await evaluate('__stageProbe.calls.at(-1)');
    check(sent?.response?.actionArguments?.conversation_ids?.join(',') === 'selected-task'
      && sent?.response?.actionArguments?.limit === 12,
    'Stage DailyWrap did not send the selected history source and fixed result limit');
    check(await evaluate('__stageProbe.calls.every(call => !call.unexpectedPrompt)'), 'a response went through submitSelectionCommand');
    const witness = { failures, calls: await evaluate('__stageProbe.calls'), turns: await evaluate('document.querySelectorAll(".thread-turn").length') };
    fs.writeFileSync(path.join(output, 'witness.json'), JSON.stringify(witness, null, 2));
    fs.writeFileSync(path.join(output, 'stage.png'), (await win.webContents.capturePage()).toPNG());
    process.stdout.write(JSON.stringify(witness) + '\n');
    app.exit(failures.length ? 1 : 0);
  } catch (error) {
    process.stderr.write(String(error.stack || error) + '\n');
    process.stderr.write(JSON.stringify(await evaluate(`({ calls: __stageProbe.calls,
      decision: document.getElementById('stage-decision').textContent,
      custom: document.querySelector('#stage-decision textarea')?.value,
      state: document.getElementById('stage').dataset.state })`)) + '\n');
    fs.writeFileSync(path.join(output, 'failure.png'), (await win.webContents.capturePage()).toPNG());
    app.exit(1);
  }
  finally { clearTimeout(deadline); }
});
