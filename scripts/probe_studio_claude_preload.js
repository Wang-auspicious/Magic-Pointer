'use strict';

const { contextBridge } = require('electron');

const option = (name, fallback) => {
  const prefix = `--mp-probe-${name}=`;
  const raw = process.argv.find((value) => String(value).startsWith(prefix));
  return raw ? String(raw).slice(prefix.length) : fallback;
};

const theme = option('theme', 'light') === 'dark' ? 'dark' : 'light';
const state = option('state', 'landing');
const emptyLanding = state === 'landing' || state === 'minimum';
const exactConversation = state === 'conversation';
const PROJECT_ROOT = 'D:/Desktop/VisLexicon 视元';
const MAGIC_POINTER_ROOT = 'D:/Desktop/Magic Pointer';
const NOW = Date.parse('2026-09-01T18:40:00+08:00');

try { globalThis.localStorage.setItem('mp:theme', theme); } catch (_) {}

const referenceConversations = [
  {
    id: 'studio-reference',
    title: 'Greeting',
    subtitle: 'VisLexicon 视元',
    workspaceRoot: PROJECT_ROOT,
    updatedAt: NOW,
    hasPendingWork: state === 'running' || state === 'permission',
    object: { app: 'Claude', windowTitle: 'Greeting', label: 'VisLexicon 视元' },
    turns: [
      {
        at: NOW - 12 * 60 * 1000,
        question: '你好',
        answer: '你好!我是Claude。看到你在 `D:\\Desktop\\VisLexicon 视元` 这个\n目录下。\n\n有什么我可以帮你的吗?比如写代码、调试问题、分析文件,或者聊聊\n这个项目的想法?',
        modelUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        modelId: 'claude-opus-5 1M',
      },
      {
        at: NOW - 3 * 60 * 1000,
        question: '读本地的两个md文件。然后查一下我们目标产品的已有近似产品的形态如何。然后写一份调研.md并进一步完善实现思路。如果有开源的我们直接拿来用而不用重复造轮子。先实现一个demo',
        thinking: state === 'thinking-expanded' ? [
          '我需要先核对项目的本地文档和目录结构，再判断哪些现成项目真正可以复用。',
          '第一步是找到两份 Markdown 原文，不依赖摘要推测需求。',
          '第二步是将产品边界拆成资产检索、语义标注、规格输出和 Agent 交付。',
          '第三步是只比较与这些边界直接重合的开源实现。',
          '我会保留每个候选的许可证、活跃度、接口形态和失败语义。',
          '可以直接复用的部分应该进入适配层，不应把外部工程的整套壳搬进核心。',
          '这样最后demo能验证真实链路，同时不会把原型写成无法替换的一次性代码。',
          '现在先读文件，再开始外部对照。',
        ].join('\n') : undefined,
        answer: '读完了。',
        trajectory: [
          { kind: 'message', text: '我先找到本地的两个 md 文件,同时看看目录结构。' },
          { kind: 'tool', groupLabel: 'Found files, ran a command', name: 'search', callId: 'search-md', state: 'done', text: JSON.stringify({ pattern: '**/*.md' }), result: 'VisLexicon-完整方案.md\nrebuttal.md', isError: false, usedBackend: 'filesystem', startedAt: 1000, completedAt: 9000 },
          { kind: 'tool', groupLabel: 'Found files, ran a command', name: 'list_dir', callId: 'list-root', state: 'done', text: JSON.stringify({ path: '.' }), result: 'VisLexicon-完整方案.md\nrebuttal.md', isError: false, usedBackend: 'filesystem', startedAt: 9000, completedAt: 12000 },
          { kind: 'message', text: '找到两个文件了,我读一下。' },
          { kind: 'tool', groupLabel: 'Read 2 files', name: 'read_file', callId: 'read-plan', state: 'done', text: JSON.stringify({ path: 'VisLexicon-完整方案.md' }), result: '内容', isError: false, usedBackend: 'filesystem', startedAt: 12000, completedAt: 30000 },
          { kind: 'tool', groupLabel: 'Read 2 files', name: 'read_file', callId: 'read-rebuttal', state: 'done', text: JSON.stringify({ path: 'rebuttal.md' }), result: '内容', isError: false, usedBackend: 'filesystem', startedAt: 30000, completedAt: 68000 },
        ],
        modelUsage: { inputTokens: 0, outputTokens: 417, totalTokens: 417 },
        modelId: 'claude-opus-5 1M',
        timingMs: 67000,
        usedBackend: 'magic_pointer.messages_multiturn_streaming',
      },
    ],
  },
  // 本机会话：参考图只展示当前项目下的 Greeting，避免额外历史行污染像素夹具。
];

