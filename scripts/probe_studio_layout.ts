// @ts-nocheck
'use strict';


const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const STATES = [
  'landing',
  'conversation',
  'conversation-inspector',
  'running',
  'permission',
  'error',
  'inspector-maximized',
  'thinking-expanded',
  'subagent',
  'browser',
  'customize',
  'design',
  'flow',
  'tool-cards',
  'worktree',
  'minimum',
];

const ROOT = process.cwd();

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback;
}

function numberOption(name, fallback) {
  const value = Number(option(name, fallback));
  if (!Number.isFinite(value) || value <= 0) throw new Error(`invalid --${name}: ${value}`);
  return value;
}

function parseOptions() {
  const state = String(option('state', 'landing'));
  const theme = String(option('theme', 'light'));
  if (!STATES.includes(state)) throw new Error(`invalid --state: ${state}`);
  if (!['light', 'dark'].includes(theme)) throw new Error(`invalid --theme: ${theme}`);
  const output = path.resolve(String(option('output', path.join('data', 'runtime', `studio-layout-${theme}-${state}.png`))));
  return {
    width: Math.round(numberOption('width', state === 'minimum' ? 1020 : 1199)),
    height: Math.round(numberOption('height', state === 'minimum' ? 700 : 800)),
    scaleFactor: numberOption('scale-factor', 2),
    theme,
    state,
    output,
  };
}

function launchElectron() {
  const builtEntry = path.join(ROOT, 'build', 'scripts', 'probe_studio_layout.js');
  if (!fs.existsSync(builtEntry)) {
    process.stderr.write('probe requires a fresh `npm run build:electron` first\n');
    process.exitCode = 1;
    return;
  }
  const electronBinary = require('electron');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawnSync(electronBinary, [builtEntry, ...process.argv.slice(2)], {
    cwd: ROOT,
    env,
    stdio: 'inherit',
  });
  process.exitCode = child.status === null ? 1 : child.status;
}

