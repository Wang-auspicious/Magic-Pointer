'use strict';
// Visual gallery of the Studio conversation surfaces (finished turn, live turn,
// plan, question card, background tasks). Screenshots only; no assertions.
// Usage: npx electron scripts/probe_studio_gallery.cjs [outDir] [light|dark]
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const output = path.resolve(process.argv[2] || 'data/runtime/studio-gallery');
const theme = process.argv[3] === 'dark' ? 'dark' : 'light';
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'profile'));
app.disableHardwareAcceleration();
const deadline = setTimeout(() => app.exit(1), 40000);

const fixture = `(() => {
  const NOW = Date.now();
  const todos = [
    { content: 'Read the design reference and the current renderer', status: 'completed' },
    { content: 'Compare turn spacing with the Claude transcript', status: 'completed' },
    { content: 'Fix plan and question card details', status: 'in_progress' },
    { content: 'Verify light and dark themes', status: 'pending' },
  ];
  const trajectory = [
    { kind: 'message', turn: 1, reasoning: 'The user wants the transcript to feel like Claude. First I should look at the existing renderer and the reference screenshots, then decide which spacing values differ.', state: 'done' },
    { kind: 'message', text: 'I will start by reading the renderer and the reference notes.' },
    { kind: 'tool', name: 'Read', callId: 'r1', state: 'done', text: JSON.stringify({ file_path: 'electron/renderer/chat_view.ts' }), result: 'export const ChatView = ...', startedAt: 1000, completedAt: 1400 },
    { kind: 'tool', name: 'Grep', callId: 'r2', state: 'done', text: JSON.stringify({ pattern: 'mp-chat-flow' }), result: 'chat_styles.css:12', startedAt: 1400, completedAt: 1700 },
    { kind: 'tool', name: 'Todo', callId: 'plan1', state: 'done', text: JSON.stringify({ todos }), result: JSON.stringify({ plan: todos }) },
    { kind: 'message', text: 'Two areas differ: the tool group rhythm and the finished turn footer. I will delegate the CSS audit.' },
    { kind: 'tool', name: 'Agent', callId: 'ag1', state: 'done', text: JSON.stringify({ task: 'Audit chat CSS spacing' }), result: '[subagent id=child-1 status=completed steps=4] Found 3 spacing mismatches.' },
    { kind: 'tool', name: 'Bash', callId: 'b1', state: 'done', text: JSON.stringify({ command: 'npm run typecheck' }), result: 'typecheck passed', startedAt: 2000, completedAt: 9000 },
    { kind: 'tool', name: 'Edit', callId: 'e1', state: 'done', text: JSON.stringify({ file_path: 'electron/renderer/chat_styles.css', old_string: '.mp-chat-flow { gap: 12px; }', new_string: '.mp-chat-flow { gap: 16px; }' }), result: 'ok' },
  ];
  const answer = 'Done. The transcript now uses the same rhythm as Claude:\\n\\n- Tool groups collapse into a single summary line\\n- The finished turn shows a quiet footer with copy and retry\\n- The plan lives in the right panel\\n\\n\`\`\`css\\n.mp-chat-flow { gap: 16px; }\\n\`\`\`\\n\\nAnything else you want tuned?';
  return {
    id: 'gallery', title: 'Polish the Studio transcript', subtitle: 'Magic-Pointer', workspaceRoot: 'D:/Desktop/Magic Pointer', updatedAt: NOW,
    turns: [
      { at: NOW - 600000, question: 'Hi, can you check the chat renderer?', answer: 'Sure. What should I look at first?' },
      { at: NOW - 120000, question: 'Make the conversation feel like Claude Desktop: plan cards, question cards, the subagent panel on the right and how a finished turn looks.', answer, trajectory, timingMs: 67000, modelUsage: { inputTokens: 1200, outputTokens: 417, totalTokens: 1617 }, modelId: 'claude-opus-5', plan: { steps: todos } },
    ],
  };
})()`;

