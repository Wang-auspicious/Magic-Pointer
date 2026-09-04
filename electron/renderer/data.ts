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
    activities?: Record<string, unknown>[];
    trajectory?: Record<string, unknown>[];
    receipts?: Record<string, unknown>[];
    modelUsage?: Record<string, number>;
    modelId?: string;
    timingMs?: number;
    usedBackend?: string;
    pendingInput?: {
      question?: string;
      options?: string[];
      kind?: string;
      tool?: string;
      prefix?: string;
    };
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
    updatedAt?: number;
    agentSessionId?: string;
    hasPendingWork?: boolean;
    workspaceRoot?: string;
    object?: MagicPointerObject | null;
    turns?: MagicPointerTurn[];
    [key: string]: unknown;
  }

  interface MagicPointerProject {
    root: string;
    name: string;
    addedAt?: number;
    lastOpenedAt?: number;
  }

  interface MagicPointerHomeStats {
    sessions: number;
    messages: number;
    totalTokens: number;
    activeDays: number;
    currentStreak: number;
    longestStreak: number;
    peakHour: number | null;
    favoriteModel: string | null;
    heatmap: Array<{ date: string; messages: number; future: boolean }>;
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
  const renderFoldedProcess: (steps?: unknown[]) => Element | null;
  const cardElapsedText: (card: MagicPointerCard, now: number) => string;

  /* DSH 聊天渲染器（deepseek-harness 100% 移植）：classic script 暴露的全局。 */
  interface MagicPointerDshChatApi {
    userNode(question: string, timeMs?: number, branch?: { conversationId: string; turnIndex: number }): Element;
    assistantTurnNode(turn: Record<string, unknown>): Element[];
    turnStatusNode(label: string): Element;
    turnErrorNode(message: string, code?: string, tone?: 'error' | 'warning'): Element;
    bindDelegation(scope?: Element): void;
    liveActivityNode(record: Record<string, unknown>): Element;
    thinkNode(reasoning: string, running?: boolean): Element;
  }
  const DshChat: MagicPointerDshChatApi;

  const DshMarkdown: {
    render(markdown: unknown): Element;
  };
  /* Studio 会话控制（流式/停止/插话）的纯决策层全局。 */
  interface MagicPointerConversationControlApi {
    SESSION_READY_PHASE: string;
    ANSWER_CHUNK_PHASE: string;
    PLAN_PHASE: string;
    sessionIdFromRecord(record: unknown): string | null;
    decodeChunkBlob(fields: Record<string, string>): string;
    failedDraftValue(current: unknown, submitted: unknown): string;
    callConversationAction(action: () => Promise<{ ok?: boolean; error?: string }>): Promise<{ ok: boolean; error: string }>;
    planStepsFromRecord(record: unknown): { steps: Array<{ content: string; status: string }> } | null;
    permissionGrantRule(tool: unknown, prefix?: unknown): string;
    sanitizePermissionRule(value: unknown): string;
  }
  const ConversationControl: MagicPointerConversationControlApi;

  /* 斜杠触发检测（DSH input-trigger detect 层）。 */
  const SlashTrigger: {
    detectSlashToken(textBeforeCaret: string): string | null;
  };
  const DshIcons: {
    node(name: string, size?: number): Element;
  };
  const DshTrajectory: {
    project(turns: Array<Record<string, any>>): Array<Record<string, any>>;
    render(rows: Array<Record<string, any>>): Element;
  };

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
    text?: string;
    icon?: string;
    [key: string]: unknown;
  }
  interface MagicPointerComposerOptions {
    placeholder?: string;
    density?: string;
    onSubmit?: (payload: { text: string; attachments: MagicPointerAttachment[] }) => boolean | void | Promise<boolean | void>;
    onStop?: (() => boolean | void | Promise<boolean | void>) | null;
    onSteer?: ((text: string) => boolean | void | Promise<boolean | void>) | null;
    onVoice?: (() => void) | null;
    onScissor?: (() => void) | null;
    allowAttachments?: boolean;
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
    decideSubmission(state: 'idle' | 'running', value: unknown, attachments: MagicPointerAttachment[]): Record<string, unknown>;
    shouldRestoreFocus(active: unknown, composerInput: unknown): boolean;
    isTextAttachmentName(name: unknown): boolean;
    textAttachmentWithinLimit(size: unknown): boolean;
    attachmentSubmissionSnapshot<T extends { id: number }>(entries: T[], cutoff: number): T[];
    pendingReadsThrough(pending: Map<number, Promise<void>>, cutoff: number): Promise<void>[];
    remainingAttachmentEntries<T extends { id: number }>(current: T[], submitted: T[]): T[];
    createInFlightGate(): { tryEnter(): boolean; leave(): void; active(): boolean };
    callAcknowledged(callback: () => boolean | void | Promise<boolean | void>): Promise<boolean>;
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
  interface MagicPointerModelEntry {
    id: string;
    vision?: boolean;
    contextWindow?: number;
  }
  interface MagicPointerModelGroup {
    id: string;
    name: string;
    models: MagicPointerModelEntry[];
  }
  interface MagicPointerSlashEntry {
    name: string;
    description: string;
    whenToUse?: string;
    source?: string;
    path?: string;
  }
  interface MagicPointerSlashDirectory {
    ok?: boolean;
    commands?: MagicPointerSlashEntry[];
    skills?: MagicPointerSlashEntry[];
    errors?: string[];
  }
  interface MagicPointerModelCatalog {
    current?: string;
    visionModel?: string;
    provider?: string;
    source?: string;
    error?: string;
    groups?: MagicPointerModelGroup[];
  }

  interface MagicPointerUpdateState {
    state: string;
    checkedAt?: number;
    version?: string;
    progress?: number;
    message?: string;
  }

  interface MagicPointerTimelineDay {
    key?: string;
    at?: number;
    items?: unknown[];
  }

  interface MagicPointerDashboardApi {
    setTheme?(theme: unknown): void;
    startDictation?(): void;
    stopDictation?(options?: { graceful?: boolean }): void;
    onDictationResult?(cb: (payload: MagicPointerDictationResultPayload) => void): void;
    saveFabricSettings?(settings: unknown): Promise<unknown>;
    getFabricSettings?(): Promise<Record<string, unknown>>;
    modelsCatalog?(): Promise<{ ok?: boolean; catalog?: MagicPointerModelCatalog; error?: string }>;
    slashDirectory?(): Promise<MagicPointerSlashDirectory | { ok?: boolean; error?: string }>;
    selectModel?(model: unknown): Promise<{ ok?: boolean; model?: string; error?: string }>;
    projects?: {
      list(): Promise<MagicPointerProject[]>;
      open(): Promise<{ ok?: boolean; canceled?: boolean; project?: MagicPointerProject; error?: string }>;
      pickFiles(projectRoot: string): Promise<{ ok?: boolean; canceled?: boolean; paths?: string[]; error?: string }>;
      tree(projectRoot: string, relativePath?: string): Promise<{ ok?: boolean; entries?: Array<{ name: string; path: string; kind: 'directory' | 'file' }>; error?: string }>;
      readFile(projectRoot: string, relativePath: string): Promise<{ ok?: boolean; text?: string; truncated?: boolean; error?: string }>;
      openPath(projectRoot: string, relativePath: string): Promise<{ ok?: boolean; error?: string }>;
      openUrl(url: string): Promise<{ ok?: boolean; error?: string }>;
      environment(projectRoot: string, conversationId?: string | null): Promise<MagicPointerProjectEnvironment>;
      contextMenu(projectRoot: string, relativePath: string, kind: 'directory' | 'file'): Promise<{ ok?: boolean; action?: string; absolutePath?: string; error?: string }>;
      runCommand(projectRoot: string, command: string, relativeDirectory?: string): Promise<{ ok?: boolean; code?: number | null; output?: string; error?: string }>;
    };
    browserView?: {
      open(url: string, bounds: { x: number; y: number; width: number; height: number }): Promise<{ ok?: boolean; state?: MagicPointerBrowserViewState; error?: string }>;
      resize(bounds: { x: number; y: number; width: number; height: number }): Promise<{ ok?: boolean; error?: string }>;
      command(command: 'back' | 'forward' | 'reload' | 'stop' | 'external' | 'close'): Promise<{ ok?: boolean; state?: MagicPointerBrowserViewState; error?: string }>;
      onState(callback: (state: MagicPointerBrowserViewState) => void): void;
    };
    windowControls?: {
      command(command: string): Promise<{ ok?: boolean; version?: string; electron?: string; chrome?: string; error?: string }>;
    };
    updates?: {
      status(): Promise<MagicPointerUpdateState>;
      check(): Promise<{ ok?: boolean; reason?: string }>;
      onStatus(callback: (state: MagicPointerUpdateState) => void): void;
    };
    conversations: {
      list(): Promise<MagicPointerConversation[]>;
      stats?(): Promise<MagicPointerHomeStats | null>;
      get(id: unknown): Promise<MagicPointerConversation | undefined>;
      branch?(payload: { id?: unknown; turnIndex?: unknown }): Promise<{ ok?: boolean; conversation?: MagicPointerConversation; error?: string }>;
      send(payload: { conversationId?: string | null; question: string; permissionPreset?: string; requestId?: string; workspaceRoot?: string; replyStyle?: string; permissionGrant?: string; permissionDeny?: string; permissionGrantOnce?: string }): Promise<Record<string, any>>;
      pickWorkspace?(): Promise<{ ok?: boolean; canceled?: boolean; path?: string; error?: string }>;
      export?(id: unknown): Promise<{ ok?: boolean; canceled?: boolean; path?: string; error?: string }>;
      rename?(payload: { id?: unknown; title?: unknown }): Promise<{ ok?: boolean; title?: string; error?: string }>;
      delete?(id: unknown): Promise<{ ok?: boolean; error?: string }>;
      stop?(requestId: unknown): Promise<{ ok?: boolean; sessionId?: string; error?: string }>;
      steer?(payload: { agentSessionId?: unknown; text?: unknown }): Promise<{ ok?: boolean; messageId?: string; error?: string }>;
      timeline(): Promise<MagicPointerTimelineDay[]>;
      memories(): Promise<unknown[]>;
      artifacts(): Promise<unknown[]>;
      onTurn?(cb: () => void): void;
      onProgress?(cb: (payload: { requestId?: string; record?: Record<string, unknown> }) => void): void;
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
    projects(): Promise<MagicPointerProject[]>;
    openProject(): Promise<{ ok?: boolean; canceled?: boolean; project?: MagicPointerProject; error?: string }>;
    pickProjectFiles(projectRoot: string): Promise<{ ok?: boolean; canceled?: boolean; paths?: string[]; error?: string }>;
    projectTree(projectRoot: string, relativePath?: string): Promise<{ ok?: boolean; entries?: Array<{ name: string; path: string; kind: 'directory' | 'file' }>; error?: string }>;
    readProjectFile(projectRoot: string, relativePath: string): Promise<{ ok?: boolean; text?: string; truncated?: boolean; error?: string }>;
    openProjectPath(projectRoot: string, relativePath: string): Promise<{ ok?: boolean; error?: string }>;
    openProjectUrl(url: string): Promise<{ ok?: boolean; error?: string }>;
    projectEnvironment(projectRoot: string, conversationId?: string | null): Promise<MagicPointerProjectEnvironment>;
    showProjectContextMenu(projectRoot: string, relativePath: string, kind: 'directory' | 'file'): Promise<{ ok?: boolean; action?: string; absolutePath?: string; error?: string }>;
    openBrowserView(url: string, bounds: { x: number; y: number; width: number; height: number }): Promise<{ ok?: boolean; state?: MagicPointerBrowserViewState; error?: string }>;
    resizeBrowserView(bounds: { x: number; y: number; width: number; height: number }): Promise<{ ok?: boolean; error?: string }>;
    browserViewCommand(command: 'back' | 'forward' | 'reload' | 'stop' | 'external' | 'close'): Promise<{ ok?: boolean; state?: MagicPointerBrowserViewState; error?: string }>;
    onBrowserViewState(callback: (state: MagicPointerBrowserViewState) => void): void;
    windowCommand(command: string): Promise<{ ok?: boolean; version?: string; electron?: string; chrome?: string; error?: string }>;
    updateStatus(): Promise<MagicPointerUpdateState>;
    checkForUpdates(): Promise<{ ok?: boolean; reason?: string }>;
    onUpdateStatus(callback: (state: MagicPointerUpdateState) => void): void;
    runProjectCommand(projectRoot: string, command: string, relativeDirectory?: string): Promise<{ ok?: boolean; code?: number | null; output?: string; error?: string }>;
    conversations(): Promise<MagicPointerConversation[]>;
    conversationStats(): Promise<MagicPointerHomeStats | null>;
    conversation(id: string): Promise<MagicPointerConversation | undefined>;
    branchConversation(id: string, turnIndex: number): Promise<{ ok?: boolean; conversation?: MagicPointerConversation; error?: string }>;
    sendConversation(conversationId: string | null, question: string, permissionPreset?: string, requestId?: string, workspaceRoot?: string, replyStyle?: string, permission?: { grant?: string; deny?: string; once?: string }): Promise<Record<string, any>>;
    pickWorkspace(): Promise<{ ok?: boolean; canceled?: boolean; path?: string; error?: string }>;
    exportConversation(id: string): Promise<{ ok?: boolean; canceled?: boolean; path?: string; error?: string }>;
    renameConversation(id: string, title: string): Promise<{ ok?: boolean; title?: string; error?: string }>;
    deleteConversation(id: string): Promise<{ ok?: boolean; error?: string }>;
    stopConversation(requestId: string): Promise<{ ok?: boolean; sessionId?: string; error?: string }>;
    steerConversation(agentSessionId: string, text: string): Promise<{ ok?: boolean; messageId?: string; error?: string }>;
    onConversationProgress(callback: (payload: { requestId?: string; record?: Record<string, unknown> }) => void): void;
    models(): Promise<MagicPointerModelCatalog | null>;
    slashDirectory(): Promise<MagicPointerSlashDirectory | null>;
    selectModel(model: string): Promise<{ ok?: boolean; model?: string; error?: string }>;
    timeline(): Promise<MagicPointerTimelineDay[]>;
    memories(): Promise<unknown[]>;
    artifacts(): Promise<unknown[]>;
    stash(): Promise<MagicPointerStashEntry[]>;
    describeStashImage(src: string): Promise<string | null | undefined>;
    onChange(callback: () => void): void;
  }
  const Data: MagicPointerDataApi;

  interface MagicPointerProjectEnvironment {
    ok?: boolean;
    root?: string;
    name?: string;
    isGit?: boolean;
    branch?: string;
    upstream?: string;
    ahead?: number;
    behind?: number;
    changedFiles?: number;
    fileChanges?: Array<{ path: string; status: string; staged: boolean }>;
    addedLines?: number;
    deletedLines?: number;
    remoteUrl?: string;
    pullRequestUrl?: string;
    sources?: string[];
    error?: string;
  }

  interface MagicPointerBrowserViewState {
    url?: string;
    title?: string;
    loading?: boolean;
    canGoBack?: boolean;
    canGoForward?: boolean;
    error?: string;
  }

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
    onElementGhosts(cb: (payload: Record<string, unknown>) => void): void;
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
    steerSelectionCommand(payload: unknown): Promise<any>;
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
  var ClarificationChips: any;
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
      question: '把这个模块的读取超时修好，并说明你改了什么。',
      answer: [
        '## 已完成',
        '',
        '我把读取路径改成了**冻结帧优先**，并保留 UIA 作为结构化证据。现在 `pointerup` 之后不会再抓到更晚的画面。',
        '',
        '- 固定了 200ms 探针预算的归属',
        '- 为帧租约补上了回归测试',
        '- 保留完整目标表面，不再只存手势小裁剪',
        '',
        '| 验证 | 结果 |',
        '| --- | --- |',
        '| Python | 通过 |',
        '| TypeScript | 通过 |',
        '',
        '```pwsh',
        'python -m pytest tests/frame_lease_test.py -q',
        '```',
      ].join('\n'),
      activities: [{ kind: 'model', turn: 1, state: 'done', latencyMs: 2840, firstTokenMs: 612 }],
      events: [
        { name: 'pwsh', arguments: { command: 'rg -n "pointerup|capture" electron' }, result: 'electron/main.ts:1398', isError: false, usedBackend: 'subprocess', latencyMs: 86 },
        { name: 'read', arguments: { path: 'electron/main.ts', line: 1380 }, result: 'capturePage(rect)', isError: false, usedBackend: 'filesystem', latencyMs: 12 },
        { name: 'edit', arguments: { path: 'electron/main.ts' }, result: 'Done', isError: false, usedBackend: 'workspace', latencyMs: 44 },
      ],
      modelUsage: { inputTokens: 1842, outputTokens: 286, totalTokens: 2128 },
      timingMs: 3218,
      usedBackend: 'openai-compatible',
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

  async projects(): Promise<MagicPointerProject[]> {
    if (!hasBridge()) return [];
    const projects = await bridge()!.projects?.list?.();
    return Array.isArray(projects) ? projects : [];
  },

  async openProject(): Promise<{ ok?: boolean; canceled?: boolean; project?: MagicPointerProject; error?: string }> {
    const projects = bridge()?.projects;
    if (!hasBridge() || !projects?.open) return { ok: false, error: '打开项目通道不可用。' };
    return projects.open();
  },

  async pickProjectFiles(projectRoot: string): Promise<{ ok?: boolean; canceled?: boolean; paths?: string[]; error?: string }> {
    const projects = bridge()?.projects;
    if (!hasBridge() || !projects?.pickFiles) return { ok: false, error: '附件通道不可用。' };
    return projects.pickFiles(projectRoot);
  },

  async projectTree(projectRoot: string, relativePath = '') {
    const projects = bridge()?.projects;
    if (!hasBridge() || !projects?.tree) return { ok: false, error: '文件树通道不可用。' };
    return projects.tree(projectRoot, relativePath);
  },

  async readProjectFile(projectRoot: string, relativePath: string) {
    const projects = bridge()?.projects;
    if (!hasBridge() || !projects?.readFile) return { ok: false, error: '文件读取通道不可用。' };
    return projects.readFile(projectRoot, relativePath);
  },

  async openProjectPath(projectRoot: string, relativePath: string) {
    const projects = bridge()?.projects;
    if (!hasBridge() || !projects?.openPath) return { ok: false, error: '文件打开通道不可用。' };
    return projects.openPath(projectRoot, relativePath);
  },

  async openProjectUrl(url: string) {
    const projects = bridge()?.projects;
    if (!hasBridge() || !projects?.openUrl) return { ok: false, error: '浏览器通道不可用。' };
    return projects.openUrl(url);
  },

  async projectEnvironment(projectRoot: string, conversationId?: string | null) {
    const projects = bridge()?.projects;
    if (!hasBridge() || !projects?.environment) return { ok: false, error: '项目环境通道不可用。' };
    return projects.environment(projectRoot, conversationId);
  },

  async showProjectContextMenu(projectRoot: string, relativePath: string, kind: 'directory' | 'file') {
    const projects = bridge()?.projects;
    if (!hasBridge() || !projects?.contextMenu) return { ok: false, error: '文件操作菜单不可用。' };
    return projects.contextMenu(projectRoot, relativePath, kind);
  },

  async openBrowserView(url: string, bounds: { x: number; y: number; width: number; height: number }) {
    const browserView = bridge()?.browserView;
    if (!hasBridge() || !browserView?.open) return { ok: false, error: '内置浏览器不可用。' };
    return browserView.open(url, bounds);
  },

  async resizeBrowserView(bounds: { x: number; y: number; width: number; height: number }) {
    const browserView = bridge()?.browserView;
    if (!hasBridge() || !browserView?.resize) return { ok: false, error: '内置浏览器不可用。' };
    return browserView.resize(bounds);
  },

  async browserViewCommand(command: 'back' | 'forward' | 'reload' | 'stop' | 'external' | 'close') {
    const browserView = bridge()?.browserView;
    if (!hasBridge() || !browserView?.command) return { ok: false, error: '内置浏览器不可用。' };
    return browserView.command(command);
  },

  onBrowserViewState(callback: (state: MagicPointerBrowserViewState) => void) {
    bridge()?.browserView?.onState?.(callback);
  },

  async windowCommand(command: string) {
    const controls = bridge()?.windowControls;
    if (!hasBridge() || !controls?.command) return { ok: false, error: '窗口命令通道不可用。' };
    return controls.command(command);
  },

  async updateStatus(): Promise<MagicPointerUpdateState> {
    const updates = bridge()?.updates;
    if (!hasBridge() || !updates?.status) return { state: 'unsupported' };
    try {
      const state = await updates.status();
      return state && typeof state === 'object' ? state : { state: 'unsupported' };
    } catch {
      return { state: 'error', message: '暂时无法读取更新状态。' };
    }
  },

  async checkForUpdates(): Promise<{ ok?: boolean; reason?: string }> {
    const updates = bridge()?.updates;
    if (!hasBridge() || !updates?.check) return { ok: false, reason: 'update_channel_unavailable' };
    try {
      return await updates.check();
    } catch {
      return { ok: false, reason: 'update_check_failed' };
    }
  },

  onUpdateStatus(callback: (state: MagicPointerUpdateState) => void): void {
    bridge()?.updates?.onStatus?.(callback);
  },

  async runProjectCommand(projectRoot: string, command: string, relativeDirectory = '') {
    const projects = bridge()?.projects;
    if (!hasBridge() || !projects?.runCommand) return { ok: false, error: '终端通道不可用。' };
    return projects.runCommand(projectRoot, command, relativeDirectory);
  },

  async conversations(): Promise<MagicPointerConversation[]> {
    if (!hasBridge()) return DEMO_CONVERSATIONS;
    const list = await bridge()!.conversations.list();
    return Array.isArray(list) ? list : [];
  },

  async conversationStats(): Promise<MagicPointerHomeStats | null> {
    if (!hasBridge() || !bridge()!.conversations.stats) return null;
    try {
      return await bridge()!.conversations.stats!();
    } catch {
      return null;
    }
  },

  async conversation(id: string): Promise<MagicPointerConversation | undefined> {
    if (!hasBridge()) return DEMO_CONVERSATIONS.find((c) => c.id === id) || DEMO_CONVERSATIONS[0];
    return bridge()!.conversations.get(id);
  },

  async branchConversation(id: string, turnIndex: number): Promise<{ ok?: boolean; conversation?: MagicPointerConversation; error?: string }> {
    if (!hasBridge() || !bridge()!.conversations.branch) return { ok: false, error: '分支通道不可用。' };
    return bridge()!.conversations.branch!({ id, turnIndex });
  },

  async sendConversation(conversationId: string | null, question: string, permissionPreset?: string, requestId?: string, workspaceRoot?: string, replyStyle?: string, permission?: { grant?: string; deny?: string; once?: string }): Promise<Record<string, any>> {
    if (!hasBridge()) return { ok: false, error: '请在 Magic Pointer 应用里发送。' };
    return bridge()!.conversations.send({ conversationId, question, permissionPreset: permissionPreset || 'workspace-write', requestId, workspaceRoot, replyStyle: replyStyle || 'normal', permissionGrant: permission?.grant, permissionDeny: permission?.deny, permissionGrantOnce: permission?.once });
  },

  async pickWorkspace(): Promise<{ ok?: boolean; canceled?: boolean; path?: string; error?: string }> {
    if (!hasBridge() || !bridge()!.conversations.pickWorkspace) return { ok: false, error: '选择工作区通道不可用。' };
    return bridge()!.conversations.pickWorkspace!();
  },

  async exportConversation(id: string): Promise<{ ok?: boolean; canceled?: boolean; path?: string; error?: string }> {
    if (!hasBridge() || !bridge()!.conversations.export) return { ok: false, error: '导出通道不可用。' };
    return bridge()!.conversations.export!(id);
  },

  async renameConversation(id: string, title: string): Promise<{ ok?: boolean; title?: string; error?: string }> {
    if (!hasBridge() || !bridge()!.conversations.rename) return { ok: false, error: '重命名通道不可用。' };
    return bridge()!.conversations.rename!({ id, title });
  },

  async deleteConversation(id: string): Promise<{ ok?: boolean; error?: string }> {
    if (!hasBridge() || !bridge()!.conversations.delete) return { ok: false, error: '删除通道不可用。' };
    return bridge()!.conversations.delete!(id);
  },

  async stopConversation(requestId: string): Promise<{ ok?: boolean; sessionId?: string; error?: string }> {
    if (!hasBridge()) return { ok: false, error: '停止通道不可用。' };
    return bridge()!.conversations.stop!(requestId);
  },

  async steerConversation(agentSessionId: string, text: string): Promise<{ ok?: boolean; messageId?: string; error?: string }> {
    if (!hasBridge()) return { ok: false, error: '插话通道不可用。' };
    return bridge()!.conversations.steer!({ agentSessionId, text });
  },

  onConversationProgress(callback: (payload: { requestId?: string; record?: Record<string, unknown> }) => void): void {
    bridge()?.conversations?.onProgress?.(callback);
  },

  async models(): Promise<MagicPointerModelCatalog | null> {
    if (!hasBridge()) return null;
    try {
      const response = await bridge()!.modelsCatalog?.();
      return response?.ok ? (response.catalog ?? null) : null;
    } catch {
      return null;
    }
  },

  async slashDirectory(): Promise<MagicPointerSlashDirectory | null> {
    if (!hasBridge()) return null;
    try {
      const response = (await bridge()!.slashDirectory?.()) as MagicPointerSlashDirectory | { ok?: boolean; error?: string } | undefined;
      if (!response || (response as { ok?: boolean }).ok === false) return null;
      return response as MagicPointerSlashDirectory;
    } catch {
      return null;
    }
  },

  async selectModel(model: string): Promise<{ ok?: boolean; model?: string; error?: string }> {
    if (!hasBridge()) return { ok: false, error: '请在 Magic Pointer 应用里切换。' };
    try {
      return (await bridge()!.selectModel?.(model)) || { ok: false, error: '模型切换通道不可用。' };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
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