function statePreparationScript(state, theme) {
  return `(async () => {
    const state = ${JSON.stringify(state)};
    const theme = ${JSON.stringify(theme)};
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    document.body.toggleAttribute('data-ds-dark-theme', theme === 'dark');
    try { localStorage.setItem('mp:theme', theme); } catch (_) {}

    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    // This renderer fixture has no live runtime recovery transport.
    Data.recovery = async () => ({ ok: true, pendingRecovery: [] });
    const openReference = async (conversationId = 'studio-reference') => {
      setProductMode('walker', false);
      await openConversation(conversationId);
      await wait(30);
    };
    const openFiles = async (maximized) => {
      await openReference();
      inspectorState = { ...inspectorState, width: 747, previousWidth: 747, maximized: false };
      setInspector(true, 'files');
      await refreshProjectInspector();
      expandedProjectDirectories.add('electron');
      await loadProjectDirectory('electron');
      await selectProjectFile('VisLexicon-完整方案.md');
      if (maximized) document.getElementById('inspector-maximize')?.click();
      await wait(40);
    };

    if (state === 'landing' || state === 'minimum') {
      setProductMode('walker', false);
      show('chat');
      startNewChat();
      await renderStudioHome();
    } else if (state === 'conversation') {
      await openReference('magic-pointer-review');
      const flow = document.querySelector('#stream .mp-chat-flow');
      if (flow) {
        const host = document.createElement('div');
        host.className = 'mp-chat-flow-item mp-reference-working';
        host.appendChild(ChatView.turnStatusNode('Thinking'));
        flow.appendChild(host);
        const stream = document.getElementById('stream');
        if (stream) stream.scrollTop = stream.scrollHeight;
      }
    } else if (state === 'conversation-inspector') {
      await openFiles(false);
    } else if (state === 'inspector-maximized') {
      await openFiles(true);
    } else if (state === 'running') {
      await openReference();
      studioComposerBusy = true;
      setComposerRunningState(true);
      composerPlan = { steps: [
        { content: '清退旧 Studio 视觉栈', status: 'completed' },
        { content: '逐像素核对两张参考图', status: 'in_progress' },
        { content: '同步安装版并核对版本', status: 'pending' },
      ] };
      renderPlanCard();
      const flow = document.querySelector('#stream .mp-chat-flow');
      if (flow) {
        const host = document.createElement('div');
        host.className = 'mp-chat-flow-item';
        host.appendChild(ChatView.liveActivityNode({
          phase: 'tool_call',
          fields: { id: 'probe-running', name: 'Bash', command: 'npm run typecheck' },
          ms: 6840,
        }));
        flow.appendChild(host);
      }
    } else if (state === 'worktree') {
      /* 打开项目 + 停在首页 = 参考里 composer 上方那一排 chip 出现的状态。 */
      setProductMode('walker', false);
      show('chat');
      setActiveProject('D:/Desktop/Magic Pointer');
      await renderStudioHome();
      await wait(40);
    } else if (state === 'flow') {
      await openReference();
      const home = document.getElementById('studio-home');
      if (home) home.hidden = true;
      const stream = document.getElementById('stream');
      const flow = document.createElement('div');
      flow.className = 'mp-chat-flow';
      stream.replaceChildren(flow);
      const question = '读一下参考图，然后按 Studio 的对话流重做这一块。';
      flow.appendChild(ChatView.userNode(question, Date.now() - 4 * 60 * 1000));

      /* 注意：这一整段是外层模板字符串的内容，美元花括号会被外层先插值。
         所以这里只用字符串拼接，不写模板字面量。 */
      const lines = (n, prefix) => {
        const out = [];
        for (let i = 1; i <= n; i += 1) out.push(prefix + i + ' 行');
        return out.join('\\n');
      };
      const NEW_TEXT = lines(17, '第 ');
      const OLD_TEXT = lines(5, '旧第 ');
      const editChip = (path, newText, oldText, callId) => ({
        kind: 'tool', name: 'Edit', callId, state: 'done', isError: false, result: 'ok',
        text: JSON.stringify({ file_path: path, old_string: oldText, new_string: newText }),
      });
      flow.appendChild(ChatView.assistantTurnNode({
        conversationId: 'probe-flow',
        turnIndex: 0,
        answer: '前 15 张图的口径已经对齐，剩下的按同一套令牌收尾。',
        /* 产物卡挂在回合末尾，所以它出现在下一条用户消息之前——参考里就是这个
           位置。字段用运行时会真的给的那几个。 */
        artifacts: [{ artifactId: 'artifact-probe-1', revision: 3, kind: 'markdown', name: 'CVPR 2027 选题核验' }],
        trajectory: [
          { kind: 'message', text: '三个都实搜验证过，空白很干净。现在合并进 HTML。' },
          editChip('cvpr2027-verified-top5.html', NEW_TEXT, OLD_TEXT, 'e1'),
          { kind: 'message', text: 'Now the CSS for lanes + the 人话 row style:' },
          editChip('cvpr2027-verified-top5.html', NEW_TEXT + NEW_TEXT, '', 'e2'),
          { kind: 'tool', name: 'Bash', callId: 'b1', state: 'done', isError: false, result: 'clean',
            text: '{"command":"git status --porcelain"}' },
          { kind: 'tool', name: 'Bash', callId: 'b2', state: 'done', isError: true, result: 'exit 1',
            text: '{"command":"npm run typecheck"}' },
          { kind: 'tool', name: 'Read', callId: 'r1', state: 'done', isError: false, result: 'ok',
            text: '{"file_path":"electron/renderer/chat_styles.css"}' },
          { kind: 'tool', name: 'Grep', callId: 's1', state: 'done', isError: false, result: 'ok',
            text: '{"pattern":"mp-chat-code"}' },
          { kind: 'tool', name: 'Edit', callId: 'e3', state: 'done', isError: false, result: 'ok',
            text: JSON.stringify({ file_path: 'electron/renderer/chat_styles.css', old_string: 'a\\nb', new_string: 'x' }) },
        ],
      })[0]);

      /* 运行中的回合：星芒 + 计时 + 阶段名，同一行。 */
      const live = document.createElement('div');
      live.className = 'mp-chat-assistant';
      const liveBody = document.createElement('div');
      liveBody.className = 'mp-chat-assistant-body';
      liveBody.appendChild(ChatView.liveActivityNode({
        phase: 'agent_turn',
        fields: { turn: '2' },
      }));
      liveBody.appendChild(ChatView.thinkNode('第一张图里主色是暖白，第二张是纯白——需要逐张取色再定。', true));
      live.appendChild(liveBody);
      flow.appendChild(live);
      const metaSlot = liveBody.querySelector('[data-turn-meta]');
      if (metaSlot) metaSlot.textContent = ChatView.formatRunMeta(12 * 60 * 1000 + 59 * 1000, 3600);
      if (stream) stream.scrollTop = stream.scrollHeight;
    } else if (state === 'tool-cards') {
      /* 展开的工具卡有两种形态，参考里是分开的：多行脚本走「带高亮的代码卡，
         输出在卡外」；单行命令走「提示符 + 命令和它的输出同在一张终端卡里」。
         这一屏把两种并排放在一条流里，配色、缩进、滚动区一眼可比。
         注意：这段注释在外层模板字符串里面，反引号和美元花括号都不能出现。 */
      await openReference();
      const home = document.getElementById('studio-home');
      if (home) home.hidden = true;
      const stream = document.getElementById('stream');
      const flow = document.createElement('div');
      flow.className = 'mp-chat-flow';
      stream.replaceChildren(flow);

      /* 外层是模板字符串，所以这里不能出现反引号或美元花括号——参考图里的
         那段 PowerShell 用反引号拼行，这里换成等价写法。 */
      const script = [
        'function Txt($u,$n=7000) {',
        '  try { $r = Invoke-WebRequest -Uri $u -UseBasicParsing -TimeoutSec 40 } catch { "ERR $u : $($_.Exception.Message)"; return }',
        "  $c = $r.Content -replace '(?s)<script.*?</script>','' -replace '(?s)<style.*?</style>',''",
        "  $c = [System.Net.WebUtility]::HtmlDecode($c) -replace '[ ]+',' '",
        '  $c = $c.Trim()',
        '  "===== $u"',
        '  $c.Substring(0,[Math]::Min($n,$c.Length))',
        '}',
        'Txt "https://openai.com/index/gpt-6-astra/" 9000',
      ].join('\\n');

      const listing = ['total 33816'];
      for (let i = 1; i <= 24; i += 1) {
        listing.push('-rw-r--r-- 1 zjz65 197609 ' + (825637 + i * 997)
          + ' Sep 16 14:31 43709c3d-aa31-4509-ae9b-10852a2fd298.jsonl');
      }
      listing.push('drwxr-xr-x 1 zjz65 197609 0 Sep 16 14:31 356913b5-a21d-4cf1-a7f5-faf21a3007c0');

      flow.appendChild(ChatView.assistantTurnNode({
        conversationId: 'probe-tool-cards',
        turnIndex: 0,
        answer: '',
        trajectory: [
          /* 折叠的行要有若干条才看得出「组」——单个工具在参考里是一条裸行，
             不会长成带边框的容器，所以夹具必须凑够两条以上。 */
          { kind: 'tool', name: 'Bash', callId: 'w1', state: 'done', isError: false,
            text: JSON.stringify({ command: 'rg -n "novelty" docs/ --glob "*.md" | head -40' }),
            result: 'docs/01.md:12:novelty search' },
          { kind: 'tool', name: 'Bash', callId: 'w2', state: 'done', isError: false,
            text: JSON.stringify({ command: 'curl -s https://cvpr.thecvf.com/Conferences/2027/Dates' }),
            result: 'ok' },
          { kind: 'message', text: '三个都实搜验证过，空白很干净。现在合并进 HTML。' },
          { kind: 'tool', name: 'pwsh', callId: 'ps1', state: 'done', isError: false,
            text: JSON.stringify({ command: script }),
            result: 'ERR https://openai.com/index/gpt-6-astra/ ： 远程服务器返回错误: (403) 已禁止。' },
          { kind: 'message', text: '换成先看本地会话文件，再决定要不要抓网页。' },
          { kind: 'tool', name: 'Bash', callId: 'b1', state: 'done', isError: false,
            text: JSON.stringify({ command: 'ls -1t ./sessions/ | head -30' }),
            result: listing.join('\\n') },
        ],
      })[0]);
      /* 直接写属性展开，不走 click：点击会经过事件委托，委托里有些分支会去
         调桥，探针只想要那一屏静止的像素。 */
      for (const group of stream.querySelectorAll('details.mp-chat-tool-group')) group.open = true;
      for (const row of stream.querySelectorAll('.mp-chat-disclosure')) row.setAttribute('data-open', 'true');
      if (stream) stream.scrollTop = 0;
      /* 展开是一次带淡入的动画（mp-chat-reveal）。不等它跑完就截图，拍到的是
         半透明的那一帧，看起来像配色出了问题。 */
      await wait(400);
    } else if (state === 'permission') {
      await openReference();
      pendingPermissionAsk = { tool: 'Bash', prefix: 'npm run sync' };
      pendingAskInput = null;
      renderPermissionAsk();
    } else if (state === 'error') {
      await openReference();
      const flow = document.querySelector('#stream .mp-chat-flow');
      if (flow) {
        const host = document.createElement('div');
        host.className = 'mp-chat-flow-item';
        host.appendChild(ChatView.turnErrorNode(
          '模型端点暂时不可用；provider_unavailable · usedBackend=magic_pointer.messages_multiturn_streaming',
          'provider_unavailable',
        ));
        flow.appendChild(host);
      }
      setComposerSettledState('error');
      const stream = document.getElementById('stream');
      if (stream) stream.scrollTop = stream.scrollHeight;
    } else if (state === 'thinking-expanded') {
      await openReference();
      const reasoning = document.querySelector('.mp-chat-think > .mp-chat-row');
      if (reasoning) reasoning.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      const more = document.querySelector('.mp-chat-think-more');
      if (more) more.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    } else if (state === 'subagent') {
      await openReference();
      activeConversationTurns = [{ trajectory: [{
        kind: 'tool', callId: 'parent-agent-probe', name: 'Agent', state: 'running',
        text: JSON.stringify({ task: 'Audit Studio Settings and Inspector', readonly: true }),
        result: '', usedBackend: 'subagent_loop', startedAt: 100,
      }] }];
      activeConversationTurns[0].trajectory[0].subagent = {
        id: 'child-probe', parentCallId: 'parent-agent-probe',
        description: 'Audit Studio Settings and Inspector', readonly: true,
        status: 'running', stepCount: 3, currentTool: 'Read',
        steps: [
          { index: 1, tool: 'Grep', status: 'completed', usedBackend: 'ripgrep', latencyMs: 42 },
          { index: 2, tool: 'Read', status: 'completed', usedBackend: 'filesystem', latencyMs: 18 },
          { index: 3, tool: 'Read', status: 'running', usedBackend: 'filesystem' },
        ],
      };
      focusedSubagentId = 'child-probe';
      setInspector(true, 'tasks');
      renderProjectTasks();
    } else if (state === 'browser') {
      await openReference();
      inspectorState = { ...inspectorState, width: 747, previousWidth: 747, maximized: false };
      setInspector(true, 'browser');
      const browserInput = document.getElementById('project-browser-url');
      if (browserInput) browserInput.value = 'https://example.test';
      await openProjectBrowser('https://example.test');
      await wait(40);
    } else if (state === 'customize') {
      setProductMode('walker', false);
      show('settings');
      activeSettingsPage = 'models-agents';
      renderSettings();
    } else if (state === 'design') {
      setProductMode('design', false);
      show('design');
    }

    document.getElementById('global-search-overlay')?.setAttribute('hidden', '');
    await wait(40);
    return { state, theme };
  })()`;
}

