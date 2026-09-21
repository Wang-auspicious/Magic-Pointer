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
const DshChat = require('../electron/renderer/dsh_chat');
assert.equal(typeof DshChat.createLiveTurn, 'function', 'Stage and Studio need the same incremental turn renderer');

const host = new TestNode('div');
// 展开态现在活在渲染层之外的 store 里，按稳定 id 取。测试直接改 data-open 不再
// 算数——那正是这一版要修的：重建时读的是 store，不是旧 DOM 上的残留属性。
DshChat.expansion.clear();
const live = DshChat.createLiveTurn(host);
const call = { phase: 'tool_call', fields: { id: 'r1', name: 'Read', args: '{"path":"notes.txt"}' } };
live.update({ answer: 'First', thinking: 'Reading', records: [call] });
const answer = host.querySelector('.dsh-stream-live');
const think = host.querySelector('.dsh-think');
const thinkBody = host.querySelector('.dsh-think-body');
const tool = host.querySelector('.dsh-tool');
think.setAttribute('data-open', 'true'); thinkBody.scrollTop = 19;
const structure = host.structuralChanges;
live.update({ answer: 'First answer', thinking: 'Reading\nComparing', records: [call] });
assert.equal(host.querySelector('.dsh-stream-live'), answer, 'answer node must survive chunks');
assert.equal(host.querySelector('.dsh-think'), think, 'reasoning node must survive chunks');
assert.equal(host.querySelector('.dsh-think-body'), thinkBody, 'expanded reasoning body must survive chunks');
assert.equal(think.getAttribute('data-open'), 'true');
assert.equal(thinkBody.scrollTop, 19);
assert.equal(host.structuralChanges, structure, 'chunks must not detach the turn children');
assert.equal(answer.textContent, 'First answer');
assert.equal(thinkBody.textContent, 'Reading\nComparing');
// 用户点开这一行：走 store，和点击路径写的是同一个地方。
DshChat.expansion.setRow(tool.querySelector('.dsh-disclosure').getAttribute('data-row-id'), true);
live.update({ answer: 'First answer', thinking: 'Reading\nComparing', records: [
  { phase: 'tool_result', fields: { ...call.fields, state: 'ok', result: 'read the actual contents' } },
] });
assert.equal(host.querySelector('.dsh-tool'), tool, 'settling the call retains its root');
assert.equal(tool.querySelector('.dsh-disclosure').getAttribute('data-open'), 'true');
assert.match(tool.textContent, /read the actual contents/, 'tool output must show real result content');

assert.equal(typeof DshChat.createConversationView, 'function');
const flow = new TestNode('div');
const view = DshChat.createConversationView(flow);
view.update({ id: 'c1', turns: [{ question: 'What is here?', outcome: '进行中', liveProgress: {
  answer: 'Partial', thinking: 'Inspecting', records: [call],
} }] });
const user = flow.querySelector('.dsh-user');
const liveAnswer = flow.querySelector('.dsh-stream-live');
view.update({ id: 'c1', turns: [{ question: 'What is here?', outcome: '进行中', liveProgress: {
  answer: 'Partial answer', thinking: 'Inspecting', records: [call],
} }] });
assert.equal(flow.querySelector('.dsh-user'), user);
assert.equal(flow.querySelector('.dsh-stream-live'), liveAnswer);
view.update({ id: 'c1', turns: [{ question: 'What is here?', answer: 'Final saved answer', thinking: 'Inspected' }] });
assert.equal(flow.querySelector('.dsh-user'), user, 'final notification must preserve the question node');
assert.match(flow.textContent, /Final saved answer/, 'current conversation must show the completed answer');
assert.doesNotMatch(flow.textContent, /Partial answer/);
console.log('shared live turn incremental renderer tests ok');

const thoughtHost = new TestNode('div');
const thoughtLive = DshChat.createLiveTurn(thoughtHost);
const longThought = 'Source inspection\n'.repeat(80);
thoughtLive.update({ trajectory: [{ kind: 'message', turn: 1, reasoning: longThought, state: 'running' }] });
const thoughtRoot = thoughtHost.querySelector('.dsh-think');
thoughtRoot.setAttribute('data-open', 'true');
thoughtLive.update({ trajectory: [{ kind: 'message', turn: 1, reasoning: longThought, state: 'done' }] });
assert.equal(thoughtHost.querySelector('.dsh-think'), thoughtRoot);
assert.equal(thoughtRoot.getAttribute('data-state'), 'ok', 'unchanged text must still settle thinking state');
assert.equal(thoughtRoot.getAttribute('data-long'), 'true', 'completed streamed thought needs bounded preview');
assert.equal(thoughtRoot.getAttribute('data-open'), 'true');
assert.ok(thoughtRoot.querySelector('.dsh-think-more'));

