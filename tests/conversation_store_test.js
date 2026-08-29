'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createConversationStore, objectKey, titleFrom, isSubstantiveQuestion } = require('../electron/conversation_store');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-conv-'));
let clock = 1_770_000_000_000;
const store = createConversationStore({ baseDir: dir, now: () => (clock += 1000) });

const excel = { app: 'EXCEL.EXE', windowTitle: '2026Q3.xlsx', elementPath: 'sheet1/C1:E9', label: 'C:E 列' };
const code = { app: 'Code.exe', windowTitle: 'uia_text_adapter.py', elementPath: 'line:118', label: '第 118 行' };

// ---- 对象标识：拿不到元素路径要退到标题，别每次都算成新对象 ----
assert.strictEqual(objectKey(excel), 'EXCEL.EXE|2026Q3.xlsx|sheet1/C1:E9');
assert.strictEqual(objectKey({ app: 'a', windowTitle: 'b' }), 'a|b');
assert.strictEqual(objectKey({}), 'unknown');
assert.strictEqual(objectKey({ app: 'a' }), objectKey({ app: 'a' }), '同一输入必须得到同一个键');
// 瞬态 elementPath（每次划线都新的 UUID）不得拆散记忆：同窗口的两次划线必须同键
assert.strictEqual(
  objectKey({ app: 'explorer', windowTitle: '参考 - 文件资源管理器', elementPath: 'selection-bba81fadfb354707' }),
  objectKey({ app: 'explorer', windowTitle: '参考 - 文件资源管理器', elementPath: 'selection-cf0b1fdbe6ce4d0a' }),
  'selection-UUID 必须降级，否则记忆全是碎片',
);
assert.strictEqual(
  objectKey({ app: 'a', windowTitle: 'b', elementPath: 'selection-deadbeef' }),
  'a|b',
  'UUID 元素路径应丢弃',
);

// ---- 标题：规则化小结，不是问题原文截断 ----
assert.strictEqual(titleFrom('  这段代码  在干嘛？ '), '代码');
assert.strictEqual(titleFrom('帮我总结这个表格是什么意思'), '总结这个表格');
assert.strictEqual(titleFrom('为什么这段代码会崩溃'), '代码会崩溃');
assert.strictEqual(titleFrom(''), '未命名');
assert.ok(titleFrom('x'.repeat(60)).endsWith('…'));

// ---- 记忆准入：问候/泛问不算记忆 ----
assert.ok(isSubstantiveQuestion('为什么这段代码会崩溃'));
assert.ok(isSubstantiveQuestion('描述这个图'));
assert.ok(!isSubstantiveQuestion('你好'));
assert.ok(!isSubstantiveQuestion('这是什么'));
assert.ok(!isSubstantiveQuestion('这啥'));
assert.ok(!isSubstantiveQuestion(''));

// ---- 第一次指某个对象 → 新建 ----
const c1 = store.appendTurn({ question: '这段代码在干嘛？', answer: 'UIA 硬超时兜底。', object: code });
assert.strictEqual(c1.turns.length, 1);
assert.strictEqual(c1.title, '代码');
assert.strictEqual(c1.subtitle, 'Code.exe · 第 118 行');

// ---- 追问同一个对象 → 接在同一条上，不新开 ----
const c1b = store.appendTurn({ question: '那 600ms 会不会太保守？', answer: '不会。', object: code });
assert.strictEqual(c1b.id, c1.id, '追问必须接在同一条对话上');
assert.strictEqual(c1b.turns.length, 2);

// ---- 指了别的对象 → 另起一条 ----
const c2 = store.appendTurn({ question: '把这三列汇总', answer: '合计 1,240。', object: excel,
  artifacts: [{ name: '汇总结果', kind: 'text' }] });
assert.notStrictEqual(c2.id, c1.id);
assert.strictEqual(store.list().length, 2);

// ---- 最近碰过的排最前 ----
assert.strictEqual(store.list()[0].id, c2.id);
store.appendTurn({ question: '再看一眼', answer: '嗯。', object: code });
assert.strictEqual(store.list()[0].id, c1.id, '刚追问过的应当回到最前');