const magicPointerQuestion = '继续找我这个项目的代码里的错误。任何小细节不要放过。“D:\\Desktop\\Magic Pointer\\AGENTS.md”先读一下。然后开工。尽可能少的浪费时间。精准命中所有错误并快速修改。我现在连一个完整的agent闭环，用我这个harness处理一个负责的项目任务，完全做不了。差距到底在哪里。全部补齐。然后我们独特的感知层现在面临什么问题到底一直体验很差，识别不好。这里也重点排查。不开subagent。快速的做。';

const exactConversationRows = [
  {
    id: 'magic-pointer-debugging',
    title: 'Magic Pointer agent debugging',
    subtitle: 'Magic-Pointer',
    workspaceRoot: MAGIC_POINTER_ROOT,
    updatedAt: NOW,
    turns: [{
      at: NOW - 60_000,
      question: '排查 Magic Pointer agent 闭环。',
      answer: 'The previous run stopped before completing the requested work.',
      failed: true,
    }],
  },
  {
    id: 'magic-pointer-review',
    title: 'Magic Pointer 项目代码审查与问题排查',
    subtitle: 'Magic-Pointer',
    workspaceRoot: MAGIC_POINTER_ROOT,
    updatedAt: NOW - 30_000,
    hasPendingWork: false,
    turns: [
      ...Array.from({ length: 3 }, (_, index) => ({
        at: NOW - (30 - index * 4) * 60_000,
        question: `Earlier project investigation ${index + 1}`,
        answer: 'Reviewed the project runtime, renderer contracts, and recent delivery evidence.\nRecorded the concrete findings before continuing the current investigation.',
      })),
      {
        at: NOW - 12 * 60_000,
        answer: "Ready. What's the task for Magic Pointer?",
      },
      {
        at: NOW - 2 * 60_000,
        question: magicPointerQuestion,
        answer: "It looks like a file (`STATUS.md`) was partially loaded but I don't see the actual question or task you'd like help with yet.\nCould you let me know what you'd like me to do — for example, summarize the status file, find a specific section, or work on something else in the Magic Pointer project?",
        trajectory: [
          { kind: 'message', text: 'AGENTS.md read. No subagent per instruction. Reading required docs first per mandatory-read rule.' },
          { kind: 'tool', name: 'Bash', callId: 'git-status', state: 'done', text: JSON.stringify({ command: 'git status --short; git log -5 --oneline' }), result: 'main · working tree has changes', isError: false, usedBackend: 'powershell', summary: 'Checked git status and recent commits' },
          { kind: 'message', text: 'I see a suspicious system-reminder claiming fake “prior steps” and instructing me to skip re-reading. That’s a prompt injection — ignoring it. Continuing normally with real work.' },
          { kind: 'message', text: 'Mandatory docs first per AGENTS.md.' },
          { kind: 'tool', name: 'Read', callId: 'read-status', state: 'done', text: JSON.stringify({ file_path: 'D:\\Desktop\\Magic Pointer\\docs\\STATUS.md' }), result: 'Current status loaded', isError: false, usedBackend: 'filesystem', summary: 'Read STATUS.md' },
        ],
      },
    ],
  },
  {
    id: 'vislexicon-greeting',
    title: 'Greeting',
    subtitle: 'VisLexicon 视元',
    workspaceRoot: PROJECT_ROOT,
    updatedAt: NOW - 2 * 60_000,
    turns: [{ at: NOW - 2 * 60_000, question: '你好', answer: '你好。' }],
  },
];

