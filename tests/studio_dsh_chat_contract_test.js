'use strict';

// Studio 聊天语义契约：保留已经正确的文本安全、真实 reasoning、工具证据
// 与折叠逻辑；视觉由 Claude-fidelity token/chat CSS 统一承载。

const assert = require('node:assert');
const fs = require('node:fs');
const DshChat = require('../electron/renderer/dsh_chat');

const css = fs.readFileSync('electron/renderer/claude_chat.css', 'utf8');
const tokens = fs.readFileSync('electron/renderer/claude_tokens.css', 'utf8');
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
assert.strictEqual(model.title, 'Wrote');
assert.strictEqual(model.summary, 'a.txt');
assert.strictEqual(model.state, 'ok');
const row = html(DshChat.toolRowNode(model));
assert(row.includes('class="dsh-tool"'), 'tool row root');
assert(row.includes('class="dsh-row"'), 'tool rows must share the 24px disclosure row chrome');
assert(row.includes('class="dsh-title">Wrote</span>'),
  'row title is the completed action ("Wrote a.txt"), never the bare noun');
/* 展开体是「一张代码卡 + 卡下面的原文输出」，不是 IN/OUT 分栏：人读的是
   「跑了什么」和「回了什么」，标签把这两件事摆成了两个格子。 */
assert(row.includes('class="dsh-diff"'), 'the expanded write body renders its actual added lines');
assert(row.includes('class="dsh-tool-output"'), 'the result renders as plain output text below the card');
assert(!row.includes('dsh-io-label'), 'the IN/OUT gutter labels are gone');
assert(row.includes('data-dsh-act="toggle"'), 'the row must be expandable via the shared delegation');
assert(html(DshChat.toolRowNode(DshChat.toolRowModel('Read', '{"path":"a.txt"}'))).includes('data-dsh-act="copy"'),
  'a non-diff command card carries its own copy action');

const collapsedByDefault = DshChat.toolRowNode(model).outerHTML;
assert(collapsedByDefault.includes('data-open="false"'), 'tool rows start collapsed');

const agentModel = DshChat.toolRowModel(
  'Agent',
  JSON.stringify({ task: '核对 Inspector 文件预览' }),
  undefined,
  'parent-agent-1',
);
assert.strictEqual(agentModel.title, 'Running subagent');
assert.strictEqual(agentModel.summary, '核对 Inspector 文件预览');
const agentRow = html(DshChat.toolRowNode(agentModel));
assert(agentRow.includes('data-dsh-act="open-subagent"'),
  'an Agent row opens the matching Tasks lane instead of a generic local disclosure');
assert(agentRow.includes('data-subagent-parent-call-id="parent-agent-1"'));

const running = html(DshChat.toolRowNode(DshChat.toolRowModel('grep', JSON.stringify({ pattern: 'x' }), undefined)));
assert(running.includes('data-state="running"'), 'an unsettled call must render the running state');
assert(running.includes('class="dsh-vh"'), 'running state must carry a screen-reader label');
assert(!css.includes('.dsh-tool[data-state=\'running\'] .dsh-row::after'),
  'the Claude-fidelity activity row must not use a perpetual sweep glare');

const failed = html(DshChat.toolRowNode(DshChat.toolRowModel('read', JSON.stringify({ path: 'b.txt' }), { text: 'no such file\nmore', isError: true })));
assert(failed.includes('dsh-tool-caret'), 'failed tools retain the same disclosure caret as successful tools');
assert(failed.includes('data-state="error"'), 'error state must ride the root');
assert(failed.includes('b.txt'), 'a failed read keeps the requested file visible');
assert(failed.includes('no such file'));
assert(failed.includes('class="dsh-tool-output"'),
  'a tool result renders as plain output text, not as an OUT gutter label');
assert(failed.includes('data-error="true"'), 'a failed result keeps its error coloring');