// ---- 落盘：换一个 store 实例读同一个目录，历史还在 ----
const reopened = createConversationStore({ baseDir: dir, now: () => clock });
assert.strictEqual(reopened.list().length, 2, '重开之后历史必须还在');
assert.strictEqual(reopened.get(c1.id).turns.length, 3);
assert.strictEqual(reopened.get('nope'), null);

// ---- 时间线按天分组 ----
const days = store.timeline();
assert.strictEqual(days.length, 1, '同一天的应当归到一组');
assert.strictEqual(days[0].items.length, 2);

// ---- 记忆：指过一次的不算，反复指到的才算 ----
const mem = store.memories(3);
assert.strictEqual(mem.length, 1, '只有被指到 3 次以上的对象才进记忆');
assert.strictEqual(mem[0].object.windowTitle, 'uia_text_adapter.py');
assert.strictEqual(store.memories(1).length, 2);

// ---- 产物：跨对话汇总，按时间倒序 ----
const arts = store.artifacts();
assert.strictEqual(arts.length, 1);
assert.strictEqual(arts[0].name, '汇总结果');
assert.strictEqual(arts[0].from, '把这三列汇总', '产物要能说清它是从哪次问答里出来的');

// ---- 显式指定 conversationId 时以它为准 ----
const forced = store.appendTurn({ conversationId: c2.id, question: '再算一次', answer: '一样。', object: code });
assert.strictEqual(forced.id, c2.id, '显式给了 conversationId 就不要再按对象猜');

// ---- 工具链事件：Agent 每轮的工具调用要能跟着对话一起落盘并读回 ----
const tooled = store.appendTurn({
  newConversation: true,
  question: '列出进程',
  answer: '找到了。',
  events: [
    { name: 'pwsh', arguments: { command: 'Get-Process' }, result: 'explorer', isError: false,
      usedBackend: 'subprocess', latencyMs: 82 },
    { name: 'read', arguments: { path: 'a.txt' }, result: 'boom', isError: true },
  ],
  activities: [{ kind: 'model', turn: 1, state: 'done', latencyMs: 625, firstTokenMs: 118 }],
  trajectory: [
    { seq: 1, kind: 'message', turn: 1, step: 1, state: 'done', startedAt: 10, completedAt: 635 },
    { seq: 2, kind: 'tool', turn: 1, callId: 'pwsh-1', name: 'pwsh', state: 'done', startedAt: 20, completedAt: 102 },
  ],
  receipts: [{ toolName: 'pwsh', usedBackend: 'subprocess', latencyMs: 82 }],
  modelUsage: { inputTokens: 120, outputTokens: 30, totalTokens: 150 },
  timingMs: 910,
  usedBackend: 'openai-compatible',
  agentSessionId: 'agent-studio-abc123',
  hasPendingWork: true,
});
assert.strictEqual(tooled.turns.length, 1);
assert.strictEqual(tooled.turns[0].events.length, 2, '工具链事件必须随回合持久化');
assert.strictEqual(tooled.turns[0].events[0].name, 'pwsh');
assert.strictEqual(tooled.turns[0].events[1].isError, true);
assert.strictEqual(tooled.turns[0].events[0].latencyMs, 82, 'tool latency must survive persistence');
assert.strictEqual(tooled.turns[0].events[0].usedBackend, 'subprocess', 'tool backend must survive persistence');
assert.strictEqual(tooled.turns[0].activities[0].firstTokenMs, 118, 'model lifecycle must survive persistence');
assert.strictEqual(tooled.turns[0].trajectory[1].callId, 'pwsh-1', 'ordered DSH trajectory records must survive persistence');
assert.strictEqual(tooled.turns[0].receipts[0].toolName, 'pwsh', 'audit receipts must survive persistence');
assert.strictEqual(tooled.turns[0].modelUsage.totalTokens, 150, 'real model token usage must survive persistence');
assert.strictEqual(tooled.turns[0].timingMs, 910, 'real turn time must survive persistence');
assert.strictEqual(tooled.turns[0].usedBackend, 'openai-compatible', 'model backend must survive persistence');
assert.strictEqual(tooled.agentSessionId, 'agent-studio-abc123', 'durable Agent session identity must survive on the thread');
assert.strictEqual(tooled.hasPendingWork, true, 'unfinished work must be visible at thread level');
const tooledAgain = createConversationStore({ baseDir: dir, now: () => clock }).get(tooled.id);
assert.strictEqual(tooledAgain.turns[0].events.length, 2, '重开 store 后工具链事件仍在');
assert.strictEqual(tooledAgain.turns[0].modelUsage.outputTokens, 30, '重开 store 后 token usage 仍在');
assert.strictEqual(tooledAgain.turns[0].trajectory[0].seq, 1, '重开 store 后 trajectory 顺序仍在');
assert.strictEqual(tooledAgain.hasPendingWork, true, '重开 store 后待续标记仍在');

