'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const output = path.resolve('data/runtime/studio-decisions-20260921');
const buildRoot = path.resolve(process.env.MP_PROBE_BUILD_ROOT || 'build/electron');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'profile'));
app.disableHardwareAcceleration();
const deadline = setTimeout(() => app.exit(1), 30000);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1240, height: 900, show: false, webPreferences: {
    offscreen: true, sandbox: false, contextIsolation: true,
    preload: path.resolve('scripts/probe_studio_layout_preload.js'),
    additionalArguments: ['--mp-probe-theme=light', '--mp-probe-state=landing'],
  } });
  try {
    await win.loadFile(path.join(buildRoot, 'renderer', 'studio.html'));
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
      Data.conversations = async () => [{ id: 'selected-conversation', title: 'Selected task' }, { id: 'other-conversation', title: 'Other task' }];
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
      check(document.querySelector('.mpw-scroll').getBoundingClientRect().height <= 46, 'single-line Code composer exceeds the reference 44px editor plus border');
      check(document.querySelector('.mpw-primary').getBoundingClientRect().width === 24, 'Code send control is not the compact 24px size');
      const overflowWitness = document.createElement('div');
      overflowWitness.style.height = '1400px'; overflowWitness.style.flex = '0 0 1400px';
      const chatStream = document.getElementById('stream');
      chatStream.append(overflowWitness);
      const conversationFlow = chatStream.querySelector('.mp-chat-flow');
      const textLeft = conversationFlow.getBoundingClientRect().left + parseFloat(getComputedStyle(conversationFlow).paddingLeft);
      const centeredTranscript = Math.abs(textLeft - document.querySelector('.mpw-scroll').getBoundingClientRect().left) < 1;
      overflowWitness.remove();
      const narrationWitness = document.createElement('div');
      narrationWitness.className = 'mp-chat-narration';
      narrationWitness.innerHTML = '<div class="mp-chat-markdown"><p>Check the actual text dimensions.</p></div>';
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
      const showHistoryApproval = async (requestId, tool, args) => {
        stored.turns[0].pendingInput = { requestId, kind: 'permission', tool, question: 'Allow ' + tool + '?',
          options: ['仅这一次允许', '拒绝'], action: { tool, arguments: args }, actionPreview: '{truncated' };
        await openConversation(stored.id);
        if (tool === 'DailyWrap.read') await wait();
        check(!host.querySelector('[data-decision="grant"]'), tool + ' history approval offered session-wide access');
        check(host.querySelector('[data-decision="once"]')?.textContent === '仅这一次允许', tool + ' lost the exact one-time choice');
      };
      await showHistoryApproval('recall-scope', 'Recall', { query: 'launch readiness', max_results: 3 });
      check(host.textContent.includes('launch readiness') && host.textContent.includes('all saved tasks')
        && !host.textContent.includes('{truncated'), 'Recall approval did not explain its cross-task search scope');
      await showHistoryApproval('recall-event', 'Recall', { session_id: 'saved-session', event_seq: 19, offset: 100 });
      check(host.textContent.includes('saved-session') && host.textContent.includes('19')
        && !host.textContent.includes('all saved tasks'), 'Recall event approval did not identify the exact saved task and event');
      await showHistoryApproval('daily-scope', 'DailyWrap.read', { from_ms: 1789228800000, to_ms: 1789315200000,
        conversation_ids: ['selected-conversation'], limit: 12 });
      check(host.textContent.includes('Selected task')
        && host.querySelector('[data-dailywrap-source-id="selected-conversation"]')?.checked
        && new Date(host.querySelector('[data-dailywrap-from]').value).getTime() === 1789228800000,
      'DailyWrap approval hid the proposed saved task or time window');
      await showHistoryApproval('daily-zero', 'DailyWrap.read', { from_ms: 1789228800000, to_ms: 1789315200000,
        conversation_ids: [], limit: 0 });
      check(host.textContent.includes('Read up to 0 records.'), 'DailyWrap approval overstated a zero-record limit');
      await showHistoryApproval('daily-all', 'DailyWrap.read', { from_ms: 1789228800000, to_ms: 1789315200000,
        conversation_ids: [] });
      check(!!host.querySelector('[data-history-source-mode="all"]')
        && host.querySelector('[data-decision="once"]').disabled,
      'empty DailyWrap source proposal silently approved all saved tasks');
      await showHistoryApproval('recipe-memory', 'Recipe', { operation: 'execute', plan: {
        recipeId: 'memory.recall', provider: 'local.memory', command: 'old notes', objectIds: ['selected-note'],
        parameters: { query: 'project Orion', limit: 5, objects: [{ id: 'selected-note', source: { app: 'browser', title: 'Orion notes' } }],
          contextPacket: { otherMaterial: 'unselected private material' } },
      } });
      check(host.textContent.includes('project Orion') && host.textContent.includes('selected-note')
        && host.textContent.includes('Orion notes') && !host.textContent.includes('{truncated')
        && !host.textContent.includes('unselected private material'),
      'Recipe memory approval hid the query or selected source');
      await showHistoryApproval('recipe-clipboard-search', 'Recipe', { operation: 'execute', plan: {
        recipeId: 'clipboard.history', provider: 'clipboard.history', command: 'find clip', objectIds: [],
        parameters: { query: 'invoice', objects: [] },
      } });
      check(host.textContent.includes('search saved clipboard history') && host.textContent.includes('invoice'),
        'Recipe clipboard history approval hid its query');
      await showHistoryApproval('recipe-restore', 'Recipe', { operation: 'execute', plan: {
        recipeId: 'clipboard.history', provider: 'clipboard.history', command: 'restore saved clip', objectIds: ['selected-object'],
        parameters: { digest: 'selected-digest', objects: [{ id: 'selected-object', source: { title: 'Selected document' } }] },
      } });
      check(host.textContent.includes('restore') && host.textContent.includes('selected-digest')
        && host.textContent.includes('Selected document') && !host.textContent.includes('{truncated'),
      'Recipe approval did not explain the clipboard restore target and selected source');
      stored.turns[0].pendingInput = { requestId: 'ask-format', questions: [
        { header: 'Format', question: 'Which format?', options: [{ label: 'Report', description: 'A document to share', preview: '<button>Example</button>\\n  outline' }, { label: 'Slides', description: 'A presentation' }] },
        { header: 'Include', question: 'What should it include?', multiSelect: true, options: [{ label: 'Charts' }, { label: 'Sources' }] },
      ] };
      await openConversation(stored.id);
      check(!host.hidden && host.textContent.includes('A document to share'), 'structured question descriptions are missing');
      check(host.querySelector('.mp-decision-option-preview')?.textContent === '<button>Example</button>\\n  outline', 'option preview lost formatting');
      check(!host.querySelector('.mp-decision-option-preview button'), 'option preview must display source, not execute markup');
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
      check(document.getElementById('project-inspector').getBoundingClientRect().width === 240, 'Tasks must use the Studio 15–20rem session rail, not the wide document inspector');
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
      check(!document.querySelector('#stream .mp-chat-todo-list'), 'the transcript repeats the plan already shown in the task rail');
      check(getComputedStyle(document.querySelector('.mp-chat-user-stack')).maxWidth.startsWith('min(75%'), 'user prompt bubbles must match the reference 75% transcript width');
      let childStatus = 'awaiting_user';
      let childResponse;
      Data.subagents = async () => ({ ok: true, tasks: [{ id: 'child-background', parentCallId: 'agent-call',
        description: 'Independent child', status: childStatus, stepCount: 1, steps: [],
        pendingInput: childStatus === 'awaiting_user' ? { requestId: 'child-write', kind: 'permission',
          tool: 'Write', question: 'Allow child edit?', actionPreview: 'exact child edit' } : null }] });
      Data.respondSubagent = async payload => { childResponse = payload; childStatus = 'completed'; return { ok: true, accepted: true }; };
      await refreshBackgroundAgentTasks(stored.id);
      const childRow = document.querySelector('.mp-subagent-task[data-task-id="child-background"]');
      check(childRow?.dataset.status === 'awaiting_user', 'child approval is mislabeled as finished');
      check(!childRow.querySelector('.mp-subagent-stop').hidden, 'waiting child cannot be stopped');
      check(childRow.textContent.includes('exact child edit'), 'child original action is not displayed');
      childRow.querySelector('[data-decision="once"]').click(); await wait(); await wait();
      check(childResponse?.subagentId === 'child-background' && childResponse?.requestId === 'child-write', 'parent approval lost the child/request binding');
      check(normalSends === 0 && !pendingConversation, 'child approval started another parent turn');
      check(!childRow.querySelector('.mp-decision-card'), 'answered child card remained actionable');
      check(textarea.value === 'Keep my unsent follow-up', 'child approval overwrote the draft');
      let crashedPending = true, crashedAnswerSaved = false;
      Data.subagents = async () => ({ ok: true, tasks: [{ id: 'child-background', parentCallId: 'agent-call',
        description: 'Independent child', status: 'stopped', resumeRequired: true, answerSaved: crashedAnswerSaved,
        stepCount: 1, steps: [], pendingInput: crashedPending ? { requestId: 'child-crashed-write', kind: 'permission',
          tool: 'Write', question: 'Allow saved child edit?', actionPreview: 'original saved action' } : null }] });
      Data.respondSubagent = async payload => { childResponse = payload; crashedPending = false; crashedAnswerSaved = true; return { ok: true, accepted: true, resumeRequired: true }; };
      await refreshBackgroundAgentTasks(stored.id);
      const crashedRow = document.querySelector('.mp-subagent-task[data-task-id="child-background"]');
      check(crashedRow?.closest('[data-task-section="Needs attention"]'), 'crashed approval stayed folded under Finished');
      check(crashedRow?.querySelector('.mp-decision-card') && crashedRow.textContent.includes('original saved action'), 'crashed child lost the original approval request');
      check(crashedRow.textContent.includes('答复后仍需恢复任务'), 'crashed approval falsely implies immediate execution');
      crashedRow.querySelector('[data-decision="once"]').click(); await wait(); await wait();
      check(childResponse?.requestId === 'child-crashed-write', 'crashed child answer lost its original request ID');
      check(!crashedRow.querySelector('.mp-decision-card') && crashedRow.textContent.includes('审批答复已保存，后台任务尚未恢复执行'), 'saved answer was shown as executed or still actionable');
      check(normalSends === 0 && textarea.value === 'Keep my unsent follow-up', 'crashed child answer auto-ran or changed the parent draft');
      Data.subagents = async () => ({ ok: true, tasks: [{ id: 'child-background', parentCallId: 'agent-call',
        description: 'Independent child', status: 'partial', stepCount: 1, steps: [], pendingInput: null }] });
      await refreshBackgroundAgentTasks(stored.id);
      check(crashedRow.querySelector('.mp-subagent-state').textContent === 'Partially complete'
        && crashedRow.closest('[data-task-section="Needs attention"]'), 'partial child was displayed as Completed or hidden under Finished');
      let resolveSources;
      const sourcesPromise = new Promise(resolve => { resolveSources = resolve; });
      Data.conversations = async () => sourcesPromise;
      await showHistoryApproval('daily-user-scope', 'DailyWrap.read', { from_ms: 1789228800000, to_ms: 1789315200000,
        conversation_ids: ['selected-conversation', 'selected-conversation'], limit: 12 });
      check(host.querySelector('[data-decision="once"]').disabled, 'DailyWrap approved before saved tasks loaded');
      resolveSources([{ id: 'selected-conversation', title: 'Selected task' }, { id: 'other-conversation', title: 'Other task' }]);
      await wait();
      check(!!host.querySelector('[data-dailywrap-from]') && !!host.querySelector('[data-dailywrap-to]'), 'DailyWrap has no editable time range');
      check(host.querySelector('.mp-decision-dailywrap-sources .mp-decision-hint')?.textContent === '1 selected',
        'duplicate proposed task IDs remain duplicated in the user selection');
      check(host.querySelector('[data-decision="once"]').disabled, 'DailyWrap accepted a model-selected source without user choice');
      host.querySelector('[data-dailywrap-source-selected]').click();
      const fromInput = host.querySelector('[data-dailywrap-from]');
      const selectedFrom = 1789232400000;
      const localDate = new Date(selectedFrom - new Date(selectedFrom).getTimezoneOffset() * 60000).toISOString().slice(0, 16);
      fromInput.value = localDate;
      fromInput.dispatchEvent(new Event('input', { bubbles: true }));
      host.querySelector('[data-dailywrap-source-id="other-conversation"]').click();
      host.querySelector('[data-decision="once"]').click(); await wait();
      const dailyResponse = responses.at(-1);
      check(dailyResponse?.requestId === 'daily-user-scope' && dailyResponse.response?.decision === 'once'
        && dailyResponse.response.actionArguments?.from_ms === selectedFrom
        && dailyResponse.response.actionArguments?.to_ms === 1789315200000
        && dailyResponse.response.actionArguments?.limit === 12
        && JSON.stringify(dailyResponse.response.actionArguments?.conversation_ids?.sort()) === JSON.stringify(['other-conversation', 'selected-conversation']),
      'DailyWrap did not submit the user-selected time and saved task set');
      return { normalSends, responses: responses.length, sameTurn: stored.turns.length === 1, permissionAndQuestions: true, durablePlan: true, backgroundApproval: true };
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
