'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { app, BrowserWindow } = require('electron');
const root = process.cwd();
const output = path.join(root, 'data', 'acceptance-20260918');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'transcript-probe-profile'));
app.commandLine.appendSwitch('force-device-scale-factor', '2');
app.whenReady().then(async () => {
  const conversation = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA, 'magic-pointer', 'history', 'conversations.json'), 'utf8'))
    .find(item => item.id === 'c1789708549905');
  assert(conversation, 'the actual reported conversation must be available');
  const win = new BrowserWindow({ show: false, width: 1560, height: 992, useContentSize: true, frame: false,
    webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: true, sandbox: false,
      preload: path.join(root, 'scripts', 'probe_studio_layout_preload.js') } });
  const errors = [];
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 2) errors.push(message); });
  await win.loadFile(path.join(root, 'build', 'electron', 'renderer', 'studio.html'), { query: { view: 'chat' } });
  const result = await win.webContents.executeJavaScript(`(async () => {
    await document.fonts.ready;
    setProductMode('walker', false);
    await openConversation('studio-reference');
    const conversation = ${JSON.stringify(conversation)};
    const turn = conversation.turns[0];
    document.getElementById('studio-home').hidden = true;
    const stream = document.getElementById('stream');
    const host = document.createElement('div'); host.className = 'mp-chat-flow'; stream.replaceChildren(host);
    const view = ChatView.createConversationView(host); view.update(conversation);
    const groups = [...host.querySelectorAll('.mp-chat-tool-group')];
    const collapsed = groups.every(n => !n.open);
    groups[0].querySelector('summary').click();
    await new Promise(resolve => requestAnimationFrame(resolve));
    const reopened = groups[0].open && groups[0].querySelector('.mp-chat-tool-group-body').getBoundingClientRect().height > 0;
    const tools = host.querySelectorAll('.mp-chat-tool').length;
    const reasoning = host.querySelectorAll('.mp-chat-think').length;
    const originalText = host.textContent;
    view.update(conversation);
    const retained = host.querySelector('.mp-chat-tool-group') === groups[0] && groups[0].open;
    host.replaceChildren(); ChatView.createConversationView(host).update(conversation);
    const historyIntact = host.textContent === originalText;
    const liveHost = document.createElement('div'); host.appendChild(liveHost);
    const live = ChatView.createLiveTurn(liveHost);
    live.update({ trajectory: turn.trajectory });
    const strip = liveHost.querySelector('[data-cds-spark-strip]');
    strip.closest('.mp-chat-turn-status').style.cssText = 'position:fixed;top:130px;left:550px;z-index:100';
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const first = getComputedStyle(strip).transform;
    await new Promise(resolve => setTimeout(resolve, 200));
    const second = getComputedStyle(strip).transform;
    const animation = { name: getComputedStyle(strip).animationName, duration: getComputedStyle(strip).animationDuration,
      easing: getComputedStyle(strip).animationTimingFunction, first, second, mask: getComputedStyle(strip).maskImage };
    const liveTools = liveHost.querySelectorAll('.mp-chat-tool').length;
    const liveGroups = liveHost.querySelectorAll('.mp-chat-tool-group-body').length;
    liveHost.remove();
    host.querySelectorAll('.mp-chat-tool-group').forEach(n => { n.open = true; });
    const failed = host.querySelector('.mp-chat-tool[data-state="error"] .mp-chat-row');
    failed?.click();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await new Promise(resolve => setTimeout(resolve, 400));
    const output = host.querySelector('.mp-chat-tool[data-state="error"] .mp-chat-tool-output');
    const errorVisible = output.getBoundingClientRect().height > 0 && Number(getComputedStyle(output.parentElement).opacity) > 0.99;
    const spark = document.querySelector('.mp-account-mark svg');
    return { collapsed, reopened, retained, historyIntact, tools, reasoning, liveTools, liveGroups, animation, errorVisible,
      accountSparkFill: getComputedStyle(spark).fill, errors: [],
      expectedTools: turn.trajectory.filter(r => r.kind === 'tool').length,
      expectedReasoning: turn.trajectory.filter(r => r.kind === 'message' && r.reasoning).length };
  })()`);
  await win.webContents.executeJavaScript('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
  fs.writeFileSync(path.join(output, 'actual-transcript-expanded.png'), (await win.webContents.capturePage()).toPNG());
  await win.webContents.executeJavaScript("(async () => { document.querySelectorAll('.mp-chat-tool-group').forEach(n => { n.open = false; }); await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); await new Promise(r => setTimeout(r, 400)); })()");
  fs.writeFileSync(path.join(output, 'actual-transcript-collapsed.png'), (await win.webContents.capturePage()).toPNG());
  fs.writeFileSync(path.join(output, 'transcript-verification.json'), JSON.stringify({ ...result, errors }, null, 2));
  assert(result.collapsed && result.reopened && result.retained && result.historyIntact);
  assert(result.errorVisible, 'a failed read must render visible evidence after expansion');
  assert.equal(result.tools, result.expectedTools);
  assert.equal(result.liveTools, result.expectedTools);
  assert.equal(result.reasoning, result.expectedReasoning);
  assert.notEqual(result.animation.first, result.animation.second);
  assert.equal(result.animation.name, 'mp-spark-frames');
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log(JSON.stringify(result));
  win.destroy(); app.quit();
}).catch(error => { console.error(error); app.exit(1); });