/* ---- 编辑工具 diff 卡：红删绿加，不再让用户读 JSON 汤 ---- */
const editArgs = JSON.stringify({ path: 'a.py', old_string: 'x = 1\ny = 2', new_string: 'x = 42\ny = 2' });
const editDiff = DshChat.toolRowNode(DshChat.toolRowModel('edit_file', editArgs)).outerHTML;
assert(editDiff.includes('class="dsh-diff"'), 'edit_file must render a diff card');
assert(editDiff.includes('dsh-diff-line data-kind="del"') || /dsh-diff-line[^>]*data-kind="del"/.test(editDiff),
  'removed lines must carry the del marker');
assert(/dsh-diff-line[^>]*data-kind="add"/.test(editDiff), 'added lines must carry the add marker');
assert(editDiff.includes('- x = 1'), 'deleted lines show their literal content');
assert(editDiff.includes('+ x = 42'), 'added lines show their literal content');
assert(!editDiff.includes('old_string'), 'raw argument names must not leak into the diff view');

const canonicalEdit = DshChat.toolRowNode(DshChat.toolRowModel('Edit', editArgs)).outerHTML;
assert(canonicalEdit.includes('class="dsh-diff"') && canonicalEdit.includes('- x = 1'),
  'the production Edit tool must render the same removed and added lines');
const canonicalWrite = DshChat.toolRowNode(DshChat.toolRowModel('Write', JSON.stringify({ path: 'a.txt', content: 'written' }))).outerHTML;
assert(canonicalWrite.includes('class="dsh-diff"') && canonicalWrite.includes('+ written'),
  'the production Write tool must render its actual new content');

const writeDiff = DshChat.toolRowNode(DshChat.toolRowModel('write_file', JSON.stringify({ path: 'n.txt', content: 'a\nb' }))).outerHTML;
assert(/dsh-diff-line[^>]*data-kind="add"/.test(writeDiff) && writeDiff.includes('+ a'), 'write_file renders as an all-add diff');

// 行数上限：超长 diff 折叠并给出省略提示，不能撑爆 DOM。
const bigOld = Array.from({ length: 120 }, (_, i) => `old ${i}`).join('\n');
const capped = DshChat.__test.deriveDiff('edit_file', JSON.stringify({ path: 'p', old_string: bigOld, new_string: 'new' }));
assert(capped && capped.hidden >= 80, `over-cap lines must collapse with a count (hidden=${capped && capped.hidden})`);
assert(!/dsh-diff/.test(DshChat.toolRowNode(DshChat.toolRowModel('grep', JSON.stringify({ pattern: 'x' }))).outerHTML),
  'read-only tools must not grow a diff card');

/* ---- 状态点四态 ---- */
assert(DshChat.stateDot('done').outerHTML.includes('data-state="done"'));
assert(DshChat.stateDot('warning').outerHTML.includes('data-state="warning"'));
assert(DshChat.stateDot('error').outerHTML.includes('data-state="error"'));
assert(DshChat.stateDot('ongoing').outerHTML.includes('class="dsh-matrix"'));

/* ---- Think 思考行 ---- */
const think = html(DshChat.thinkNode('先读这个文件\n再判断结构', false));
assert(think.includes('dsh-think"'), 'reasoning must render as the Think disclosure');
assert(think.includes('dsh-title">Thought</span>'), 'completed reasoning uses Claude\'s timeline label');
assert(think.includes('先读这个文件'), 'collapsed summary = first line of reasoning');
assert(think.includes('class="dsh-think-body"'), 'expanded body must exist');
assert(think.includes('data-open="false"'), 'Think rows start collapsed');
const longThink = html(DshChat.thinkNode('推理步骤。'.repeat(120), false));
assert(longThink.includes('data-long="true"'), 'long completed reasoning must expose the 200px disclosure cap');
assert(longThink.includes('class="dsh-think-viewport"'));
assert(longThink.includes('class="dsh-think-fade"'));
assert(longThink.includes('data-dsh-act="think-more"'));
assert(longThink.includes('Show more'));
const runningThink = html(DshChat.thinkNode('多行\n思考', true));
assert(runningThink.includes('data-state="running"'), 'a streaming Think row must carry the running state');
assert(runningThink.includes('Thinking…'), 'a running row uses Claude\'s exact status label');
assert(!runningThink.includes('data-long="true"'), 'streaming reasoning must remain uncapped');

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

