'use strict';


const assert = require('node:assert');
const fs = require('node:fs');
const ChatView = require('../electron/renderer/chat_view');

const css = fs.readFileSync('electron/renderer/chat_styles.css', 'utf8');
const tokens = fs.readFileSync('electron/renderer/theme_tokens.css', 'utf8');
const html = (node) => (node ? node.outerHTML : '');

const interactive = ChatView.assistantTurnNode({
  answer: '```openui\nroot = Card([TextContent("visual tool unavailable is sample data")])\n```',
}, 'interactive-task#0').map(html).join('');
assert(interactive.includes('data-openui-source='), 'OpenUI answers create a renderer mount');
assert(interactive.includes('visual tool unavailable is sample data'), 'answer cleanup must preserve UI code');
assert(!interactive.includes('mp-chat-code-head'), 'OpenUI is an interactive response, not a code card');

const user = html(ChatView.userNode('把这个表格转成 CSV', 1729857600000));
assert(user.includes('class="mp-chat-user"'), 'user node must carry the user row');
assert(user.includes('class="mp-chat-bubble"'), 'the question must render inside the bubble');
assert(user.includes('把这个表格转成 CSV'));
assert(user.includes('class="mp-chat-action"'), 'the bubble must carry copy actions');
assert(user.includes('data-mp-chat-copy="把这个表格转成 CSV"'), 'copy action must carry the message text');
assert(!ChatView.userNode('<script>alert(1)</script>').outerHTML.includes('<script>'),
  'user text must be structural text, never concatenated HTML');

const model = ChatView.toolRowModel('write', JSON.stringify({ path: 'a.txt', content: 'x' }), { text: 'ok', isError: false });
assert.strictEqual(model.title, 'Created', 'settled Write is "Created" per the reference (group singular "Created a file"), not "Wrote"');
assert.strictEqual(model.summary, 'a.txt');
assert.strictEqual(model.state, 'ok');
const row = html(ChatView.toolRowNode(model));
assert(row.includes('class="mp-chat-tool"'), 'tool row root');
assert(row.includes('class="mp-chat-row"'), 'tool rows must share the 24px disclosure row chrome');
assert(/class="mp-chat-title"[^>]*>Created<\/span>/.test(row),
  'row title is the completed action ("Created a.txt"), never the bare noun');
assert(row.includes('class="mp-chat-diff"'), 'the expanded write body renders its actual added lines');
assert(!row.includes('mp-chat-tool-output'),
  'file rows fold the raw output into the diff card instead of a duplicate plain line');
assert(!row.includes('mp-chat-io-label'), 'the IN/OUT gutter labels are gone');
assert(row.includes('data-mp-chat-act="toggle"'), 'the row must be expandable via the shared delegation');
assert(html(ChatView.toolRowNode(ChatView.toolRowModel('Read', '{"path":"a.txt"}'))).includes('data-mp-chat-act="copy"'),
  'a non-diff command card carries its own copy action');

const collapsedByDefault = ChatView.toolRowNode(model).outerHTML;
assert(collapsedByDefault.includes('data-open="false"'), 'tool rows start collapsed');

const agentModel = ChatView.toolRowModel(
  'Agent',
  JSON.stringify({ task: '核对 Inspector 文件预览' }),
  undefined,
  'parent-agent-1',
);
assert.strictEqual(agentModel.title, 'Running subagent');
assert.strictEqual(agentModel.summary, '核对 Inspector 文件预览');
const agentRow = html(ChatView.toolRowNode(agentModel));
assert(agentRow.includes('data-mp-chat-act="open-subagent"'),
  'an Agent row opens the matching Tasks lane instead of a generic local disclosure');
assert(agentRow.includes('data-subagent-parent-call-id="parent-agent-1"'));

const running = html(ChatView.toolRowNode(ChatView.toolRowModel('grep', JSON.stringify({ pattern: 'x' }), undefined)));
assert(running.includes('data-state="running"'), 'an unsettled call must render the running state');
assert(running.includes('class="mp-chat-vh"'), 'running state must carry a screen-reader label');
assert(!css.includes('.mp-chat-tool[data-state=\'running\'] .mp-chat-row::after'),
  'the Studio activity row must not use a perpetual sweep glare');

const failed = html(ChatView.toolRowNode(ChatView.toolRowModel('read', JSON.stringify({ path: 'b.txt' }), { text: 'no such file\nmore', isError: true })));
assert(failed.includes('data-mp-chat-act="toggle"'), 'failed tools retain the same disclosure toggle as successful tools (the old caret class is gone)');
assert(failed.includes('data-state="error"'), 'error state must ride the root');
assert(failed.includes('b.txt'), 'a failed read keeps the requested file visible');
assert(failed.includes('no such file'));
assert(failed.includes('class="mp-chat-tool-output"'),
  'a tool result renders as plain output text, not as an OUT gutter label');
