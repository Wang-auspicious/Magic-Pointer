'use strict';

// DSH 聊天渲染器契约（deepseek-harness 100% 移植）：
// 钉死用户气泡 / Think 行 / 工具调用行的 DOM 结构与展开、状态点、
// 复制动作、错误行——渲染层不拼 innerHTML，文本走文本节点。

const assert = require('node:assert');
const fs = require('node:fs');
const DshChat = require('../electron/renderer/dsh_chat');

const css = fs.readFileSync('electron/renderer/dsh_chat.css', 'utf8');
const tokens = fs.readFileSync('electron/renderer/dsh_tokens.css', 'utf8');
const html = (node) => (node ? node.outerHTML : '');

/* ---- 用户气泡（Figma User_Bubble r22，右对齐 + 时钟 + 复制） ---- */
const user = html(DshChat.userNode('把这个表格转成 CSV', 1729857600000));
assert(user.includes('class="dsh-user"'), 'user node must carry the DSH user row');
assert(user.includes('class="dsh-bubble"'), 'the question must render inside the DSH bubble');
assert(user.includes('把这个表格转成 CSV'));
assert(user.includes('class="dsh-action"'), 'the bubble must carry copy actions');
assert(user.includes('data-dsh-copy="把这个表格转成 CSV"'), 'copy action must carry the message text');
assert(!DshChat.userNode('<script>alert(1)</script>').outerHTML.includes('<script>'),
  'user text must be structural text, never concatenated HTML');

/* ---- 工具调用行：24px 行骨架 + IN/OUT 卡 + 状态点 ---- */
const model = DshChat.toolRowModel('write', JSON.stringify({ path: 'a.txt', content: 'x' }), { text: 'ok', isError: false });
assert.strictEqual(model.title, 'Write');
assert.strictEqual(model.summary, 'a.txt');
assert.strictEqual(model.state, 'ok');
const row = html(DshChat.toolRowNode(model));
assert(row.includes('class="dsh-tool"'), 'tool row root');
assert(row.includes('class="dsh-row"'), 'tool rows must share the 24px disclosure row chrome');
assert(row.includes('class="dsh-title">Write</span>'), 'row title = variant literal');
assert(row.includes('class="dsh-io-card"'), 'args/result must render as the IN/OUT card');
assert(row.includes('class="dsh-io-label">IN</span>'), 'input section must carry the IN gutter label');
assert(row.includes('class="dsh-io-label">OUT</span>'), 'result section must carry the OUT gutter label');
assert(row.includes('data-dsh-act="toggle"'), 'the row must be expandable via the shared delegation');

const collapsedByDefault = DshChat.toolRowNode(model).outerHTML;
assert(collapsedByDefault.includes('data-open="false"'), 'tool rows start collapsed');

const running = html(DshChat.toolRowNode(DshChat.toolRowModel('grep', JSON.stringify({ pattern: 'x' }), undefined)));
assert(running.includes('data-state="running"'), 'an unsettled call must render the running state');
assert(running.includes('class="dsh-vh"'), 'running state must carry a screen-reader label');
assert(css.includes('.dsh-tool[data-state=\'running\'] .dsh-row::after'),
  'the running sweep glare must exist in the stylesheet');

const failed = html(DshChat.toolRowNode(DshChat.toolRowModel('read', JSON.stringify({ path: 'b.txt' }), { text: 'no such file\nmore', isError: true })));
assert(failed.includes('class="dsh-dot"'), 'an error row must show the state dot');
assert(failed.includes('data-state="error"'), 'error state must ride the root');
assert(failed.includes('dsh-error-summary'), 'the collapsed error summary must use the error color');
assert(failed.includes('no such file'));

/* ---- 状态点四态 ---- */
assert(DshChat.stateDot('done').outerHTML.includes('data-state="done"'));
assert(DshChat.stateDot('warning').outerHTML.includes('data-state="warning"'));
assert(DshChat.stateDot('error').outerHTML.includes('data-state="error"'));
assert(DshChat.stateDot('ongoing').outerHTML.includes('class="dsh-matrix"'));