async function shot(win, name) {
  await new Promise(r => setTimeout(r, 350));
  const image = await win.webContents.capturePage();
  fs.writeFileSync(path.join(output, name), image.toPNG());
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1440, height: 900, show: false, webPreferences: {
    offscreen: true, sandbox: false, contextIsolation: true,
    preload: path.resolve('scripts/probe_studio_layout_preload.js'),
    additionalArguments: [`--mp-probe-theme=${theme}`, '--mp-probe-state=conversation'],
  } });
  try {
    await win.loadFile(path.resolve('build/electron/renderer/studio.html'));
    await win.webContents.executeJavaScript('document.fonts.ready');
    await new Promise(r => setTimeout(r, 600));
    await win.webContents.executeJavaScript(`(async () => {
      const stored = ${fixture};
      window.__galleryStored = stored;
      Data.conversation = async id => id === stored.id ? structuredClone(stored) : null;
      Data.recovery = async () => ({ ok: true, pendingRecovery: [] });
      Data.subagents = async () => ({ ok: true, tasks: [
        { id: 'child-1', parentCallId: 'ag1', description: 'Audit chat CSS spacing', status: 'completed', stepCount: 4, elapsedMs: 42000, answer: 'Found 3 spacing mismatches.', summary: 'Found 3 spacing mismatches.', steps: [] },
        { id: 'child-2', parentCallId: 'ag2', description: 'Check dark theme contrast', status: 'running', stepCount: 2, elapsedMs: 12000, currentTool: 'Read', phase: 'tool', steps: [] },
      ] });
      show('chat');
      document.getElementById('studio-home').hidden = true;
      await openConversation(stored.id);
    })()`);
    await shot(win, `01-finished-${theme}.png`);
    await win.webContents.executeJavaScript(`(async () => {
      const s = document.querySelector('.mpw-scrollbody') || document.getElementById('stream');
      s.scrollTop = s.scrollHeight;
    })()`);
    await shot(win, `02-finished-bottom-${theme}.png`);
    await win.webContents.executeJavaScript(`(async () => { setInspector(true, 'tasks'); renderProjectTasks(); await refreshBackgroundAgentTasks('gallery'); })()`);
    await shot(win, `03-tasks-panel-${theme}.png`);
    await win.webContents.executeJavaScript(`(async () => {
      setInspector(false);
      const stored = window.__galleryStored;
      stored.turns[1] = { ...stored.turns[1], answer: '', pendingInput: { requestId: 'q1', kind: 'question', tool: 'AskUserQuestion',
        question: 'Which surface should I polish first?', header: 'Priority',
        options: [
          { label: 'Plan card', description: 'The checklist in the right panel and inline plan updates.' },
          { label: 'Question card', description: 'How the agent asks you to choose between options.' },
          { label: 'Background tasks', description: 'Subagent rows in the right panel.' },
        ] } };
      await openConversation(stored.id);
      const s = document.querySelector('.mpw-scrollbody') || document.getElementById('stream');
      s.scrollTop = s.scrollHeight;
    })()`);
    await shot(win, `04-question-${theme}.png`);
    await win.webContents.executeJavaScript(`(async () => {
      const stored = window.__galleryStored;
      stored.turns[1] = { ...stored.turns[1], pendingInput: { requestId: 'p1', kind: 'permission', tool: 'Bash', prefix: 'npm test', actionPreview: 'npm test && npm run build', question: 'Allow running the project tests?', options: ['Allow once', 'Always allow', 'Deny'] } };
      await openConversation(stored.id);
      const s = document.querySelector('.mpw-scrollbody') || document.getElementById('stream');
      s.scrollTop = s.scrollHeight;
    })()`);
    await shot(win, `05-permission-${theme}.png`);
    // Live turn
    await win.webContents.executeJavaScript(`(async () => {
      const stored = window.__galleryStored;
      stored.turns = stored.turns.slice(0, 1);
      await openConversation(stored.id);
      const flow = document.querySelector('.mp-chat-flow');
      const q = document.createElement('div'); flow.appendChild(q);
      const host = document.createElement('div'); flow.appendChild(host);
      const renderer = ChatView.createLiveTurn(host, 'gallery-live#0', { taskPanel: true });
      ChatView.bindDelegation(host);
      pendingConversation = { body: host, records: new Map(), streamText: '', reasoningText: '',
        transcript: ConversationControl.createTranscript(), renderer };
      const event = (phase, fields) => renderConversationProgress({ phase, fields });
      event('model_request', { turn: '1' });
      event('reasoning_chunk', { b64: btoa('Looking at the renderer to find where turns are laid out. ') });
      event('model_response', {});
      event('model_request', { turn: '2' });
      event('answer_chunk', { b64: btoa('Let me read the chat styles first.') });
      event('model_response', {});
      event('tool_call', { id: 'lr1', name: 'Read', args: JSON.stringify({ file_path: 'electron/renderer/chat_styles.css' }) });
      event('tool_result', { id: 'lr1', name: 'Read', args: JSON.stringify({ file_path: 'electron/renderer/chat_styles.css' }), result: '...', state: 'ok' });
      event('tool_call', { id: 'lr2', name: 'Bash', args: JSON.stringify({ command: 'npm run build:electron' }) });
      await new Promise(r => setTimeout(r, 300));
    })()`);
    await shot(win, `06-live-${theme}.png`);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    clearTimeout(deadline);
    app.exit(process.exitCode || 0);
  }
});
