// @ts-nocheck -- legacy classic-script globals are preserved during the extension migration.
/* 卡片画廊。只用来核对视觉——每一张都是 renderCard 的真实输出，
   不是另画一遍的样子。所以这一页看到什么，产品里就是什么。 */

const SAMPLES = [
  ['运行中 · 没有已知进度', 'capsule', {
    kind: 'prose', state: 'running',
    source: { app: 'VS Code', label: '第 118 行' },
  }],

  ['运行中 · 已知步骤', 'full', {
    kind: 'prose', state: 'running',
    source: { app: 'VS Code', label: 'uia_text_adapter.py' },
    steps: [
      CardModel.phaseStep({ phase: 'payload_read', ms: 3 }),
      CardModel.phaseStep({ phase: 'pixels_frozen', ms: 412, fields: { w: '2950', h: '1200' } }),
      CardModel.phaseStep({ phase: 'structured_read', ms: 90, fields: { hit: 'uia' } }),
      CardModel.phaseStep({ phase: 'route_recipe', ms: 12, fields: { recipe: 'explain_code' } }),
    ],
  }],

  ['一段话', 'full', {
    kind: 'prose',
    title: '这段代码在干嘛？',
    source: { app: 'VS Code', label: '第 118 行' },
    answer: '这是 UIA 探针的**硬超时兜底**。`_probe_with_deadline` 给每次跨进程读取 200ms，超过就放弃结构层、退到像素层。\n\n200 这个数不是拍的——探针本身冷启动就要 175ms，所以留给实际读取的只有 25ms。这就是为什么四个普通窗口全部超时失败：**它撞的是自己的启动开销，不是目标窗口慢。**',
  }],

  ['已确认的事实', 'full', {
    kind: 'facts',
    rows: [
      { label: '定义位置', value: 'uia_text_adapter.py:118' },
      { label: '最后修改', value: '7 天前 · d9f92b1' },
      { label: '实测冷启动', value: '175 ms' },
      { label: '当前状态', value: '四窗全部超时', tone: 'terracotta' },
    ],
  }],

  ['数据', 'full', {
    kind: 'metric',
    value: '175', unit: 'ms', delta: '+340%', deltaTone: 'terracotta',
    caption: '探针冷启动，n=20 的 p50。200ms 预算里只剩 25ms 给实际读取。',
    foot: [
      { value: '0/5', label: '记事本' },
      { value: '0/5', label: '资源管理器' },
      { value: '1/5', label: 'VS Code' },
      { value: '0/5', label: '终端' },
    ],
  }],

  ['图 · 正在出', 'full', { kind: 'image', state: 'running', w: 1024, h: 640, progress: 0.62 }],

  ['图 · 出好了', 'full', {
    kind: 'image', w: 1024, h: 640,
    src: 'data:image/svg+xml;base64,' + btoa(`<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="640">
      <defs><linearGradient id="g" x1="0" y1="1" x2="1" y2="0">
        <stop offset="0" stop-color="#F3D9A8"/><stop offset=".5" stop-color="#DFC0A6"/>
        <stop offset="1" stop-color="#A8CBB4"/></linearGradient></defs>
      <rect width="1024" height="640" fill="url(#g)"/></svg>`),
    caption: '去掉了背景，边缘按头发丝细化过',
  }],

  ['提案 · 要你点头', 'full', {
    kind: 'proposal',
    title: '整理桌面',
    summary: '桌面上找到 8 个文件，和 DietControl AI、产品文档、地图类三件事有关。要归到三个文件夹里吗？',
    preview: { kind: 'folders', items: [{ name: '地图类' }, { name: 'DietControl AI' }, { name: '产品文档' }] },
    irreversible: true,
    actions: [{ id: 'reject', label: '不用' }, { id: 'approve', label: '就这么办' }],
  }],

  ['写回预览', 'full', {
    kind: 'diff',
    title: '改动',
    original: 'PROBE_DEADLINE_MS = 200',
    proposed: 'PROBE_DEADLINE_MS = 600  # 175ms 是探针自身冷启动，留 425ms 给实际读取',
    actions: [{ id: 'copy', label: '改成复制到剪贴板' }, { id: 'write', label: '写回并二次确认' }],
  }],

  ['对比', 'full', {
    kind: 'table',
    title: '超时预算复测 · 交替 A/B 20 轮',
    columns: ['窗口', 'A 200ms', 'B 600ms', '结论'],
    rows: [
      ['记事本', '0/5', '5/5', '受限于自身开销'],
      ['资源管理器', '0/5', '5/5', '同上'],
      ['VS Code', '1/5', '5/5', '同上'],
      ['Windows 终端', '0/5', '2/5', '另需 RangeFromPoint'],
    ],
  }],

  ['日程草稿', 'full', {
    kind: 'calendar',
    title: '和设计过一遍卡片',
    start: '8月8日 14:00', end: '15:00',
    location: '会议室 B / 飞书',
    conflict: '和「周会」有 15 分钟重叠',
    actions: [{ id: 'edit', label: '改一下' }, { id: 'create', label: '创建' }],
  }],

  ['提示词草稿', 'full', {
    kind: 'prompt',
    title: '交给 Claude Code',
    prompt: '在 app/adapters/uia_text_adapter.py 里，把 PROBE_DEADLINE_MS 从 200 改成 600，\n并在旁边写清楚为什么：175ms 是探针自身冷启动，200ms 预算只剩 25ms 给实际读取。\n改完跑 tests/uia_text_adapter_test.py。',
    actions: [{ id: 'send', label: '发给 codex · 这个仓库' }],
  }],

  ['过程 · 没有产物', 'full', {
    kind: 'steps',
    title: '整理好了',
    steps: [
      { label: '读了桌面上的 8 个文件', state: 'done' },
      { label: '按内容归成三类', note: '3 组', state: 'done' },
      { label: '建了文件夹并移入', note: '8 个', state: 'done' },
      { label: '回读确认', note: '8/8', state: 'done' },
    ],
    actions: [{ id: 'undo', label: '撤回' }],
  }],

  ['失败 · 停在断掉的地方', 'full', {
    kind: 'image', state: 'failed', progress: 0.6, w: 1024, h: 640,
    error: '模型没返回。已经花掉的算力不会退，但没有改动任何东西。',
    actions: [{ id: 'retry', label: '再试一次' }],
  }],

  ['胶囊密度 · 同一张卡', 'capsule', {
    kind: 'prose',
    source: { app: 'Windows 终端' },
    answer: '这条报错是端口被占了。占用它的是上一次没退干净的 `ocr_resident_worker`，PID 18244。',
    actions: [{ id: 'kill', label: '结束它' }],
  }],
];

const grid = document.getElementById('grid');
for (const [caption, density, raw] of SAMPLES) {
  const cell = document.createElement('div');
  cell.className = density === 'capsule' ? 'cell narrow' : 'cell';
  const cap = document.createElement('div');
  cap.className = 'cap';
  cap.textContent = caption;
  cell.appendChild(cap);
  const card = CardModel.normalizeCard(raw);
  card.runningLabel = CardModel.runningLabel(card);
  cell.appendChild(renderCard(card, { density }));
  grid.appendChild(cell);
}
