// Headless Studio probe: the REAL renderer chain for the Think (reasoning) row.
// Loads the real studio.html, submits through the real composer form, then
// drives the captured conversations.onProgress callback with records shaped
// exactly like python_bridge_runner emits (phase=reasoning_chunk, fields.b64).
// Asserts the live Think row renders (running state, streaming text) and
// captures an offscreen screenshot to data/runtime/.
//   npx electron scripts/probe_studio_think.js

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');

app.setPath('userData', path.join(ROOT, 'data', 'runtime', 'probe-studio-think-profile'));
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
    const sentRequestIds = [];
    for (const [channel, reply] of Object.entries({
      'conversations:list': [],
      'conversations:get': undefined,
      'conversations:timeline': [],
      'conversations:memories': [],
      'conversations:artifacts': [],
      'conversations:stash': [],
      
      
      'conversations:pick-workspace': { ok: true, path: 'C:/tmp/mp-think-ws' },
      // The renderer owns the requestId; main must echo it back (real main.ts does).
      // Hold the send open: the composer clears pendingConversation as soon
      // as the reply lands, and later progress records are dropped. Real
      // conversations stay pending for the whole bridge run.
      'conversations:send': (payload) => {
        sentRequestIds.push(payload && payload.requestId);
        return new Promise(() => {});
      },
      'projects:list': [{ root: 'C:/tmp/mp-think-ws', name: 'think-ws' }],
      'models:catalog': null,
      'models:select': { ok: true },
      'slash:directory': null,
      'stash:list': [],
    })) {
      ipcMain.handle(channel, (_event, payload) => (typeof reply === 'function' ? reply(payload) : reply));
    }
  const window = new BrowserWindow({
    width: 1500,
    height: 1000,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      offscreen: true,
      preload: path.join(ROOT, 'build', 'electron', 'preload.js'),
    },
  });
  const errors = [];
  window.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) errors.push(String(message).slice(0, 300));
  });
  let failures = [];
  try {
    // Load the COMPILED renderer (what the installed app actually runs).
    await window.loadFile(path.join(ROOT, 'build', 'electron', 'renderer', 'studio.html'));
    await new Promise((r) => setTimeout(r, 900));
    // Second pass: persist the project root so boot() reads it from
    // localStorage (the same key setActiveProject writes in the real app).
    await window.webContents.executeJavaScript(
      `localStorage.setItem('mp:active-project-root', 'C:/tmp/mp-think-ws'); 'stored'`,
    );
    // Load the COMPILED renderer (what the installed app actually runs).
    await window.loadFile(path.join(ROOT, 'build', 'electron', 'renderer', 'studio.html'));
    await new Promise((r) => setTimeout(r, 900));

    const REQUEST_ID = 'req-think-1';
    const CHANNEL = 'conversations:progress';
    // Minimal main-side handlers for the channels the real preload invokes
    // during studio boot and composer send.

    // A pending conversation must exist for renderConversationProgress to paint.
    // Wait for async boot() to settle: startNewChat() focuses the composer and
    // wipes the stream — submitting before it lands gets the flow erased.
    for (let i = 0; i < 40; i++) {
      const focused = await window.webContents.executeJavaScript(
        `document.activeElement && document.activeElement.classList.contains('dshw-input')`,
      );
      if (focused) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    await new Promise((r) => setTimeout(r, 300));
    await window.webContents.executeJavaScript(`
      (function(){
        const ta = document.querySelector('.dshw-input');
        ta.value = '验证 Think 行';
        document.getElementById('composer-form').requestSubmit();
        return 'submitted';
      })()
    `);
    const submitProbe = await window.webContents.executeJavaScript(`
      (async function(){
        const form = document.getElementById('composer-form');
        const before = form.getAttribute('aria-busy');
        let sendErr = null;
        try {
          const orig = window.magicPointerDashboard.conversations.send;
          window.magicPointerDashboard.conversations.send = async (p) => {
            window.__sendCalled = true;
            return orig(p);
          };
        } catch (e) { sendErr = String(e); }
        return { before, sendErr, hasTextarea: Boolean(form.querySelector('textarea')), taValue: (form.querySelector('textarea')||{}).value };
      })()
    `);
    console.log('debug: submitPre=' + JSON.stringify(submitProbe));
    await new Promise((r) => setTimeout(r, 600));
    const submitProbe2 = await window.webContents.executeJavaScript(`
      (function(){ return { ariaBusy: document.getElementById('composer-form').getAttribute('aria-busy'), sendCalled: Boolean(window.__sendCalled) }; })()
    `);
    console.log('debug: submitPost=' + JSON.stringify(submitProbe2));

    // Async boot can still wipe the submitted flow (startNewChat replaceChildren).
    // Heal: if the pending assistant body vanished, submit again until it sticks.
    for (let attempt = 0; attempt < 4; attempt++) {
      const intact = await window.webContents.executeJavaScript(
        `Boolean(document.querySelector('.dsh-assistant-body'))`,
      );
      if (intact) break;
      await window.webContents.executeJavaScript(`
        (function(){
          const ta = document.querySelector('.dshw-input');
          ta.value = '验证 Think 行';
          document.getElementById('composer-form').requestSubmit();
          return 'resubmitted';
        })()
      `);
      await new Promise((r) => setTimeout(r, 500));
    }

    // Drive the REAL channel (preload onPayload -> Data.onConversationProgress ->
    // studio renderConversationProgress) with records shaped exactly like
    // python_bridge_runner emits for "@@mp ... reasoning_chunk" lines.
    console.log('debug: sends=' + sentRequestIds.length);
    const bootProbe = await window.webContents.executeJavaScript(`
      (function(){
        return {
          projectRoot: localStorage.getItem('mp:active-project-root'),
          formIsInputForm: Boolean(document.querySelector('form.dshw-input-form#composer-form')),
          formHidden: (document.getElementById('composer-form')||{}).hidden ?? null,
          viewSections: [...document.querySelectorAll('main section, .dsh-shell > section')].map(s => s.getAttribute('aria-label') || s.id || s.className).slice(0, 6),
          gate: Boolean(document.querySelector('[class*=project-gate], [id*=project-gate]')),
          dashKeys: Object.keys(window.magicPointerDashboard || {}),
          projectsKey: typeof (window.magicPointerDashboard || {}).projects,
        };
      })()
    `);
    console.log('debug: boot=' + JSON.stringify(bootProbe));
    const apiProbe = await window.webContents.executeJavaScript(`
      (async function(){
        try {
          const projects = await window.magicPointerDashboard.projects.list();
          const convs = await window.magicPointerDashboard.conversations.list();
          return { projects, convs };
        } catch (err) { return { error: String(err) }; }
      })()
    `);
    console.log('debug: api=' + JSON.stringify(apiProbe));
    const pendingProbe = await window.webContents.executeJavaScript(`
      (function(){
        return {
          assistants: document.querySelectorAll('.dsh-assistant').length,
          users: document.querySelectorAll('.dsh-user').length,
          stream: Boolean(document.querySelector('.dsh-chat-stream') || document.querySelector('[class*=stream]')),
        };
      })()
    `);
    console.log('debug: pending=' + JSON.stringify(pendingProbe));
    const liveRequestId = sentRequestIds[sentRequestIds.length - 1] || REQUEST_ID;
    console.log('debug: liveRequestId=' + liveRequestId);
    const chunks = ['先看工作区结构。', '再决定改哪个文件。', 'Edit 前必须先 Read。'];
    for (const text of chunks) {
      const b64 = Buffer.from(text, 'utf8').toString('base64');
      window.webContents.send(CHANNEL, { requestId: liveRequestId, record: { phase: 'reasoning_chunk', fields: { b64 } } });
      await new Promise((r) => setTimeout(r, 120));
    }

    const afterChunks = await window.webContents.executeJavaScript(`
      (function(){
        const body = document.querySelector('.dsh-assistant-body');
        return {
          bodyChildren: body ? body.children.length : -1,
          bodyHtml: body ? body.innerHTML.slice(0, 400) : '(no body)',
          disclosures: document.querySelectorAll('.dsh-disclosure').length,
        };
      })()
    `);
    console.log('debug: afterChunks=' + JSON.stringify(afterChunks));
    const thinkState = await window.webContents.executeJavaScript(`
      (function(){
        const row = document.querySelector('.dsh-think');
        if (!row) return { present: false };
        return {
          present: true,
          state: row.getAttribute('data-state'),
          summary: (row.querySelector('.dsh-summary') || {}).textContent || '',
          body: (row.querySelector('.dsh-think-body') || {}).textContent || '',
        };
      })()
    `);
    if (!thinkState.present) failures.push('live Think row missing while reasoning chunks streamed');
    else {
      if (thinkState.state !== 'running') failures.push(`live Think state=${thinkState.state}, expected running`);
      if (!thinkState.body.includes('Edit 前必须先 Read')) failures.push('live Think body missing latest chunk text');
    }

    // Finished turn: thinking arrives on the turn record (bridge result JSON).
    await window.webContents.executeJavaScript(`
      (function(){
        window.magicPointerDashboard.conversations.get = async () => ({
          id: 'c-think',
          turns: [{
            question: '验证 Think 行',
            answer: '已验证。',
            thinking: '第一行思考。\\n第二行思考。',
          }],
        });
        return 'get-patched';
      })()
    `);
    // Re-open the conversation through the real renderer path.
    await window.webContents.executeJavaScript(`
      (async function(){
        const api = window.magicPointerDashboard;
        const conv = await api.conversations.get('c-think');
        window.__renderedThinking = conv && conv.turns && conv.turns[0].thinking;
        return typeof window.__renderedThinking;
      })()
    `);
    const finished = await window.webContents.executeJavaScript(`
      (function(){
        const rows = document.querySelectorAll('.dsh-think');
        const any = rows.length > 0;
        const bodyText = [...document.querySelectorAll('.dsh-think-body')].map(n => n.textContent).join('|');
        return { any, count: rows.length, bodyText };
      })()
    `);
    if (!finished.any) failures.push('finished-turn Think row missing (turn.thinking not rendered)');

    const image = await window.webContents.capturePage();
    const out = path.join(ROOT, 'data', 'runtime', 'probe-studio-think-1.0.27.png');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, image.toPNG());
    console.log('think_live=' + JSON.stringify(thinkState));
        console.log('console_errors=' + errors.length + (errors.length ? ' :: ' + errors.join(' | ') : ''));
    console.log('screenshot=' + out);
    console.log(failures.length ? 'FAIL: ' + failures.join('; ') : 'PASS: think row renders live and finished');
    process.exitCode = failures.length || errors.length ? 1 : 0;
  } catch (err) {
    console.error('probe error:', err);
    console.error('console_messages:', errors.join(' | '));
    process.exitCode = 1;
  } finally {
    setTimeout(() => app.quit(), 300);
  }
});
