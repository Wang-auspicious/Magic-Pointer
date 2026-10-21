'use strict';
const {app, BrowserWindow} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const output = path.resolve('data/runtime/compaction-status');
fs.mkdirSync(output, {recursive: true});
app.setPath('userData', path.join(output, 'profile'));
app.disableHardwareAcceleration();
const deadline = setTimeout(() => app.exit(1), 60000);
app.whenReady().then(async () => {
  const {
    RuntimeActivitySink,
  } = require('../build/electron/runtime/agent_activity');
  const {
    createConversationStore,
  } = require('../build/electron/conversation_store');
  const storeFolder = fs.mkdtempSync(path.join(output, 'history-'));
  const store = createConversationStore({baseDir: storeFolder});
  const wire = [];
  const sink = new RuntimeActivitySink((phase, fields) =>
    wire.push({phase, fields}),
  );
  const win = new BrowserWindow({
    width: 1320,
    height: 900,
    show: false,
    webPreferences: {
      offscreen: true,
      sandbox: false,
      contextIsolation: true,
      preload: path.resolve('scripts/probe_studio_layout_preload.js'),
      additionalArguments: [
        '--mp-probe-theme=light',
        '--mp-probe-state=landing',
      ],
    },
  });
  const errors = [];
  const witnesses = [];
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 3) errors.push(message);
  });
  const js = code => win.webContents.executeJavaScript(code);
  const render = async () =>
    js(
      `window.__view.update({...window.__conversation,turns:[{...window.__conversation.turns[0],answer:window.__transcript.answer,trajectory:window.__transcript.trajectory,liveProgress:window.__transcript}]})`,
    );
  const event = async value => {
    sink.onEvent(value);
    const records = wire.splice(0);
    await js(
      `for(const record of ${JSON.stringify(records)}){ConversationControl.appendTranscript(window.__transcript,record);}void 0;`,
    );
    await render();
  };
  const base = {
    kind: 'context_compacting',
    compactionId: 'compact-probe',
    status: 'request',
    pass: 0,
    chunk: 1,
    chunks: 3,
  };
  try {
    await win.loadFile(path.resolve('build/electron/renderer/studio.html'));
    await js(
      `window.__conversation={id:'compact-status-probe',title:'Long task · context handoff',workMode:'code',hasPendingWork:false,turns:[{at:Date.now(),question:'Continue verifying the project. Keep the checked facts and remaining steps.',answer:'',outcome:'进行中',trajectory:[]}]};Data.conversation=async()=>window.__conversation;void 0;`,
    );
    await js('show("chat");openConversation("compact-status-probe")');
    await js(
      'window.__host=document.querySelector("#stream .mp-chat-flow");window.__host.replaceChildren();window.__view=ChatView.createConversationView(window.__host);window.__transcript=ConversationControl.createTranscript();void 0;',
    );
    await event(base);
    assert.equal(
      await js(
        'document.querySelector(".mp-chat-compaction").getBoundingClientRect().height>0 && !document.querySelector("#view-chat").hidden',
      ),
      true,
    );
    assert.equal(
      await js('document.querySelectorAll(".mp-chat-compaction").length'),
      1,
    );
    assert.match(
      await js('document.querySelector(".mp-chat-compaction").textContent'),
      /Compacting context/,
    );
    assert.equal(
      await js('document.querySelectorAll(".mp-chat-turn-status").length'),
      0,
      'the compaction row replaces the generic busy label',
    );
    witnesses.push('live bridge notice and active status');
    await new Promise(resolve => setTimeout(resolve, 150));
    fs.writeFileSync(
      path.join(output, 'compaction-live-light.png'),
      (await win.webContents.capturePage()).toPNG(),
    );
    await js(
      'window.__notice=document.querySelector(".mp-chat-compaction");window.__copy=window.__notice.querySelector(".mp-chat-notice-copy");void 0;',
    );
    for (let i = 0; i < 12; i++) {
      await event({...base, status: 'streaming'});
    }
    assert.equal(
      await js(
        'window.__notice===document.querySelector(".mp-chat-compaction")&&window.__copy===document.querySelector(".mp-chat-notice-copy")',
      ),
      true,
    );
    assert.equal(
      await js('window.__notice.getAttribute("aria-live")'),
      'polite',
    );
    witnesses.push('heartbeat preserves DOM and avoids repeated announcements');
    await event({...base, pass: 1, chunk: 2, chunks: 3});
    assert.match(
      await js('window.__notice.textContent'),
      /Consolidating context summary.*2\/3/,
    );
    assert.equal(
      await js('document.querySelectorAll(".mp-chat-compaction").length'),
      1,
    );
    witnesses.push('chunk and consolidation progress share one row');
    await event({
      ...base,
      status: 'done',
      beforeTokens: 12000,
      afterTokens: 1700,
    });
    assert.equal(await js('window.__notice.dataset.state'), 'done');
    assert.match(
      await js('window.__notice.textContent'),
      /≈12,000.*1,700 tokens/,
    );
    assert.equal(
      await js(
        'window.__notice.querySelectorAll("[data-state=ongoing]").length',
      ),
      0,
    );
    witnesses.push(
      'successful compaction shows estimated reduction and stops motion',
    );
    await event({...base, compactionId: 'failed-one'});
    await event({
      ...base,
      compactionId: 'failed-one',
      status: 'failed',
      error: 'Connection closed <img src=x onerror=alert(1)>',
    });
    assert.equal(
      await js(
        '[...document.querySelectorAll(".mp-chat-compaction")].at(-1).dataset.state',
      ),
      'error',
    );
    assert.equal(
      await js('document.querySelectorAll(".mp-chat-compaction img").length'),
      0,
    );
    assert.match(
      await js(
        '[...document.querySelectorAll(".mp-chat-compaction")].at(-1).textContent',
      ),
      /Connection closed/,
    );
    witnesses.push('failure remains distinct and error text is inert');
    assert.equal(
      await js('document.querySelectorAll(".mp-chat-turn-status").length'),
      0,
      'a finished compaction does not invent a primary model request',
    );
    await event({...base, compactionId: 'cancelled-one'});
    await event({kind: 'loop_stopped', terminal: {reason: 'user_interrupt'}});
    assert.equal(
      await js(
        '[...document.querySelectorAll(".mp-chat-compaction")].at(-1).dataset.state',
      ),
      'cancelled',
    );
    witnesses.push('worker interruption settles the live notice');
    await event({...base, compactionId: 'changed-one'});
    await event({
      ...base,
      compactionId: 'changed-one',
      status: 'history_changed',
    });
    assert.match(
      await js(
        '[...document.querySelectorAll(".mp-chat-compaction")].at(-1).textContent',
      ),
      /new input preserved/,
    );
    witnesses.push('new-input conflict does not claim successful compaction');
    const saved = store.appendTurn({
      newConversation: true,
      question: 'Continue verifying the project.',
      answer: 'The checked facts are retained.',
      outcome: '已完成',
      trajectory: sink.trajectory,
    });
    store.flush();
    const reopened = createConversationStore({baseDir: storeFolder});
    const turn = reopened.get(saved.id).turns[0];
    await js(
      `window.__conversation.turns=[${JSON.stringify(turn)}];window.__view.update(window.__conversation);void 0;`,
    );
    assert.equal(
      await js('document.querySelectorAll(".mp-chat-compaction").length'),
      4,
    );
    assert.equal(
      await js(
        'document.querySelector(".mp-chat-compaction").getAttribute("aria-live")',
      ),
      'off',
    );
    witnesses.push(
      'durable turn replay includes completed and interrupted notices',
    );
    await js(
      'document.documentElement.lang="zh-CN";window.__host.replaceChildren();window.__view=ChatView.createConversationView(window.__host);window.__view.update(window.__conversation);void 0;',
    );
    assert.match(
      await js('document.querySelector(".mp-chat-compaction").textContent'),
      /上下文已压缩/,
    );
    witnesses.push('replay uses the current language');
    await js(
      'document.documentElement.lang="en";window.__conversation.turns[0].trajectory=window.__conversation.turns[0].trajectory.slice(0,1);window.__host.replaceChildren();window.__view=ChatView.createConversationView(window.__host);window.__view.update(window.__conversation);void 0;',
    );
    fs.writeFileSync(
      path.join(output, 'compaction-light.png'),
      (await win.webContents.capturePage()).toPNG(),
    );
    await js(
      'document.documentElement.dataset.theme="dark";document.documentElement.classList.add("dark")',
    );
    win.setSize(860, 820);
    await new Promise(resolve => setTimeout(resolve, 150));
    fs.writeFileSync(
      path.join(output, 'compaction-dark-narrow.png'),
      (await win.webContents.capturePage()).toPNG(),
    );
    const report = {
      ok: !errors.length,
      usedBackend:
        'production Studio, RuntimeActivitySink, live transport, ChatView and real conversation store; controlled progress events, no model',
      witnesses,
      errors,
    };
    fs.writeFileSync(
      path.join(output, 'renderer-result.json'),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report));
    app.exit(report.ok ? 0 : 1);
  } catch (error) {
    const report = {ok: false, error: error.message, witnesses, errors};
    fs.writeFileSync(
      path.join(output, 'renderer-result.json'),
      JSON.stringify(report, null, 2),
    );
    console.error(JSON.stringify(report));
    app.exit(1);
  } finally {
    clearTimeout(deadline);
  }
});
