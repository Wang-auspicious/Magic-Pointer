'use strict';


const assert = require('node:assert');
const fs = require('node:fs');
const ChatView = require('../electron/renderer/chat_view');

const css = fs.readFileSync('electron/renderer/chat_styles.css', 'utf8');
const tokens = fs.readFileSync('electron/renderer/theme_tokens.css', 'utf8');
const html = (node) => (node ? node.outerHTML : '');

const user = html(ChatView.userNode('把这个表格转成 CSV', 1729857600000));
assert(user.includes('class="mp-chat-user"'), 'user node must carry the user row');
assert(user.includes('class="mp-chat-bubble"'), 'the question must render inside the bubble');
assert(user.includes('把这个表格转成 CSV'));
assert(user.includes('class="mp-chat-action"'), 'the bubble must carry copy actions');
assert(user.includes('data-mp-chat-copy="把这个表格转成 CSV"'), 'copy action must carry the message text');
assert(!ChatView.userNode('<script>alert(1)</script>').outerHTML.includes('<script>'),
  'user text must be structural text, never concatenated HTML');

const model = ChatView.toolRowModel('write', JSON.stringify({ path: 'a.txt', content: 'x' }), { text: 'ok', isError: false });
assert.strictEqual(model.title, 'Wrote');
assert.strictEqual(model.summary, 'a.txt');
assert.strictEqual(model.state, 'ok');
const row = html(ChatView.toolRowNode(model));
assert(row.includes('class="mp-chat-tool"'), 'tool row root');
assert(row.includes('class="mp-chat-row"'), 'tool rows must share the 24px disclosure row chrome');
assert(row.includes('class="mp-chat-title">Wrote</span>'),
  'row title is the completed action ("Wrote a.txt"), never the bare noun');
assert(row.includes('class="mp-chat-diff"'), 'the expanded write body renders its actual added lines');
assert(row.includes('class="mp-chat-tool-output"'), 'the result renders as plain output text below the card');
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
assert(failed.includes('mp-chat-tool-caret'), 'failed tools retain the same disclosure caret as successful tools');
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
const canonicalWrite = ChatView.toolRowNode(ChatView.toolRowModel('Write', JSON.stringify({ path: 'a.txt', content: 'written' }))).outerHTML;
assert(canonicalWrite.includes('class="mp-chat-diff"') && canonicalWrite.includes('+ written'),
  'the production Write tool must render its actual new content');

const writeDiff = ChatView.toolRowNode(ChatView.toolRowModel('write_file', JSON.stringify({ path: 'n.txt', content: 'a\nb' }))).outerHTML;
assert(/mp-chat-diff-line[^>]*data-kind="add"/.test(writeDiff) && writeDiff.includes('+ a'), 'write_file renders as an all-add diff');

const bigOld = Array.from({ length: 120 }, (_, i) => `old ${i}`).join('\n');
const capped = ChatView.__test.deriveDiff('edit_file', JSON.stringify({ path: 'p', old_string: bigOld, new_string: 'new' }));
assert(capped && capped.hidden >= 80, `over-cap lines must collapse with a count (hidden=${capped && capped.hidden})`);
assert(!/mp-chat-diff/.test(ChatView.toolRowNode(ChatView.toolRowModel('grep', JSON.stringify({ pattern: 'x' }))).outerHTML),
  'read-only tools must not grow a diff card');

assert(ChatView.stateDot('done').outerHTML.includes('data-state="done"'));
assert(ChatView.stateDot('warning').outerHTML.includes('data-state="warning"'));
assert(ChatView.stateDot('error').outerHTML.includes('data-state="error"'));
assert(ChatView.stateDot('ongoing').outerHTML.includes('class="mp-chat-matrix"'));