const agentHost = new TestNode('div');
const agentLive = DshChat.createLiveTurn(agentHost);
const agentRecord = { kind: 'tool', callId: 'pa', name: 'Agent', text: '{"task":"Check source"}', state: 'running',
  subagent: { id: 'ca', parentCallId: 'pa', status: 'running', phase: 'thinking', reasoning: 'Tracing event source', stepCount: 0 } };
agentLive.update({ trajectory: [agentRecord] });
assert.match(agentHost.textContent, /Tracing event source/);
const heartbeat = agentHost.querySelector('.dsh-subagent-heartbeat');
agentRecord.subagent.reasoning += '\nFound the handler';
agentLive.update({ trajectory: [agentRecord] });
assert.equal(agentHost.querySelector('.dsh-subagent-heartbeat'), heartbeat, 'child token updates preserve the parent row');
assert.match(agentHost.textContent, /Found the handler/);

const trace = [
  { kind: 'message', turn: 1, text: 'I will inspect the files.', reasoning: 'First reasoning', state: 'done' },
  { kind: 'tool', callId: 'a', name: 'Read', text: '{"path":"a.pdf"}', result: 'file missing', isError: true, state: 'error' },
  { kind: 'message', turn: 2, text: 'Trying the original source.', reasoning: 'Second reasoning', state: 'running' },
  { kind: 'tool', callId: 'b', name: 'Read', text: '{"path":"b.pdf"}', state: 'running' },
];
const transcriptHost = new TestNode('div');
const transcript = DshChat.createLiveTurn(transcriptHost);
transcript.update({ trajectory: trace, answer: 'Trying the original source.', thinking: 'Second reasoning' });
assert.equal(transcriptHost.querySelectorAll('.dsh-tool-group-body').length, 2, 'every live tool run has the reference border, including a single failed Read');
assert.equal(transcriptHost.querySelectorAll('.dsh-think').length, 2, 'reasoning survives the next model round');
assert.match(transcriptHost.textContent, /I will inspect the files/);
assert.match(transcriptHost.querySelectorAll('.dsh-tool')[0].querySelector('.dsh-row').textContent, /a.pdf/, 'failure must not replace the selected file with an error dump');
const before = transcriptHost.querySelectorAll('.dsh-tool-group')[0];
before.setAttribute('open', '');
transcript.update({ trajectory: trace, answer: 'Trying the original source.' });
assert.equal(transcriptHost.querySelectorAll('.dsh-tool-group')[0], before, 'stream updates preserve the expanded work record');
transcript.finish({ trajectory: trace.map(r => ({ ...r, state: 'done' })), answer: 'Complete.' });
assert.equal(transcriptHost.querySelectorAll('.dsh-think').length, 2, 'completed history retains all reasoning');
assert.equal(transcriptHost.querySelectorAll('.dsh-tool-group').length, 2);
assert(transcriptHost.querySelectorAll('.dsh-tool-group').every(n => n.getAttribute('open') === null), 'all completed tool runs start collapsed, even single calls');
assert.match(transcriptHost.textContent, /file missing/, 'collapsed history retains the complete error for reopening');

const groupHost = new TestNode('div');
const groupLive = DshChat.createLiveTurn(groupHost);
const firstTool = { kind: 'tool', callId: '1', name: 'Read', text: '{"path":"a.pdf"}', state: 'running' };
groupLive.update({ trajectory: [firstTool] });
assert.equal(groupHost.querySelector('.dsh-tool-group').getAttribute('data-single'), 'true');
groupLive.update({ trajectory: [firstTool, { ...firstTool, callId: '2', text: '{"path":"b.pdf"}' }] });
assert.equal(groupHost.querySelector('.dsh-tool-group').getAttribute('data-single'), null,
  'a second tool restores the individual rows instead of keeping singleton CSS');
const editHost = new TestNode('div');
DshChat.createLiveTurn(editHost).update({ trajectory: [
  { kind: 'tool', callId: 'e', name: 'Edit', text: '{"file_path":"a.py","old_string":"old","new_string":"new"}', state: 'running' },
] });
assert.match(editHost.querySelector('.dsh-tool-group-header').textContent, /\+1.*−1/,
  'single edit summary keeps the reference added/removed line counts visible');
const finishedHost = new TestNode('div');
DshChat.createLiveTurn(finishedHost).finish({ answer: 'Done.', trajectory: [
  firstTool, { kind: 'message', turn: 2, reasoning: 'Use the other file.', state: 'done' },
  { ...firstTool, callId: '2' },
] });
assert.equal(finishedHost.querySelectorAll('.dsh-tool-group').length, 1,
  'completion folds one uninterrupted work sequence into one reference summary');