async function settleTwoFrames(webContents) {
  await webContents.executeJavaScript(
    'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
  );
}

async function waitForStudio(webContents) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const ready = await webContents.executeJavaScript(
      "Boolean(document.getElementById('studio-home') && document.getElementById('composer-form') && document.querySelector('#side-convos > *'))",
    );
    if (ready) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const diagnostic = await webContents.executeJavaScript(`(() => ({
    readyState: document.readyState,
    href: location.href,
    bridge: Boolean(window.magicPointerDashboard),
    conversations: Boolean(window.magicPointerDashboard?.conversations),
    shell: Boolean(document.getElementById('shell')),
    home: Boolean(document.getElementById('studio-home')),
    composer: Boolean(document.getElementById('composer-form')),
    projectRows: document.querySelectorAll('#side-convos .mpw-project').length,
    sideText: String(document.getElementById('side-convos')?.textContent || '').slice(0, 300),
  }))()`);
  throw new Error(`Studio fixture did not finish booting: ${JSON.stringify(diagnostic)}`);
}

async function collectMetrics(webContents) {
  return webContents.executeJavaScript(`(() => {
    const round = (value) => Math.round(value * 100) / 100;
    const rect = (selector) => {
      const element = document.querySelector(selector);
      if (!element || element.hidden || getComputedStyle(element).display === 'none') return null;
      const value = element.getBoundingClientRect();
      return { x: round(value.x), y: round(value.y), width: round(value.width), height: round(value.height), right: round(value.right), bottom: round(value.bottom) };
    };
    const style = (selector) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const value = getComputedStyle(element);
      return {
        display: value.display,
        position: value.position,
        width: value.width,
        height: value.height,
        minHeight: value.minHeight,
        padding: value.padding,
        gridTemplateRows: value.gridTemplateRows,
        alignContent: value.alignContent,
        alignSelf: value.alignSelf,
        flex: value.flex,
        backgroundColor: value.backgroundColor,
        color: value.color,
        borderColor: value.borderColor,
        borderRadius: value.borderRadius,
        boxShadow: value.boxShadow,
        fontFamily: value.fontFamily,
        fontSize: value.fontSize,
        fontWeight: value.fontWeight,
        lineHeight: value.lineHeight,
      };
    };
    const horizontalOverflow = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth;
    return {
      viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
      geometry: {
        shell: rect('#shell'),
        titlebar: rect('#window-titlebar'),
        sidebar: rect('.mpw-sidebar-col'),
        sidebarProjectHeader: rect('.mpw-project-row'),
        sidebarSession: rect('.side-item'),
        sidebarSessionTitle: rect('.side-item .side-title'),
        primary: rect('.mpw-conversation:not([hidden])'),
        home: rect('#studio-home'),
        stats: rect('#studio-home-stats'),
        composer: rect('#composer-form'),
        composerInput: rect('.mpw-scroll'),
        composerSend: rect('.mpw-primary'),
        inspector: rect('#project-inspector'),
        sidebarFooter: rect('.mpw-foot'),
        updateCard: rect('#update-card'),
        accountFooter: rect('#account-footer'),
        settings: rect('.mpw-settings-panel'),
        design: rect('#design-actions'),
        flow: rect('.mp-chat-flow'),
        chatHeader: rect('.mpw-header'),
        taskHeader: rect('.mp-inspector-header'),
        taskCard: rect('.mp-subagent-task'),
        taskHeading: rect('.mp-subagent-heading'),
        taskTitle: rect('.mp-subagent-heading strong'),
        taskMeta: rect('.mp-subagent-meta'),
        taskStats: rect('.mp-subagent-stats'),
        narration: rect('.mp-chat-narration'),
        narrationParagraph: rect('.mp-chat-narration p'),
        actualInput: rect('.mpw-input'),
        toolGroupHeader: rect('.mp-chat-tool-group-header'),
        user: rect('.mp-chat-user'),
        bubble: rect('.mp-chat-bubble'),
        assistantBody: rect('.mp-chat-assistant-body'),
        stream: rect('#stream'),
        composerSeat: rect('.mpw-composer-seat'),
        repositoryContext: rect('#composer-repository-context'),
        browserHost: rect('#project-browser-host'),
        sidebarProjects: document.querySelectorAll('#side-convos .mpw-project').length,
        sidebarSessions: document.querySelectorAll('#side-convos .side-item').length,
        navigationRows: Array.from(document.querySelectorAll('.mp-main-navigation > button, .mp-main-navigation > .mp-nav-row > .mpw-customize')).filter((element) => element.checkVisibility()).map((element) => {
          const value = element.getBoundingClientRect();
          const computed = getComputedStyle(element);
          const label = element.querySelector('.mp-nav-label');
          const icon = element.querySelector('.cds-icon');
          const labelBounds = label?.getBoundingClientRect();
          return {
            id: element.id, x: round(value.x), y: round(value.y), width: round(value.width), height: round(value.height),
            labelX: labelBounds ? round(labelBounds.x) : null,
            fontSize: computed.fontSize, lineHeight: computed.lineHeight, marginBottom: computed.marginBottom, gap: computed.gap,
            iconSize: icon ? getComputedStyle(icon).fontSize : null,
          };
        }),
        planRows: document.querySelectorAll('#composer-plan:not([hidden]) .mpw-plan-step').length,
        permissionActions: document.querySelectorAll('#composer-permission-ask:not([hidden]) .mpw-perm-ask-btn').length,
        turnErrors: document.querySelectorAll('#stream .mp-chat-turn-error').length,
        thinkingRows: document.querySelectorAll('#stream .mp-chat-think').length,
        expandedThinkingRows: document.querySelectorAll('#stream .mp-chat-think[data-open="true"]').length,
        subagentRows: document.querySelectorAll('#project-inspector:not([hidden]) .mp-subagent-task').length,
        settingsRows: document.querySelectorAll('#view-settings:not([hidden]) .mp-settings-row').length,
        designRows: document.querySelectorAll('#view-design:not([hidden]) .mp-design-action-row').length,
        composerBusy: document.getElementById('composer-form')?.getAttribute('aria-busy') === 'true',
        inspectorMaximized: document.getElementById('shell')?.dataset.inspectorMaximized === 'true',
        flowChildren: Array.from(document.querySelectorAll('.mp-chat-flow > *')).map((element) => {
          const value = element.getBoundingClientRect();
          return {
            className: element.className,
            x: round(value.x), y: round(value.y), width: round(value.width), height: round(value.height),
            text: String(element.textContent || '').replace(/\\s+/g, ' ').slice(0, 100),
          };
        }),
        assistantChildren: Array.from(document.querySelectorAll('.mp-chat-flow-item:last-child .mp-chat-assistant-body > *')).map((element) => {
          const value = element.getBoundingClientRect();
          return {
            className: element.className,
            tagName: element.tagName,
            x: round(value.x), y: round(value.y), width: round(value.width), height: round(value.height),
            text: String(element.textContent || '').replace(/\\s+/g, ' ').slice(0, 120),
          };
        }),
        activityRows: Array.from(document.querySelectorAll('.mp-chat-flow-item:last-child .mp-chat-tool-group-header, .mp-chat-flow-item:last-child .mp-chat-tool-group-body, .mp-chat-flow-item:last-child .mp-chat-tool .mp-chat-row')).map((element) => {
          const value = element.getBoundingClientRect();
          return { className: element.className, x: round(value.x), y: round(value.y), width: round(value.width), height: round(value.height), text: String(element.textContent || '').replace(/\\s+/g, ' ').slice(0, 80) };
        }),
        visibleToolRows: Array.from(document.querySelectorAll('#stream .mp-chat-tool-group-header, #stream .mp-chat-tool .mp-chat-row')).filter((element) => element.checkVisibility()).map((element) => {
          const value = element.getBoundingClientRect();
          return { className: element.className, x: round(value.x), y: round(value.y), width: round(value.width), height: round(value.height) };
        }),
        filePreviewContent: rect('#project-file-content'),
        filePreviewBlocks: Array.from(document.querySelectorAll('#project-file-content .mp-chat-markdown > *')).slice(0, 20).map((element) => {
          const value = element.getBoundingClientRect();
          return { tagName: element.tagName, className: element.className, x: round(value.x), y: round(value.y), width: round(value.width), height: round(value.height), text: String(element.textContent || '').replace(/\\s+/g, ' ').slice(0, 140) };
        }),
      },
      styles: {
        body: style('body'),
        sidebar: style('.mpw-sidebar'),
        sidebarProjectHeader: style('.mpw-project-row'),
        sidebarProjectName: style('.mpw-project-name'),
        sidebarSession: style('.side-item'),
        panel: style('#project-inspector'),
        composer: style('#composer-form .mpw-card'),
        homeTitle: style('#studio-home-title'),
        sidebarFooter: style('.mpw-foot'),
        updateCard: style('#update-card'),
        accountFooter: style('#account-footer'),
        toolGroupBody: style('.mp-chat-tool-group-body'),
        toolGroupHeader: style('.mp-chat-tool-group-header'),
        toolRow: style('.mp-chat-tool .mp-chat-row'),
        chatHeader: style('.mpw-header'),
        taskHeader: style('.mp-inspector-header'),
        taskCard: style('.mp-subagent-task'),
        taskHeading: style('.mp-subagent-heading'),
        taskTitle: style('.mp-subagent-heading strong'),
        taskMeta: style('.mp-subagent-meta'),
        taskStats: style('.mp-subagent-stats'),
        narration: style('.mp-chat-narration'),
        narrationParagraph: style('.mp-chat-narration p'),
        actualInput: style('.mpw-input'),
        inputScroll: style('.mpw-scroll'),
        inputSend: style('.mpw-primary'),
        bubble: style('.mp-chat-bubble'),
      },
      horizontalOverflow: round(horizontalOverflow),
      consoleState: document.readyState,
      scroll: (() => { const element = document.getElementById('stream'); return element ? {
        scrollTop: round(element.scrollTop), scrollHeight: round(element.scrollHeight), clientHeight: round(element.clientHeight),
      } : null; })(),
    };
  })()`);
}

