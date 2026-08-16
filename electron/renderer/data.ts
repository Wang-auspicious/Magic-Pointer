/* ============================================================
   数据层
   ------------------------------------------------------------
   有桥就走桥（Electron 里的真实记录），没有桥就用样例（浏览器里预览）。
   页面只跟这一层打交道，不直接碰 IPC——所以换数据源不用改渲染。
   ============================================================ */

declare global {
  /* ---- 渲染层各 classic script 之间的共享名字 ---- */

  interface MagicPointerObject {
    app?: string;
    label?: string;
    windowTitle?: string;
    [key: string]: unknown;
  }

  interface MagicPointerTurn {
    at?: number;
    question?: string;
    answer?: string;
    thinking?: string;
    failed?: boolean;
    trace?: (string | { label: string; note?: string })[];
    facts?: { label?: string; value?: string; tone?: string }[];
    artifacts?: MagicPointerArtifact[];
    events?: Record<string, unknown>[];
    [key: string]: unknown;
  }

  interface MagicPointerArtifact {
    kind?: string;
    name?: string;
    src?: string;
    summary?: string;
    w?: number;
    h?: number;
    [key: string]: unknown;
  }

  interface MagicPointerConversation {
    id: string;
    title?: string;
    subtitle?: string;
    objectKey?: string;
    object?: MagicPointerObject | null;
    turns?: MagicPointerTurn[];
    [key: string]: unknown;
  }

  interface MagicPointerCard {
    id: string;
    kind: string;
    state: string;
    progress: number | null;
    title: string;
    subtitle: string;
    steps: unknown[];
    stage: string;
    actions: unknown[];
    source: MagicPointerObject | null;
    startedAt: number | null;
    runningLabel?: string;
    error?: string;
    answer?: string;
    [key: string]: unknown;
  }

  interface MagicPointerCardModel {
    normalizeCard(raw: Record<string, unknown>, options?: { id?: string; seed?: unknown }): MagicPointerCard;
    applyPatch(card: MagicPointerCard, patch: Record<string, unknown>): MagicPointerCard;
    runningLabel(card: MagicPointerCard): string;
    isSettled(card: MagicPointerCard): boolean;
    phaseStep(record: { phase?: unknown; fields?: unknown; ms?: number }): unknown;
  }
  const CardModel: MagicPointerCardModel;

  const renderCard: (card: unknown, options?: { density?: string }) => Element;
  const cardElapsedText: (card: MagicPointerCard, now: number) => string;

  /* DSH 聊天渲染器（deepseek-harness 100% 移植）：classic script 暴露的全局。 */
  interface MagicPointerDshChatApi {
    userNode(question: string, timeMs?: number): Element;
    assistantTurnNode(turn: Record<string, unknown>): Element[];
    turnStatusNode(label: string): Element;
    turnErrorNode(message: string, code?: string, tone?: 'error' | 'warning'): Element;
    bindDelegation(scope?: Element): void;
  }
  const DshChat: MagicPointerDshChatApi;

  interface MagicPointerLiveCardsApi {
    track(card: MagicPointerCard): MagicPointerCard;
    patch(cardId: string, patch: Record<string, unknown>): MagicPointerCard | null;
    get(cardId: string): MagicPointerCard | null;
    reset(): void;
  }
  const LiveCards: MagicPointerLiveCardsApi;

  interface MagicPointerAttachment {
    name?: string;
    src?: string;
    icon?: string;
    [key: string]: unknown;
  }
  interface MagicPointerComposerOptions {
    placeholder?: string;
    density?: string;
    onSubmit?: (payload: { text: string; attachments: MagicPointerAttachment[] }) => void;
    onStop?: () => void;
    onScissor?: (() => void) | null;
    meta?: { id?: string; title?: string; label?: string; dot?: string; icon?: string }[];
    onMeta?: (id: string, btn: HTMLElement) => void;
  }
  interface MagicPointerComposerInstance {
    el: HTMLElement;
    focus(): void;
    setPlaceholder(text: string): void;
    attach(item: MagicPointerAttachment): void;
    setAttachments(list: MagicPointerAttachment[]): void;
    attachments(): MagicPointerAttachment[];
    running(on: boolean): void;
    state(): string;
    setMeta(id: string, label: string): void;
  }
  const Composer: {
    create(options?: MagicPointerComposerOptions): MagicPointerComposerInstance;
    safeThumb(value: unknown): string;
  };

  interface MagicPointerStashItem {
    desc?: string;
    absPath?: string;
    text?: string;
    media?: string;
    summary?: string;
    [key: string]: unknown;
  }
  interface MagicPointerStashBurst {
    id?: string;
    app?: string;
    kind?: string;
    capturedAt?: number;
    items?: MagicPointerStashItem[];
    [key: string]: unknown;
  }
  interface MagicPointerStashEntry {
    id?: string;
    title: string;
    app: string;
    icon: string;
    time: string;
    kind: string;
    items: {
      t: string;
      w?: number;
      h?: number;
      desc?: string;
      src?: string;
      text?: string;
      media?: string;
      summary?: string;
    }[];
  }
  interface MagicPointerTimelineDay {
    key?: string;
    at?: number;
    items?: unknown[];
  }

  interface MagicPointerDashboardApi {
    setTheme?(theme: unknown): void;
    saveFabricSettings?(settings: unknown): Promise<unknown>;
    getFabricSettings?(): Promise<Record<string, unknown>>;
    conversations: {
      list(): Promise<MagicPointerConversation[]>;
      get(id: unknown): Promise<MagicPointerConversation | undefined>;
      send(payload: { conversationId?: string | null; question: string; permissionPreset?: string }): Promise<Record<string, any>>;
      timeline(): Promise<MagicPointerTimelineDay[]>;
      memories(): Promise<unknown[]>;
      artifacts(): Promise<unknown[]>;
      onTurn?(cb: () => void): void;
    };
    stash: {
      list(): Promise<MagicPointerStashBurst[]>;
      describe?(src: unknown): Promise<{ ok?: boolean; summary?: string }>;
      onEntry?(cb: () => void): void;
    };
    onShow?(cb: (payload: Record<string, unknown>) => void): void;
    onCardPatch?(cb: (payload: MagicPointerCardPatchPayload) => void): void;
  }

  interface MagicPointerCardPatchPayload {
    cardId?: string;
    patch?: Record<string, unknown>;
    [key: string]: unknown;
  }

  interface MagicPointerPanelApi {
    hide(): void;
    resize(payload: Record<string, unknown>): void;
    submitSelectionCommand(payload: Record<string, unknown>): void;
    executeAction(payload: Record<string, unknown>): void;
    showContextualResult(payload: Record<string, unknown>): void;
    startDictation(): void;
    onShow(cb: (payload: MagicPointerPanelShowPayload) => void): void;
    onHide(cb: () => void): void;
    onResult(cb: (payload: MagicPointerPanelResultPayload) => void): void;
    onDictationResult(cb: (payload: MagicPointerDictationResultPayload) => void): void;
  }
  interface MagicPointerPanelShowPayload {
    selectionSessionToken?: string;
    panelLayoutNonce?: string;
    captureSummary?: MagicPointerCaptureSummary;
    captureEligibility?: MagicPointerCaptureEligibility;
    defaultInputMode?: string;
    voiceAutoSubmit?: boolean;
    voiceSilenceMs?: number;
    sessionExpiresAt?: number;
    [key: string]: unknown;
  }
  interface MagicPointerCaptureSummary {
    label?: string;
    [key: string]: unknown;
  }
  interface MagicPointerCaptureEligibility {
    commandReady?: boolean;
    message?: string;
    autoDismissMs?: unknown;
    [key: string]: unknown;
  }
  interface MagicPointerPanelResultPayload {
    ok?: boolean | null;
    status?: string;
    error?: string;
    selectionSessionToken?: string;
    [key: string]: unknown;
  }
  interface MagicPointerDictationResultPayload {
    surface?: string;
    ok?: boolean;
    error?: string;
    transcript?: string;
    final?: boolean;
    [key: string]: unknown;
  }

  interface MagicPointerCompanionApi {
    pin?(pinned: boolean): void;
    expand?(): void;
    hide?(): void;
    onCardPatch?(cb: (payload: MagicPointerCardPatchPayload) => void): void;
  }

  interface MagicPointerOnboardingApi {
    start(): void;
    cancel(): void;
    continue(): void;
    onShow(cb: (payload: MagicPointerOnboardingShowPayload) => void): void;
    onPreflightEvent(cb: (payload: MagicPointerPreflightEvent) => void): void;
  }
  interface MagicPointerOnboardingShowPayload {
    screen?: string;
    [key: string]: unknown;
  }
  interface MagicPointerPreflightEvent {
    type?: string;
    stages?: { id: string; title?: string }[];
    id?: string;
    state?: string;
    title?: string;
    evidence?: string;
    percent?: number;
    ready?: boolean;
    error?: string;
    [key: string]: unknown;
  }
  interface MagicPointerOnboardingStage {
    id?: string;
    title?: string;
    state?: string;
    evidence?: string;
    [key: string]: unknown;
  }

  interface MagicPointerDataApi {
    isLive(): boolean;
    conversations(): Promise<MagicPointerConversation[]>;
    conversation(id: string): Promise<MagicPointerConversation | undefined>;
    sendConversation(conversationId: string | null, question: string, permissionPreset?: string): Promise<Record<string, any>>;
    timeline(): Promise<MagicPointerTimelineDay[]>;
    memories(): Promise<unknown[]>;
    artifacts(): Promise<unknown[]>;
    stash(): Promise<MagicPointerStashEntry[]>;
    describeStashImage(src: string): Promise<string | null | undefined>;
    onChange(callback: () => void): void;
  }
  const Data: MagicPointerDataApi;

  interface MagicPointerOverlayApi {
    ready(): void;
    gestureReady(token: unknown): void;
    hide(): void;
    done(payload: unknown): void;
    gestureStarted(token: unknown): void;
    gestureStroke(token: unknown, index: unknown): void;
    startDictation(): void;
    onShow(cb: (payload: Record<string, unknown>) => void): void;
    onHide(cb: () => void): void;
    onCursor(cb: (payload: Record<string, unknown>) => void): void;
    onGuidePoint(cb: (payload: Record<string, unknown>) => void): void;
    guideFinished(): void;
    onGestureInput(cb: (payload: Record<string, unknown>) => void): void;
    onGestureSubmit(cb: (payload: Record<string, unknown>) => void): void;
    syncHitRegions?(): void;
  }

  interface MagicPointerGestureCaptureApi {
    chainFinalizeDelay(options?: { deadlineAt?: unknown; idleMs?: unknown; now?: unknown }): number;
    pointerContinuesGestureChain(previous: unknown, next: unknown, minimumDistance?: unknown): boolean;
    summarizeGesture(rawPoints: unknown, rawStrokes?: unknown, thresholds?: unknown): Record<string, unknown>;
  }
  // var 声明才是全局对象属性：classic script 之间用 globalThis.X 互访。
  var GestureCapture: MagicPointerGestureCaptureApi;

  interface MagicPointerSweepSample {
    x: number;
    y: number;
    progress: number;
  }
  interface MagicPointerSweepBounds {
    left: number;
    right: number;
    top: number;
    bottom: number;
  }
  interface MagicPointerSweepPath {
    mode: string;
    samples: MagicPointerSweepSample[];
    bodyHalfWidth: number;
    edgeFeather: number;
    tailSoftnessBoost: number;
    tailFloorOpacity: number;
    bounds: MagicPointerSweepBounds;
  }
  interface MagicPointerSweepProfile {
    color: readonly number[];
    opacity: number;
    edgeFeather: number;
  }
  interface MagicPointerSweepRenderer {
    resize(width: number, height: number, dpr?: number): void;
    clear(): void;
    render(entries: unknown, width?: number): void;
  }
  interface MagicPointerSweepVisualApi {
    SWEEP_STYLE: Record<string, unknown>;
    VERTEX_SHADER_SOURCE: string;
    FRAGMENT_SHADER_SOURCE: string;
    buildSdfPath(points: unknown, requestedWidth?: number): MagicPointerSweepPath | null;
    sweepProfile(progress: number): MagicPointerSweepProfile;
    buildSweepGeometry(points: unknown, requestedWidth?: number): MagicPointerSweepPath | null;
    buildSweepSegments(points: unknown, requestedWidth?: number): unknown[];
    buildSweepRibbon(points: unknown, requestedWidth?: number): MagicPointerSweepPath | null;
    SweepRenderer: new (canvas: HTMLCanvasElement) => MagicPointerSweepRenderer;
  }
  var MagicSweepVisual: MagicPointerSweepVisualApi;

  interface Window {
    magicPointer: MagicPointerOverlayApi;
    magicPointerDashboard: MagicPointerDashboardApi;
    magicPointerPanel: MagicPointerPanelApi;
    magicPointerCompanion?: MagicPointerCompanionApi;
    magicPointerOnboarding: MagicPointerOnboardingApi;
    magicPointerStage: MagicPointerStageApi;
  }

  /* ---- studio / stage 共享的渲染层函数（实现留在各自 classic script） ---- */
  function formatTime(ms: number | null | undefined): string;
  function dayLabel(ms: number | undefined): string;
  function renderSettings(): void;

  /* ---- 舞台桥。载荷形状见 preload.ts；渲染层只按松散形状取用。 ---- */
  interface MagicPointerStageApi {
    ready(): void;
    reportState(payload: unknown): void;
    hidden(): void;
    dismiss(): void;
    submitSelectionCommand(payload: unknown): void;
    executeAction(payload: unknown): void;
    contextAction(payload: unknown): void;
    insertResultText(payload: unknown): void;
    expandPassage(payload: unknown): Promise<any>;
    pickElement(payload: unknown): Promise<any>;
    listAgentSessions(selectionSessionToken: unknown): Promise<any>;
    dispatchAgentPrompt(payload: unknown): Promise<any>;
    startDictation(): void;
    stopDictation(options?: unknown): void;
    setMouseCapture(enabled: unknown, options?: unknown): void;
    onShow(cb: (payload: Record<string, unknown>) => void): void;
    onUpdate(cb: (payload: Record<string, unknown>) => void): void;
    onCardPatch(cb: (payload: MagicPointerCardPatchPayload) => void): void;
    onHide(cb: () => void): void;
    onDictationResult(cb: (payload: Record<string, unknown>) => void): void;
    onPointerInput(cb: (payload: Record<string, unknown>) => void): void;
    onModelHealth(cb: (payload: Record<string, unknown>) => void): void;
  }

  /* ---- stage 的 classic-script 全局（契约在 electron/*.ts，渲染层只取用） ---- */
  var StageState: any;
  var StageAnchor: any;
  var StageSurfacePolicy: any;
  var StudioShell: any;
  var MagicPointerVoiceTrigger: any;
  var MagicPointerStageHitPolicy: any;
  var AnswerShapePolicy: any;
  var CaptureProofPolicy: any;
  var StageStretchPolicy: any;
  var StagePickPolicy: any;
  var StageTurnStream: any;
  var StageChipsPolicy: any;
}