assert(failed.includes('data-error="true"'), 'a failed result keeps its error coloring');

const editArgs = JSON.stringify({ path: 'a.py', old_string: 'x = 1\ny = 2', new_string: 'x = 42\ny = 2' });
const editDiff = ChatView.toolRowNode(ChatView.toolRowModel('edit_file', editArgs)).outerHTML;
assert(editDiff.includes('class="mp-chat-diff"'), 'edit_file must render a diff card');
assert(editDiff.includes('mp-chat-diff-line data-kind="del"') || /mp-chat-diff-line[^>]*data-kind="del"/.test(editDiff),
  'removed lines must carry the del marker');
assert(/mp-chat-diff-line[^>]*data-kind="add"/.test(editDiff), 'added lines must carry the add marker');
assert(editDiff.includes('- x = 1'), 'deleted lines show their literal content');
assert(editDiff.includes('+ x = 42'), 'added lines show their literal content');
assert(!editDiff.includes('old_string'), 'raw argument names must not leak into the diff view');

const canonicalEdit = ChatView.toolRowNode(ChatView.toolRowModel('Edit', editArgs)).outerHTML;
assert(canonicalEdit.includes('class="mp-chat-diff"') && canonicalEdit.includes('- x = 1'),
  'the production Edit tool must render the same removed and added lines');
const canonicalWrite = ChatView.toolRowNode(ChatView.toolRowModel('Write', JSON.stringify({ path: 'a.txt', content: 'written' }), {text: 'ok', isError: false})).outerHTML;
assert(canonicalWrite.includes('class="mp-chat-diff"'),
  'the settled production Write tool renders the snapshot-backed diff card');
assert(!canonicalWrite.includes('+ written'),
  'Write must not synthesize diff lines from raw args; only real snapshots provide content');

const writeDiff = ChatView.toolRowNode(ChatView.toolRowModel('write_file', JSON.stringify({ path: 'n.txt', content: 'a\nb' }), {text: 'ok', isError: false})).outerHTML;
assert(writeDiff.includes('mp-chat-diff-preview') && writeDiff.includes('+2'),
  'write_file shows the snapshot-backed preview with its all-add stat');
assert(!writeDiff.includes('+ a'),
  'write_file must not synthesize literal diff lines from raw args');

// Complete long and batch previews are covered by chat_diff_preview_test.ts.
assert(!/mp-chat-diff/.test(ChatView.toolRowNode(ChatView.toolRowModel('grep', JSON.stringify({ pattern: 'x' }))).outerHTML),
  'read-only tools must not grow a diff card');

assert(ChatView.stateDot('done').outerHTML.includes('data-state="done"'));
assert(ChatView.stateDot('warning').outerHTML.includes('data-state="warning"'));
assert(ChatView.stateDot('error').outerHTML.includes('data-state="error"'));
assert(ChatView.stateDot('ongoing').outerHTML.includes('mp-chat-status-spinner'),
  'ongoing renders the shared spinner');

const think = html(ChatView.thinkNode('先读这个文件\n再判断结构', false));
assert(think.includes('mp-chat-think"'), 'reasoning must render as the Think disclosure');
assert(/mp-chat-title[^>]*>Thought process<\/span>/.test(think),
  'modern reasoning uses the original Step label');
assert(think.includes('先读这个文件'), 'expanded body retains the original reasoning');
assert(think.includes('class="mp-chat-think-body"'), 'expanded body must exist');
assert(think.includes('data-open="true"'), 'Thinking Step starts open');
const longThink = html(ChatView.thinkNode('推理步骤。'.repeat(120), false));
assert(!longThink.includes('data-long="true"'), 'expanded thinking has no arbitrary length threshold');
assert(longThink.includes('class="mp-chat-think-viewport"'));
assert(!longThink.includes('class="mp-chat-think-fade"'));
assert(!longThink.includes('data-mp-chat-act="think-more"'));
assert(longThink.includes('data-mp-chat-act="copy-thinking"'));
const runningThink = html(ChatView.thinkNode('多行\n思考', true));
assert(runningThink.includes('data-state="running"'), 'a streaming Think row must carry the running state');
assert(runningThink.includes('Thought process'), 'streaming keeps the Step label');
assert(!runningThink.includes('data-long="true"'), 'streaming reasoning must remain uncapped');

const turn = ChatView.assistantTurnNode({
  answer: '已转换。',
  thinking: '先解析表格',
  events: [{ name: 'read', arguments: { path: '表.csv' }, result: 'a,b', isError: false }],
  at: 1729857600000,
});
const turnHtml = turn.map(html).join('');
assert(turnHtml.includes('class="mp-chat-assistant"'), 'assistant root');
assert(turnHtml.includes('class="mp-chat-markdown"'), 'assistant text body');
assert(turnHtml.includes('已转换。'));
assert(turnHtml.includes('class="mp-chat-tool"'), 'structured events must render tool rows');
assert(turnHtml.includes('class="mp-chat-actions"'), 'settled answers must carry copy actions');

