const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const preload = fs.readFileSync(path.join(root, 'electron', 'preload.ts'), 'utf8');
const main = fs.readFileSync(path.join(root, 'electron', 'main.ts'), 'utf8');
const html = fs.readFileSync(path.join(root, 'electron', 'renderer', 'stage.html'), 'utf8');
const js = fs.readFileSync(path.join(root, 'electron', 'renderer', 'stage.ts'), 'utf8');
const css = fs.readFileSync(path.join(root, 'electron', 'renderer', 'stage.css'), 'utf8');

assert(preload.includes('listAgentSessions:') && preload.includes("ipcRenderer.invoke('stage:agent-sessions'"));
assert(preload.includes('dispatchAgentPrompt:') && preload.includes("ipcRenderer.invoke('stage:dispatch-agent-prompt'"));
assert(main.includes("ipcMain.handle('stage:agent-sessions'"));
assert(main.includes("ipcMain.handle('stage:dispatch-agent-prompt'"));
// The stage must NOT force the handoff mode; it forwards what the surface asked
// for and lets the Python router decide. See tests/agent_handoff_routing_test.py.
assert(main.includes("payload?.requestMode === 'agent_prompt' ? 'agent_prompt' : 'auto'"));
assert(!main.includes("requestMode: 'agent_prompt',"));
assert(main.includes('activeOnly: true'));
assert(main.includes('setAgentPromptDraft('));
assert(main.includes('getAgentPromptDraft('));

assert(html.includes('id="tpl-agent-prompt-draft"'));
assert(html.includes('class="agent-prompt-editor"'));
assert(html.includes('class="agent-session-row"'));
assert(html.includes('class="agent-prompt-confirm"'));
assert(js.includes("kind === 'agent-prompt-draft'"));
assert(js.includes('if (raw.live !== true) return null;'));
assert(js.includes('}).slice(0, 5);'));
assert(js.includes('api.listAgentSessions(session.token)'));
assert(js.includes('api.dispatchAgentPrompt({'));
assert(js.includes("confirm.textContent = '确认'"));
assert(!js.includes("confirm.textContent = '发送'"));
// Dragging is positive-handle only, so a native scrollbar can never move the panel.
assert(js.includes('function isDragHandleAt('));
assert(!js.includes('button:not([disabled]), textarea, input, [contenteditable='));
// 抓手从「卡顶一条灰色小横杠」换成了整条眉毛行 + 底栏（它们说的是这张卡在讲
// 什么、你能对它做什么，顺便可以拖）。钉的仍然是同一条约束：面板上必须存在
// 正向的 data-drag-handle，而滚动区 #stage-result 绝不能是其中之一。
assert(html.includes('class="thread-head" data-drag-handle="1"'));
assert(html.includes('class="thread-bar" data-drag-handle="1"'));
assert(!/id="stage-result"[^>]*data-drag-handle/.test(html),
  'the scrollable result area must never be a drag surface');
assert(html.includes('data-no-drag="1"'));
assert(css.includes('.thread-head'));
// No horizontal scrollbar anywhere on the stage.
assert(css.includes('overflow-x: hidden;'));
assert(!/\.stage-result\s*\{[^}]*overflow:\s*auto/.test(css));
assert(css.includes('.agent-session-chip'));
assert(css.includes('.agent-prompt-confirm'));
assert(css.includes('overflow-x: auto'));

console.log('stage agent prompt static test ok');
