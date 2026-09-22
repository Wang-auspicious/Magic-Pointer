'use strict';

const assert = require('node:assert/strict');

class TestNode {
  constructor(tag = '', text = '') {
    this.tagName = tag.toUpperCase(); this.nodeType = tag ? 1 : 3;
    this.childNodes = []; this.attrs = {}; this.dataset = {}; this.data = text;
    this.parentNode = null; this.scrollTop = 0; this.structuralChanges = 0;
  }
  get children() { return this.childNodes.filter(n => n.nodeType === 1); }
  get firstChild() { return this.childNodes[0] || null; }
  get textContent() { return this.nodeType === 3 ? this.data : this.childNodes.map(n => n.textContent).join(''); }
  set textContent(value) { this.replaceChildren(new TestNode('', String(value))); }
  get className() { return this.attrs.class || ''; }
  set className(value) { this.setAttribute('class', value); }
  setAttribute(key, value) { this.attrs[key] = String(value); }
  getAttribute(key) { return this.attrs[key] ?? null; }
  removeAttribute(key) { delete this.attrs[key]; }
  appendChild(node) { return this.insertBefore(node, null); }
  insertBefore(node, before) {
    if (node.parentNode) node.remove();
    const index = before ? this.childNodes.indexOf(before) : this.childNodes.length;
    this.childNodes.splice(index, 0, node); node.parentNode = this; this.structuralChanges++;
    return node;
  }
  remove() {
    if (!this.parentNode) return;
    const parent = this.parentNode; parent.childNodes.splice(parent.childNodes.indexOf(this), 1);
    parent.structuralChanges++; this.parentNode = null;
  }
  replaceChildren(...nodes) {
    this.childNodes.slice().forEach(node => node.remove()); nodes.forEach(node => this.appendChild(node));
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  querySelectorAll(selector) {
    const matches = (node) => selector.startsWith('.')
      ? node.className.split(' ').includes(selector.slice(1))
      : selector.startsWith('[') ? node.getAttribute(selector.slice(1, -1)) !== null
        : node.tagName.toLowerCase() === selector;
    const found = [];
    for (const child of this.children) {
      if (matches(child)) found.push(child);
      found.push(...child.querySelectorAll(selector));
    }
    return found;
  }
  addEventListener() {}
}

global.document = {
  createElement: tag => new TestNode(tag),
  createElementNS: (_ns, tag) => new TestNode(tag),
  createTextNode: text => new TestNode('', text),
};
const ChatView = require('../electron/renderer/chat_view');
assert.equal(typeof ChatView.createLiveTurn, 'function', 'Stage and Studio need the same incremental turn renderer');

const host = new TestNode('div');
ChatView.expansion.clear();
const live = ChatView.createLiveTurn(host);
const call = { phase: 'tool_call', fields: { id: 'r1', name: 'Read', args: '{"path":"notes.txt"}' } };
live.update({ answer: 'First', thinking: 'Reading', records: [call] });
const answer = host.querySelector('.mp-chat-stream-live');
const think = host.querySelector('.mp-chat-think');
const thinkBody = host.querySelector('.mp-chat-think-body');
const tool = host.querySelector('.mp-chat-tool');
think.setAttribute('data-open', 'true'); thinkBody.scrollTop = 19;
const structure = host.structuralChanges;
live.update({ answer: 'First answer', thinking: 'Reading\nComparing', records: [call] });
assert.equal(host.querySelector('.mp-chat-stream-live'), answer, 'answer node must survive chunks');
assert.equal(host.querySelector('.mp-chat-think'), think, 'reasoning node must survive chunks');
assert.equal(host.querySelector('.mp-chat-think-body'), thinkBody, 'expanded reasoning body must survive chunks');
assert.equal(think.getAttribute('data-open'), 'true');
assert.equal(thinkBody.scrollTop, 19);
assert.equal(host.structuralChanges, structure, 'chunks must not detach the turn children');
assert.equal(answer.textContent, 'First answer');
assert.equal(thinkBody.textContent, 'Reading\nComparing');
ChatView.expansion.setRow(tool.querySelector('.mp-chat-disclosure').getAttribute('data-row-id'), true);
live.update({ answer: 'First answer', thinking: 'Reading\nComparing', records: [
  { phase: 'tool_result', fields: { ...call.fields, state: 'ok', result: 'read the actual contents' } },
] });
assert.equal(host.querySelector('.mp-chat-tool'), tool, 'settling the call retains its root');
assert.equal(tool.querySelector('.mp-chat-disclosure').getAttribute('data-open'), 'true');
assert.match(tool.textContent, /read the actual contents/, 'tool output must show real result content');

const planHost = new TestNode('div');
const planLive = ChatView.createLiveTurn(planHost);
const todos = [{ content: 'Inspect the task', status: 'completed' }, { content: 'Fix the issue', status: 'in_progress' }, { content: 'Run checks', status: 'pending' }];
planLive.update({ trajectory: [{ kind: 'tool', callId: 'todo-1', name: 'Todo', text: JSON.stringify({ todos }), result: JSON.stringify({ plan: todos }), state: 'done' }] });
const planTool = planHost.querySelector('.mp-chat-tool');
assert.equal(planTool.getAttribute('data-call-id'), 'todo-1', 'plan rows must link to their real transcript tool');
assert.equal(planTool.querySelectorAll('.mp-chat-todo-item').length, 3, 'expanded Todo tools show a readable checklist');
assert.equal(planTool.querySelectorAll('.mp-chat-todo-item')[0].getAttribute('data-state'), 'completed');
assert.match(planTool.textContent, /Fix the issue/);
assert.doesNotMatch(planTool.textContent, /"todos"|"plan"|"status"/, 'a successful plan is not a JSON dump');
planLive.update({ trajectory: [{ kind: 'tool', callId: 'todo-1', name: 'Todo', text: JSON.stringify({ todos }), result: 'Could not save plan', isError: true, state: 'error' }] });
assert.match(planHost.textContent, /Could not save plan/, 'failed plan updates still expose their real error');

const questionHost = new TestNode('div');
const questionLive = ChatView.createLiveTurn(questionHost);
const questions = [{ question: 'Which format?', options: [{ label: 'Report' }, { label: 'Slides' }] }, { question: 'Which details?', multiSelect: true, options: [{ label: 'Charts' }, { label: 'Sources' }] }];
questionLive.update({ trajectory: [{ kind: 'tool', callId: 'ask-1', name: 'AskUser', text: JSON.stringify({ questions }), result: JSON.stringify({ answered: true, answers: { 'Which format?': 'Report', 'Which details?': [] }, skippedQuestions: ['Which details?'] }), state: 'done' }] });
assert.equal(questionHost.querySelectorAll('.mp-chat-question-answer').length, 2, 'answered questions remain readable in tool history');
assert.match(questionHost.textContent, /Which format\?Report/);
assert.match(questionHost.textContent, /No preference/);
assert.doesNotMatch(questionHost.textContent, /"questions"|"answered"|"answers"/, 'question history must not dump the request protocol');

assert.equal(typeof ChatView.createConversationView, 'function');
const flow = new TestNode('div');
const view = ChatView.createConversationView(flow);
view.update({ id: 'c1', turns: [{ question: 'What is here?', outcome: '进行中', liveProgress: {
  answer: 'Partial', thinking: 'Inspecting', records: [call],
} }] });
const user = flow.querySelector('.mp-chat-user');
const liveAnswer = flow.querySelector('.mp-chat-stream-live');
view.update({ id: 'c1', turns: [{ question: 'What is here?', outcome: '进行中', liveProgress: {
  answer: 'Partial answer', thinking: 'Inspecting', records: [call],
} }] });
assert.equal(flow.querySelector('.mp-chat-user'), user);
assert.equal(flow.querySelector('.mp-chat-stream-live'), liveAnswer);
view.update({ id: 'c1', turns: [{ question: 'What is here?', answer: 'Final saved answer', thinking: 'Inspected' }] });
assert.equal(flow.querySelector('.mp-chat-user'), user, 'final notification must preserve the question node');
assert.match(flow.textContent, /Final saved answer/, 'current conversation must show the completed answer');
assert.doesNotMatch(flow.textContent, /Partial answer/);
console.log('shared live turn incremental renderer tests ok');

const thoughtHost = new TestNode('div');
const thoughtLive = ChatView.createLiveTurn(thoughtHost);
const longThought = 'Source inspection\n'.repeat(80);
thoughtLive.update({ trajectory: [{ kind: 'message', turn: 1, reasoning: longThought, state: 'running' }] });
const thoughtRoot = thoughtHost.querySelector('.mp-chat-think');
thoughtRoot.setAttribute('data-open', 'true');
thoughtLive.update({ trajectory: [{ kind: 'message', turn: 1, reasoning: longThought, state: 'done' }] });
assert.equal(thoughtHost.querySelector('.mp-chat-think'), thoughtRoot);
assert.equal(thoughtRoot.getAttribute('data-state'), 'ok', 'unchanged text must still settle thinking state');
assert.equal(thoughtRoot.getAttribute('data-long'), 'true', 'completed streamed thought needs bounded preview');
assert.equal(thoughtRoot.getAttribute('data-open'), 'true');
assert.ok(thoughtRoot.querySelector('.mp-chat-think-more'));

const agentHost = new TestNode('div');
const agentLive = ChatView.createLiveTurn(agentHost);
const agentRecord = { kind: 'tool', callId: 'pa', name: 'Agent', text: '{"task":"Check source"}', state: 'running',
  subagent: { id: 'ca', parentCallId: 'pa', status: 'running', phase: 'thinking', reasoning: 'Tracing event source', stepCount: 0 } };
agentLive.update({ trajectory: [agentRecord] });
assert.match(agentHost.textContent, /Tracing event source/);
const heartbeat = agentHost.querySelector('.mp-chat-subagent-heartbeat');
agentRecord.subagent.reasoning += '\nFound the handler';
agentLive.update({ trajectory: [agentRecord] });
assert.equal(agentHost.querySelector('.mp-chat-subagent-heartbeat'), heartbeat, 'child token updates preserve the parent row');
assert.match(agentHost.textContent, /Found the handler/);

const studioTasksHost = new TestNode('div');
const studioTasks = ChatView.createLiveTurn(studioTasksHost, 'studio-tasks#0', { taskPanel: true });
const studioPlan = { kind: 'tool', callId: 'studio-plan', name: 'Todo', text: JSON.stringify({ todos }), result: JSON.stringify({ plan: todos }), state: 'done' };
const studioAgent = { ...agentRecord, callId: 'studio-agent',
  subagent: { ...agentRecord.subagent, id: 'studio-child', parentCallId: 'studio-agent' } };
studioTasks.update({ trajectory: [studioPlan, studioAgent] });
assert.equal(studioTasksHost.querySelectorAll('.mp-chat-todo-item').length, 0, 'Studio renders the plan only in the Tasks rail');
assert.equal(studioTasksHost.querySelectorAll('.mp-chat-subagent-heartbeat').length, 0, 'child reasoning belongs only to the Tasks rail');
assert.doesNotMatch(studioTasksHost.textContent, /Inspect the task|Found the handler|"task"/);
const studioAgentRow = studioTasksHost.querySelector('.mp-chat-tool');
assert.equal(studioAgentRow.getAttribute('data-call-id'), 'studio-agent');
assert.equal(studioAgentRow.querySelector('.mp-chat-row').getAttribute('data-mp-chat-act'), 'open-subagent');
assert.equal(studioAgentRow.querySelector('.mp-chat-row').getAttribute('data-subagent-parent-call-id'), 'studio-agent');
assert.equal(studioAgentRow.querySelector('.mp-chat-body-wrap').textContent, '', 'the child entry has no hidden duplicate transcript');
studioAgent.subagent.status = 'failed';
studioTasks.update({ trajectory: [studioPlan, studioAgent] });
assert.equal(studioTasksHost.querySelector('.mp-chat-tool'), studioAgentRow, 'child state changes preserve the compact entry');
assert.equal(studioAgentRow.getAttribute('data-state'), 'error', 'the compact entry reflects a child failure before its parent tool settles');
studioTasks.finish({ answer: 'Complete.', trajectory: [studioPlan, studioAgent] });
assert.equal(studioTasksHost.querySelectorAll('.mp-chat-todo-item').length, 0);
assert.equal(studioTasksHost.querySelectorAll('.mp-chat-tool-group').length, 0, 'the Agent entry stays directly accessible after completion');
assert.equal(studioTasksHost.querySelector('.mp-chat-row').getAttribute('data-mp-chat-act'), 'open-subagent');
assert.doesNotMatch(studioTasksHost.textContent, /Found the handler|"task"/);
studioTasks.update({ trajectory: [{ ...studioPlan, result: 'Could not save plan', isError: true, state: 'error' }] });
assert.match(studioTasksHost.textContent, /Could not save plan/, 'a rejected plan update must remain visible');
assert.equal(studioTasksHost.querySelectorAll('.mp-chat-todo-item').length, 0, 'a rejected plan does not render its proposed checklist');
studioTasks.update({ records: [{ phase: 'tool_result', fields: { id: 'studio-plan', name: 'Todo', args: studioPlan.text, result: studioPlan.result, state: 'ok' } }] });
assert.equal(studioTasksHost.querySelectorAll('.mp-chat-todo-item').length, 0, 'legacy live records also avoid the duplicate checklist');
const studioHistory = new TestNode('div');
ChatView.createConversationView(studioHistory).update({ id: 'task-panel-history', turns: [{ trajectory: [studioPlan, studioAgent], answer: 'Complete.' }] });
assert.equal(studioHistory.querySelectorAll('.mp-chat-todo-item').length, 0, 'reopening Studio uses the same task presentation');
assert.equal(studioHistory.querySelectorAll('.mp-chat-subagent-heartbeat').length, 0);
assert.equal(studioHistory.querySelector('.mp-chat-row').getAttribute('data-mp-chat-act'), 'open-subagent');

const trace = [
  { kind: 'message', turn: 1, text: 'I will inspect the files.', reasoning: 'First reasoning', state: 'done' },
  { kind: 'tool', callId: 'a', name: 'Read', text: '{"path":"a.pdf"}', result: 'file missing', isError: true, state: 'error' },
  { kind: 'message', turn: 2, text: 'Trying the original source.', reasoning: 'Second reasoning', state: 'running' },
  { kind: 'tool', callId: 'b', name: 'Read', text: '{"path":"b.pdf"}', state: 'running' },
];
const transcriptHost = new TestNode('div');
const transcript = ChatView.createLiveTurn(transcriptHost);
transcript.update({ trajectory: trace, answer: 'Trying the original source.', thinking: 'Second reasoning' });
assert.equal(transcriptHost.querySelectorAll('.mp-chat-tool-group-body').length, 2, 'every live tool run has the reference border, including a single failed Read');
assert.equal(transcriptHost.querySelectorAll('.mp-chat-think').length, 2, 'reasoning survives the next model round');
assert.match(transcriptHost.textContent, /I will inspect the files/);
assert.match(transcriptHost.querySelectorAll('.mp-chat-tool')[0].querySelector('.mp-chat-row').textContent, /a.pdf/, 'failure must not replace the selected file with an error dump');
const before = transcriptHost.querySelectorAll('.mp-chat-tool-group')[0];
before.setAttribute('open', '');
transcript.update({ trajectory: trace, answer: 'Trying the original source.' });
assert.equal(transcriptHost.querySelectorAll('.mp-chat-tool-group')[0], before, 'stream updates preserve the expanded work record');
transcript.finish({ trajectory: trace.map(r => ({ ...r, state: 'done' })), answer: 'Complete.' });
assert.equal(transcriptHost.querySelectorAll('.mp-chat-think').length, 2, 'completed history retains all reasoning');
assert.equal(transcriptHost.querySelectorAll('.mp-chat-tool-group').length, 2);
assert(transcriptHost.querySelectorAll('.mp-chat-tool-group').every(n => n.getAttribute('open') === null), 'all completed tool runs start collapsed, even single calls');
assert.match(transcriptHost.textContent, /file missing/, 'collapsed history retains the complete error for reopening');

const groupHost = new TestNode('div');
const groupLive = ChatView.createLiveTurn(groupHost);
const firstTool = { kind: 'tool', callId: '1', name: 'Read', text: '{"path":"a.pdf"}', state: 'running' };
groupLive.update({ trajectory: [firstTool] });
assert.equal(groupHost.querySelector('.mp-chat-tool-group').getAttribute('data-single'), 'true');
groupLive.update({ trajectory: [firstTool, { ...firstTool, callId: '2', text: '{"path":"b.pdf"}' }] });
assert.equal(groupHost.querySelector('.mp-chat-tool-group').getAttribute('data-single'), null,
  'a second tool restores the individual rows instead of keeping singleton CSS');
const editHost = new TestNode('div');
ChatView.createLiveTurn(editHost).update({ trajectory: [
  { kind: 'tool', callId: 'e', name: 'Edit', text: '{"file_path":"a.py","old_string":"old","new_string":"new"}', state: 'running' },
] });
assert.match(editHost.querySelector('.mp-chat-tool-group-header').textContent, /\+1.*−1/,
  'single edit summary keeps the reference added/removed line counts visible');
const finishedHost = new TestNode('div');
ChatView.createLiveTurn(finishedHost).finish({ answer: 'Done.', trajectory: [
  firstTool, { kind: 'message', turn: 2, reasoning: 'Use the other file.', state: 'done' },
  { ...firstTool, callId: '2' },
] });
assert.equal(finishedHost.querySelectorAll('.mp-chat-tool-group').length, 1,
  'completion folds one uninterrupted work sequence into one reference summary');
assert.match(finishedHost.querySelector('.mp-chat-tool-group-body').textContent, /Use the other file/,
  'the folded work sequence keeps its intermediate reasoning available');

ChatView.expansion.clear();
const handoffHost = new TestNode('div');
const handoffLive = ChatView.createLiveTurn(handoffHost, 'c9#0');
handoffLive.update({ trajectory: [{ kind: 'message', turn: 0, reasoning: '先读文件', state: 'running' }] });
const liveThinkRow = handoffHost.querySelector('.mp-chat-think');
const liveThinkId = liveThinkRow.getAttribute('data-row-id');
assert.ok(liveThinkId, 'a streaming thinking row must carry a stable id');
ChatView.expansion.setRow(liveThinkId, true);  
handoffLive.finish({
  answer: '完成',
  conversationId: 'c9',
  turnIndex: 0,
  trajectory: [{ kind: 'message', turn: 0, reasoning: '先读文件', text: '' }],
});
assert.equal(handoffHost.querySelector('.mp-chat-think').getAttribute('data-open'), 'true',
  'a thinking row the user opened must survive the swap to the settled turn');
ChatView.expansion.clear();
console.log('expansion survives the live-to-settled swap');

const test = require('node:test');

test('intermediate thinking keeps its identity when completion folds it into a tool group', () => {
  ChatView.expansion.clear();
  const target = new TestNode('div');
  const renderer = ChatView.createLiveTurn(target, 'grouped#0');
  const trajectory = [
    { kind: 'tool', callId: 'read-first', name: 'Read', text: '{"path":"a.md"}', result: 'A', state: 'done' },
    { kind: 'message', turn: 2, reasoning: 'Compare with the other source.', state: 'done' },
    { kind: 'tool', callId: 'read-second', name: 'Read', text: '{"path":"b.md"}', result: 'B', state: 'done' },
  ];
  renderer.update({ trajectory });
  const id = target.querySelector('.mp-chat-think').getAttribute('data-row-id');
  ChatView.expansion.setRow(id, true);
  renderer.finish({ conversationId: 'grouped', turnIndex: 0, trajectory, answer: 'Compared.' });
  const settled = target.querySelector('.mp-chat-think');
  assert.equal(settled.getAttribute('data-row-id'), id);
  assert.equal(settled.getAttribute('data-open'), 'true');
  assert.equal(target.querySelector('.mp-chat-tool-group').getAttribute('open'), '',
    'the opened thought must remain visible inside the merged group');
});

test('merging an opened later tool group preserves visibility once and honors a later collapse', () => {
  ChatView.expansion.clear();
  const target = new TestNode('div');
  const renderer = ChatView.createLiveTurn(target, 'merged#0');
  const trajectory = [
    { kind: 'tool', callId: 'first', name: 'Read', text: '{"path":"a.md"}', result: 'A', state: 'done' },
    { kind: 'message', turn: 2, reasoning: 'Compare the sources.', state: 'done' },
    { kind: 'tool', callId: 'second', name: 'Read', text: '{"path":"b.md"}', result: 'B', state: 'done' },
  ];
  renderer.update({ trajectory });
  const laterId = target.querySelectorAll('.mp-chat-tool-group-header')[1].getAttribute('data-group-id');
  ChatView.expansion.setGroup(laterId, true);
  const turn = { conversationId: 'merged', turnIndex: 0, trajectory, answer: 'Compared.' };
  renderer.finish(turn);
  assert.equal(target.querySelectorAll('.mp-chat-tool-group').length, 1);
  assert.equal(target.querySelector('.mp-chat-tool-group').getAttribute('open'), '',
    'an opened later group must stay visible after merging into the first group');
  assert.equal(target.querySelectorAll('.mp-chat-tool')[1].querySelector('.mp-chat-disclosure').getAttribute('data-open'), 'true',
    'the result visible in a singleton group must stay visible when it becomes a row');
  const mergedId = target.querySelector('.mp-chat-tool-group-header').getAttribute('data-group-id');
  ChatView.expansion.setGroup(mergedId, false);
  renderer.finish(turn);
  assert.equal(target.querySelector('.mp-chat-tool-group').getAttribute('open'), null,
    'an old child expansion must not override the user closing the merged group');
});

test('a local draft card names the deliverable without pretending it was published', () => {
  const card = ChatView.artifactCardNode([{ artifactId: 'draft-one', name: 'Release notes',
    kind: 'text', revision: 2, state: 'edited' }], 'draft-task');
  assert.ok(card.textContent.includes('Release notes'));
  assert.ok(!card.textContent.includes('Published'), 'a generated or edited local draft has not been published');
  assert.equal(card.querySelectorAll('[data-mp-chat-act]').length, 1, 'one deliverable needs one coherent open target');
  assert.equal(ChatView.artifactCardNode([], 'draft-task'), null, 'ordinary messages have no artifact placeholder');
});

test('a standalone Stage turn preserves expansion through finish without conversation metadata', () => {
  ChatView.expansion.clear();
  const target = new TestNode('div');
  const renderer = ChatView.createLiveTurn(target);
  renderer.update({ thinking: 'Inspecting the selected material.' });
  const id = target.querySelector('.mp-chat-think').getAttribute('data-row-id');
  ChatView.expansion.setRow(id, true);
  renderer.finish({ thinking: 'Inspected the selected material.', answer: 'Done.' });
  assert.equal(target.querySelector('.mp-chat-think').getAttribute('data-row-id'), id);
  assert.equal(target.querySelector('.mp-chat-think').getAttribute('data-open'), 'true');
});

test('provider call ids reused by separate conversations do not share expansion state', () => {
  ChatView.expansion.clear();
  const trajectory = [
    { kind: 'tool', callId: 'call_1', name: 'Read', text: '{"path":"a.md"}', result: 'A', state: 'done' },
    { kind: 'tool', callId: 'call_2', name: 'Read', text: '{"path":"b.md"}', result: 'B', state: 'done' },
  ];
  const a = new TestNode('div');
  const b = new TestNode('div');
  const first = ChatView.createConversationView(a);
  first.update({ id: 'session-a', turns: [{ trajectory, answer: 'Done A.' }] });
  const rowId = a.querySelector('.mp-chat-disclosure').getAttribute('data-row-id');
  const groupId = a.querySelector('.mp-chat-tool-group-header').getAttribute('data-group-id');
  ChatView.expansion.setRow(rowId, true);
  ChatView.expansion.setGroup(groupId, true);
  ChatView.createConversationView(b).update({ id: 'session-b', turns: [{ trajectory, answer: 'Done B.' }] });
  assert.notEqual(b.querySelector('.mp-chat-disclosure').getAttribute('data-row-id'), rowId);
  assert.equal(b.querySelector('.mp-chat-disclosure').getAttribute('data-open'), 'false');
  assert.equal(b.querySelector('.mp-chat-tool-group').getAttribute('open'), null);
});