/* exported Data, formatTime, dayLabel */

const bridge = (): MagicPointerDashboardApi | null => window.magicPointerDashboard || null;
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

// classic-script 全局 API，被 overlay/stage/settings 等以 global 方式消费。
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const Data: MagicPointerDataApi = {
  isLive: hasBridge,

  async conversations(): Promise<MagicPointerConversation[]> {
    if (!hasBridge()) return DEMO_CONVERSATIONS;
    const list = await bridge()!.conversations.list();
    return Array.isArray(list) ? list : [];
  },

  async conversation(id: string): Promise<MagicPointerConversation | undefined> {
    if (!hasBridge()) return DEMO_CONVERSATIONS.find((c) => c.id === id) || DEMO_CONVERSATIONS[0];
    return bridge()!.conversations.get(id);
  },

  async sendConversation(conversationId: string | null, question: string, permissionPreset?: string): Promise<Record<string, any>> {
    if (!hasBridge()) return { ok: false, error: '请在 Magic Pointer 应用里发送。' };
    return bridge()!.conversations.send({ conversationId, question, permissionPreset: permissionPreset || 'workspace-write' });
  },

  async timeline(): Promise<MagicPointerTimelineDay[]> {
    if (!hasBridge()) {
      return [{ key: 'demo', at: Date.now(), items: DEMO_CONVERSATIONS }];
    }
    const days = await bridge()!.conversations.timeline();
    return Array.isArray(days) ? days : [];
  },

  async memories(): Promise<unknown[]> {
    if (!hasBridge()) {
      return DEMO_CONVERSATIONS.slice(0, 2).map((c) => ({
        key: c.id, object: c.object, subtitle: c.subtitle,
        touches: 3, lastAt: c.updatedAt, questions: [c.title],
      }));
    }
    const list = await bridge()!.conversations.memories();
    return Array.isArray(list) ? list : [];
  },

  async artifacts(): Promise<unknown[]> {
    if (!hasBridge()) {
      return [{ name: '超时预算复测报告', kind: 'text', at: Date.parse('2026-08-06T12:33:00'),
        from: '这段代码在干嘛？', conversationId: 'demo-1' }];
    }
    const list = await bridge()!.conversations.artifacts();
    return Array.isArray(list) ? list : [];
  },

  async stash(): Promise<MagicPointerStashEntry[]> {
    if (!bridge()?.stash) return DEMO_STASH;
    const bursts = await bridge()!.stash.list();
    if (!Array.isArray(bursts) || !bursts.length) return [];
    // 主进程给的是「一簇里若干条」，画布要的是「一簇里若干个节点」
    return bursts.map((b: MagicPointerStashBurst) => ({
      id: b.id,
      title: b.items![0]?.desc || b.app || '一组',
      app: b.app || '',
      icon: 'ic-window',
      time: formatTime(b.capturedAt),
      kind: b.kind || '素材',
      items: b.items!.map((e) => ({
        t: 'shot', w: 180, h: 120, desc: e.desc, src: e.absPath,
        text: e.text || '', media: e.media || 'image', summary: e.summary || '',
      })),
    }));
  },

  // 悬停收藏图片 1 秒后调本地视觉模型出 3-4 句简介
  async describeStashImage(src: string): Promise<string | null | undefined> {
    if (!bridge()?.stash?.describe) return null;
    try {
      const result = await bridge()!.stash.describe!(src);
      return result?.ok ? result.summary : null;
    } catch (_error) {
      return null;
    }
  },

  onChange(callback: () => void) {
    bridge()?.conversations?.onTurn?.(() => callback());
    bridge()?.stash?.onEntry?.(() => callback());
  },
};

function formatTime(ms: number | null | undefined): string {
  if (!ms) return '';
  const d = new Date(ms);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const pad = (n: number) => String(n).padStart(2, '0');
  if (sameDay) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const y = new Date(today.getTime() - 86400000);
  if (d.toDateString() === y.toDateString()) return '昨天';
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

// classic-script 全局 API（settings 等文件直接调用 dayLabel）。
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function dayLabel(ms: number): string {
  const d = new Date(ms);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return '今天';
  const y = new Date(today.getTime() - 86400000);
  if (d.toDateString() === y.toDateString()) return '昨天';
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}
