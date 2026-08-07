/* ============================================================
   数据层
   ------------------------------------------------------------
   有桥就走桥（Electron 里的真实记录），没有桥就用样例（浏览器里预览）。
   页面只跟这一层打交道，不直接碰 IPC——所以换数据源不用改渲染。
   ============================================================ */

/* exported Data, formatTime, dayLabel */

const bridge = () => window.magicPointerDashboard || null;
const hasBridge = () => Boolean(bridge()?.conversations);

/* ---------- 样例：只在没有桥的时候用 ---------- */
const DEMO_CONVERSATIONS = [
  {
    id: 'demo-1',
    title: '这段代码在干嘛？',
    subtitle: 'VS Code · uia_text_adapter.py',
    updatedAt: Date.parse('2026-08-06T12:33:00'),
    object: { app: 'VS Code', windowTitle: 'uia_text_adapter.py', label: '第 118 行' },
    outcomes: ['结构层'],
    turns: [{
      at: Date.parse('2026-08-06T12:33:00'),
      question: '这段代码在干嘛？为什么要有 200ms 这个数？',
      answer: '这是 UIA 探针的硬超时兜底。',
    }],
  },
  {
    id: 'demo-2',
    title: '把这三列汇总',
    subtitle: 'Excel · 2026Q3.xlsx',
    updatedAt: Date.parse('2026-08-06T11:12:00'),
    object: { app: 'Excel', windowTitle: '2026Q3.xlsx', label: 'C:E 列' },
    outcomes: ['已写回'],
    turns: [],
  },
  {
    id: 'demo-3',
    title: '这条报错什么意思',
    subtitle: 'Windows 终端',
    updatedAt: Date.parse('2026-08-06T09:44:00'),
    object: { app: 'Windows 终端', windowTitle: '', label: '像素兜底' },
    outcomes: ['像素来源'],
    turns: [],
  },
];

const DEMO_STASH = [
  { id: 'b1', title: '看 Oreo 那套组件', app: 'Chrome', icon: 'ic-window', time: '14:22', kind: '灵感',
    items: [
      { t: 'shot', w: 196, h: 126, desc: '进度条拆成五段的通知卡' },
      { t: 'shot', w: 150, h: 126, desc: '决策卡：稍后决定 / 批准' },
      { t: 'note', text: '这个五段进度条是五个独立 scaleX，不是一条 width 动画' },
    ] },
  { id: 'b2', title: 'Claude 的交接', app: 'Windows 终端', icon: 'ic-term', time: '13:58', kind: '交接',
    items: [
      { t: 'shot', w: 230, h: 150, desc: 'UIA 超时预算要按窗口分档' },
      { t: 'note', text: '175ms 是探针自身冷启动，200ms 预算只剩 25ms 给读取' },
    ] },
  { id: 'b3', title: '订阅与续费', app: '支付宝 · 邮件', icon: 'ic-file', time: '11:40', kind: '凭证',
    items: [
      { t: 'shot', w: 168, h: 110, desc: '设计资源 ¥348/年 · 8842-1109' },
      { t: 'shot', w: 168, h: 110, desc: '域名续费 · 到期 2027-03-11' },
      { t: 'shot', w: 168, h: 110, desc: '差旅报销 ¥1,240 · 待提交' },
    ] },
  { id: 'b4', title: '首屏背景候选', app: 'Pinterest · Unsplash', icon: 'ic-img', time: '10:07', kind: '素材',
    items: [
      { t: 'shot', w: 150, h: 100, desc: '暖调云层' },
      { t: 'shot', w: 150, h: 100, desc: '窗帘逆光' },
      { t: 'shot', w: 150, h: 100, desc: '干草地低光' },
      { t: 'shot', w: 150, h: 100, desc: '空桌与光柱' },
    ] },
];

/* ---------- 对外 ---------- */

const Data = {
  isLive: hasBridge,

  async conversations() {
    if (!hasBridge()) return DEMO_CONVERSATIONS;
    const list = await bridge().conversations.list();
    return Array.isArray(list) ? list : [];
  },

  async conversation(id) {
    if (!hasBridge()) return DEMO_CONVERSATIONS.find((c) => c.id === id) || DEMO_CONVERSATIONS[0];
    return bridge().conversations.get(id);
  },

  async timeline() {
    if (!hasBridge()) {
      return [{ key: 'demo', at: Date.now(), items: DEMO_CONVERSATIONS }];
    }
    const days = await bridge().conversations.timeline();
    return Array.isArray(days) ? days : [];
  },

  async memories() {
    if (!hasBridge()) {
      return DEMO_CONVERSATIONS.slice(0, 2).map((c) => ({
        key: c.id, object: c.object, subtitle: c.subtitle,
        touches: 3, lastAt: c.updatedAt, questions: [c.title],
      }));
    }
    const list = await bridge().conversations.memories();
    return Array.isArray(list) ? list : [];
  },

  async artifacts() {
    if (!hasBridge()) {
      return [{ name: '超时预算复测报告', kind: 'text', at: Date.parse('2026-08-06T12:33:00'),
        from: '这段代码在干嘛？', conversationId: 'demo-1' }];
    }
    const list = await bridge().conversations.artifacts();
    return Array.isArray(list) ? list : [];
  },

  async stash() {
    if (!bridge()?.stash) return DEMO_STASH;
    const bursts = await bridge().stash.list();
    if (!Array.isArray(bursts) || !bursts.length) return [];
    // 主进程给的是「一簇里若干条」，画布要的是「一簇里若干个节点」
    return bursts.map((b) => ({
      id: b.id,
      title: b.items[0]?.desc || b.app || '一组',
      app: b.app || '',
      icon: 'ic-window',
      time: formatTime(b.capturedAt),
      kind: b.kind || '素材',
      items: b.items.map((e) => ({
        t: 'shot', w: 180, h: 120, desc: e.desc, src: e.absPath,
        text: e.text || '', media: e.media || 'image', summary: e.summary || '',
      })),
    }));
  },

  // 悬停收藏图片 1 秒后调本地视觉模型出 3-4 句简介
  async describeStashImage(src) {
    if (!bridge()?.stash?.describe) return null;
    try {
      const result = await bridge().stash.describe(src);
      return result?.ok ? result.summary : null;
    } catch (_error) {
      return null;
    }
  },

  onChange(callback) {
    bridge()?.conversations?.onTurn?.(() => callback());
    bridge()?.stash?.onEntry?.(() => callback());
  },
};

function formatTime(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const pad = (n) => String(n).padStart(2, '0');
  if (sameDay) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const y = new Date(today.getTime() - 86400000);
  if (d.toDateString() === y.toDateString()) return '昨天';
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

function dayLabel(ms) {
  const d = new Date(ms);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return '今天';
  const y = new Date(today.getTime() - 86400000);
  if (d.toDateString() === y.toDateString()) return '昨天';
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}
