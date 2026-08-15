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

// 主界面的「新对话」没有屏幕对象；两次点击新对话不能都并进 unknown 那一条。
const generic1 = store.appendTurn({ newConversation: true, question: '写一封请假邮件', answer: '草稿一。' });
const generic2 = store.appendTurn({ newConversation: true, question: '列一个采购清单', answer: '清单二。' });
assert.notStrictEqual(generic2.id, generic1.id, '明确的新对话必须新建，不能按 unknown 对象合并');

store.clear();
assert.strictEqual(store.list().length, 0);

fs.rmSync(dir, { recursive: true, force: true });
console.log('conversation store test ok');