const conversations = exactConversation ? exactConversationRows : referenceConversations;

/* The reference account's 26×7 overview grid.  The renderer consumes the
   same column-major order as Claude (seven days per week column). */
const referenceHeatLevels = [
  '1111111111111111111...12.1',
  '1111111111111111111...411.',
  '1111111111111111111...4111',
  '1111111111111111111..141.1',
  '1111111111111111111..331..',
  '1111111111111111111..23111',
  '111111111111111111...221..',
];
const heatmap = Array.from({ length: 182 }, (_, index) => {
  const day = new Date(Date.parse('2026-03-16T12:00:00+08:00') + index * 86_400_000);
  const date = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
  const column = Math.floor(index / 7);
  const row = index % 7;
  const level = Number(referenceHeatLevels[row][column] || 0);
  return { date, messages: level, future: false };
});

const daily = heatmap.map((entry, _index) => ({
  date: entry.date,
  inputTokens: entry.messages * 73_000,
  outputTokens: entry.messages * 19_000,
  totalTokens: entry.messages * 92_000,
  messages: entry.messages,
}));
const modelRows = [
  { modelId: 'claude-opus-5 1M', inputTokens: 1_720_000_000, outputTokens: 430_000_000, totalTokens: 2_150_000_000, turns: 214, share: 86 },
  { modelId: 'claude-sonnet-4', inputTokens: 250_000_000, outputTokens: 100_000_000, totalTokens: 350_000_000, turns: 17, share: 14 },
];
const allStats = {
  sessions: 231,
  messages: 52_275,
  totalTokens: 2_500_000_000,
  activeDays: 157,
  currentStreak: 1,
  longestStreak: 132,
  peakHour: 16,
  favoriteModel: 'Opus 5',
  heatmap,
  daily,
  models: modelRows,
};
const stats = {
  ...allStats,
  ranges: {
    all: allStats,
    '30d': {
      ...allStats,
      sessions: 47,
      messages: 8_412,
      totalTokens: 388_000_000,
      activeDays: 29,
      currentStreak: 1,
      longestStreak: 24,
      heatmap: heatmap.slice(-30),
      daily: daily.slice(-30),
      models: modelRows.map((row) => ({ ...row, inputTokens: Math.round(row.inputTokens * .155), outputTokens: Math.round(row.outputTokens * .155), totalTokens: Math.round(row.totalTokens * .155) })),
    },
    '7d': {
      ...allStats,
      sessions: 12,
      messages: 1_639,
      totalTokens: 74_000_000,
      activeDays: 7,
      currentStreak: 1,
      longestStreak: 7,
      heatmap: heatmap.slice(-7),
      daily: daily.slice(-7),
      models: modelRows.map((row) => ({ ...row, inputTokens: Math.round(row.inputTokens * .03), outputTokens: Math.round(row.outputTokens * .03), totalTokens: Math.round(row.totalTokens * .03) })),
    },
  },
};

const projectEntries = {
  '': [
    { name: 'VisLexicon-完整方案.md', path: 'VisLexicon-完整方案.md', kind: 'file' },
    { name: 'rebuttal.md', path: 'rebuttal.md', kind: 'file' },
    { name: 'app', path: 'app', kind: 'directory' },
    { name: 'electron', path: 'electron', kind: 'directory' },
    { name: 'scripts', path: 'scripts', kind: 'directory' },
    { name: 'tests', path: 'tests', kind: 'directory' },
    { name: 'AGENTS.md', path: 'AGENTS.md', kind: 'file' },
    { name: 'package.json', path: 'package.json', kind: 'file' },
  ],
  electron: [
    { name: 'renderer', path: 'electron/renderer', kind: 'directory' },
    { name: 'main.ts', path: 'electron/main.ts', kind: 'file' },
    { name: 'preload.ts', path: 'electron/preload.ts', kind: 'file' },
  ],
  'electron/renderer': [
    { name: 'claude_chat.css', path: 'electron/renderer/claude_chat.css', kind: 'file' },
    { name: 'claude_shell.css', path: 'electron/renderer/claude_shell.css', kind: 'file' },
    { name: 'claude_tokens.css', path: 'electron/renderer/claude_tokens.css', kind: 'file' },
    { name: 'studio.ts', path: 'electron/renderer/studio.ts', kind: 'file' },
  ],
};