assert.match(finishedHost.querySelector('.dsh-tool-group-body').textContent, /Use the other file/,
  'the folded work sequence keeps its intermediate reasoning available');

/* 用户在流式期间展开的思考行，轮末换成终态节点后不该自己收回去。
   这一条要的是「流式那侧和终态那侧用的是同一个 id」——以前两边各推各的，
   终态重建时读不到流式期间的展开态，于是用户刚点开的东西在轮末自己合上了。 */
DshChat.expansion.clear();
const handoffHost = new TestNode('div');
const handoffLive = DshChat.createLiveTurn(handoffHost, 'c9#0');
handoffLive.update({ trajectory: [{ kind: 'message', turn: 0, reasoning: '先读文件', state: 'running' }] });
const liveThinkRow = handoffHost.querySelector('.dsh-think');
const liveThinkId = liveThinkRow.getAttribute('data-row-id');
assert.ok(liveThinkId, 'a streaming thinking row must carry a stable id');
DshChat.expansion.setRow(liveThinkId, true); // 等同上用户点开这一行
handoffLive.finish({
  answer: '完成',
  conversationId: 'c9',
  turnIndex: 0,
  trajectory: [{ kind: 'message', turn: 0, reasoning: '先读文件', text: '' }],
});
assert.equal(handoffHost.querySelector('.dsh-think').getAttribute('data-open'), 'true',
  'a thinking row the user opened must survive the swap to the settled turn');
DshChat.expansion.clear();
console.log('expansion survives the live-to-settled swap');

const test = require('node:test');

test('intermediate thinking keeps its identity when completion folds it into a tool group', () => {
  DshChat.expansion.clear();
  const target = new TestNode('div');
  const renderer = DshChat.createLiveTurn(target, 'grouped#0');
  const trajectory = [
    { kind: 'tool', callId: 'read-first', name: 'Read', text: '{"path":"a.md"}', result: 'A', state: 'done' },
    { kind: 'message', turn: 2, reasoning: 'Compare with the other source.', state: 'done' },
    { kind: 'tool', callId: 'read-second', name: 'Read', text: '{"path":"b.md"}', result: 'B', state: 'done' },
  ];
  renderer.update({ trajectory });
  const id = target.querySelector('.dsh-think').getAttribute('data-row-id');
  DshChat.expansion.setRow(id, true);
  renderer.finish({ conversationId: 'grouped', turnIndex: 0, trajectory, answer: 'Compared.' });
  const settled = target.querySelector('.dsh-think');
  assert.equal(settled.getAttribute('data-row-id'), id);
  assert.equal(settled.getAttribute('data-open'), 'true');
});

test('a standalone Stage turn preserves expansion through finish without conversation metadata', () => {
  DshChat.expansion.clear();
  const target = new TestNode('div');
  const renderer = DshChat.createLiveTurn(target);
  renderer.update({ thinking: 'Inspecting the selected material.' });
  const id = target.querySelector('.dsh-think').getAttribute('data-row-id');
  DshChat.expansion.setRow(id, true);
  renderer.finish({ thinking: 'Inspected the selected material.', answer: 'Done.' });
  assert.equal(target.querySelector('.dsh-think').getAttribute('data-row-id'), id);
  assert.equal(target.querySelector('.dsh-think').getAttribute('data-open'), 'true');
});

test('provider call ids reused by separate conversations do not share expansion state', () => {
  DshChat.expansion.clear();
  const trajectory = [
    { kind: 'tool', callId: 'call_1', name: 'Read', text: '{"path":"a.md"}', result: 'A', state: 'done' },
    { kind: 'tool', callId: 'call_2', name: 'Read', text: '{"path":"b.md"}', result: 'B', state: 'done' },
  ];
  const a = new TestNode('div');
  const b = new TestNode('div');
  const first = DshChat.createConversationView(a);
  first.update({ id: 'session-a', turns: [{ trajectory, answer: 'Done A.' }] });
  const rowId = a.querySelector('.dsh-disclosure').getAttribute('data-row-id');
  const groupId = a.querySelector('.dsh-tool-group-header').getAttribute('data-group-id');
  DshChat.expansion.setRow(rowId, true);
  DshChat.expansion.setGroup(groupId, true);
  DshChat.createConversationView(b).update({ id: 'session-b', turns: [{ trajectory, answer: 'Done B.' }] });
  assert.notEqual(b.querySelector('.dsh-disclosure').getAttribute('data-row-id'), rowId);
  assert.equal(b.querySelector('.dsh-disclosure').getAttribute('data-open'), 'false');
  assert.equal(b.querySelector('.dsh-tool-group').getAttribute('open'), null);
});
