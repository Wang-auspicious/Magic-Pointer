'use strict';
// Offline events exercise the shipped renderer in real Chromium; no model claims.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const output = path.resolve('data/runtime/subagent-streaming-20260920');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'profile'));
app.disableHardwareAcceleration();
const deadline = setTimeout(() => app.exit(1), 25000);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1240, height: 850, show: false, webPreferences: {
    offscreen: true, sandbox: false, contextIsolation: true,
    preload: path.resolve('scripts/probe_studio_claude_preload.js'),
    additionalArguments: ['--mp-probe-theme=light', '--mp-probe-state=landing'],
  } });
  try {
    await win.loadFile(path.resolve('build/electron/renderer/studio.html'));
    await win.webContents.executeJavaScript('document.fonts.ready');
    const witness = await win.webContents.executeJavaScript(`(async () => {
      const failures = [];
      const check = (ok, message) => { if (!ok) failures.push(message); };
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
      show('chat');
      const host = document.createElement('div');
      document.getElementById('studio-home').hidden = true;
      const flow = document.querySelector('.dsh-flow') || document.querySelector('.dshw-scrollbody');
      flow.appendChild(host);
      let paints = 0;
      const renderer = DshChat.createLiveTurn(host);
      pendingConversation = { body: host, records: new Map(), streamText: '', reasoningText: '',
        transcript: ConversationControl.createTranscript(), renderer: { update: value => { paints++; renderer.update(value); } } };
      const event = (phase, fields) => renderConversationProgress({ phase, fields });
      const blob = obj => btoa(unescape(encodeURIComponent(JSON.stringify(obj))));
      event('model_request', { turn: '1' });
      for (let i = 0; i < 100; i++) event('reasoning_chunk', { b64: btoa('Inspect sources. ') });
      await wait(230);
      check(paints <= 4, '100 chunks caused ' + paints + ' paints');
      check(host.querySelector('.dsh-think-body').textContent === 'Inspect sources. '.repeat(100), 'batched text lost chunks');
      event('model_response', {});
      event('tool_call', { id: 'parent-a', name: 'Agent', args: '{"task":"Inspect runtime"}' });
      event('tool_call', { id: 'parent-b', name: 'Agent', args: '{"task":"Inspect renderer"}' });
      const a = { id: 'child-a', parentCallId: 'parent-a', description: 'Inspect runtime', status: 'running', phase: 'thinking',
        reasoning: 'Reading the event pipeline', answer: '', stepCount: 1, currentTool: '', elapsedMs: 4200,
        steps: [{ index: 1, callId: 'read-a', tool: 'Read', status: 'completed', input: 'subagent.py', output: 'event sink found', usedBackend: 'filesystem', latencyMs: 12 }] };
      event('subagent', { b64: blob(a) });
      event('subagent', { b64: blob({ ...a, id: 'child-b', parentCallId: 'parent-b', description: 'Inspect renderer', reasoning: 'Checking DOM stability' }) });
      setInspector(true, 'tasks');
      await wait(230);
      const row = document.querySelector('[data-task-id="child-a"]');
      check(!!row, 'child row missing');
      row.open = true;
      const body = row.querySelector('.mp-subagent-body');
      const before = row;
      a.reasoning += '\\nParent ID is preserved';
      event('subagent', { b64: blob(a) });
      await wait(230);
      const after = document.querySelector('[data-task-id="child-a"]');
      check(after === before && after.open, 'child update rebuilt or closed expanded row');
      check(after.querySelector('.mp-subagent-body') === body, 'child body replaced');
      check(after.textContent.includes('Parent ID is preserved'), 'child thinking is absent');
      check(after.textContent.includes('event sink found'), 'tool output is absent');
      check(host.textContent.includes('Parent ID is preserved') && host.textContent.includes('Checking DOM stability'), 'parent rows lack independent child heartbeats');
      pendingConversation = null;
      DshChat.bindDelegation(document);
      const continuityHost = document.createElement('div');
      flow.appendChild(continuityHost);
      const continuity = DshChat.createLiveTurn(continuityHost, 'continuity#0');
      const trajectory = [
        { kind: 'tool', callId: 'read-1', name: 'Read', text: '{"path":"one.md"}', result: 'one', state: 'done' },
        { kind: 'message', turn: 2, reasoning: 'Compare the second source.', state: 'done' },
        { kind: 'tool', callId: 'read-2', name: 'Read', text: '{"path":"two.md"}', state: 'running' },
      ];
      continuity.update({ trajectory });
      const thoughtId = continuityHost.querySelector('.dsh-think').dataset.rowId;
      continuityHost.querySelector('.dsh-think .dsh-row').click();
      continuityHost.querySelector('.dsh-tool-group-header').click();
      await wait(0); // Native details.toggle must reach the delegated store.
      trajectory[2].result = 'two';
      trajectory[2].state = 'done';
      continuity.update({ trajectory });
      continuity.finish({ conversationId: 'continuity', turnIndex: 0, trajectory, answer: 'Compared.' });
      const settledThought = continuityHost.querySelector('.dsh-think');
      check(settledThought.dataset.rowId === thoughtId && settledThought.dataset.open === 'true', 'folding the transcript lost the opened thought');
      check(continuityHost.querySelector('.dsh-tool-group').open, 'completion closed the opened tool group');
      const otherHost = document.createElement('div');
      flow.appendChild(otherHost);
      DshChat.createConversationView(otherHost).update({ id: 'other-session', turns: [{ trajectory, answer: 'Other answer.' }] });
      check(!otherHost.querySelector('.dsh-tool-group').open, 'another session inherited tool expansion');
      const standalone = DshChat.createLiveTurn(otherHost);
      standalone.update({ thinking: 'Inspect selection.' });
      otherHost.querySelector('.dsh-think .dsh-row').click();
      standalone.finish({ thinking: 'Inspect selection.', answer: 'Selected answer.' });
      check(otherHost.querySelector('.dsh-think').dataset.open === 'true', 'standalone Stage completion lost expansion');
      continuityHost.remove();
      otherHost.remove();
      return { paints, children: document.querySelectorAll('.mp-subagent-task').length, transcriptContinuity: true, failures };
    })()`);
    fs.writeFileSync(path.join(output, 'witness.json'), JSON.stringify(witness, null, 2));
    fs.writeFileSync(path.join(output, 'streaming.png'), (await win.webContents.capturePage()).toPNG());
    console.log(JSON.stringify(witness));
    clearTimeout(deadline);
    app.exit(witness.failures.length ? 1 : 0);
  } catch (error) { console.error(error); clearTimeout(deadline); app.exit(1); }
});
