'use strict';
// Studio transcript polish: question/plan cards, run footer and turn rhythm.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const output = path.resolve('data/runtime/studio-turn-polish');
const buildRoot = path.resolve(process.env.MP_PROBE_BUILD_ROOT || 'build/electron');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'profile'));
app.disableHardwareAcceleration();
const deadline = setTimeout(() => app.exit(1), 30000);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1440, height: 900, show: false, webPreferences: {
    offscreen: true, sandbox: false, contextIsolation: true,
    preload: path.resolve('scripts/probe_studio_layout_preload.js'),
    additionalArguments: ['--mp-probe-theme=light', '--mp-probe-state=landing'],
  } });
  try {
    await win.loadFile(path.join(buildRoot, 'renderer', 'studio.html'));
    await win.webContents.executeJavaScript('document.fonts.ready');
    const failures = await win.webContents.executeJavaScript(`(async () => {
      const failures = [];
      const check = (ok, message) => { if (!ok) failures.push(message); };
      show('chat');
      document.getElementById('studio-home').hidden = true;
      const trajectory = [
        { kind: 'message', text: 'Reading the renderer first.' },
        { kind: 'tool', name: 'Read', callId: 'r1', state: 'done', text: JSON.stringify({ file_path: 'a.ts' }), result: 'ok', startedAt: 1000, completedAt: 1400 },
        { kind: 'tool', name: 'Bash', callId: 'b1', state: 'done', text: JSON.stringify({ command: 'npm test' }), result: 'ok', startedAt: 1400, completedAt: 9000 },
      ];
      const stored = { id: 'polish', title: 'Polish', turns: [
        { at: Date.now() - 1000, question: 'Check the renderer.', answer: 'Done.', trajectory, timingMs: 67000, modelUsage: { totalTokens: 1617 } },
      ] };
      Data.conversation = async id => id === stored.id ? structuredClone(stored) : null;
      Data.recovery = async () => ({ ok: true, pendingRecovery: [] });
      await openConversation(stored.id);

      const desktopRow = ChatView.toolRowModel('activate_window', JSON.stringify({ app: 'msedge' }), { text: '{"ok":true}' }, 'focus-edge');
      check(desktopRow.title.includes('切换') && desktopRow.summary.includes('msedge'), 'desktop tool row does not explain the action and target');
      const windowsRow = ChatView.toolRowModel('list_windows', '{}', { text: '{"value":"[]"}' }, 'windows');
      check(windowsRow.title.includes('窗口') && !windowsRow.summary.includes('{}'), 'window discovery is still an opaque Used/empty-JSON row');
      const navigationRow = ChatView.toolRowModel('Browser.navigate', JSON.stringify({ window_id: '42', url: 'https://github.com' }), { text: '{"ok":true}' }, 'nav');
      check(navigationRow.summary.includes('https://github.com'), 'browser navigation exposes only an opaque window number');
      const desktopFlow = document.createElement('div');
      desktopFlow.append(...ChatView.assistantTurnNode({ trajectory: [
        { kind: 'tool', name: 'Tools', callId: 'load', text: '{"names":["Browser.navigate"]}', result: '{}', state: 'done' },
        { kind: 'tool', name: 'Browser.navigate', callId: 'nav', text: '{"url":"https://github.com","window_id":"42"}', result: '{"ok":true}', state: 'done' },
      ], answer: 'Opened' }, 'desktop-summary'));
      check(desktopFlow.querySelector('.mp-chat-tool-group-title')?.textContent.includes('打开网页'), 'mixed tool-loading and desktop groups still say only Used tools');
      Data.recovery = async () => ({ ok: true, pendingRecovery: Array.from({ length: 8 }, (_, i) => ({
        operationId: 'recover-' + i, tool: 'activate_window', arguments: { app: 'msedge' },
        verificationCandidates: [{ tool: 'list_windows', callId: 'read-' + i, arguments: {}, result: JSON.stringify({ value: 'x'.repeat(12000) }) }],
      })) });
      await renderConversationRecovery(stored.id);
      const recovery = document.getElementById('conversation-recovery');
      check(!!recovery.closest('#inspector-activity'), 'recovery cards are still laid over the conversation instead of the execution sidebar');
      check(document.getElementById('stream').getBoundingClientRect().height > 450, 'recovery records consume the conversation viewport');
      check(![...recovery.querySelectorAll('details')].some(item => item.open), 'raw recovery details are expanded by default');
      setInspector(true, 'activity');
      check(document.documentElement.scrollWidth <= innerWidth + 1, 'long recovery JSON overflows the window');
      Data.recovery = async () => ({ ok: true, pendingRecovery: [] });
      await renderConversationRecovery(stored.id);
      check(recovery.hidden, 'resolved recovery records remain visible');
      setInspector(false);

      const meta = document.querySelector('#stream .mp-chat-run-meta');
      check(meta && meta.textContent.includes('1m 7s'), 'finished turn footer ignores the real turn duration: ' + meta?.textContent);

      const plain = document.createElement('div');
      document.querySelector('.mp-chat-flow').append(plain);
      ChatView.createLiveTurn(plain, 'plain#0').finish({ answer: 'A normal answer.', timingMs: 12500 });
      check(plain.querySelector('.mp-chat-run-meta')?.textContent.includes('13s'),
        'a completed answer without tools loses its recorded duration');
      plain.remove();

      const live = document.createElement('div');
      document.querySelector('.mp-chat-flow').append(live);
      const renderer = ChatView.createLiveTurn(live, 'live-status#0', { taskPanel: true });
      const messages = [{ kind: 'message', turn: 1, reasoning: 'Reading the current interface.', state: 'running' }];
      renderer.update({ trajectory: messages });
      const running = [...messages, ...trajectory.slice(1, 2),
        { kind: 'tool', name: 'Bash', callId: 'running-command', text: JSON.stringify({ command: 'npm test' }), state: 'running' }];
      renderer.update({ trajectory: running });
      const liveStatus = live.querySelector('.mp-chat-turn-status');
      const statusLabel = liveStatus.querySelector('.mp-chat-turn-status-label');
      check(statusLabel.textContent === 'Running tools' && getComputedStyle(statusLabel).position !== 'absolute',
        'the active tool status is still visually hidden after thinking');
      check(liveStatus.getAttribute('aria-label') === 'Running tools', 'the live status accessible label is stale');
      check(!live.querySelector('.mp-chat-tool-group-title').textContent.includes('Ran 1 command'),
        'the running command is already described as completed');
      live.remove();

      const bubble = document.querySelector('#stream .mp-chat-bubble').getBoundingClientRect();
      const assistant = document.querySelector('#stream .mp-chat-flow-item').getBoundingClientRect();
      check(assistant.top - bubble.bottom <= 56, 'user prompt and reply are too far apart: ' + Math.round(assistant.top - bubble.bottom));

      const narration = document.querySelector('#stream .mp-chat-narration');
      const range = document.createRange(); range.selectNodeContents(narration.querySelector('p') || narration);
      const textLeft = range.getBoundingClientRect().left;
      const label = document.querySelector('#stream .mp-chat-tool-group-header .mp-chat-row-label, #stream .mp-chat-tool-group-header');
      const labelRange = document.createRange(); labelRange.selectNodeContents(label);
      const labelLeft = [...labelRange.getClientRects()].find(r => r.width > 0)?.left ?? 0;
      check(Math.abs(labelLeft - textLeft) <= 1, 'tool summary is not aligned with the prose: ' + (labelLeft - textLeft).toFixed(1));

      stored.turns[0] = { ...stored.turns[0], answer: '', pendingInput: { requestId: 'q1', question: 'Which surface first?',
        options: [{ label: 'Plan card', description: 'The checklist.' }, { label: 'Question card', description: 'Choices.' }] } };
      await openConversation(stored.id);
      const host = document.getElementById('composer-permission-ask');
      check(!host.textContent.includes('[object Object]'), 'object options render as [object Object]');
      check(host.textContent.includes('Plan card') && host.textContent.includes('The checklist.'), 'object option label or description missing');
      check(!document.querySelector('#stream .mp-chat-run-meta'), 'a turn waiting for the user already shows the finished footer');
      await Promise.all(host.querySelector('.mp-decision-card').getAnimations().map(animation => animation.finished));
      const card = host.querySelector('.mp-decision-card').getBoundingClientRect();
      const column = document.querySelector('.mpw-scroll').getBoundingClientRect();
      check(Math.abs(card.left - column.left) <= 1 && Math.abs(card.width - column.width) <= 1,
        'question dock is not aligned to the composer: ' + JSON.stringify([card.left, card.width, column.left, column.width]));

      const option = host.querySelector('[data-option-index="0"]');
      option.focus(); option.click();
      check(host.querySelector('[data-option-index="0"]').getAttribute('aria-checked') === 'true'
        && document.activeElement === host.querySelector('[data-option-index="0"]'),
        'selecting an answer loses keyboard focus when the card repaints');

      stored.turns[0].pendingInput = { requestId: 'p1', kind: 'plan', tool: 'ExitPlanMode',
        plan: '# Polish plan\\n\\n1. Fix the question card\\n2. Verify **both** themes', question: 'Approve?', options: ['Manual', 'Accept edits', 'Keep planning'] };
      await openConversation(stored.id);
      const plan = host.querySelector('[data-kind="plan"]');
      check(plan && !plan.textContent.includes('# Polish plan') && plan.querySelector('h1, h2, h3') && plan.querySelector('ol li strong'),
        'plan approval shows raw markdown instead of a rendered plan');
      return failures;
    })()`);
    if (failures.length) console.error(failures.join('\n'));
    await new Promise(resolve => setTimeout(resolve, 200));
    fs.writeFileSync(path.join(output, 'plan.png'), (await win.webContents.capturePage()).toPNG());
    await win.setContentSize(720, 480);
    failures.push(...await win.webContents.executeJavaScript(`(async () => {
      const failures = [];
      const host = document.getElementById('composer-permission-ask');
      setInspector(true, 'tasks');
      const planText = '# Delivery plan\\n\\n' + Array.from({ length: 18 }, (_, i) =>
        (i + 1) + '. Review the conversation and preserve the existing task state.').join('\\n');
      DecisionCard.render(host, { key: 'narrow-plan', kind: 'plan', presentation: 'inline', plan: planText }, () => {});
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      document.getElementById('stream').scrollTop = document.getElementById('stream').scrollHeight;
      const card = host.querySelector('.mp-decision-card');
      const actions = card.querySelector('.mp-decision-actions');
      const bounds = card.getBoundingClientRect();
      const buttons = [...actions.querySelectorAll('button')];
      if (card.scrollWidth > card.clientWidth + 1 || buttons.some(button => {
        const rect = button.getBoundingClientRect();
        return rect.right > bounds.right || rect.left < bounds.left || button.scrollHeight > button.clientHeight + 1;
      })) failures.push('narrow plan actions overflow or clip their labels');
      if (actions.getBoundingClientRect().bottom > bounds.bottom + 1)
        failures.push('long plan pushes its approval actions out of view');
      return failures;
    })()`));
    await new Promise(resolve => setTimeout(resolve, 200));
    fs.writeFileSync(path.join(output, 'plan-narrow.png'), (await win.webContents.capturePage()).toPNG());
    if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1; }
  } catch (error) {
    console.error(error); process.exitCode = 1;
  } finally {
    clearTimeout(deadline); app.exit(process.exitCode || 0);
  }
});