const flowingTurn = ChatView.assistantTurnNode({
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
assert(flowingTurn.includes('class="mp-chat-narration"'), 'model narration must render as visible prose');
assert(flowingTurn.includes('我先看看目录结构。'));
assert(flowingTurn.includes('class="mp-chat-notice"'),
  'trajectory notice must remain visible beside normal message/tool rows');
assert(flowingTurn.includes('超过本轮上限 128'),
  'tool truncation notice text must reach the Studio conversation');
assert(!flowingTurn.includes('class="mp-chat-think"'),
  'fake per-round Think rows must be gone');
assert(!flowingTurn.includes('运行记录'),
  'the 运行记录 N 步 cluster header must be gone');
assert(flowingTurn.includes('class="mp-chat-tool-group"'),
  'consecutive tool calls must group into one rounded container');
assert(flowingTurn.includes('class="mp-chat-narration"') === true);
assert(flowingTurn.indexOf('我先看看目录结构。') < flowingTurn.indexOf('mp-chat-summary'),
  'narration precedes the first tool chip it introduces');
assert(flowingTurn.indexOf('找到文件了，我读一下。') > flowingTurn.indexOf('obsidian-daily-log/README.md'),
  'the second narration comes after the first tool chip');
assert(flowingTurn.indexOf('找到文件了，我读一下。') < flowingTurn.indexOf('2 files (1 failed)'),
  'the second narration precedes the tool group it introduces');
assert(flowingTurn.includes('mp-chat-code'), 'expanded evidence (the command card) must survive');
assert(flowingTurn.includes('not found: README.md'));
assert((flowingTurn.match(/>这个项目是一个 Obsidian 日记技能，包含脚本和评估用例。</g) || []).length === 1,
  'final-round narration must not duplicate the answer (text nodes only)');

const groupedReads = ChatView.assistantTurnNode({
  answer: '读完。',
  trajectory: Array.from({ length: 3 }, (_, index) => ({
    kind: 'tool', turn: 1, callId: `r${index}`, name: 'read_file', state: 'done',
    text: JSON.stringify({ path: `f${index}.md` }), result: 'x',
  })),
  events: Array.from({ length: 3 }, (_, index) => ({
    name: 'read_file', arguments: { path: `f${index}.md` }, result: 'x', isError: false,
  })),
}).map(html).join('');
assert(groupedReads.includes('3 files'),
  'consecutive reads must collapse into one "Read N files" group header');
assert(groupedReads.includes('f0.md') && groupedReads.includes('f2.md'),
  'the collapsed group still carries the per-file chips inside');
assert(!/<details[^>]*class="mp-chat-tool-group"[^>]*\sopen(?:=|\s|>)/.test(groupedReads),
  'Studio tool groups start collapsed and reveal evidence only on demand');

const referenceFlow = ChatView.assistantTurnNode({
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
  'reference mixed tool group keeps the interface exact group label');
assert(referenceFlow.includes('Searched') && referenceFlow.includes('**/*.md'),
  'search tool uses the completed-action label from the reference');
assert(referenceFlow.includes('Listed files in working directory'),
  'directory listing uses the completed-action label from the reference');
assert(referenceFlow.includes('Read') && referenceFlow.includes('VisLexicon-完整方案.md') && referenceFlow.includes('rebuttal.md'),
  'read chips preserve both exact reference filenames');
assert(!/<details[^>]*class="mp-chat-tool-group"[^>]*\sopen(?:=|\s|>)/.test(referenceFlow),
  'completed groups collapse as in the final user reference, including two-item groups');
assert(referenceFlow.indexOf('读完了。') < referenceFlow.indexOf('1m 7s · 417 tokens'),
  'the final answer appears before the run meta, as in the reference transcript');
assert(referenceFlow.includes('mp-chat-disclosure'),
  'tool chips expose a trailing disclosure row rather than a leading generic chevron (the old caret class is gone)');

const explicitActionLabels = ChatView.assistantTurnNode({
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

const eventsOnly = ChatView.assistantTurnNode({
  answer: 'ok',
  activities: [{ kind: 'model', turn: 1, latencyMs: 1200 }, { kind: 'model', turn: 2, latencyMs: 900 }],
  events: [{ name: 'search', arguments: { pattern: '**/*.md' }, result: 'a.md', isError: false }],
}).map(html).join('');
assert(!eventsOnly.includes('mp-chat-think'), 'model activities without content must not become Think rows');
assert(eventsOnly.includes('**/*.md'));

const errorTurn = ChatView.assistantTurnNode({ failed: true, at: 1 }).map(html).join('');
assert(errorTurn.includes('class="mp-chat-turn-error"'), 'a failed turn must render the turn error row');
assert(errorTurn.includes('class="mp-chat-dot"'), 'the error row leads with the red state dot');

assert(ChatView.turnStatusNode('Thinking').outerHTML.includes('class="mp-chat-turn-status"'));
assert(!css.includes('@keyframes mp-chat-turn-status-shimmer'), 'perpetual status shimmer must be removed');

assert(tokens.includes('--mp-page: #F5F5F3'), 'light page token matches the open-claude-ui alignment (6be99bc)');
assert(tokens.includes('body[data-ds-dark-theme]'), 'the dark alias block must exist (full platform)');
assert(tokens.includes('--mp-page: #0B0B0A'), 'dark page token matches the open-claude-ui alignment (6be99bc)');
assert.match(css, /\.mp-chat-bubble\s*\{[^}]*border-radius:\s*var\(--mp-r-bubble\)/s, 'user bubble radius rides the aligned bubble token');
assert(tokens.includes('--mp-r-bubble: 18px'), 'bubble radius token matches the open-claude-ui alignment (6be99bc)');
assert.match(css, /\.mp-chat-tool-group-header,[\s\S]*min-height:\s*28px/s, 'activity rows use the compact Studio height');
assert.match(css, /\.mp-chat-row-caret\s*\{[^}]*font-family:\s*'Anthropicons Code'/s,
  'tool disclosure arrows use the original icon font caret (E02A), rotating open');
assert.match(css, /\.mp-chat-disclosure\[data-open='true'\] > \.mp-chat-row \.mp-chat-row-caret\s*\{[^}]*transform:\s*rotate\(90deg\)/s,
  'the caret rotates with the disclosure state');
assert.match(css, /\.mp-chat-tool-group-title,[^}]*\{[^}]*flex:\s*0 1 auto/s,
  'group disclosure arrows sit directly after the group label');
assert.match(css, /\.mp-chat-disclosure:not\(\[data-open='true'\]\) > \.mp-chat-body-wrap\s*\{[^}]*display:\s*none/s);
assert(!css.includes('.mp-chat-think[data-long='));
assert(!css.includes('.mp-chat-think-fade'));
assert(!css.includes('mp-chat-state-dot-chase'), 'ongoing activity must not use decorative pixel chase');
assert(tokens.includes('prefers-reduced-motion'), 'reduced motion must collapse spatial transitions');

assert.strictEqual(ChatView.__test.firstLine('a\nb'), 'a');
assert.strictEqual(ChatView.__test.latestLine('a\nb'), 'b');
assert.strictEqual(ChatView.__test.classifyTool('web_search'), 'search');
assert.strictEqual(ChatView.__test.classifyTool('unknown_tool'), 'others');
assert.strictEqual(ChatView.__test.deriveSummary('read', JSON.stringify({ path: 'x/y.md' })), 'x/y.md');
assert.match(ChatView.__test.formatClock(1729857600000), /^\d{2}:\d{2}$/, 'clock = local HH:MM');

const src = fs.readFileSync('electron/renderer/chat_view.ts', 'utf8');
assert(src.includes('copyToClipboard(text).then((ok: boolean) =>'), 'copy must wait on the clipboard promise');
assert(src.includes('fallbackCopyText(text)'), 'clipboard failure must fall back to execCommand');
assert(src.includes("button.setAttribute('aria-label', lt('chat.copy_failed'))"),
  'a failed copy must not show the success checkmark');
assert(src.includes('document.execCommand(\'copy\')'), 'the fallback must use the textarea copy trick');


const editRow = html(ChatView.toolRowNode(ChatView.toolRowModel(
  'Edit',
  JSON.stringify({ file_path: 'a.html', old_string: '1\n2\n3\n4\n5', new_string: Array.from({ length: 17 }, (_, i) => `n${i}`).join('\n') }),
  { text: 'ok', isError: false },
)));
assert(editRow.includes('class="mp-chat-diff-stat"'), 'edit rows must carry a line-count stat');
assert(editRow.includes('class="mp-chat-diff-add">+17<'), `edit row must count added lines, got ${editRow}`);
assert(editRow.includes('class="mp-chat-diff-del">−5<'), `edit row must count removed lines, got ${editRow}`);
assert(html(ChatView.toolRowNode(ChatView.toolRowModel(
  'Read', JSON.stringify({ file_path: 'a.md' }), { text: 'ok', isError: false },
))).includes('mp-chat-diff-stat') === false, 'non-editing rows must not invent a diff stat');

const mixedGroup = ChatView.assistantTurnNode({
  trajectory: [
    { kind: 'tool', name: 'Bash', callId: 'b1', state: 'error', isError: true, text: '{"command":"npm run typecheck"}', result: 'exit 1' },
    { kind: 'tool', name: 'Read', callId: 'r1', state: 'done', isError: false, text: '{"file_path":"a.md"}', result: 'ok' },
    { kind: 'tool', name: 'Grep', callId: 's1', state: 'done', isError: false, text: '{"pattern":"x"}', result: 'ok' },
  ],
}).map(html).join('');
assert(mixedGroup.includes('Ran') && mixedGroup.includes('a command (1 failed)'),
  `the failure count rides the clause it belongs to, got ${mixedGroup}`);
assert(/ran|read|searched/.test(mixedGroup),
  'later clauses stay lowercase so the line reads as one sentence');

const runningLine = html(ChatView.turnStatusNode('第 2 轮推理中'));
assert(runningLine.includes('class="mp-chat-thinking-mark"'), 'the running line leads with the star mark');
assert(runningLine.includes('data-turn-meta'), 'the running line must expose a clock slot');
assert(runningLine.includes('class="mp-chat-turn-status-label">第 2 轮推理中<'),
  'the phase name is the tail of the running line, not a separate row');
assert.strictEqual(ChatView.formatRunMeta(779000, 3600), '12m 59s · 3.6k tokens');
assert.strictEqual(ChatView.formatRunMeta(12000, null), '12s',
  'with no token count the clock must not invent one');

const now = 1_700_000_000_000;
assert.strictEqual(ChatView.__test.relativeTime(now - 30_000, now), 'just now');
assert.strictEqual(ChatView.__test.relativeTime(now - 23 * 60_000, now), '23 minutes ago');
assert.strictEqual(ChatView.__test.relativeTime(now - 3 * 3_600_000, now), '3 hours ago');
assert.match(ChatView.__test.relativeTime(now - 30 * 86_400_000, now), /^\d{2}:\d{2}$/,
  'beyond a week the clock falls back to an absolute time rather than counting days');

const stampedUser = html(ChatView.userNode('问题', Date.now() - 23 * 60_000));
assert(stampedUser.includes('class="mp-chat-action-time"'), 'user hover row carries a timestamp');
assert(stampedUser.indexOf('mp-chat-action-time') < stampedUser.indexOf('mp-chat-action"'),
  'the user timestamp leads its icons, as in the reference');
const stampedTurn = ChatView.assistantTurnNode({ answer: '答', at: Date.now() - 3 * 3_600_000 }).map(html).join('');
assert(stampedTurn.includes('3 hours ago'), 'assistant hover row carries its own timestamp');
assert(stampedTurn.indexOf('mp-chat-action-time') > stampedTurn.indexOf('class="mp-chat-action"'),
  'the assistant timestamp trails its icons, as in the reference');
assert(!html(ChatView.userNode('问题')).includes('mp-chat-action-time'),
  'a message with no recorded time must not invent one');

const narration = ChatView.assistantTurnNode({
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

const receipt = html(ChatView.permissionAnswerNode({ decision: 'grant', rule: 'Bash(curl -L)' }));
assert(receipt.includes('class="mp-chat-perm-receipt"'), 'a permission answer renders as a receipt');
assert(receipt.includes('Allowed for this session') && receipt.includes('Bash(curl -L)'),
  'the receipt names both the decision and the rule it landed on');
assert(receipt.includes('data-decision="grant"'));
assert(html(ChatView.permissionAnswerNode({ decision: 'deny', rule: 'Bash' })).includes('Denied'));
assert(html(ChatView.permissionAnswerNode({ decision: 'once', rule: 'Bash' })).includes('Allowed once'));

const liveDone = html(ChatView.liveActivityNode({
  phase: 'tool_result',
  fields: { name: 'Bash', state: 'done', backend: 'desktop', latency_ms: '0.0', args: '{"command":"curl -L -o a.pdf https://x"}' },
}));
assert(liveDone.includes('curl -L -o a.pdf'),
  `a finished live tool row must name the command, got ${liveDone}`);
assert(!liveDone.includes('0.0ms'), 'a sub-millisecond latency is not worth printing');
const liveSlow = html(ChatView.liveActivityNode({
  phase: 'tool_result',
  fields: { name: 'Search', state: 'done', backend: 'ripgrep', latency_ms: '5237.3', args: '{"query":"x"}' },
}));
assert(liveSlow.includes('5237ms'), `a real latency rounds to whole milliseconds, got ${liveSlow}`);

const ActivityMarks = require('../electron/renderer/activity_marks');
const StreamSmoother = require('../electron/renderer/stream_smoother');

assert(!css.includes('.mp-chat-turn-status-label[data-quiet="true"]'),
  'turn status label must not carry the 1px data-quiet clipping rule');
assert(!ChatView.turnStatusNode('Thinking').outerHTML.includes('data-quiet="true"'),
  'running turn status label must remain visible without data-quiet="true"');
assert.match(css, /\.mp-chat-turn-status\s*\{[^}]*gap:\s*16px/s,
  'streaming status footer matches Claude Desktop PSt gap: 16px');
assert.match(css, /\.mp-chat-turn-status\s*\{[^}]*min-height:\s*20px/s,
  'streaming status footer matches Claude Desktop PSt h-5 (20px)');
assert.match(css, /\.mp-chat-turn-status[\s\S]*tabular-nums/s,
  'streaming status footer enforces tabular-nums');

assert(css.includes('@keyframes epitaxy-thinking-shimmer'),
  'thinking opacity shimmer keyframes must be defined');
assert(css.includes('@keyframes cds-shimmer-text-shine'),
  'CDS ShimmerText keyframes must be defined');
assert(css.includes('@keyframes _fadeInText_4za3l_1') && css.includes('.mp-stream-word-in'),
  '100ms streaming word fade-in animation must be defined');

assert.match(css, /\.mp-chat-stream-live\s*\{[^}]*(?:15px|0\.9375rem)/s,
  'live stream body matches settled 15px (0.9375rem) typography');
assert.match(css, /\.mp-chat-stream-live\s*\{[^}]*line-height:\s*1\.4\b/s,
  'live stream body matches settled line-height: 1.4');
assert.match(css, /\.mp-chat-markdown\s*\{[^}]*(?:15px|0\.9375rem)/s,
  'settled markdown uses 15px (0.9375rem) typography');
assert.match(css, /\.mp-chat-markdown\s*\{[^}]*line-height:\s*1\.4\b/s,
  'settled markdown uses line-height: 1.4');
assert.match(css, /\.mp-chat-narration\s*\{[^}]*line-height:\s*1\.4\b/s,
  'mid-turn narration unifies line-height: 1.4 to prevent settle jump');

assert.match(css, /\.mp-chat-think[^{]*> \.mp-chat-body-wrap\s*\{[^}]*transition:\s*none/s,
  'Thought process toggle panel must open/collapse instantaneously');

assert(ActivityMarks.MARKS.spark.includes('viewBox="0 0 100 100"'),
  'static Spark must keep 100x100 viewBox');
assert(ActivityMarks.MARKS.spark.includes('#d97757') || ActivityMarks.MARKS.spark.includes('--cds-clay'),
  'static Spark must use clay #d97757 token');
const expectedSparkStates = {
  thinking: [9, 90],
  writing: [8, 90],
  waiting: [16, 600],
  shimmer: [15, 100],
  entrance: [6, 70],
  exit: [6, 70],
  orbiting: [18, 100],
  tickle: [7, 40],
};
assert.ok(ActivityMarks.SPARK_STATES, 'ActivityMarks.SPARK_STATES must expose the 8 sprite states');
for (const [state, [frames, speed]] of Object.entries(expectedSparkStates)) {
  const spec = ActivityMarks.SPARK_STATES[state];
  assert.ok(spec, `missing SPARK_STATES.${state}`);
  assert.strictEqual(spec.frameCount, frames, `${state} frameCount`);
  assert.strictEqual(spec.speed, speed, `${state} speed`);
}
const animatedSparkHtml = ActivityMarks.spark('thinking');
assert(animatedSparkHtml.includes('data-cds="Spark"') && animatedSparkHtml.includes('data-cds-spark-strip'),
  'animated Spark must emit data-cds="Spark" sprite strip markup');

assert.match(css, /\.mpw-primary\s*\{[^}]*width:\s*32px[^}]*height:\s*32px/s,
  'composer primary button uses 32px sizing per REA §1.4');
assert.match(css, /\.mpw-primary\.is-stop[\s\S]*?(?:#d97757|--cds-clay)/s,
  'composer stop button uses clay #d97757 fill');

assert.strictEqual(typeof StreamSmoother.formatElapsedTime, 'function');
assert.strictEqual(typeof ChatView.formatElapsedTime, 'function');
assert.strictEqual(typeof ChatView.formatThinkingLabel, 'function');
assert.strictEqual(typeof ChatView.updateTurnStatus, 'function');
assert.strictEqual(typeof ChatView.applySaliency, 'function');

{
  class MockNode {
    constructor(tag = '', text = '') {
      this.tagName = tag.toUpperCase();
      this.nodeType = tag ? 1 : 3;
      this.childNodes = [];
      this.attrs = {};
      this.dataset = {};
      this.nodeValue = text;
      this.parentNode = null;
    }
    get children() { return this.childNodes.filter(n => n.nodeType === 1); }
    get firstChild() { return this.childNodes[0] || null; }
    get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
    get lastElementChild() {
      const kids = this.children;
      return kids[kids.length - 1] || null;
    }
    get textContent() {
      return this.nodeType === 3 ? this.nodeValue : this.childNodes.map(n => n.textContent).join('');
    }
    set textContent(val) {
      this.replaceChildren(new MockNode('', String(val)));
    }
    get className() { return this.attrs.class || ''; }
    set className(val) { this.setAttribute('class', val); }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
    removeAttribute(k) { delete this.attrs[k]; }
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k); }
    appendChild(node) { return this.insertBefore(node, null); }
    insertBefore(node, before) {
      if (node && node.nodeType === 11 && Array.isArray(node.childNodes)) {
        const items = node.childNodes.slice();
        for (const item of items) {
          this.insertBefore(item, before);
        }
        return node;
      }
      const child = typeof node === 'string' ? new MockNode('', node) : node;
      if (child.parentNode && typeof child.remove === 'function') child.remove();
      const idx = before ? this.childNodes.indexOf(before) : this.childNodes.length;
      this.childNodes.splice(idx < 0 ? this.childNodes.length : idx, 0, child);
      child.parentNode = this;
      return child;
    }
    replaceChild(nextNode, oldNode) {
      this.insertBefore(nextNode, oldNode);
      if (oldNode && typeof oldNode.remove === 'function') oldNode.remove();
      return oldNode;
    }
    remove() {
      if (!this.parentNode) return;
      const arr = this.parentNode.childNodes;
      const idx = arr.indexOf(this);
      if (idx >= 0) arr.splice(idx, 1);
      this.parentNode = null;
    }
    replaceChildren(...nodes) {
      this.childNodes.slice().forEach(n => {
        if (typeof n.remove === 'function') n.remove();
        else n.parentNode = null;
      });
      this.childNodes.length = 0;
      for (const n of nodes) this.appendChild(n);
    }
    contains(target) {
      if (target === this) return true;
      return this.childNodes.some(n => (typeof n.contains === 'function' ? n.contains(target) : n === target));
    }
    querySelectorAll(selector) {
      const selectors = selector.split(',').map(s => s.trim()).filter(Boolean);
      const matchSingle = (node, sel) => {
        if (sel.startsWith('.')) return node.className.split(/\s+/).includes(sel.slice(1));
        if (sel.startsWith('[')) {
          const inner = sel.slice(1, -1);
          const eq = inner.indexOf('=');
          if (eq === -1) return node.hasAttribute(inner);
          const key = inner.slice(0, eq);
          const expected = inner.slice(eq + 1).replace(/^['"]|['"]$/g, '');
          return node.getAttribute(key) === expected;
        }
        return node.tagName.toLowerCase() === sel.toLowerCase();
      };
      const out = [];
      for (const child of this.children) {
        if (selectors.some(sel => matchSingle(child, sel))) out.push(child);
        out.push(...child.querySelectorAll(selector));
      }
      return out;
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  }

  const prevDoc = global.document;
  const prevHtmlEl = global.HTMLElement;
  const prevSaliency = global.TextSaliency;
  const resolvedChatView = require.resolve('../electron/renderer/chat_view');
  const resolvedChatMarkdown = require.resolve('../electron/renderer/chat_markdown');
  const prevChatCache = require.cache[resolvedChatView];
  const prevMarkdownCache = require.cache[resolvedChatMarkdown];
  global.HTMLElement = MockNode;
  global.document = {
    documentElement: { lang: 'en', dataset: {}, getAttribute: () => null },
    createElement: (tag) => new MockNode(tag),
    createElementNS: (_ns, tag) => new MockNode(tag),
    createTextNode: (text) => new MockNode('', text),
    createDocumentFragment: () => ({ nodeType: 11, childNodes: [], appendChild(n) { this.childNodes.push(n); return n; } }),
  };
  delete require.cache[resolvedChatMarkdown];
  delete require.cache[resolvedChatView];
  const LiveChatView = require('../electron/renderer/chat_view');

  try {
    // 1. Auto-collapse when prose begins streaming unless user opened/pinned.
    LiveChatView.expansion.clear();
    const autoHost = new MockNode('div');
    const autoLive = LiveChatView.createLiveTurn(autoHost, 'auto-collapse#0');
    autoLive.update({ thinking: 'Inspecting files', nowMs: 100 });
    assert.strictEqual(
      autoHost.querySelector('.mp-chat-think').getAttribute('data-open'),
      'true',
      'Thought process starts open while thinking',
    );
    autoLive.update({ thinking: 'Inspecting files', answer: 'First prose chunk.', nowMs: 200 });
    assert.strictEqual(
      autoHost.querySelector('.mp-chat-think').getAttribute('data-open'),
      'false',
      'Thought process auto-collapses when prose begins streaming',
    );

    const pinnedHost = new MockNode('div');
    const pinnedLive = LiveChatView.createLiveTurn(pinnedHost, 'pinned-collapse#0');
    pinnedLive.update({ thinking: 'Checking contract', nowMs: 100 });
    const pinnedRow = pinnedHost.querySelector('.mp-chat-think');
    LiveChatView.expansion.setRow(pinnedRow.getAttribute('data-row-id'), true);
    pinnedLive.update({ thinking: 'Checking contract', answer: 'Streaming answer.', nowMs: 200 });
    assert.strictEqual(
      pinnedRow.getAttribute('data-open'),
      'true',
      'User-opened/pinned Thought process remains open during streaming',
    );
    LiveChatView.expansion.clear();

    // 2. Live status PSt ticks, oSt=5000ms token gate, Spark state transitions, selection pause, and finish TextSaliency hook.
    let saliencyAppliedHost = null;
    global.TextSaliency = { apply: (target) => { saliencyAppliedHost = target; } };

    const host = new MockNode('div');
    const live = LiveChatView.createLiveTurn(host, 'live-footer#0', { smooth: true });
    live.update({
      startedAt: 1000,
      nowMs: 1000,
      tokens: 1500,
      trajectory: [{ kind: 'message', turn: 0, reasoning: 'Tracing flow', state: 'running' }],
    });
    let status = host.querySelector('.mp-chat-turn-status');
    assert.strictEqual(status.querySelector('.mp-chat-turn-status-label').textContent, 'Thinking…');
    assert.strictEqual(status.querySelector('[data-turn-meta]').textContent, '', 'elapsed < 2s stays hidden');
    assert.strictEqual(status.querySelector('.mp-chat-thinking-mark').getAttribute('data-spark-state'), 'thinking');

    live.tickStatus(3500); // elapsed 2.5s -> shows 2s, tokens still gated (<5000ms)
    assert.strictEqual(status.querySelector('[data-turn-meta]').textContent, '2s');

    live.tickStatus(17500); // elapsed 16.5s -> Still thinking… + smoothed tokens > 5000ms gate
    assert.strictEqual(status.querySelector('.mp-chat-turn-status-label').textContent, 'Still thinking…');
    assert(status.querySelector('[data-turn-meta]').textContent.includes('1.5k tokens'),
      'token count reveals after 5000ms oSt gate');

    live.tickStatus(62000); // elapsed 61s -> Almost done thinking… + 1m 01s
    assert.strictEqual(status.querySelector('.mp-chat-turn-status-label').textContent, 'Almost done thinking…');
    assert(status.querySelector('[data-turn-meta]').textContent.startsWith('1m 01s · '),
      'elapsed >= 60s formats as m ss');

    live.update({
      startedAt: 1000,
      nowMs: 62050,
      answer: 'Alpha beta ',
      records: [],
    });
    live.tickStatus(62080);
    const ansNode = host.querySelector('.mp-chat-stream-live');
    assert.ok(ansNode && ansNode.textContent.length > 0, 'smooth RAF tick releases initial chunk');
    const heldText = ansNode.textContent;
    live.setSelectionPaused(true, 62100);
    live.update({
      startedAt: 1000,
      nowMs: 62150,
      answer: 'Alpha beta gamma delta',
      records: [],
    });
    assert.strictEqual(ansNode.textContent, heldText, 'selection pause freezes live DOM emission');
    live.setSelectionPaused(false, 62200);
    live.tickStatus(62250);
    assert.ok(ansNode.textContent.length > heldText.length, 'resuming advances stream');
    assert.ok(ansNode.querySelector('.mp-stream-word-in'), 'incremental words receive 100ms fade-in class');
    live.flush(62300);
    assert.strictEqual(ansNode.textContent, 'Alpha beta gamma delta', 'flush catches up cleanly after pause');
    status = host.querySelector('.mp-chat-turn-status');
    assert.strictEqual(status.querySelector('.mp-chat-thinking-mark').getAttribute('data-spark-state'), 'writing');

    live.finish({ answer: 'Alpha beta gamma delta', trajectory: [] });
    assert.strictEqual(saliencyAppliedHost, host, 'finish() triggers post-settle TextSaliency application');
  } finally {
    global.document = prevDoc;
    global.HTMLElement = prevHtmlEl;
    global.TextSaliency = prevSaliency;
    if (prevMarkdownCache) {
      require.cache[resolvedChatMarkdown] = prevMarkdownCache;
    } else {
      delete require.cache[resolvedChatMarkdown];
    }
    if (prevChatCache) {
      require.cache[resolvedChatView] = prevChatCache;
    } else {
      delete require.cache[resolvedChatView];
    }
  }
}

console.log('studio chat contract test ok');
