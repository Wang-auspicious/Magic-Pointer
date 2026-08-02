const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const preload = fs.readFileSync(path.join(root, 'electron', 'preload.js'), 'utf8');
const main = fs.readFileSync(path.join(root, 'electron', 'main.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'electron', 'renderer', 'stage.html'), 'utf8');
const js = fs.readFileSync(path.join(root, 'electron', 'renderer', 'stage.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'electron', 'renderer', 'stage.css'), 'utf8');

assert(preload.includes("listAgentSessions: (selectionSessionToken) => ipcRenderer.invoke('stage:agent-sessions'"));
assert(preload.includes("dispatchAgentPrompt: (payload) => ipcRenderer.invoke('stage:dispatch-agent-prompt'"));
assert(main.includes("ipcMain.handle('stage:agent-sessions'"));
assert(main.includes("ipcMain.handle('stage:dispatch-agent-prompt'"));
assert(main.includes("requestMode: 'agent_prompt'"));
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
assert(js.includes("button:not([disabled]), textarea, input, [contenteditable=\"true\"]"));
assert(css.includes('.agent-session-chip'));
assert(css.includes('.agent-prompt-confirm'));
assert(css.includes('overflow-x: auto'));

console.log('stage agent prompt static test ok');
