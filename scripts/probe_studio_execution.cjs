'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const output = path.resolve('data/runtime/studio-execution-design');
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
      const stored = { id: 'execution-design', title: '在 Edge 中打开 GitHub', turns: [{
        at: Date.now(), question: '打开 Edge 里的 GitHub，确认页面已加载。', answer: '已打开 GitHub，页面标题和地址都已核对。',
        timingMs: 21676, modelUsage: { totalTokens: 13482 }, trajectory: [
          { kind: 'tool', name: 'Tools', callId: 'load', text: '{"names":["Browser.navigate","list_windows"]}', result: '{}', state: 'done', startedAt: 1000, completedAt: 1030 },
          { kind: 'tool', name: 'list_windows', callId: 'windows', text: '{}', result: '{"value":"[{\\"title\\":\\"Microsoft Edge\\"}]"}', state: 'done', startedAt: 1200, completedAt: 1500 },
          { kind: 'tool', name: 'Browser.navigate', callId: 'nav', text: '{"url":"https://github.com/explore","window_id":"42"}', result: '{"url":"https://github.com/explore","documentTitle":"Explore GitHub","verification":{"verified":true}}', state: 'done', startedAt: 1600, completedAt: 3600 },
        ],
      }] };
      Data.conversation = async () => structuredClone(stored);
      Data.recovery = async () => ({ ok: true, pendingRecovery: [] });
      await openConversation(stored.id); setInspector(true, 'activity');
      const activity = document.getElementById('conversation-activity');
      check(activity.querySelectorAll('.mp-execution-phase').length === 3, 'execution has no semantic phase blocks');
      check(activity.textContent.includes('Explore GitHub') && activity.textContent.includes('已核验'), 'execution hides the actual verified result');
      check(activity.textContent.includes('13.5k') && activity.textContent.includes('22s'), 'execution has no actual cost and duration summary');
      check(activity.querySelector('.mp-execution-phase[data-phase="prepare"]')?.open === false, 'completed tool-loading should be folded by default');
      const nav = activity.querySelector('[data-call-id="nav"]');
      if (nav) {
        nav.open = true;
        stored.turns[0].trajectory[1].result = '{"value":[{"title":"Microsoft Edge"},{"title":"Notes"}]}';
        activeConversationTurns = stored.turns; renderConversationActivity();
        check(nav === activity.querySelector('[data-call-id="nav"]') && nav.open, 'a progress refresh replaces the inspected step');
      }
      stored.turns[0].trajectory.push({ kind: 'tool', name: 'Read', callId: 'failed-read', text: '{"path":"notes.txt"}', result: '{"error":"File not found: notes.txt"}', state: 'error' });
      activeConversationTurns = stored.turns; renderConversationActivity();
      check(activity.textContent.includes('File not found: notes.txt') && activity.textContent.includes('1 项失败'), 'execution hides the failure reason or counts a failure as success');
      stored.turns[0].trajectory.pop(); activeConversationTurns = stored.turns; renderConversationActivity();
      if (nav) nav.open = false;
      stored.turns[0].pendingInput = { requestId: 'ui-question', kind: 'ask', questions: [{
        header: '下一步', question: '接下来想看 GitHub 的哪一部分？', options: [
          { label: '项目概览', description: '先了解项目在做什么，以及能解决哪些问题。' },
          { label: '实现细节', description: '查看架构、数据流和关键代码。' },
        ],
      }] };
      await openConversation(stored.id);
      const host = document.getElementById('composer-permission-ask');
      check(!!host.closest('.mpw-composer-stack'), 'decision is still buried in the scrolling transcript');
      const card = host.querySelector('.mp-decision-card');
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
    fs.writeFileSync(path.join(output, 'witness.json'), JSON.stringify({ failures }, null, 2));
    if (failures.length) throw new Error(failures.join('\n'));
    console.log('Execution phases, evidence, stable updates, dock, submission, retry and stale acknowledgement passed');
    clearTimeout(deadline); win.destroy(); app.exit(0);
  } catch (error) {
    console.error(error); clearTimeout(deadline); win.destroy(); app.exit(1);
  }
});