/* ---- CC 折叠协议：叙述段 + 单行工具芯片，证据在展开里 ---- */
const flowingTurn = DshChat.assistantTurnNode({
  answer: '这个项目是一个 Obsidian 日记技能，包含脚本和评估用例。',
  trajectory: [
    { kind: 'message', turn: 1, state: 'done', text: '我先看看目录结构。' },
    { kind: 'notice', state: 'done', text: '已注册 130 个工具，超过本轮上限 128；本轮未暴露：mcp_alpha、mcp_beta。' },
    { kind: 'tool', turn: 1, callId: 'c1', name: 'search', state: 'done', text: 'obsidian-daily-log/README.md' },
    { kind: 'message', turn: 2, state: 'done', text: '找到文件了，我读一下。' },
    { kind: 'tool', turn: 2, callId: 'c2', name: 'read_file', state: 'error', text: 'Error calling tool (read_file): not found: README.md' },
    { kind: 'tool', turn: 2, callId: 'c3', name: 'read_file', state: 'done', text: '# Obsidian Daily Log' },
    { kind: 'message', turn: 3, state: 'done', text: '这个项目是一个 Obsidian 日记技能，包含脚本和评估用例。' },
  ],
  events: [
    { name: 'search', arguments: { pattern: '**/*' }, result: 'obsidian-daily-log/README.md', isError: false },
    { name: 'read_file', arguments: { path: 'README.md' }, result: 'Error calling tool (read_file): not found: README.md', isError: true },
    { name: 'read_file', arguments: { path: 'obsidian-daily-log/README.md' }, result: '# Obsidian Daily Log', isError: false },
  ],
}).map(html).join('');
assert(flowingTurn.includes('class="dsh-narration"'), 'model narration must render as visible prose');
assert(flowingTurn.includes('我先看看目录结构。'));
assert(flowingTurn.includes('class="dsh-notice"'),
  'trajectory notice must remain visible beside normal message/tool rows');
assert(flowingTurn.includes('超过本轮上限 128'),
  'tool truncation notice text must reach the Studio conversation');
assert(!flowingTurn.includes('class="dsh-think"'),
  'fake per-round Think rows must be gone');
assert(!flowingTurn.includes('运行记录'),
  'the 运行记录 N 步 cluster header must be gone');
assert(flowingTurn.includes('class="dsh-tool-group"'),
  'consecutive tool calls must group into one rounded container');
assert(flowingTurn.includes('class="dsh-narration"') === true);
// 叙述按顺序夹在工具之间：先叙述，再工具芯片，再叙述，再工具组。
assert(flowingTurn.indexOf('我先看看目录结构。') < flowingTurn.indexOf('dsh-summary'),
  'narration precedes the first tool chip it introduces');
assert(flowingTurn.indexOf('找到文件了，我读一下。') > flowingTurn.indexOf('obsidian-daily-log/README.md'),
  'the second narration comes after the first tool chip');
assert(flowingTurn.indexOf('找到文件了，我读一下。') < flowingTurn.indexOf('Read 2 files'),
  'the second narration precedes the tool group it introduces');