function pixelHex(image, cssX, cssY, cssWidth, cssHeight) {
  const size = image.getSize();
  const bitmap = image.toBitmap();
  const scaleX = size.width / cssWidth;
  const scaleY = size.height / cssHeight;
  const x = Math.max(0, Math.min(size.width - 1, Math.round(cssX * scaleX)));
  const y = Math.max(0, Math.min(size.height - 1, Math.round(cssY * scaleY)));
  const offset = (y * size.width + x) * 4;
  const b = bitmap[offset] || 0;
  const g = bitmap[offset + 1] || 0;
  const r = bitmap[offset + 2] || 0;
  return `#${[r, g, b].map((value) => value.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

async function runElectron() {
  let options;
  try {
    options = parseOptions();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
    return;
  }

  const { app, BrowserWindow } = require('electron');
  app.commandLine.appendSwitch('force-device-scale-factor', String(options.scaleFactor));
  const profile = path.join(ROOT, 'data', 'runtime', 'probe-studio-layout-profile');
  fs.mkdirSync(profile, { recursive: true });
  app.setPath('userData', profile);

  await app.whenReady();
  const consoleErrors = [];
  const window = new BrowserWindow({
    width: options.width,
    height: options.height,
    useContentSize: true,
    frame: false,
    show: false,
    backgroundColor: options.theme === 'dark' ? '#151515' : '#FCFCFB',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      offscreen: true,
      preload: path.join(ROOT, 'scripts', 'probe_studio_layout_preload.js'),
      additionalArguments: [
        `--mp-probe-theme=${options.theme}`,
        `--mp-probe-state=${options.state}`,
      ],
    },
  });
  window.setContentSize(options.width, options.height);
  window.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    if (level >= 2) consoleErrors.push({ level, message: String(message).slice(0, 500), line, sourceId });
  });

  try {
    const studioHtml = path.join(ROOT, 'build', 'electron', 'renderer', 'studio.html');
    if (!fs.existsSync(studioHtml)) throw new Error('built Studio renderer is missing');
    await window.loadFile(studioHtml, { query: { view: 'chat' } });
    await waitForStudio(window.webContents);
    await window.webContents.executeJavaScript(statePreparationScript(options.state, options.theme));
    await window.webContents.executeJavaScript('document.fonts && document.fonts.ready');
    await settleTwoFrames(window.webContents);
    const metrics = await collectMetrics(window.webContents);
    const geometry = metrics.geometry;
    const stateFailures = [];
    const requireVisible = (name, value) => {
      if (!value || value.width <= 0 || value.height <= 0) stateFailures.push(`${name} missing`);
    };
    if (options.state === 'landing') {
      requireVisible('home', geometry.home);
      if (stateFailures.length) throw new Error(`invalid landing probe: ${stateFailures.join('; ')}`);
    } else if (options.state === 'conversation') {
      requireVisible('repository context', geometry.repositoryContext);
      if (geometry.sidebarProjects < 2) stateFailures.push('fewer than two project groups');
      if (geometry.sidebarSessions < 3) stateFailures.push('fewer than three session rows');
      if (geometry.flowChildren.length < 4) stateFailures.push('conversation fixture did not render');
      if (stateFailures.length) throw new Error(`invalid Studio work-state probe: ${stateFailures.join('; ')}`);
    } else if (options.state === 'conversation-inspector') {
      requireVisible('inspector', geometry.inspector);
      requireVisible('file preview', geometry.filePreviewContent);
      if (geometry.filePreviewBlocks.length < 2) stateFailures.push('file preview content missing');
      if (stateFailures.length) throw new Error(`invalid conversation-inspector probe: ${stateFailures.join('; ')}`);
    } else if (options.state === 'running') {
      if (geometry.planRows < 3) stateFailures.push('plan steps missing');
      if (!geometry.composerBusy) stateFailures.push('composer is not busy');
      if (stateFailures.length) throw new Error(`invalid running probe: ${stateFailures.join('; ')}`);
    } else if (options.state === 'permission') {
      if (geometry.permissionActions < 3) stateFailures.push('permission actions missing');
      if (stateFailures.length) throw new Error(`invalid permission probe: ${stateFailures.join('; ')}`);
    } else if (options.state === 'error') {
      if (geometry.turnErrors < 1) stateFailures.push('turn error missing');
      if (stateFailures.length) throw new Error(`invalid error probe: ${stateFailures.join('; ')}`);
    } else if (options.state === 'inspector-maximized') {
      requireVisible('inspector', geometry.inspector);
      if (!geometry.inspectorMaximized) stateFailures.push('inspector is not maximized');
      if (stateFailures.length) throw new Error(`invalid inspector-maximized probe: ${stateFailures.join('; ')}`);
    } else if (options.state === 'thinking-expanded') {
      if (geometry.thinkingRows < 1) stateFailures.push('thinking row missing');
      if (geometry.expandedThinkingRows < 1) stateFailures.push('thinking row is not expanded');
      if (stateFailures.length) throw new Error(`invalid thinking-expanded probe: ${stateFailures.join('; ')}`);
    } else if (options.state === 'subagent') {
      if (geometry.subagentRows < 1) stateFailures.push('subagent row missing');
      if (stateFailures.length) throw new Error(`invalid subagent probe: ${stateFailures.join('; ')}`);
    } else if (options.state === 'browser') {
      requireVisible('browser host', geometry.browserHost);
      if (stateFailures.length) throw new Error(`invalid browser probe: ${stateFailures.join('; ')}`);
    } else if (options.state === 'customize') {
      if (geometry.settingsRows < 1) stateFailures.push('settings rows missing');
      if (stateFailures.length) throw new Error(`invalid customize probe: ${stateFailures.join('; ')}`);
    } else if (options.state === 'design') {
      if (geometry.designRows < 4) stateFailures.push('design rows missing');
      if (stateFailures.length) throw new Error(`invalid design probe: ${stateFailures.join('; ')}`);
    } else if (options.state === 'minimum') {
      requireVisible('home', geometry.home);
      if (!geometry.sidebar || geometry.sidebar.width > 44) stateFailures.push('sidebar is not collapsed');
      if (stateFailures.length) throw new Error(`invalid minimum probe: ${stateFailures.join('; ')}`);
    }
    const image = await window.webContents.capturePage();
    const imageSize = image.getSize();
    const points = {
      titlebar: [Math.min(options.width - 1, 420), 18],
      sidebar: [Math.min(options.width - 1, 120), Math.min(options.height - 1, 90)],
      page: [Math.min(options.width - 1, 320), Math.min(options.height - 1, 90)],
      stats: metrics.geometry.stats
        ? [metrics.geometry.stats.x + metrics.geometry.stats.width / 2, metrics.geometry.stats.y + metrics.geometry.stats.height / 2]
        : null,
      inspector: metrics.geometry.inspector
        ? [metrics.geometry.inspector.x + metrics.geometry.inspector.width / 2, metrics.geometry.inspector.y + 20]
        : null,
    };
    const pixelSamples = {};
    for (const [name, point] of Object.entries(points)) {
      if (point) pixelSamples[name] = pixelHex(image, point[0], point[1], options.width, options.height);
    }

    fs.mkdirSync(path.dirname(options.output), { recursive: true });
    fs.writeFileSync(options.output, image.toPNG());
    const metadataPath = options.output.replace(/\.png$/i, '') + '.json';
    fs.writeFileSync(metadataPath, JSON.stringify({
      options,
      imageSize,
      geometry: metrics.geometry,
      styles: metrics.styles,
      scroll: metrics.scroll,
      horizontalOverflow: metrics.horizontalOverflow,
      pixelSamples,
      consoleErrors,
    }, null, 2));

    process.stdout.write(
      `state=${options.state} theme=${options.theme} viewport=${options.width}x${options.height} dpr=${options.scaleFactor}\n`
      + `png=${options.output}\nmetadata=${metadataPath}\n`
      + `image=${imageSize.width}x${imageSize.height} horizontal_overflow=${metrics.horizontalOverflow} console_errors=${consoleErrors.length}\n`,
    );
    if (metrics.horizontalOverflow > 0 || consoleErrors.length > 0) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`Studio probe failed: ${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    for (const entry of consoleErrors.slice(0, 12)) {
      process.stderr.write(`console[${entry.level}] ${entry.message} (${entry.sourceId}:${entry.line})\n`);
    }
    process.exitCode = 1;
  } finally {
    window.destroy();
    app.exit(process.exitCode || 0);
  }
}

if (process.versions.electron) {
  void runElectron();
} else {
  launchElectron();
}