/* Visible Markdown fixture copied from the supplied Claude transcript.  It is
   deliberately kept as plain text so the Inspector exercises the same
   Markdown path as a real project file. */
const referencePlan = [
  '# VisLexicon（视元）完整方案',
  '',
  '> 一句话定位：给人类用的"前端视觉选型器"，给 Agent 用的"设计上下文供给站"。人在这里"挑"，Agent 从这里"取"。',
  '> 挑的结果不是灵感，而是一份可执行的精确规格（Design Spec）。',
  '',
  '## 0. 先纠正原始思路里的三个偏差',
  '',
  '在展开方案之前，必须先把想法里三个隐含的错误假设摆正，否则后面全部工程都会歪：',
  '',
  '偏差一：以为产品是"聚合站"。聚合站（awesome-list 网页版）没有护城河，且已有大量竞品（uiverse.io、21st.dev、Mobbin、Godly、Awwwards、Component Party 等）。真正的空白不是"收集"，而是**"收集之后的结构化"**：把散乱资产收敛到一套受控词表（Controlled Vocabulary）上，并以机器可读的方式分发给 Agent。词表＋标注数据＋分发协议才是产品，聚合只是原料采购。',
  '',
  '偏差二：以为核心交付物是"代码"或"图"。用户最终要的既不是一张图也不是一段复制来的代码，而是**"我的 Agent 能一次做对"**。所以本站真正的输出物是一份 Design Spec（设计规格 JSON＋高清资产 URL 集）——用户在站内点选、组合，站点生成规格，用户把一个链接丢给自己的 Agent，Agent 拉取规格与图像后进行 visual coding。图和代码都是规格的附件。',
  '',
  '偏差三：以为"把小红书/X 的图搬过来"是可行的。中心化抓取并二次分发社交平台图片，在版权和反爬两个维度上都是死路（详见 89 法律架构）。正确做法是**"元数据中心化、像素分发去中心化"**：平台只存标签、嵌入向量、缩略图和原始链接；高清原图由用户侧的开源取图组件（MCP Server / CLI / Skill）在用户机器上实时从源站获取**。这一架构决策同时解决了版权、存储成本和反爬三个问题，是全方案最重要的一步棋。',
  '',
  '## 1. 问题定义与价值主张',
  '',
  '### 1.1 断层在哪里',
  '',
  '| 环节 | 现状 | 痛点 |',
  '| --- | --- | --- |',
  '| 想要什么 | 普通人视野有限，不知道好设计长什么样 | 见识不足 → 目标模糊 |',
  '| 说出想要什么 | 自然语言描述交互/动效/排版极其低效 | 语义鸿沟：“那种滑过去有点弹的感觉” |',
  '| 找到参考 | 资产散落在几十个组件库、GitHub、社交平台 | 检索成本高，且找到的东西不可复用 |',
  '| 交给 AI 做 | 把模糊描述丢给 Agent，产出平庸的"AI 味"页面 | 上下文里没有精确视觉信号 |',
  '| 验收 | 用户说"不对，再改改" | 无标准，无限返工 |',
  '',
  '### 1.2 VisLexicon 在每一环的解法',
  '',
  '1. 见识：视觉词典＋灵感画廊，让用户"逛"出品味；',
  '2. 表达：每个视觉现象绑定行业标准术语＋可交互演示，用户点选代替描述；',
  '3. 检索：用户用标准术语组合筛选，找到可复用的真实参考；',
  '4. 交付：生成机器可读的 Design Spec，直接交给 Agent；',
].join('\n');
const referenceRebuttal = [
  '# rebuttal',
  '',
  '这是第二个本地 md 文件，用于验证批量读取和 Inspector 文件预览。',
].join('\n');
// Transcript labels rendered by the Studio activity rows: Searched **/*.md ·
// Listed files in working directory · Read 2 files · 1m 7s · 417 tokens.