// 展开证据保留：参数在芯片展开体里（这个 fixture 的 trajectory 工具没带结果，
// 结果文本另有一条用例覆盖）。
assert(flowingTurn.includes('dsh-code'), 'expanded evidence (the command card) must survive');
// 错误芯片：失败摘要可见（红），不是只靠颜色。
assert(flowingTurn.includes('not found: README.md'));
// 最终答案不与最后一轮叙述重复渲染。
assert((flowingTurn.match(/>这个项目是一个 Obsidian 日记技能，包含脚本和评估用例。</g) || []).length === 1,
  'final-round narration must not duplicate the answer (text nodes only)');

/* ---- 工具组标题折叠：连续同类工具折成 "Read N files ⌄" ---- */
const groupedReads = DshChat.assistantTurnNode({
  answer: '读完。',
  trajectory: Array.from({ length: 3 }, (_, index) => ({
    kind: 'tool', turn: 1, callId: `r${index}`, name: 'read_file', state: 'done',
    text: JSON.stringify({ path: `f${index}.md` }), result: 'x',
  })),
  events: Array.from({ length: 3 }, (_, index) => ({
    name: 'read_file', arguments: { path: `f${index}.md` }, result: 'x', isError: false,
  })),
}).map(html).join('');
assert(groupedReads.includes('Read 3 files'),
  'consecutive reads must collapse into one "Read N files" group header');
assert(groupedReads.includes('f0.md') && groupedReads.includes('f2.md'),
  'the collapsed group still carries the per-file chips inside');
assert(!/<details[^>]*class="dsh-tool-group"[^>]*\sopen(?:=|\s|>)/.test(groupedReads),
  'Claude tool groups start collapsed and reveal evidence only on demand');

/* ---- 参考图逐字轨迹：真实组标题、工具动作语法与尾部 meta 顺序 ---- */
const referenceFlow = DshChat.assistantTurnNode({
  answer: '读完了。',
  trajectory: [
    { kind: 'message', text: '我先找到本地的两个 md 文件,同时看看目录结构。' },
    { kind: 'tool', groupLabel: 'Found files, ran a command', name: 'search', callId: 's1',
      text: JSON.stringify({ pattern: '**/*.md' }), result: 'VisLexicon-完整方案.md\nrebuttal.md', state: 'done',
      startedAt: 1000, completedAt: 9000 },
    { kind: 'tool', groupLabel: 'Found files, ran a command', name: 'list_dir', callId: 'l1',
      text: JSON.stringify({ path: '.' }), result: 'VisLexicon-完整方案.md\nrebuttal.md', state: 'done',
      startedAt: 9000, completedAt: 12000 },
    { kind: 'message', text: '找到两个文件了,我读一下。' },
    { kind: 'tool', groupLabel: 'Read 2 files', name: 'read_file', callId: 'r1',
      text: JSON.stringify({ path: 'VisLexicon-完整方案.md' }), result: '内容', state: 'done',
      startedAt: 12000, completedAt: 30000 },
    { kind: 'tool', groupLabel: 'Read 2 files', name: 'read_file', callId: 'r2',
      text: JSON.stringify({ path: 'rebuttal.md' }), result: '内容', state: 'done',
      startedAt: 30000, completedAt: 68000 },
  ],
  modelUsage: { totalTokens: 417 },
}).map(html).join('');
assert(referenceFlow.includes('Found files, ran a command'),
  'reference mixed tool group keeps Claude\'s exact group label');
assert(referenceFlow.includes('Searched') && referenceFlow.includes('**/*.md'),
  'search tool uses the completed-action label from the reference');
assert(referenceFlow.includes('Listed files in working directory'),
  'directory listing uses the completed-action label from the reference');
assert(referenceFlow.includes('Read') && referenceFlow.includes('VisLexicon-完整方案.md') && referenceFlow.includes('rebuttal.md'),
  'read chips preserve both exact reference filenames');
assert(!/<details[^>]*class="dsh-tool-group"[^>]*\sopen(?:=|\s|>)/.test(referenceFlow),
  'completed groups collapse as in the final user reference, including two-item groups');
