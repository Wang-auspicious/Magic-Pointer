'use strict';
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
    preload: path.resolve('scripts/probe_studio_layout_preload.js'),
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
      activeConversationId = 'studio-streaming-probe';
      const host = document.createElement('div');
      document.getElementById('studio-home').hidden = true;
      const flow = document.querySelector('.mp-chat-flow') || document.querySelector('.mpw-scrollbody');
      flow.appendChild(host);
      let paints = 0;
      const renderer = ChatView.createLiveTurn(host, 'studio-streaming#0', { taskPanel: true });
      ChatView.bindDelegation(host);
      pendingConversation = { body: host, records: new Map(), streamText: '', reasoningText: '',
        transcript: ConversationControl.createTranscript(), renderer: { update: value => { paints++; renderer.update(value); } } };
      const event = (phase, fields) => renderConversationProgress({ phase, fields });
      const blob = obj => btoa(unescape(encodeURIComponent(JSON.stringify(obj))));
      event('model_request', { turn: '1' });
      for (let i = 0; i < 100; i++) event('reasoning_chunk', { b64: btoa('Inspect sources. ') });
      await wait(230);
      check(paints <= 4, '100 chunks caused ' + paints + ' paints');
      check(host.querySelector('.mp-chat-think-body').textContent === 'Inspect sources. '.repeat(100), 'batched text lost chunks');
      event('model_response', {});
      const todos = [{ content: 'Inspect task sources', status: 'in_progress' }, { content: 'Verify the delivered result', status: 'pending' }];
      event('tool_call', { id: 'plan-probe', name: 'Todo', args: JSON.stringify({ todos }) });
      event('tool_result', { id: 'plan-probe', name: 'Todo', args: JSON.stringify({ todos }), result: JSON.stringify({ plan: todos }), state: 'ok' });
      event('tool_call', { id: 'parent-a', name: 'Agent', args: '{"task":"Inspect runtime"}' });
      event('tool_call', { id: 'parent-b', name: 'Agent', args: '{"task":"Inspect renderer"}' });
      const a = { id: 'child-a', parentCallId: 'parent-a', description: 'Inspect runtime', status: 'running', phase: 'thinking',
        reasoning: 'Reading the event pipeline', answer: '', stepCount: 1, currentTool: '', elapsedMs: 4200,
        steps: [{ index: 1, callId: 'read-a', tool: 'Read', status: 'completed', input: 'subagent.py', output: 'event sink found', usedBackend: 'filesystem', latencyMs: 12 }] };
      event('subagent', { b64: blob(a) });
      event('subagent', { b64: blob({ ...a, id: 'child-b', parentCallId: 'parent-b', description: 'Inspect renderer', reasoning: 'Checking DOM stability' }) });
      await wait(230);
      const entry = host.querySelector('[data-subagent-parent-call-id="parent-a"]');
      check(!!entry, 'compact child task entry missing');
      entry.click();
      await wait(60);
      check(activeInspectorTab === 'tasks' && shell.dataset.inspector === 'open', 'child entry did not open the Tasks panel');
      check(!host.querySelector('.mp-chat-todo-list') && !host.textContent.includes('Inspect task sources'), 'Studio body repeats the task plan');
      check(document.getElementById('project-plan').textContent.includes('Inspect task sources'), 'the only task plan is missing from the right rail');
      const row = document.querySelector('[data-task-id="child-a"]');
      check(!!row, 'child row missing');
      const body = row.querySelector('.mp-subagent-body');
      check(body.hidden, 'background task transcript opens only through View transcript');
      const transcriptButton = row.querySelector('.mp-subagent-transcript');
      if (!transcriptButton) throw new Error('background task needs a View transcript action');
      const compactCard = { height: row.getBoundingClientRect().height, width: row.getBoundingClientRect().width,
        padding: getComputedStyle(row).padding, title: getComputedStyle(row.querySelector('strong')).fontSize,
        metadata: getComputedStyle(row.querySelector('.mp-subagent-meta')).fontSize };
      check(compactCard.width === 394, 'Background tasks card must have the reference 10px panel inset');
      check(compactCard.height === 77, 'Background tasks card height differs from the supplied 77px reference');
      check(row.getBoundingClientRect().height <= 112, 'running task summary is not compact');
      check(row.querySelector('.mp-subagent-meta').textContent.includes('Agent'), 'task kind is missing');
      check(row.querySelector('.mp-subagent-stats').textContent.includes('1 tool use'), 'real tool use count is missing');
      const stopRequests = [];
      const originalStop = Data.stopSubagent;
      Data.stopSubagent = async request => {
        stopRequests.push(request);
        return stopRequests.length === 1 ? { ok: false, error: 'Please retry stopping this task.' } : { ok: true };
      };
      const stop = row.querySelector('.mp-subagent-stop');
      check(!stop.hidden, 'a running child with a conversation has no Stop action');
      stop.click();
      await wait(0);
      check(!stop.disabled && !row.querySelector('.mp-subagent-stop-error').hidden, 'a failed stop cannot be retried');
      stop.click();
      await wait(0);
      check(stop.disabled && row.dataset.status === 'running', 'accepted stop must await the real stopped progress');
      check(row.querySelector('.mp-subagent-state').textContent === 'Stopping', 'accepted stop needs visible pending feedback');
      check(stopRequests.length === 2 && stopRequests.every(request => request.conversationId === 'studio-streaming-probe' && request.subagentId === 'child-a'), 'Stop targeted the wrong task');
      check(document.querySelector('[data-task-id="child-b"]').dataset.status === 'running', 'stopping one child changed its sibling');
      Data.stopSubagent = originalStop;
      transcriptButton.click();
      check(!body.hidden, 'View transcript does not reveal child details');
      const before = row;
      a.reasoning += '\\nParent ID is preserved';
      event('subagent', { b64: blob(a) });
      await wait(230);
      const after = document.querySelector('[data-task-id="child-a"]');
      check(after === before && !body.hidden, 'child update rebuilt or closed expanded transcript');
      check(after.querySelector('.mp-subagent-state').textContent === 'Stopping', 'a running update cleared the pending stop feedback');
      check(after.querySelector('.mp-subagent-body') === body, 'child body replaced');
      check(after.textContent.includes('Parent ID is preserved'), 'child thinking is absent');
      check(after.textContent.includes('event sink found'), 'tool output is absent');
      check(!host.textContent.includes('Parent ID is preserved') && !host.textContent.includes('Checking DOM stability'), 'Studio body repeats the child transcript');
      check(!host.querySelector('.mp-chat-subagent-heartbeat'), 'Studio body retains a duplicate child heartbeat');
      a.status = 'completed'; a.phase = 'completed'; a.answer = 'Runtime verified.';
      event('subagent', { b64: blob(a) });
      event('tool_result', { id: 'parent-a', name: 'Agent', args: '{"task":"Inspect runtime"}', state: 'ok', result: '[subagent id=child-a status=completed steps=1] Runtime verified.' });
      await wait(230);
      const completed = document.querySelector('[data-task-id="child-a"]');
      check(completed === row && !body.hidden && completed.dataset.status === 'completed', 'completing a child lost its task row or transcript state');
      check(completed.closest('[data-task-section]').dataset.taskSection === 'Finished', 'completed child did not move to Finished');
      const finishedSection = completed.closest('[data-task-section]');
      check(finishedSection.querySelector('.mp-subagent-list').hidden, 'finished tasks must start folded');
      check(finishedSection.querySelector('.mp-subagent-finished-toggle').textContent.includes('Finished 1'), 'finished task count is missing');
      finishedSection.querySelector('.mp-subagent-finished-toggle').click();
      check(!finishedSection.querySelector('.mp-subagent-list').hidden, 'finished task toggle does not reveal the completed task');
      check(completed.textContent.includes('Runtime verified.'), 'child output did not arrive in the right panel');
      activeConversationTurns = [{ trajectory: pendingConversation.transcript.trajectory }];
      pendingConversation = null;
      renderer.finish({ trajectory: activeConversationTurns[0].trajectory, answer: 'Checks complete.' });
      finishedSection.querySelector('.mp-subagent-clear').click();
      renderProjectTasks();
      check(!document.querySelector('[data-task-id="child-a"]'), 'Clear did not dismiss finished tasks');
      check(currentSubagentTasks().some(task => task.id === 'child-a'), 'Clear deleted the task transcript');
      setInspector(false);
      host.querySelector('[data-subagent-parent-call-id="parent-a"]').click();
      await wait(60);
      check(activeInspectorTab === 'tasks' && shell.dataset.inspector === 'open', 'completed child entry no longer opens Tasks');
      setInspector(true, 'tasks');
      check(document.getElementById('inspector-title').textContent === 'Background tasks', 'reopening the same background panel overwrites its title');
      check(!!document.querySelector('[data-task-id="child-a"]'), 'a transcript entry cannot reveal a dismissed finished task');
      check(!host.querySelector('.mp-chat-todo-list') && !host.querySelector('.mp-chat-subagent-heartbeat'), 'completion restored duplicate task content');
      syncInspectorGeometry();
      const backgroundTurns = activeConversationTurns;
      activeConversationId = 'plan-only-probe';
      activeConversationTurns = [];
      renderProjectTasks();
      check(document.getElementById('inspector-title').textContent === 'Tasks', 'switching from background children to a plan retains the old panel title');
      check(document.getElementById('project-inspector').dataset.taskLayout === 'plan', 'a task without children retained the background layout');
      activeConversationId = 'studio-streaming-probe';
      activeConversationTurns = backgroundTurns;
      renderProjectTasks();
      const continuityHost = document.createElement('div');
      flow.appendChild(continuityHost);
      ChatView.bindDelegation(continuityHost);
      const continuity = ChatView.createLiveTurn(continuityHost, 'continuity#0');
      const trajectory = [
        { kind: 'tool', callId: 'read-1', name: 'Read', text: '{"path":"one.md"}', result: 'one', state: 'done' },
        { kind: 'message', turn: 2, reasoning: 'Compare the second source.', state: 'done' },
        { kind: 'tool', callId: 'read-2', name: 'Read', text: '{"path":"two.md"}', state: 'running' },
      ];
      continuity.update({ trajectory });
      const thoughtId = continuityHost.querySelector('.mp-chat-think').dataset.rowId;
      continuityHost.querySelector('.mp-chat-think .mp-chat-row').click();
      continuityHost.querySelector('.mp-chat-tool-group-header').click();
      await wait(0); // Native details.toggle must reach the delegated store.
      trajectory[2].result = 'two';
      trajectory[2].state = 'done';
      continuity.update({ trajectory });
      continuity.finish({ conversationId: 'continuity', turnIndex: 0, trajectory, answer: 'Compared.' });
      const settledThought = continuityHost.querySelector('.mp-chat-think');
      check(settledThought.dataset.rowId === thoughtId && settledThought.dataset.open === 'true', 'folding the transcript lost the opened thought');
      check(continuityHost.querySelector('.mp-chat-tool-group').open, 'completion closed the opened tool group');
      const mergeHost = document.createElement('div');
      flow.appendChild(mergeHost);
      ChatView.bindDelegation(mergeHost);
      const merged = ChatView.createLiveTurn(mergeHost, 'merge-later#0');
      merged.update({ trajectory });
      mergeHost.querySelectorAll('.mp-chat-tool-group-header')[1].click();
      await wait(0);
      check(!mergeHost.querySelector('.mp-chat-tool-group').open, 'merge fixture accidentally opened the first group');
      const mergedTurn = { conversationId: 'merge-later', turnIndex: 0, trajectory, answer: 'Merged.' };
      merged.finish(mergedTurn);
      check(mergeHost.querySelectorAll('.mp-chat-tool-group').length === 1 && mergeHost.querySelector('.mp-chat-tool-group').open,
        'completion hid the opened second group inside the merged group');
      check(mergeHost.querySelectorAll('.mp-chat-tool')[1].querySelector('.mp-chat-disclosure').dataset.open === 'true',
        'merging the second singleton group hid its visible result body');
      await wait(0);
      if (mergeHost.querySelector('.mp-chat-tool-group').open) mergeHost.querySelector('.mp-chat-tool-group-header').click();
      await wait(0);
      check(!mergeHost.querySelector('.mp-chat-tool-group').open, 'merged group did not close on click');
      merged.finish(mergedTurn);
      await wait(0);
      check(!mergeHost.querySelector('.mp-chat-tool-group').open, 'rebuilding a merged group undid the user collapse');
      const otherHost = document.createElement('div');
      flow.appendChild(otherHost);
      ChatView.bindDelegation(otherHost);
      ChatView.createConversationView(otherHost).update({ id: 'other-session', turns: [{ trajectory, answer: 'Other answer.' }] });
      check(!otherHost.querySelector('.mp-chat-tool-group').open, 'another session inherited tool expansion');
      const standalone = ChatView.createLiveTurn(otherHost);
      standalone.update({ thinking: 'Inspect selection.' });
      otherHost.querySelector('.mp-chat-think .mp-chat-row').click();
      standalone.finish({ thinking: 'Inspect selection.', answer: 'Selected answer.' });
      check(otherHost.querySelector('.mp-chat-think').dataset.open === 'true', 'standalone Stage completion lost expansion');
      continuityHost.remove();
      mergeHost.remove();
      otherHost.remove();
      return { paints, children: document.querySelectorAll('.mp-subagent-task').length, compactCard, stopRequests, transcriptContinuity: true, failures };
    })()`);
    fs.writeFileSync(path.join(output, 'witness.json'), JSON.stringify(witness, null, 2));
    fs.writeFileSync(path.join(output, 'streaming.png'), (await win.webContents.capturePage()).toPNG());
    console.log(JSON.stringify(witness));
    clearTimeout(deadline);
    app.exit(witness.failures.length ? 1 : 0);
  } catch (error) { console.error(error); clearTimeout(deadline); app.exit(1); }
});