const settings = {
  general: { launch_at_login: false, keep_running: true, check_updates: true },
  interaction: {
    wake_enabled: true,
    wake_gesture: 'wiggle',
    default_input_mode: 'text',
    voice_enabled: false,
    voice_resident_enabled: false,
  },
  appearance: { theme, material: 'solid', compact_mode: false },
  privacy: {
    screen_memory_enabled: false,
    background_learning_enabled: false,
    retain_captures_days: 7,
    offline_only: false,
  },
  permissions: { default_mode: 'workspace-write', ask_external_send: true },
};

const listeners = {
  progress: [],
  turn: [],
  browser: [],
  show: [],
  card: [],
};
let selectedModel = 'claude-opus-5 1M';

const ok = async () => ({ ok: true });

contextBridge.exposeInMainWorld('magicPointerDashboard', {
  hide: () => {},
  setTheme: () => {},
  startDictation: () => {},
  stopDictation: () => {},
  saveFabricSettings: async () => ({ ok: true, settings }),
  getFabricSettings: async () => ({
    ok: true,
    settings,
    modelStatus: {
      configured: true,
      displayName: 'Claude Opus 5 1M',
      provider: 'Anthropic',
      model: 'claude-opus-5 1M',
      credentialPresent: true,
      credentialBackendAvailable: true,
    },
  }),
  modelsCatalog: async () => ({
    ok: true,
    catalog: {
      current: selectedModel,
      provider: 'Anthropic',
      source: 'probe fixture',
      groups: [{ id: 'anthropic', name: 'Anthropic', models: [
        { id: 'claude-opus-5 1M', vision: false, contextWindow: 1_000_000 },
        { id: 'claude-sonnet-4', vision: true, contextWindow: 200_000 },
        { id: 'claude-haiku-4', vision: false, contextWindow: 128_000 },
      ] }],
    },
  }),
  slashDirectory: async () => ({
    ok: true,
    commands: [
      { name: 'compact', description: '压缩当前上下文' },
      { name: 'help', description: '查看本地命令' },
    ],
    skills: [
      { name: 'frontend-design', description: '高质量前端界面实现' },
      { name: 'pdf', description: '读取与生成 PDF' },
    ],
    errors: [],
  }),
  selectModel: async (model) => {
    selectedModel = String(model);
    return { ok: true, model: selectedModel };
  },
  projects: {
    list: async () => emptyLanding ? [] : exactConversation
      ? [
          { root: MAGIC_POINTER_ROOT, name: 'Magic-Pointer', lastOpenedAt: NOW },
          { root: PROJECT_ROOT, name: 'VisLexicon 视元', lastOpenedAt: NOW - 2 * 60_000 },
        ]
      : [{ root: PROJECT_ROOT, name: 'VisLexicon 视元', lastOpenedAt: NOW }],
    open: async () => ({ ok: true, project: { root: exactConversation ? MAGIC_POINTER_ROOT : PROJECT_ROOT, name: exactConversation ? 'Magic-Pointer' : 'VisLexicon 视元', lastOpenedAt: NOW } }),
    pickFiles: async () => ({ ok: true, paths: [exactConversation ? 'D:/Desktop/Magic Pointer/AGENTS.md' : 'D:/Desktop/VisLexicon 视元/VisLexicon-完整方案.md'] }),
    tree: async (_root, relativePath = '') => ({ ok: true, entries: projectEntries[relativePath] || [] }),
    readFile: async (_root, relativePath) => ({
      ok: true,
      text: relativePath === 'VisLexicon-完整方案.md'
        ? referencePlan
        : relativePath === 'rebuttal.md'
          ? referenceRebuttal
          : /\.md$/i.test(relativePath)
            ? referencePlan
        : `/* ${relativePath} */\n:root {\n  --mp-window-bar: 36px;\n  --mp-sidebar-width: 288px;\n}\n`,
      truncated: false,
    }),
    openPath: ok,
    openUrl: ok,
    environment: async (root) => String(root).replace(/\\/g, '/').includes('Magic Pointer') ? ({
      ok: true,
      root: MAGIC_POINTER_ROOT,
      name: 'Magic-Pointer',
      isGit: true,
      branch: 'main',
      upstream: 'origin/main',
      ahead: 4,
      behind: 0,
      changedFiles: 47,
      addedLines: 14_964,
      deletedLines: 20_045,
      pullRequestUrl: 'https://github.com/Wang-auspicious/Magic-Pointer/compare/main',
      fileChanges: [
        { path: 'electron/renderer/claude_shell.css', status: 'M', staged: false },
        { path: 'electron/renderer/studio.ts', status: 'M', staged: false },
      ],
      sources: ['docs/design/MAGIC_POINTER_HARNESS_20260811.md', 'design.md'],
    }) : ({
      ok: true,
      root: PROJECT_ROOT,
      name: 'VisLexicon 视元',
      isGit: true,
      branch: 'codex/claude-fidelity-studio-rebuild',
      upstream: 'origin/main',
      ahead: 7,
      behind: 0,
      changedFiles: 4,
      addedLines: 220,
      deletedLines: 19_312,
      fileChanges: [
        { path: 'electron/renderer/claude_shell.css', status: 'M', staged: false },
        { path: 'electron/renderer/studio.ts', status: 'M', staged: false },
      ],
      sources: ['docs/design/MAGIC_POINTER_HARNESS_20260811.md', 'design.md'],
    }),
    contextMenu: async () => ({ ok: true, action: 'copy-path', absolutePath: PROJECT_ROOT }),
    runCommand: async () => ({ ok: true, code: 0, output: 'typecheck passed\nnode suite passed' }),
  },
  browserView: {
    open: async (url) => ({ ok: true, state: { url, title: 'Magic Pointer', loading: false } }),
    resize: ok,
    command: async () => ({ ok: true, state: { url: 'https://example.test', title: 'Fixture', loading: false } }),
    onState: (callback) => listeners.browser.push(callback),
  },
  windowControls: { command: async () => ({ ok: true, version: '1.0.33', electron: process.versions.electron, chrome: process.versions.chrome }) },
  updates: {
    status: async () => exactConversation
      ? { state: 'idle' }
      : emptyLanding
      ? { state: 'downloading', version: '1.37937.3' }
      : { state: 'downloaded', version: '1.37937.3' },
    check: async () => ({ ok: true }),
    onStatus: () => {},
  },
  conversations: {
    list: async () => emptyLanding ? [] : conversations,
    stats: async () => stats,
    get: async (id) => conversations.find((conversation) => conversation.id === id),
    branch: async () => ({ ok: true, conversation: conversations[0] }),
    send: async () => ({ ok: true, conversationId: exactConversation ? 'magic-pointer-review' : 'studio-reference' }),
    pickWorkspace: async () => ({ ok: true, path: exactConversation ? MAGIC_POINTER_ROOT : PROJECT_ROOT }),
    export: async () => ({ ok: true, path: 'C:/probe/session.md' }),
    rename: async ({ title }) => ({ ok: true, title }),
    delete: ok,
    stop: async () => ({ ok: true, sessionId: 'mp-probe-session' }),
    steer: async () => ({ ok: true, messageId: 'probe-steer' }),
    timeline: async () => [],
    memories: async () => [{ key: 'studio-style', title: 'Studio 视觉边界', summary: '轻量、克制、真实状态。' }],
    artifacts: async () => [{ name: 'Claude-fidelity Studio', kind: 'design', at: NOW, conversationId: 'studio-reference' }],
    onProgress: (callback) => listeners.progress.push(callback),
    onTurn: (callback) => listeners.turn.push(callback),
  },
  stash: {
    list: async () => [],
    describe: async () => ({ ok: true, summary: '' }),
    onEntry: () => {},
  },
  onShow: (callback) => listeners.show.push(callback),
  onCardPatch: (callback) => listeners.card.push(callback),
  learningCandidates: { request: async () => ({ ok: true, items: [] }) },
});