assert(referenceFlow.indexOf('读完了。') < referenceFlow.indexOf('1m 7s · 417 tokens'),
  'the final answer appears before the run meta, as in the reference transcript');
assert(referenceFlow.includes('dsh-tool-caret'),
  'tool chips expose a trailing disclosure caret rather than a leading generic chevron');

const explicitActionLabels = DshChat.assistantTurnNode({
  trajectory: [
    { kind: 'tool', name: 'Bash', summary: 'Checked git status and recent commits', callId: 'g1', state: 'done', text: '{"command":"git status"}', result: 'clean' },
    { kind: 'message', text: 'Mandatory docs first per AGENTS.md.' },
    { kind: 'tool', name: 'Read', summary: 'Read STATUS.md', callId: 'r1', state: 'done', text: '{"file_path":"docs/STATUS.md"}', result: 'loaded' },
  ],
}).map(html).join('');
assert(explicitActionLabels.includes('Checked git status and recent commits'),
  'a truthful stored action summary must override generic tool wording');
assert(explicitActionLabels.includes('Read STATUS.md'),
  'reference action labels must survive as individual tool rows');

/* ---- 无 trajectory 的事件降级：不再画假 Think 行 ---- */
const eventsOnly = DshChat.assistantTurnNode({
  answer: 'ok',
  activities: [{ kind: 'model', turn: 1, latencyMs: 1200 }, { kind: 'model', turn: 2, latencyMs: 900 }],
  events: [{ name: 'search', arguments: { pattern: '**/*.md' }, result: 'a.md', isError: false }],
}).map(html).join('');
assert(!eventsOnly.includes('dsh-think'), 'model activities without content must not become Think rows');
assert(eventsOnly.includes('**/*.md'));

const errorTurn = DshChat.assistantTurnNode({ failed: true, at: 1 }).map(html).join('');
assert(errorTurn.includes('class="dsh-turn-error"'), 'a failed turn must render the DSH turn error row');
assert(errorTurn.includes('class="dsh-dot"'), 'the error row leads with the red state dot');

/* ---- 回合状态只呈现真实文字，不跑永久 shimmer ---- */
assert(DshChat.turnStatusNode('Thinking').outerHTML.includes('class="dsh-turn-status"'));
assert(!css.includes('@keyframes dsh-turn-status-shimmer'), 'perpetual status shimmer must be removed');

/* ---- 样式契约：Claude 精确灰阶与轻量消息语法 ---- */
assert(tokens.includes('--mp-page: #FCFCFB'), 'light page token matches the measured reference');
assert(tokens.includes('body[data-ds-dark-theme]'), 'the dark alias block must exist (DSH full platform)');
assert(tokens.includes('--mp-page: #151515'), 'dark page token matches the measured reference');
assert.match(css, /\.dsh-bubble\s*\{[^}]*border-radius:\s*12px/s, 'user bubble uses the measured restrained radius');
assert.match(css, /\.dsh-tool-group-header,[\s\S]*min-height:\s*28px/s, 'activity rows use the compact Claude height');
assert.match(css, /\.dsh-tool \.dsh-tool-caret\s*\{[^}]*margin-left:\s*4px/s,
  'tool disclosure arrows sit directly after the action text');
/* 组标签必须能收缩：Claude 的组头会写成一整句话
   (`Ran 25 commands (1 failed), fetched 4 pages, used 2 tools`)，
   不可收缩的标签会把 chevron 推出行外，而不是自己截断。 */
assert.match(css, /\.dsh-tool-group-title,[^}]*\{[^}]*flex:\s*0 1 auto/s,
  'group disclosure arrows sit directly after the group label');