// 没有 events 的旧回合读回来是空数组，不崩。
const plain = store.appendTurn({ newConversation: true, question: '普通一问', answer: '普通一答。' });
assert.ok(Array.isArray(plain.turns[0].events), '无事件回合也应有 events 字段（空数组）');

// 主界面的「新对话」没有屏幕对象；两次点击新对话不能都并进 unknown 那一条。
const generic1 = store.appendTurn({ newConversation: true, question: '写一封请假邮件', answer: '草稿一。' });
const generic2 = store.appendTurn({ newConversation: true, question: '列一个采购清单', answer: '清单二。' });
assert.notStrictEqual(generic2.id, generic1.id, '明确的新对话必须新建，不能按 unknown 对象合并');

// ---- Codex thread workspace_roots：工作区是线程属性，不随别的会话漂移 ----
const wsA = store.appendTurn({
  newConversation: true,
  question: '看看这个仓库',
  answer: '好。',
  workspaceRoot: 'C:/repos/alpha',
});
assert.strictEqual(wsA.workspaceRoot, 'C:/repos/alpha', '新会话必须记住自己的工作区');

// 同会话追问（不带显式 root）保持原绑定；带显式 root 则线程跟随芯片前进。
store.appendTurn({ conversationId: wsA.id, question: '再看看', answer: '嗯。' });
assert.strictEqual(store.get(wsA.id).workspaceRoot, 'C:/repos/alpha', '追问不得丢线程工作区');
store.appendTurn({ conversationId: wsA.id, question: '换到 beta', answer: '好。', workspaceRoot: 'C:/repos/beta' });
assert.strictEqual(store.get(wsA.id).workspaceRoot, 'C:/repos/beta', '显式换工作区只改本线程');

// 另一会话不受影响（全局默认不被芯片改写的核心断言）。
const wsB = store.appendTurn({ newConversation: true, question: '另一个会话', answer: '好。', workspaceRoot: 'C:/repos/gamma' });
assert.strictEqual(wsB.workspaceRoot, 'C:/repos/gamma');
assert.notStrictEqual(wsB.workspaceRoot, store.get(wsA.id).workspaceRoot, '线程之间工作区互不污染');

// list() 摘要必须携带 workspaceRoot，侧栏分组靠它。
const listed = store.list().find((c) => c.id === wsA.id);
assert.strictEqual(listed.workspaceRoot, 'C:/repos/beta', 'list 摘要要带工作区');

// ---- 项目先于对话存在：打开空文件夹后也必须留在左栏 ----
const emptyProject = store.registerProject('C:/repos/empty-project');
assert.strictEqual(emptyProject.name, 'empty-project');
assert(store.listProjects().some((project) => project.root.endsWith('empty-project')),
  '还没有对话的项目也必须持久化');
const reopenedProjects = createConversationStore({ baseDir: dir, now: () => clock }).listProjects();
assert(reopenedProjects.some((project) => project.root.endsWith('empty-project')),
  '重启后仍要看见已经打开过的空项目');

store.clear();
assert.strictEqual(store.list().length, 0);

