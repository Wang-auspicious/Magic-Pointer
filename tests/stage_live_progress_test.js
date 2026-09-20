'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const source = fs.readFileSync('electron/renderer/stage.ts', 'utf8');
const stageHtml = fs.readFileSync('electron/renderer/stage.html', 'utf8');
for (const dependency of ['claude_marks.js', 'dsh_highlight.js']) {
  assert.ok(stageHtml.includes(`src="${dependency}"`), `Stage must load the shared renderer dependency ${dependency}`);
}
const start = source.indexOf('  const runningCards = new Map');
const end = source.indexOf('  function buildTurn(', start);
const host = { replaceChildren() { throw new Error('progress must not clear the live card'); } };
const updates = [];
let creates = 0;
const context = {
  state: { turns: [{ id: 7, status: 'pending' }] },
  resultCard: { querySelector: () => host },
  workPanelScroller: { scrollHeight: 1000, scrollTop: 80, clientHeight: 300 },
  DshChat: {
    createLiveTurn(node) { assert.equal(node, host); creates++; return { update: value => updates.push(value) }; },
    bindDelegation() {},
  },
};
vm.runInNewContext(ts.transpileModule(source.slice(start, end), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText, context);
context.paintRunningCard(host, context.state.turns[0]);
for (let index = 1; index <= 8; index++) {
  context.patchRunningCard({ liveProgress: { answer: 'answer '.repeat(index), thinking: 'thinking '.repeat(index), records: [] } });
}
assert.equal(creates, 1, 'progress chunks must reuse the same shared renderer');
assert.equal(updates.length, 9);
assert.equal(updates.at(-1).answer, 'answer '.repeat(8));
assert.equal(context.workPanelScroller.scrollTop, 80, 'reading earlier content must not force scrolling');
context.workPanelScroller.scrollTop = 700;
context.patchRunningCard({ liveProgress: { answer: 'done', records: [] } });
assert.equal(context.workPanelScroller.scrollTop, 1000, 'following the bottom keeps the latest text visible');
assert.ok(!source.includes('renderFoldedProcess('), 'normal answers must not revive fabricated preliminary steps');
assert.ok(!source.includes('syncWaitClock('), 'Stage must not add an independent elapsed/status projection over the shared live renderer');
const rendered = [];
const turnHost = { dataset: {}, querySelector: () => ({ dataset: {} }) };
Object.assign(context, {
  tplThreadTurn: { content: { firstElementChild: { cloneNode: () => turnHost } } },
  renderStructured: (_node, value) => rendered.push(value),
  renderFailure: () => { throw new Error('a failed turn with a real answer must retain its shared transcript'); },
});
vm.runInNewContext(ts.transpileModule(source.slice(end, source.indexOf('  function renderThread(', end)), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText, context);
const failedResult = { answer: '已检查选区，但后续读取失败。', trajectory: [{ kind: 'tool', name: 'Look', state: 'error' }] };
context.buildTurn({ id: 7, status: 'failed', ask: '这是什么？', result: failedResult, error: { message: 'Provider unavailable' } });
assert.deepEqual(rendered, [failedResult]);
console.log('Stage shared live progress tests ok');
