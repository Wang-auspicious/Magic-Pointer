'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const output = path.resolve('data/runtime/studio-session-log');
const buildRoot = path.resolve(process.env.MP_PROBE_BUILD_ROOT || 'build/electron');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'profile'));
app.disableHardwareAcceleration();
const deadline = setTimeout(() => app.exit(1), 30000);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1440, height: 980, show: false, webPreferences: {
    offscreen: true, sandbox: false, contextIsolation: true,
    preload: path.resolve('scripts/probe_studio_layout_preload.js'),
    additionalArguments: ['--mp-probe-theme=light', '--mp-probe-state=landing'],
  } });
  try {
    await win.loadFile(path.join(buildRoot, 'renderer', 'studio.html'));
    await win.webContents.executeJavaScript('document.fonts.ready');
    const failures = await win.webContents.executeJavaScript(`(async () => {
      const failures = [];
      const check = (ok, why) => { if (!ok) failures.push(why); };
      show('chat'); setStudioHomeVisible(false);
      const origin = Date.UTC(2026, 8, 29, 1, 20);
      const stored = { id: 'execution-design', title: '整理今天的工作材料', turns: [{
        at: origin, startedAt: origin, completedAt: origin + 21676,
        question: '打开 Edge 里的 GitHub，确认页面已加载。', answer: '已打开 GitHub，页面标题和地址都已核对。',
        timingMs: 21676, modelUsage: { totalTokens: 13482 }, trajectory: [
          { seq: 1, kind: 'message', text: '先打开浏览器，再核对页面。', state: 'done', timeOriginMs: origin, startedAt: 100, firstTokenAt: 600, completedAt: 900 },
          { seq: 2, kind: 'tool', name: 'Tools', callId: 'load', text: '{"names":["Browser.navigate","list_windows"]}', result: '{}', state: 'done', timeOriginMs: origin, startedAt: 1000, completedAt: 1030 },
          { seq: 3, kind: 'tool', name: 'list_windows', callId: 'windows', text: '{}', result: '{"value":"[{\\"title\\":\\"Microsoft Edge\\"}]"}', state: 'done', timeOriginMs: origin, startedAt: 1200, completedAt: 1500 },
          { seq: 4, kind: 'tool', name: 'Browser.navigate', callId: 'nav', text: '{"url":"https://github.com/explore","window_id":"42"}', result: '{"url":"https://github.com/explore","documentTitle":"Explore GitHub","verification":{"verified":true}}', state: 'done', timeOriginMs: origin, startedAt: 1600, completedAt: 3600 },
        ],
      }, { at: origin + 30000, startedAt: origin + 30000, completedAt: origin + 38000,
        question: '比较两份报价，把差异写进纪要。', answer: '两份报价的交付时间不同，已写入纪要。', timingMs: 8000, modelUsage: { totalTokens: 1200 }, trajectory: [
          { seq: 1, kind: 'message', text: '同时读取两份报价。', state: 'done', timeOriginMs: origin + 30000, startedAt: 100, completedAt: 1600 },
          { seq: 2, kind: 'tool', name: 'Read', callId: 'read-a', text: '{"path":"报价 A.txt"}', result: '周五交付', state: 'done', timeOriginMs: origin + 30000, startedAt: 1800, completedAt: 4800 },
          { seq: 3, kind: 'tool', name: 'Read', callId: 'read-b', text: '{"path":"报价 B.txt"}', result: '下周一交付', state: 'done', timeOriginMs: origin + 30000, startedAt: 1800, completedAt: 2800 },
          { seq: 4, kind: 'tool', name: 'Write', callId: 'write-notes', text: '{"path":"会议纪要.txt","content":"两份报价的交付时间不同"}', result: '{"verification":{"verified":true},"message":"会议纪要已保存"}', state: 'done', timeOriginMs: origin + 30000, startedAt: 6000, completedAt: 6800 },
        ] }] };
      Data.conversation = async () => structuredClone(stored);
      Data.recovery = async () => ({ ok: true, pendingRecovery: [] });
      await openConversation(stored.id); setInspector(true, 'activity');
      const activity = document.getElementById('conversation-activity');
      check(activity.querySelectorAll('[data-session-lane]').length === 3, 'session log is missing its three event lanes');
      check(activity.querySelectorAll('.mp-execution-phase').length === 0, 'session log still uses coloured phase cards');
      check(!!activity.querySelector('[data-call-id="nav"]') && !!activity.querySelector('[data-call-id="write-notes"]'), 'session log drops earlier turns');
      check(activity.textContent.includes('14.7k') && activity.textContent.includes('2 次提问'), 'session summary is not session-wide');
      const spans = activity.querySelectorAll('[data-session-span]');
      check(spans.length >= 12, 'overview omits input, model or tool events');
      const a = activity.querySelector('[data-session-span][data-call-id="read-a"]');
      const b = activity.querySelector('[data-session-span][data-call-id="read-b"]');
      check(a && b && a.style.left === b.style.left && parseFloat(a.style.width) > parseFloat(b.style.width) * 2.5, 'parallel operations are serialized or durations are fabricated');
      check(activity.querySelector('[data-session-mode]')?.value === 'time', 'recorded session times are not the default timeline domain');
      const originalToolProjection = ChatView.toolRowModel;
      let projectedTools = 0;
      ChatView.toolRowModel = (...args) => { projectedTools++; return originalToolProjection(...args); };
      renderConversationActivity();
      projectedTools = 0; renderConversationActivity();
      check(projectedTools === 0, 'unchanged history reparses every tool result on each streaming refresh');
      ChatView.toolRowModel = originalToolProjection;
      const nav = activity.querySelector('[data-call-id="nav"]');
      if (nav) {
        nav.click();
        stored.turns[0].trajectory[2].result = '{"value":[{"title":"Microsoft Edge"},{"title":"Notes"}]}';
        activeConversationTurns = stored.turns; renderConversationActivity();
        check(nav === activity.querySelector('[data-call-id="nav"]') && activity.textContent.includes('Explore GitHub') && activity.textContent.includes('已核验'), 'a progress refresh loses the inspected result');
      }
      stored.turns[0].trajectory.push({ kind: 'tool', name: 'Read', callId: 'failed-read', text: '{"path":"notes.txt"}', result: '{"error":"File not found: notes.txt"}', state: 'error' });
      activeConversationTurns = stored.turns; renderConversationActivity();
      check(activity.textContent.includes('File not found: notes.txt') && activity.textContent.includes('1 项失败'), 'execution hides the failure reason or counts a failure as success');
      stored.turns[0].trajectory.pop(); activeConversationTurns = stored.turns; renderConversationActivity();
      const search = activity.querySelector('[data-session-search]');
      if (search) {
        search.value = '报价 A'; search.dispatchEvent(new Event('input'));
        check(activity.querySelectorAll('[data-session-row]:not([hidden])').length === 1, 'session search does not filter actual records');
        search.value = ''; search.dispatchEvent(new Event('input'));
      } else check(false, 'session log has no search');
      const track = activity.querySelector('.mp-session-track');
      if (track) {
        const bounds = track.getBoundingClientRect();
        const event = (type, fraction) => new PointerEvent(type, { bubbles: true, pointerId: 42, button: 0,
          clientX: bounds.left + bounds.width * fraction, clientY: bounds.top + 35 });
        track.setPointerCapture = () => {}; track.releasePointerCapture = () => {};
        track.dispatchEvent(event('pointerdown', .81)); track.dispatchEvent(event('pointermove', .94)); track.dispatchEvent(event('pointerup', .94));
        check(!activity.querySelector('[data-session-row][data-call-id="read-a"]').hidden
          && activity.querySelector('[data-session-row][data-call-id="nav"]').hidden, 'timeline range does not focus overlapping events');
        track.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        check(!activity.querySelector('[data-session-row][data-call-id="nav"]').hidden, 'Escape does not restore the complete session');
        const widthBefore = activity.querySelector('[data-session-span][data-call-id="nav"]').style.width;
        activity.querySelector('[aria-label="放大时间线"]').click();
        check(activity.querySelector('.mp-session-axis').lastElementChild.textContent === '19s', 'timeline zoom has no effect');
        track.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        check(activity.querySelector('[data-session-span][data-call-id="nav"]').style.width === widthBefore, 'reset does not restore the full time domain');
      }
      const before = stored.turns[1].trajectory;
      stored.turns[1].trajectory = [...before, { kind: 'tool', callId: 'legacy-time', name: 'Read', text: '{"path":"旧记录.txt"}', result: 'old record', startedAt: 8, completedAt: 18, state: 'done' }];
      activeConversationTurns = stored.turns; renderConversationActivity();
      check(!!activity.querySelector('[data-session-row][data-call-id="legacy-time"]')
        && !activity.querySelector('[data-session-span][data-call-id="legacy-time"]') && activity.textContent.includes('1 条未记录开始时间'), 'legacy relative clocks are fabricated as wall time');
      const mode = activity.querySelector('[data-session-mode]');
      if (mode) {
        mode.value = 'sequence'; mode.dispatchEvent(new Event('change'));
        check(!!activity.querySelector('[data-session-span][data-call-id="legacy-time"]'), 'sequence view drops events without timing');
        mode.value = 'time'; mode.dispatchEvent(new Event('change'));
      }
      stored.turns[1].trajectory = before; activeConversationTurns = stored.turns; renderConversationActivity();
      setConversationTab('trajectory');
      const fullLog = document.getElementById('trajectory');
      check(!!fullLog.querySelector('.mp-session-log') && fullLog.querySelectorAll('[data-session-row]').length === activity.querySelectorAll('[data-session-row]').length,
        'the full-width trajectory tab still uses a different or incomplete log');
      const oldRow = fullLog.querySelector('[data-session-row][data-call-id="nav"]');
      if (oldRow) {
        oldRow.click();
        const locate = fullLog.querySelector('[data-session-locate]');
        if (locate) { locate.click(); check(activeConversationTab === 'chat' && !!document.querySelector('.mp-session-located'), 'record location does not navigate back to its original message'); }
        else check(false, 'record detail has no locate-in-conversation action');
      }
      setConversationTab('chat');
      stored.turns[1].pendingInput = { requestId: 'ui-question', kind: 'ask', questions: [{
        header: '下一步', question: '接下来想看 GitHub 的哪一部分？', options: [
          { label: '项目概览', description: '先了解项目在做什么，以及能解决哪些问题。' },
          { label: '实现细节', description: '查看架构、数据流和关键代码。' },
        ],
      }] };
      await openConversation(stored.id);
      const host = document.getElementById('composer-permission-ask');
      check(!!host.closest('.mpw-composer-stack'), 'decision is still buried in the scrolling transcript');
      const card = host.querySelector('.mp-decision-card');
      check(getComputedStyle(card).boxShadow === 'none' && parseFloat(getComputedStyle(card).borderRadius) <= 6, 'question still looks like a decorative card');
      const firstOption = host.querySelector('[data-option-index="0"]'); firstOption.click();
      check(card === host.querySelector('.mp-decision-card'), 'selecting a choice remounts and replays the whole card');
      let submitted = 0;
      DecisionCard.render(host, { key: 'retryable-question', questions: [{ question: '选择输出格式', options: [{ label: '文本' }, { label: '表格' }] }] }, () => { submitted++; });
      host.querySelector('[data-option-index="0"]').click();
      host.querySelector('[data-question-submit]').click();
      check(submitted === 1 && !host.querySelector('[data-question-submit]'), 'submitted form remains on screen as a stale actionable card');
      DecisionCard.pending(host, false, '连接中断，请重试');
      check(host.querySelector('[data-option-index="0"]')?.getAttribute('aria-checked') === 'true' && host.textContent.includes('连接中断'), 'save failure does not restore the selected draft');
      if (typeof DecisionCard.resolve === 'function') {
        DecisionCard.resolve(host);
        DecisionCard.render(host, { key: 'retryable-question', questions: [{ question: 'stale snapshot', options: [] }] }, () => {});
        check(host.hidden, 'late saved snapshot resurrects an acknowledged question');
        DecisionCard.render(host, { key: 'next-question', questions: [{ question: 'new request', options: [] }] }, () => {});
        DecisionCard.render(host, { key: 'retryable-question', questions: [{ question: 'stale snapshot', options: [] }] }, () => {});
        check(!host.hidden && host.textContent.includes('new request'), 'retired snapshot erases a newer request');
      } else check(false, 'decision lifecycle has no acknowledged-request retirement');
      syncConversationPendingInput(stored.turns); renderConversationActivity();
      return failures;
    })()`);
    await new Promise(resolve => setTimeout(resolve, 300));
    fs.writeFileSync(path.join(output, 'question-light.png'), (await win.webContents.capturePage()).toPNG());
    await win.webContents.executeJavaScript(`document.documentElement.dataset.theme = 'dark'; document.body.dataset.theme = 'dark';`);
    await new Promise(resolve => setTimeout(resolve, 300));
    fs.writeFileSync(path.join(output, 'question-dark.png'), (await win.webContents.capturePage()).toPNG());
    failures.push(...await win.webContents.executeJavaScript(`(() => {
      setInspector(false); setConversationTab('trajectory');
      const log = document.querySelector('#trajectory .mp-session-log');
      const errors = [];
      if (!log || !log.querySelector('[data-session-row][data-call-id="nav"]')) errors.push('the full session cannot be reopened after chat navigation');
      if (document.documentElement.scrollWidth > innerWidth + 1) errors.push('the full session log overflows horizontally');
      renderStreamRail();
      if (!document.getElementById('stream-rail').hidden) errors.push('chat navigation marks cover the full session timeline');
      return errors;
    })()`));
    await new Promise(resolve => setTimeout(resolve, 200));
    fs.writeFileSync(path.join(output, 'full-session-dark.png'), (await win.webContents.capturePage()).toPNG());
    await win.webContents.executeJavaScript(`setConversationTab('chat'); setInspector(true, 'activity');`);
    await win.webContents.executeJavaScript(`document.documentElement.dataset.theme = 'light'; document.body.dataset.theme = 'light'; pendingAskInput = null; pendingPermissionAsk = { requestId: 'permission-design', tool: 'Bash', question: '允许运行项目测试？', actionPreview: 'npm test', options: ['仅这次允许', '本会话允许', '拒绝'] }; renderPermissionAsk();`);
    await new Promise(resolve => setTimeout(resolve, 300));
    fs.writeFileSync(path.join(output, 'permission-light.png'), (await win.webContents.capturePage()).toPNG());
    win.setContentSize(760, 640);
    failures.push(...await win.webContents.executeJavaScript(`(async () => {
      setInspector(false);
      await new Promise(resolve => setTimeout(resolve, 300));
      const errors = [], host = document.getElementById('composer-permission-ask');
      const card = host.querySelector('.mp-decision-card').getBoundingClientRect();
      if (document.documentElement.scrollWidth > innerWidth + 1) errors.push('decision overflows the narrow window');
      if (card.top < 0 || card.bottom > innerHeight) errors.push('decision actions leave the viewport');
      if (document.getElementById('stream').getBoundingClientRect().height < 140) errors.push('decision dock consumes the whole conversation');
      return errors;
    })()`));
    fs.writeFileSync(path.join(output, 'permission-narrow.png'), (await win.webContents.capturePage()).toPNG());
    failures.push(...await win.webContents.executeJavaScript(`(() => {
      setConversationTab('trajectory');
      const log = document.querySelector('#trajectory .mp-session-log');
      if (log.getBoundingClientRect().width < 100 || document.documentElement.scrollWidth > innerWidth + 1 || log.scrollWidth > log.clientWidth + 1) return ['session log is hidden or overflows the narrow window'];
      return [];
    })()`));
    fs.writeFileSync(path.join(output, 'session-narrow.png'), (await win.webContents.capturePage()).toPNG());
    fs.writeFileSync(path.join(output, 'witness.json'), JSON.stringify({ failures }, null, 2));
    if (failures.length) throw new Error(failures.join('\n'));
    console.log('Session timeline, full history, parallel durations, search, evidence, stable updates and decision lifecycle passed');
    clearTimeout(deadline); win.destroy(); app.exit(0);
  } catch (error) {
    console.error(error); clearTimeout(deadline); win.destroy(); app.exit(1);
  }
});