fs.rmSync(dir, { recursive: true, force: true });
console.log('conversation store test ok');

// ---- 线程级权限授权（CC toolPermissionDecision）：授权/拒绝随会话持久，
// 同名去重，list() 摘要携带，追问不丢。----
const pmA = store.appendTurn({
  newConversation: true, question: '跑构建', answer: '好。',
  permissionGrant: 'run_command',
});
assert.deepStrictEqual(pmA.permissionGrants, ['run_command'], '授权必须记进线程');
store.appendTurn({ conversationId: pmA.id, question: '再跑', answer: '好。', permissionGrant: 'run_command' });
store.appendTurn({ conversationId: pmA.id, question: '继续', answer: '好。', permissionGrant: 'read_background' });
assert.deepStrictEqual(
  store.get(pmA.id).permissionGrants, ['run_command', 'read_background'],
  '同名授权必须去重，不同工具追加',
);
store.appendTurn({ conversationId: pmA.id, question: '别开应用', answer: '好。', permissionDeny: 'launch_app' });
assert.deepStrictEqual(store.get(pmA.id).permissionDenials, ['launch_app'], '拒绝也要进线程 memo');
const pmListed = store.list(10).find((c) => c.id === pmA.id);
assert.deepStrictEqual(pmListed.permissionGrants, ['run_command', 'read_background'], 'list 摘要带授权');
assert.deepStrictEqual(pmListed.permissionDenials, ['launch_app'], 'list 摘要带拒绝');

console.log('conversation store test ok (permission memo)');

// ── Stage↔GUI 实时同步：updateTurn 就地补 answer/终态 ─────────────────
{
  const liveStore = createConversationStore({ baseDir: fs.mkdtempSync(path.join(os.tmpdir(), 'mp-conv-live-')), now: () => (clock += 1000) });
  const conversation = liveStore.appendTurn({ question: '圈选的问题', answer: '', outcome: '进行中' });
  assert.strictEqual(conversation.turns.length, 1);
  assert.strictEqual(conversation.turns[0].outcome, '进行中');

  const updated = liveStore.updateTurn({
    conversationId: conversation.id,
    answer: '流式到达的答案',
    outcome: '已完成',
    modelUsage: { totalTokens: 4321 },
  });
  assert.ok(updated.ok, 'updateTurn on a live turn must succeed');

  const reread = liveStore.get(conversation.id);
  assert.strictEqual(reread.turns.length, 1, 'must update in place, not append a second turn');
  assert.strictEqual(reread.turns[0].answer, '流式到达的答案');
  assert.strictEqual(reread.turns[0].outcome, '已完成');
  assert.strictEqual(reread.turns[0].modelUsage.totalTokens, 4321);

  assert.strictEqual(liveStore.updateTurn({ conversationId: 'nope' }).ok, false,
    'unknown conversation id fails honestly');
}

// ---- 思考流（P0-1）：turn.thinking 持久化，渲染层 Think 行的数据源 ----
{
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-conv-think-'));
  const thinkStore = createConversationStore({ baseDir: dir2, now: () => (clock += 1000) });
  const conversation = thinkStore.appendTurn({ question: '解释一下', answer: '' });
  assert.strictEqual(conversation.turns[0].thinking, undefined, '没有思考流时不造假字段');

  const withThink = thinkStore.updateTurn({
    conversationId: conversation.id,
    answer: '答',
    thinking: '先定位数据结构\n再推断含义',
  });
  assert.ok(withThink.ok);
  assert.strictEqual(withThink.conversation.turns[0].thinking, '先定位数据结构\n再推断表达'.replace('表达', '含义'),
    'updateTurn 必须持久化 thinking（Think 行的数据源）');

  const noThink = thinkStore.updateTurn({ conversationId: conversation.id, answer: '答2' });
  assert.ok(noThink.ok);
  assert.strictEqual(noThink.conversation.turns[0].thinking, '先定位数据结构\n再推断含义',
    '不带 thinking 的更新不得清掉已有的思考流');
}
