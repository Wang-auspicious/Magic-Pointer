'use strict';
// Exercise the shipped Studio controls in Chromium. Responses are local fixtures.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const output = path.resolve('data/runtime/studio-decisions-20260921');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'profile'));
app.disableHardwareAcceleration();
const deadline = setTimeout(() => app.exit(1), 30000);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1240, height: 900, show: false, webPreferences: {
    offscreen: true, sandbox: false, contextIsolation: true,
    preload: path.resolve('scripts/probe_studio_claude_preload.js'),
    additionalArguments: ['--mp-probe-theme=light', '--mp-probe-state=landing'],
  } });
  try {
    await win.loadFile(path.resolve('build/electron/renderer/studio.html'));
    await win.webContents.executeJavaScript('document.fonts.ready');
    const witness = await win.webContents.executeJavaScript(`(async () => {
      const check = (ok, message) => { if (!ok) throw new Error(message); };
      const wait = () => new Promise(resolve => setTimeout(resolve, 30));
      show('chat');
      document.getElementById('studio-home').hidden = true;
      const original = { id: 'decision-task', name: 'Agent workflow checks', title: 'Agent workflow checks', agentSessionId: 'agent-decision', turns: [{ at: '2026-09-21T04:00:00.000Z', question: 'Run the checks', answer: '需要批准',
        pendingInput: { requestId: 'ask-permission', kind: 'permission', tool: 'Bash', prefix: 'npm test', actionPreview: 'npm test && npm run build', question: 'Allow running the project tests?', options: ['Allow once', 'Always allow', 'Deny'] } }] };
      let stored = structuredClone(original);
      Data.conversation = async id => id === stored.id ? structuredClone(stored) : null;
      Data.recovery = async () => ({ ok: true, pendingRecovery: [] });
      let normalSends = 0;
      Data.sendConversation = async () => { normalSends++; return { ok: false, error: 'approval used normal send' }; };
      const responses = [];
      let resolveResponse;
      Data.respondConversation = payload => { responses.push(payload); return new Promise(resolve => { resolveResponse = resolve; }); };
      await openConversation(stored.id);
      const navStyle = getComputedStyle(document.getElementById('nav-artifacts'));
      check(navStyle.height === '26px' && navStyle.fontSize === '13px' && navStyle.lineHeight === '19.5px' && navStyle.marginBottom === '0.5px', 'sidebar still uses Web comfortable density instead of the supplied Code 26.5px row rhythm');
      const textarea = document.querySelector('#composer-form textarea');
      check(getComputedStyle(textarea).fontSize === '14px' && getComputedStyle(textarea).lineHeight === '18px', 'Code composer is still using the larger Web Chat typography');
      check(document.querySelector('.dshw-scroll').getBoundingClientRect().height <= 46, 'single-line Code composer exceeds the reference 44px editor plus border');
      check(document.querySelector('.dshw-primary').getBoundingClientRect().width === 24, 'Code send control is not the compact 24px size');
      const overflowWitness = document.createElement('div');
      overflowWitness.style.height = '1400px'; overflowWitness.style.flex = '0 0 1400px';
      const chatStream = document.getElementById('stream');
      chatStream.append(overflowWitness);
      const conversationFlow = chatStream.querySelector('.dsh-flow');
      const textLeft = conversationFlow.getBoundingClientRect().left + parseFloat(getComputedStyle(conversationFlow).paddingLeft);
      const centeredTranscript = Math.abs(textLeft - document.querySelector('.dshw-scroll').getBoundingClientRect().left) < 1;
      overflowWitness.remove();
      const narrationWitness = document.createElement('div');
      narrationWitness.className = 'dsh-narration';
      narrationWitness.innerHTML = '<div class="dsh-markdown"><p>Check the actual text dimensions.</p></div>';
      chatStream.append(narrationWitness);
      const narrationStyle = getComputedStyle(narrationWitness.querySelector('p'));
      check(narrationStyle.fontSize === '15px' && narrationStyle.lineHeight === '23px', 'nested markdown overrides the visible narration typography');
      narrationWitness.remove();
      check(centeredTranscript, 'scrollbar shifts the transcript away from the composer alignment');
      textarea.value = 'Keep my unsent follow-up';
      composerAttachments = [{ path: 'draft.md', name: 'draft.md' }];
      const host = document.getElementById('composer-permission-ask');
      check(host.textContent.includes('npm test && npm run build'), 'approval hides the full action behind a prefix');
      check(host.parentElement?.id === 'stream', 'pending input must be in the scrollable conversation, not a permanent second composer');
      check(document.getElementById('stream').getBoundingClientRect().height > 550, 'pending input squeezed away the conversation viewport');
      const once = [...host.querySelectorAll('button')].find(button => button.textContent.includes('Allow once'));
      check(!!once, 'permission card has no Allow once action');
      once.click(); await wait();
      check(normalSends === 0, 'permission action sent a new ordinary chat message');
      check(responses.length === 1 && responses[0].requestId === 'ask-permission' && responses[0].response.decision === 'once', 'permission was not bound to the pending tool request');
      check(textarea.value === 'Keep my unsent follow-up', 'permission click replaced the composer draft');
      check(composerAttachments.length === 1, 'permission click consumed composer attachments');
      check([...host.querySelectorAll('button')].every(button => button.disabled), 'pending decision permits duplicate submission');
      once.click(); check(responses.length === 1, 'double click submitted twice');
      stored.turns[0] = { ...stored.turns[0], answer: 'Checks completed', pendingInput: undefined };
      resolveResponse({ ok: true, accepted: true, conversationId: stored.id }); await wait(); await wait();
      check(host.hidden, 'accepted approval card stayed visible');
      check(stored.turns.length === 1, 'approval added another task turn');
      stored.turns[0].pendingInput = { requestId: 'ask-format', questions: [
        { header: 'Format', question: 'Which format?', options: [{ label: 'Report', description: 'A document to share' }, { label: 'Slides', description: 'A presentation' }] },
        { header: 'Include', question: 'What should it include?', multiSelect: true, options: [{ label: 'Charts' }, { label: 'Sources' }] },
      ] };
      await openConversation(stored.id);
      check(!host.hidden && host.textContent.includes('A document to share'), 'structured question descriptions are missing');
      const otherChoice = host.querySelector('.mp-decision-other [role="radio"]');
      check(!!otherChoice, 'inline Other is missing its selectable radio row');
      check(getComputedStyle(host.querySelector('.mp-decision-option')).gap === '12px', 'inline question choice gap differs from Code 12px');
      check(host.querySelector('[data-question-next]').getBoundingClientRect().height === 24, 'inline question action is not the Code 24px control');
      host.querySelector('[aria-label="Next question"]').click();
      host.querySelector('[data-option-index="0"]').click();
      host.querySelector('[data-question-submit]').click(); await wait();
      check(responses.length === 1 && host.textContent.includes('Which format?'), 'unanswered pages must require an answer or explicit Skip');
      host.querySelector('[data-option-index="0"]').click();
      check(responses.length === 1, 'selecting an option prematurely submitted the form');
      const other = host.querySelector('textarea');
      other.focus();
      // Hidden offscreen windows set activeElement without dispatching native focus.
      other.dispatchEvent(new FocusEvent('focus'));
      check(host.querySelector('[data-option-index="0"]').getAttribute('aria-checked') === 'false' && host.querySelector('.mp-decision-other [role="radio"]').getAttribute('aria-checked') === 'true', 'focusing Other must select Other and clear the single choice: ' + JSON.stringify({ focused: document.activeElement === other, selected: host.querySelector('[data-option-index="0"]').getAttribute('aria-checked'), other: host.querySelector('.mp-decision-other [role="radio"]').getAttribute('aria-checked') }));
      other.value = 'A memo'; other.dispatchEvent(new Event('input', { bubbles: true }));
      check(host.querySelector('[data-option-index="0"]').getAttribute('aria-checked') === 'false', 'custom single answer did not clear the radio choice');
      check(host.querySelector('[data-option-index="0"] .mp-decision-choice-mark').textContent !== '✓', 'cleared radio still displays a checkmark');
      host.querySelector('[data-option-index="0"]').click();
      host.querySelector('[data-question-next]').click();
      check(host.querySelector('[data-option-index="0"]').getAttribute('aria-checked') === 'true', 'answer validation discarded a later-page selection');
      host.querySelector('[data-option-index="1"]').click();
      const custom = host.querySelector('textarea');
      custom.value = 'Timeline'; custom.dispatchEvent(new Event('input', { bubbles: true }));
      host.querySelector('[data-question-submit]').click(); await wait();
      const answers = responses[1]?.response?.answers;
      check(answers?.['Which format?'] === 'Report', 'first question selection was lost on navigation');
      check(JSON.stringify(answers?.['What should it include?']) === JSON.stringify(['Charts', 'Sources', 'Timeline']), 'multi-select or custom answer was lost');
      resolveResponse({ ok: false, accepted: false, error: 'Could not save this answer' }); await wait();
      check(!host.hidden && host.textContent.includes('Could not save this answer'), 'unaccepted response failure must retain a retryable form');
      check(host.querySelector('textarea').value === 'Timeline', 'failed submission discarded the question draft');
      host.querySelector('[data-question-submit]').click(); await wait();
      stored.turns[0].pendingInput = undefined;
      resolveResponse({ ok: false, accepted: true, conversationId: stored.id, error: 'provider unavailable' }); await wait(); await wait();
      check(host.hidden, 'a model failure resurrected an already accepted question');
      check(textarea.value === 'Keep my unsent follow-up' && composerAttachments.length === 1, 'question submission changed composer content');
      stored.taskContext = { taskId: 'agent-decision', sources: [], references: [], referenceRevision: 0, permissionMode: 'plan', effort: 'low' };
      stored.turns[0].pendingInput = { requestId: 'exit-plan', kind: 'plan', tool: 'ExitPlanMode', plan: 'Edit the parser.\\nRun the regression test.', question: 'Approve?', options: ['Manual', 'Accept edits', 'Keep planning'] };
      await openConversation(stored.id);
      check(composerPreset === 'plan' && composerEffort === 'low', 'reopen did not restore task runtime controls');
      check(host.querySelector('[data-kind="plan"]') && host.textContent.includes('Edit the parser.'), 'plan content lost before approval');
      host.querySelector('[data-decision="grant"]').click(); await wait();
      check(responses.at(-1).requestId === 'exit-plan' && responses.at(-1).response.decision === 'grant', 'plan approval not bound to ExitPlanMode request');
      stored.turns[0].pendingInput = undefined;
      stored.taskContext.permissionMode = 'default';
      resolveResponse({ ok: true, accepted: true, conversationId: stored.id }); await wait(); await wait();
      check(host.hidden && composerPreset === 'workspace-write', 'accepted plan did not clear and restore execution mode');
      const steps = Array.from({ length: 10 }, (_, index) => ({ content: 'Step ' + (index + 1), status: index < 4 ? 'completed' : index === 4 ? 'in_progress' : 'pending' }));
      stored.turns[0].trajectory = [{ kind: 'tool', callId: 'plan-call', name: 'Todo', state: 'done', text: JSON.stringify({ todos: steps }), result: JSON.stringify({ plan: steps }) }];
      await openConversation(stored.id); setInspector(true, 'tasks');
      let plan = document.getElementById('project-plan');
      check(document.getElementById('project-inspector').getBoundingClientRect().width === 240, 'Tasks must use the Claude 15–20rem session rail, not the wide document inspector');
      check(plan && !plan.hidden, 'reopening a task did not restore its plan in the task rail');
      check(plan.querySelectorAll('.mp-plan-step').length === 6, 'the plan did not show its six-step current window');
      check(!document.getElementById('composer-plan') || document.getElementById('composer-plan').hidden, 'the plan still occupies the chat composer');
      const showAll = [...plan.querySelectorAll('button')].find(button => button.textContent.includes('Show all'));
      check(!!showAll, 'long plan has no expansion control'); showAll.click();
      check(plan.querySelectorAll('.mp-plan-step').length === 10, 'Show all discarded plan steps');
      startNewChat(); check(plan.hidden, 'a new task inherited the previous plan');
      await openConversation(stored.id); setInspector(true, 'tasks');
      plan = document.getElementById('project-plan');
      check(!plan.hidden && plan.querySelectorAll('.mp-plan-step').length === 10, 'reopening discarded the plan expansion choice');
      check(!document.querySelector('#stream .dsh-todo-list'), 'the transcript repeats the plan already shown in the task rail');
      check(getComputedStyle(document.querySelector('.dsh-user-stack')).maxWidth.startsWith('min(75%'), 'user prompt bubbles must match the reference 75% transcript width');
      return { normalSends, responses: responses.length, sameTurn: stored.turns.length === 1, permissionAndQuestions: true, durablePlan: true };
    })()`);
    fs.writeFileSync(path.join(output, 'witness.json'), JSON.stringify(witness, null, 2));
    await win.webContents.executeJavaScript(`setComposerSettledState('idle'); pendingPermissionAsk = { requestId: 'permission-preview', tool: 'Bash', prefix: 'npm test', question: 'Allow Magic Pointer to run the project tests?' }; pendingAskInput = null; renderPermissionAsk(); new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));`);
    fs.writeFileSync(path.join(output, 'permission.png'), (await win.webContents.capturePage()).toPNG());
    await win.webContents.executeJavaScript(`pendingPermissionAsk = null; pendingAskInput = { requestId: 'question-preview', questions: [{ header: 'Deliverable', question: 'How would you like the results?', options: [{ label: 'A concise report', description: 'Findings and next steps in one editable document' }, { label: 'A presentation', description: 'Slides for sharing with the team' }] }] }; renderPermissionAsk(); new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));`);
    fs.writeFileSync(path.join(output, 'questions.png'), (await win.webContents.capturePage()).toPNG());
    console.log(JSON.stringify(witness));
    clearTimeout(deadline); win.destroy(); app.exit(0);
  } catch (error) {
    console.error(error); clearTimeout(deadline); win.destroy(); app.exit(1);
  }
});