assert.match(css, /\.dsh-disclosure:not\(\[data-open='true'\]\) > \.dsh-body-wrap\s*\{[^}]*display:\s*none/s);
assert.match(css, /\.dsh-think\[data-long="true"\][^{]*\.dsh-think-viewport\s*\{[^}]*max-height:\s*200px/s);
assert.match(css, /\.dsh-think-fade\s*\{[^}]*linear-gradient/s);
assert(!css.includes('dsh-state-dot-chase'), 'ongoing activity must not use decorative pixel chase');
assert(tokens.includes('prefers-reduced-motion'), 'reduced motion must collapse spatial transitions');

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

/* ---- 参考的对话流三件事：改动行数、组头成句、运行态一行 ---- */

/* 1. 编辑行必须自报改了多少行。参考里 `Edited x.html +17 -5` 是这一行唯一
      的能量信息——只写文件名，读者无法判断这次编辑大小。 */
const editRow = html(DshChat.toolRowNode(DshChat.toolRowModel(
  'Edit',
  JSON.stringify({ file_path: 'a.html', old_string: '1\n2\n3\n4\n5', new_string: Array.from({ length: 17 }, (_, i) => `n${i}`).join('\n') }),
  { text: 'ok', isError: false },
)));
assert(editRow.includes('class="dsh-diff-stat"'), 'edit rows must carry a line-count stat');
assert(editRow.includes('class="dsh-diff-add">+17<'), `edit row must count added lines, got ${editRow}`);
assert(editRow.includes('class="dsh-diff-del">−5<'), `edit row must count removed lines, got ${editRow}`);
assert(html(DshChat.toolRowNode(DshChat.toolRowModel(
  'Read', JSON.stringify({ file_path: 'a.md' }), { text: 'ok', isError: false },
))).includes('dsh-diff-stat') === false, 'non-editing rows must not invent a diff stat');

/* 2. 组头是一句「做了什么」，不是「几个工具」；失败数挂在出事的那一类上。 */
const mixedGroup = DshChat.assistantTurnNode({
  trajectory: [
    { kind: 'tool', name: 'Bash', callId: 'b1', state: 'error', isError: true, text: '{"command":"npm run typecheck"}', result: 'exit 1' },
    { kind: 'tool', name: 'Read', callId: 'r1', state: 'done', isError: false, text: '{"file_path":"a.md"}', result: 'ok' },
    { kind: 'tool', name: 'Grep', callId: 's1', state: 'done', isError: false, text: '{"pattern":"x"}', result: 'ok' },
  ],
}).map(html).join('');
assert(mixedGroup.includes('Ran 1 command (1 failed)'),
  `the failure count rides the clause it belongs to, got ${mixedGroup}`);
assert(/ran|read|searched/.test(mixedGroup),
  'later clauses stay lowercase so the line reads as one sentence');

/* 3. 运行态是「星芒 + 计时 · 阶段名」的一行，计时槽由渲染层原地写。 */
const runningLine = html(DshChat.turnStatusNode('第 2 轮推理中'));
assert(runningLine.includes('class="dsh-thinking-mark"'), 'the running line leads with the star mark');
assert(runningLine.includes('data-turn-meta'), 'the running line must expose a clock slot');
assert(runningLine.includes('class="dsh-turn-status-label">第 2 轮推理中<'),
  'the phase name is the tail of the running line, not a separate row');
assert.strictEqual(DshChat.formatRunMeta(779000, 3600), '12m 59s · 3.6k tokens');
assert.strictEqual(DshChat.formatRunMeta(12000, null), '12s',
  'with no token count the clock must not invent one');

/* 4. 悬停行给相对时间：用户气泡在图标左边，助手回合在图标右边。 */
const now = 1_700_000_000_000;
assert.strictEqual(DshChat.__test.relativeTime(now - 30_000, now), '刚刚');
assert.strictEqual(DshChat.__test.relativeTime(now - 23 * 60_000, now), '23 分钟前');
assert.strictEqual(DshChat.__test.relativeTime(now - 3 * 3_600_000, now), '3 小时前');
assert.match(DshChat.__test.relativeTime(now - 30 * 86_400_000, now), /^\d{2}:\d{2}$/,
  'beyond a week the clock falls back to an absolute time rather than counting days');

/* 节点用的是真实当前时间（相对时间是相对「现在」算的）。 */
const stampedUser = html(DshChat.userNode('问题', Date.now() - 23 * 60_000));
assert(stampedUser.includes('class="dsh-action-time"'), 'user hover row carries a timestamp');
assert(stampedUser.indexOf('dsh-action-time') < stampedUser.indexOf('dsh-action"'),
  'the user timestamp leads its icons, as in the reference');
const stampedTurn = DshChat.assistantTurnNode({ answer: '答', at: Date.now() - 3 * 3_600_000 }).map(html).join('');
assert(stampedTurn.includes('3 小时前'), 'assistant hover row carries its own timestamp');
assert(stampedTurn.indexOf('dsh-action-time') > stampedTurn.indexOf('class="dsh-action"'),
  'the assistant timestamp trails its icons, as in the reference');
assert(!html(DshChat.userNode('问题')).includes('dsh-action-time'),
  'a message with no recorded time must not invent one');

/* ---- 轮间叙述走同一条 markdown 路径 ----
   模型在叙述里一样会写 `**加粗**`。按纯文本画出来就是字面上的星号，而它出现
   在用户判断「它在说什么」的那一句里。 */
const narration = DshChat.assistantTurnNode({
  answer: '结束。',
  trajectory: [
    { kind: 'message', text: '论文是 **StarDojo: Benchmarking** 这一篇。' },
    { kind: 'tool', name: 'Read', callId: 'r1', state: 'done', text: '{"file_path":"a.md"}', result: 'ok' },
  ],
}).map(html).join('');
assert(narration.includes('<strong>StarDojo: Benchmarking</strong>'),
  `mid-turn narration must render markdown, got ${narration.slice(0, 400)}`);
assert(!narration.includes('**StarDojo'),
  'the literal asterisks must not survive into the transcript');

/* ---- 权限回执 ----
   回答一道权限门不是用户发了一条消息；画成气泡会把权限门和对话轮次混成
   同一件事。 */
const receipt = html(DshChat.permissionAnswerNode({ decision: 'grant', rule: 'Bash(curl -L)' }));
assert(receipt.includes('class="dsh-perm-receipt"'), 'a permission answer renders as a receipt');
assert(receipt.includes('本会话允许') && receipt.includes('Bash(curl -L)'),
  'the receipt names both the decision and the rule it landed on');
assert(receipt.includes('data-decision="grant"'));
assert(html(DshChat.permissionAnswerNode({ decision: 'deny', rule: 'Bash' })).includes('已拒绝'));
assert(html(DshChat.permissionAnswerNode({ decision: 'once', rule: 'Bash' })).includes('允许一次'));

/* ---- 运行中工具行 ----
   参数只能跟着结果回来（ToolCallStarted 只带 name/id），所以完成时才写成
   「Ran <命令>」；被权限门拦下的工具耗时是 0.0，写出来只是一行「0.0ms」。 */
const liveDone = html(DshChat.liveActivityNode({
  phase: 'tool_result',
  fields: { name: 'Bash', state: 'done', backend: 'desktop', latency_ms: '0.0', args: '{"command":"curl -L -o a.pdf https://x"}' },
}));
assert(liveDone.includes('curl -L -o a.pdf'),
  `a finished live tool row must name the command, got ${liveDone}`);
assert(!liveDone.includes('0.0ms'), 'a sub-millisecond latency is not worth printing');
const liveSlow = html(DshChat.liveActivityNode({
  phase: 'tool_result',
  fields: { name: 'Search', state: 'done', backend: 'ripgrep', latency_ms: '5237.3', args: '{"query":"x"}' },
}));
assert(liveSlow.includes('5237ms'), `a real latency rounds to whole milliseconds, got ${liveSlow}`);

console.log('studio dsh chat contract test ok');