/* ---- Think 思考行 ---- */
const think = html(DshChat.thinkNode('先读这个文件\n再判断结构', false));
assert(think.includes('dsh-think"'), 'reasoning must render as the Think disclosure');
assert(think.includes('dsh-title">Think</span>'), 'the Think row title is the DSH literal');
assert(think.includes('先读这个文件'), 'collapsed summary = first line of reasoning');
assert(think.includes('class="dsh-think-body"'), 'expanded body must exist');
assert(think.includes('data-open="false"'), 'Think rows start collapsed');
const runningThink = html(DshChat.thinkNode('多行\n思考', true));
assert(runningThink.includes('data-state="running"'), 'a streaming Think row must carry the running state');
assert(runningThink.includes('思考'), 'a running row must follow the latest line');

/* ---- 助手回合组装：正文 + Think + 工具行 + 动作 ---- */
const turn = DshChat.assistantTurnNode({
  answer: '已转换。',
  thinking: '先解析表格',
  events: [{ name: 'read', arguments: { path: '表.csv' }, result: 'a,b', isError: false }],
  at: 1729857600000,
});
const turnHtml = turn.map(html).join('');
assert(turnHtml.includes('class="dsh-assistant"'), 'assistant root');
assert(turnHtml.includes('class="dsh-markdown"'), 'assistant text body');
assert(turnHtml.includes('已转换。'));
assert(turnHtml.includes('class="dsh-tool"'), 'structured events must render tool rows');
assert(turnHtml.includes('class="dsh-actions"'), 'settled answers must carry copy actions');

const errorTurn = DshChat.assistantTurnNode({ failed: true, at: 1 }).map(html).join('');
assert(errorTurn.includes('class="dsh-turn-error"'), 'a failed turn must render the DSH turn error row');
assert(errorTurn.includes('class="dsh-dot"'), 'the error row leads with the red state dot');

/* ---- 回合状态渐变字 ---- */
assert(DshChat.turnStatusNode('Thinking').outerHTML.includes('class="dsh-turn-status"'));
assert(css.includes('@keyframes dsh-turn-status-shimmer'), 'the status shimmer animation must exist');

/* ---- 样式契约：令牌与 CSS 一致（DSH 双档完整平台） ---- */
assert(tokens.includes('--dsw-specific-bubble: rgb(237, 243, 254)'), 'the DSH user bubble token must be DeepSeek-50 in light');
assert(tokens.includes('body[data-ds-dark-theme]'), 'the dark alias block must exist (DSH full platform)');
assert(tokens.includes('--dsw-specific-bubble: rgb(44, 44, 46)'), 'the dark user bubble must be bluish-850');
assert(css.includes('border-radius: 22px'), 'the bubble radius is the DSH 22px');
assert(css.includes('height: 24px'), 'rows keep the DSH 24px line height');
assert(css.includes('dsh-state-dot-chase'), 'the ongoing pixel-chase animation must exist');
assert(css.includes('prefers-reduced-motion'), 'reduced motion must disable the sweeps');

/* ---- 纯函数导出 ---- */
assert.strictEqual(DshChat.__test.firstLine('a\nb'), 'a');
assert.strictEqual(DshChat.__test.latestLine('a\nb'), 'b');
assert.strictEqual(DshChat.__test.classifyTool('web_search'), 'search');
assert.strictEqual(DshChat.__test.classifyTool('unknown_tool'), 'others');
assert.strictEqual(DshChat.__test.deriveSummary('read', JSON.stringify({ path: 'x/y.md' })), 'x/y.md');
assert.match(DshChat.__test.formatClock(1729857600000), /^\d{2}:\d{2}$/, 'clock = local HH:MM');

/* ---- 复制：失败不得假装成功（Promise 校验 + textarea 兜底） ---- */
const src = fs.readFileSync('electron/renderer/dsh_chat.ts', 'utf8');
assert(src.includes('copyToClipboard(text).then((ok: boolean) =>'), 'copy must wait on the clipboard promise');
assert(src.includes('fallbackCopyText(text)'), 'clipboard failure must fall back to execCommand');
assert(src.includes('button.setAttribute(\'aria-label\', \'复制失败\')'),
  'a failed copy must not show the success checkmark');
assert(src.includes('document.execCommand(\'copy\')'), 'the fallback must use the textarea copy trick');

console.log('studio dsh chat contract test ok');