const think = html(ChatView.thinkNode('先读这个文件\n再判断结构', false));
assert(think.includes('mp-chat-think"'), 'reasoning must render as the Think disclosure');
assert(think.includes('mp-chat-title">Thought</span>'), 'completed reasoning uses the interface timeline label');
assert(think.includes('先读这个文件'), 'collapsed summary = first line of reasoning');
assert(think.includes('class="mp-chat-think-body"'), 'expanded body must exist');
assert(think.includes('data-open="false"'), 'Think rows start collapsed');
const longThink = html(ChatView.thinkNode('推理步骤。'.repeat(120), false));
assert(longThink.includes('data-long="true"'), 'long completed reasoning must expose the 200px disclosure cap');
assert(longThink.includes('class="mp-chat-think-viewport"'));
assert(longThink.includes('class="mp-chat-think-fade"'));
assert(longThink.includes('data-mp-chat-act="think-more"'));
assert(longThink.includes('Show more'));
const runningThink = html(ChatView.thinkNode('多行\n思考', true));
assert(runningThink.includes('data-state="running"'), 'a streaming Think row must carry the running state');
assert(runningThink.includes('Thinking…'), 'a running row uses the interface exact status label');
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
assert(flowingTurn.indexOf('找到文件了，我读一下。') < flowingTurn.indexOf('Read 2 files'),
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
assert(groupedReads.includes('Read 3 files'),
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
assert(referenceFlow.includes('mp-chat-tool-caret'),
  'tool chips expose a trailing disclosure caret rather than a leading generic chevron');

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

assert(tokens.includes('--mp-page: #FCFCFB'), 'light page token matches the measured reference');
assert(tokens.includes('body[data-ds-dark-theme]'), 'the dark alias block must exist (full platform)');
assert(tokens.includes('--mp-page: #20201F'), 'dark page token matches the September 21 supplied reference');
assert.match(css, /\.mp-chat-bubble\s*\{[^}]*border-radius:\s*12px/s, 'user bubble uses the measured restrained radius');
assert.match(css, /\.mp-chat-tool-group-header,[\s\S]*min-height:\s*28px/s, 'activity rows use the compact Studio height');
assert.match(css, /\.mp-chat-tool \.mp-chat-tool-caret\s*\{[^}]*margin-left:\s*4px/s,
  'tool disclosure arrows sit directly after the action text');
assert.match(css, /\.mp-chat-tool-group-title,[^}]*\{[^}]*flex:\s*0 1 auto/s,
  'group disclosure arrows sit directly after the group label');
assert.match(css, /\.mp-chat-disclosure:not\(\[data-open='true'\]\) > \.mp-chat-body-wrap\s*\{[^}]*display:\s*none/s);
assert.match(css, /\.mp-chat-think\[data-long="true"\][^{]*\.mp-chat-think-viewport\s*\{[^}]*max-height:\s*200px/s);
assert.match(css, /\.mp-chat-think-fade\s*\{[^}]*linear-gradient/s);
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
assert(src.includes('button.setAttribute(\'aria-label\', \'复制失败\')'),
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
assert(mixedGroup.includes('Ran 1 command (1 failed)'),
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
assert.strictEqual(ChatView.__test.relativeTime(now - 30_000, now), '刚刚');
assert.strictEqual(ChatView.__test.relativeTime(now - 23 * 60_000, now), '23 分钟前');
assert.strictEqual(ChatView.__test.relativeTime(now - 3 * 3_600_000, now), '3 小时前');
assert.match(ChatView.__test.relativeTime(now - 30 * 86_400_000, now), /^\d{2}:\d{2}$/,
  'beyond a week the clock falls back to an absolute time rather than counting days');

const stampedUser = html(ChatView.userNode('问题', Date.now() - 23 * 60_000));
assert(stampedUser.includes('class="mp-chat-action-time"'), 'user hover row carries a timestamp');
assert(stampedUser.indexOf('mp-chat-action-time') < stampedUser.indexOf('mp-chat-action"'),
  'the user timestamp leads its icons, as in the reference');
const stampedTurn = ChatView.assistantTurnNode({ answer: '答', at: Date.now() - 3 * 3_600_000 }).map(html).join('');
assert(stampedTurn.includes('3 小时前'), 'assistant hover row carries its own timestamp');
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
assert(receipt.includes('本会话允许') && receipt.includes('Bash(curl -L)'),
  'the receipt names both the decision and the rule it landed on');
assert(receipt.includes('data-decision="grant"'));
assert(html(ChatView.permissionAnswerNode({ decision: 'deny', rule: 'Bash' })).includes('已拒绝'));
assert(html(ChatView.permissionAnswerNode({ decision: 'once', rule: 'Bash' })).includes('允许一次'));

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

console.log('studio chat contract test ok');
