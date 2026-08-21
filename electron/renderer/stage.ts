// PointerStage renderer: hosts every ephemeral visual (targeting outline,
// frozen glow, command capsule, processing shimmer, result/error surfaces)
// on one transparent click-through window. State lives in the pure machine
// electron/stage_state.js (loaded as a plain script -> globalThis.StageState).
//
// Motion is CSS keyframes + the Web Animations API only. GSAP is NOT a
// dependency; if the choreography outgrows this, vendor a local GSAP file
// later (no CDN, no npm) and swap the timeline code behind these helpers.
(() => {
  const machine = globalThis.StageState;
  const anchor = globalThis.StageAnchor;
  const surfacePolicy = globalThis.StageSurfacePolicy;
  const voiceTrigger = globalThis.MagicPointerVoiceTrigger;
  const hitPolicy = globalThis.MagicPointerStageHitPolicy;
  if (!machine || !anchor || !surfacePolicy || !voiceTrigger || !hitPolicy) return;
  const { initialState, transition } = machine;
  const api = window.magicPointerStage;

  // 静态 DOM：stage.html 里这些 id 固定存在，迁移期先按 non-null 取用
  // （overlay.ts 同款写法），页面结构变化时再收紧。
  const stageRoot = document.getElementById('stage') as HTMLElement;
  const targetingOutline = document.getElementById('targeting-outline') as HTMLElement;
  const captureProofLayer = document.getElementById('capture-proof') as HTMLElement;
  const screenPointLayer = document.getElementById('screen-points') as HTMLElement;
  const selectionStretch = document.getElementById('selection-stretch') as HTMLElement;
  const selectionStretchHint = document.getElementById('selection-stretch-hint') as HTMLElement;
  // Live drag on a selection handle, or null. Mirrors stretchDrag on the answer
  // card and shares its policy, so the same pull means the same thing.
  let selectionStretchDrag: {
    edge: string | undefined; startY: number; currentLines: number; currentChars: number; intent: any;
  } | null = null;
  const frozenGlow = document.getElementById('frozen-glow') as HTMLElement;
  const capsule = document.getElementById('capsule') as HTMLElement;
  const capsuleCount = document.getElementById('capsule-count') as HTMLElement;
  const capsuleRefs = document.getElementById('capsule-refs') as HTMLElement;
  // One entry per stroke the user drew, in draw order. Dropping one here drops
  // it from the command, so a mis-drawn stroke costs one click rather than a
  // whole redraw.
  let strokeRefs: { strokeIndex: number; label: string }[] = [];
  let renderedRefSignature = '';
  const capsuleInput = document.getElementById('capsule-input') as HTMLInputElement;
  const capsuleSend = document.getElementById('capsule-send') as HTMLButtonElement;
  const transcriptBox = document.getElementById('transcript') as HTMLElement;
  const shimmer = document.getElementById('processing-shimmer') as HTMLElement;
  const resultCard = document.getElementById('stage-result') as HTMLElement;
  const workPanelScroller = document.querySelector('.work-panel-scroller') as HTMLElement;
  const threadPanel = document.getElementById('stage-thread') as HTMLElement;
  const threadTitle = document.getElementById('thread-title') as HTMLElement;
  const threadEyebrow = document.getElementById('thread-eyebrow') as HTMLElement;
  const threadEyebrowText = document.getElementById('thread-eyebrow-text') as HTMLElement;
  const threadCount = document.getElementById('thread-count') as HTMLElement;
  const threadCopy = document.getElementById('thread-copy') as HTMLButtonElement;
  const threadFollowup = document.getElementById('thread-followup') as HTMLInputElement;
  const threadSend = document.getElementById('thread-send') as HTMLButtonElement;
  const threadRetry = document.getElementById('thread-retry') as HTMLButtonElement;
  const threadClose = document.getElementById('thread-close') as HTMLButtonElement;
  const consentBox = document.getElementById('capsule-consent') as HTMLElement;
  const consentTarget = document.getElementById('consent-target') as HTMLElement;
  const consentReject = document.getElementById('consent-reject') as HTMLButtonElement;
  const consentApprove = document.getElementById('consent-approve') as HTMLButtonElement;
  const shapePolicy = globalThis.AnswerShapePolicy || null;
  // 这次回答是「要送出去的」还是「自己看的」。它决定三件事：面板贴哪儿、
  // 正文解不解析 markdown、要不要出现那一下点头。
  let answerShape: { shape: string; allowMarkdown: boolean; needsConsent: boolean; reason: string } = { shape: 'inspect', allowMarkdown: true, needsConsent: false, reason: 'init' };
  const passageExpand = document.getElementById('passage-expand') as HTMLElement;
  // 就地展开：用户在回答里选中的那一段，以及它属于哪个文本节点。展开回来的
  // 字直接换掉这一段，所以这里记的是节点+偏移，不是「第几个字」。
  let passagePick: { range: Range; text: string; answer: HTMLElement } | null = null;
  let passageBusy = false;
  const errorCard = document.getElementById('stage-error') as HTMLElement;
  const chipsBox = document.getElementById('stage-chips') as HTMLElement;
  const stretchPolicy = globalThis.StageStretchPolicy || null;
  // Pick mode: the element the user last picked, so an unchanged pick does not
  // restart the highlight animation (that reads as flicker).
  let pickTargetShown: { rect: any; label: string } | null = null;
  // The element the user last clicked on, and therefore what a question is about.
  let pickedElement: { rect: any; label: string; source: string } | null = null;
  let pickInFlight = false;
  // Where this window sits on the virtual desktop, learned from the pointer
  // stream (which carries both spaces) rather than assumed to be zero.
  let stageOriginX = 0;
  let stageOriginY = 0;
  const noticeBox = document.getElementById('stage-notice') as HTMLElement;
  const noticeText = document.getElementById('stage-notice-text') as HTMLElement;
  let modelHealth: { circuitOpen: boolean; message: string; state: string } = { circuitOpen: false, message: '', state: 'unknown' };
  const deliveryBox = document.getElementById('delivery-progress') as HTMLElement;
  const deliveryLabel = document.getElementById('delivery-label') as HTMLElement;
  const deliveryBar = document.getElementById('delivery-bar') as HTMLElement;
  const deliveryCount = document.getElementById('delivery-count') as HTMLElement;
  const tplThreadTurn = document.getElementById('tpl-thread-turn') as HTMLTemplateElement;
  const tplAgentPromptDraft = document.getElementById('tpl-agent-prompt-draft') as HTMLTemplateElement;

  const DEFAULT_VISUAL_TUNING = Object.freeze({
    sweepHeightRatio: 0.52,
    sweepMinHeightDip: 10,
    sweepMaxHeightDip: 24,
    sweepDurationMs: 292,
    sweepFadeMs: 96,
    capsuleSpawnMs: 80,
    capsuleExpandMs: 125,
    capsuleVoiceWidthDip: 40,
    capsuleTextWidthDip: 144,
    capsuleMaxWidthDip: 440,
    capsuleInlineGapDip: 18,
  });
  const DISMISS_FADE_MS = 160;

  const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  let state = initialState({ reducedMotion: reducedMotionQuery.matches });
  capsule.hidden = true;
  let renderedTranscript = '';
  let dismissTimer: ReturnType<typeof setTimeout> | null = null;
  let hasShown = false;
  // Selection metadata rides on stage:show/stage:update payloads (not the
  // machine): the chips policy needs it, the lifecycle does not.
  const meta: { selectionSource: string | null; objectKind: string | null } = { selectionSource: null, objectKind: null };
  let renderedChipIds = '';
  // Signature of the turns currently in the DOM, so an unchanged thread is
  // never rebuilt (see renderThread).
  let renderedTurnSignature = '';
  // Wall clock for the pending turn's elapsed label.
  let waitTimer: ReturnType<typeof setTimeout> | null = null;
  let waitStartedAt = 0;
  // Live wiring context from main (stage:show / stage:update payloads).
  const session: {
    token: string | null;
    groundingReady: boolean;
    voiceAutoSubmit: boolean;
    voiceStartStrategy: string;
    selectionVisual: string;
    targetGeometryKind: string;
    submitOnFinal: boolean;
    pendingFinalTranscript: string;
    pointer: { x: number; y: number } | null;
    capsuleAnchor: string;
    capsuleDelayMs: number | null;
    capsulePlacement: { x: number; y: number; quadrant?: string } | null;
    capsulePlaced: boolean;
    capsuleDragged: boolean;
    panelPlacement: {
      x?: number; y?: number; width?: number; height?: number; side?: string; mode?: string;
      sessionToken?: string | null; role?: string; viewportWidth?: number; viewportHeight?: number;
    } | null;
    resultPlacement: { x: number; y: number } | null;
    resultDragged: boolean;
    consentDismissedForTurn: unknown;
    selectionCount: number;
    // 选中内容的字数（不是内容）。拉伸手势要把「屏幕上几行」换算成「多少字」，
    // 因为引擎只认后者。
    selectionChars: number;
    // 目标窗口在舞台坐标系里的矩形，和一个显示用的名字。只有几何和名字，
    // 没有句柄也没有进程 id——渲染层能画在哪儿，不等于它能读哪儿或写哪儿。
    targetWindowRect: { x: number; y: number; width: number; height: number } | null;
    targetAppLabel: string;
    voiceState: string;
    // "r, g, b" from appearance settings; empty means keep the stylesheet default.
    accentRgb: string;
    visualTuning: Record<keyof typeof DEFAULT_VISUAL_TUNING, number>;
  } = {
    token: null,
    groundingReady: false,
    voiceAutoSubmit: true,
    voiceStartStrategy: 'auto',
    selectionVisual: 'sweep_band',
    targetGeometryKind: 'pointer_only',
    submitOnFinal: false,
    pendingFinalTranscript: '',
    pointer: null,
    capsuleAnchor: 'target',
    capsuleDelayMs: null,
    capsulePlacement: null,
    capsulePlaced: false,
    capsuleDragged: false,
    panelPlacement: null,
    resultPlacement: null,
    resultDragged: false,
    consentDismissedForTurn: null,
    selectionCount: 1,
    // 选中内容的字数（不是内容）。拉伸手势要把「屏幕上几行」换算成「多少字」，
    // 因为引擎只认后者。
    selectionChars: 0,
    // 目标窗口在舞台坐标系里的矩形，和一个显示用的名字。只有几何和名字，
    // 没有句柄也没有进程 id——渲染层能画在哪儿，不等于它能读哪儿或写哪儿。
    targetWindowRect: null,
    targetAppLabel: '',
    voiceState: 'idle',
    // "r, g, b" from appearance settings; empty means keep the stylesheet default.
    accentRgb: '',
    visualTuning: { ...DEFAULT_VISUAL_TUNING },
  };
  let dictationActive = false;
  let mouseCaptureOn = false;
  let keyboardFocusRequested = false;
  let hitRegionKey = '';
  let hitRegionRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  let voiceTriggerPolicy: any = null;
  const agentPromptUi: {
    key: string;
    prompt: string;
    sessions: { provider: string; sessionId: string; title: string }[];
    selectedSession: { provider: string; sessionId: string; title: string } | null;
    loading: boolean;
  } = {
    key: '',
    prompt: '',
    sessions: [],
    selectedSession: null,
    loading: false,
  };
  let previousPointerButtons = 0;
  let pointerWasOverCapsule = false;
  let lastPointerPoint: { x: number; y: number } | null = null;
  let capsuleDrag: { startX: number; startY: number; originLeft: number; originTop: number } | null = null; // { startX, startY, originLeft, originTop }
  let surfaceDrag: { element: HTMLElement; startX: number; startY: number; originLeft: number; originTop: number } | null = null; // { element, startX, startY, originLeft, originTop }
  let reportedState = '';
  let targetSweepComplete = false;
  let targetSweepTimer: ReturnType<typeof setTimeout> | null = null;

  reducedMotionQuery.addEventListener('change', (event) => {
    dispatch({ type: 'SET_REDUCED_MOTION', value: event.matches });
  });

  function dispatch(event: any) {
    // Proof bands are evidence about a finished read, not a state of the
    // machine. They ride along on whatever event carried the result so the
    // rectangles and the answer appear together.
    if (event && Object.prototype.hasOwnProperty.call(event, 'captureProof')) {
      renderCaptureProof(event.captureProof);
    }
    if (event && Object.prototype.hasOwnProperty.call(event, 'screenPoints')) {
      renderScreenPoints(event.screenPoints);
    }
    const next = transition(state, event);
    if (next === state) return;
    state = next;
    render();
    syncEffects();
  }

  // Outline every rectangle we actually laid hands on, one band per rectangle,
  // staggered so they light up in reading order. Blue means the app handed us
  // those characters; amber means we recognised them from pixels. The colours
  // are load-bearing — see stage.css.
  function renderCaptureProof(bands: any) {
    if (!captureProofLayer) return;
    captureProofLayer.replaceChildren();
    const policy = globalThis.CaptureProofPolicy;
    const list = Array.isArray(bands) ? bands : [];
    if (!policy || list.length === 0) {
      captureProofLayer.hidden = true;
      return;
    }
    // The same screen -> stage-window transform showPickHighlight uses, so a
    // proof band and a pick highlight always land in the same place. If that
    // transform is wrong on a scaled display it is wrong for both, and there is
    // one place to fix it.
    const mapped = policy.toStageRects(list, {
      origin: { x: stageOriginX, y: stageOriginY },
    });
    let index = 0;
    for (const band of mapped) {
      const rect = band.rect;
      if (!isUsableTargetRect(rect)) continue;
      const element = document.createElement('div');
      element.className = 'capture-proof-band';
      element.dataset.source = band.source;
      element.style.left = `${rect.x}px`;
      element.style.top = `${rect.y}px`;
      element.style.width = `${rect.width}px`;
      element.style.height = `${rect.height}px`;
      element.style.setProperty('--proof-delay', `${index * 45}ms`);
      captureProofLayer.appendChild(element);
      index += 1;
    }
    captureProofLayer.hidden = index === 0;
  }

  // An arrow per [POINT] the answer carried, numbered the way the sentence is:
  // first this, then that. Screen coordinates use the same transform as the
  // proof bands and the pick highlight.
  function renderScreenPoints(points: any) {
    if (!screenPointLayer) return;
    screenPointLayer.replaceChildren();
    const list = Array.isArray(points) ? points : [];
    // [POINT] 坐标是物理屏幕像素（视觉模型看全屏截图给出）。stage 窗口
    // 坐标是 DIP——先减窗口原点、再除缩放（和 captureProof 同一套换算，
    // 否则 200% 缩放屏上箭头落在二分之一处）。
    const scale = window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
    let drawn = 0;
    for (const point of list) {
      const x = Math.round((Number(point.x) - stageOriginX) / scale);
      const y = Math.round((Number(point.y) - stageOriginY) / scale);
      if (![x, y].every(Number.isFinite)) continue;
      if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) continue;
      const element = document.createElement('div');
      element.className = 'screen-point';
      element.style.left = `${x}px`;
      element.style.top = `${y}px`;
      element.style.setProperty('--point-delay', `${drawn * 220}ms`);
      const badge = document.createElement('span');
      badge.className = 'screen-point-order';
      badge.textContent = String(Number(point.order) || drawn + 1);
      element.appendChild(badge);
      screenPointLayer.appendChild(element);
      drawn += 1;
    }
    screenPointLayer.hidden = drawn === 0;
  }

  // Place the pair of handles around whatever the user has selected. Hidden
  // whenever there is no resolved region to stretch — handles floating over
  // nothing would invite a gesture that cannot be honoured.
  function renderSelectionStretch() {
    if (!selectionStretch) return;
    const rect = state.target;
    const composerOpen = state.name === 'capsule-text' || state.name === 'capsule-voice';
    if (!composerOpen || session.targetGeometryKind !== 'resolved' || !isUsableTargetRect(rect)) {
      selectionStretch.hidden = true;
      return;
    }
    selectionStretch.style.left = `${Math.round(rect.x)}px`;
    selectionStretch.style.top = `${Math.round(rect.y)}px`;
    selectionStretch.style.width = `${Math.round(rect.width)}px`;
    selectionStretch.style.height = `${Math.round(rect.height)}px`;
    selectionStretch.hidden = false;
  }

  function selectionLineCount() {
    const rect = state.target;
    if (!isUsableTargetRect(rect)) return 1;
    // The selection's own height in lines, at the same scale the policy uses.
    return Math.max(1, Math.round(Number(rect.height) / 20));
  }

  function beginSelectionStretch(edge: string | undefined, y: number) {
    selectionStretchDrag = {
      edge,
      startY: y,
      currentLines: selectionLineCount(),
      currentChars: session.selectionChars,
      intent: null,
    };
    selectionStretch.classList.add('is-dragging');
  }

  function updateSelectionStretch(y: number) {
    if (!selectionStretchDrag || !stretchPolicy) return;
    // The top handle moves the opposite way: dragging it up makes the region
    // taller, which is the same "more" as dragging the bottom one down.
    const raw = y - selectionStretchDrag.startY;
    const dragPx = selectionStretchDrag.edge === 'top' ? -raw : raw;
    selectionStretchDrag.intent = stretchPolicy.stretchIntent({
      dragPx,
      currentLines: selectionStretchDrag.currentLines,
      currentChars: selectionStretchDrag.currentChars,
    });
    if (selectionStretchHint) selectionStretchHint.textContent = selectionStretchDrag.intent.hint;
  }

  function endSelectionStretch() {
    const drag = selectionStretchDrag;
    selectionStretchDrag = null;
    selectionStretch.classList.remove('is-dragging');
    if (selectionStretchHint) selectionStretchHint.textContent = '';
    if (!drag || !drag.intent || !stretchPolicy) return;
    const command = stretchPolicy.stretchCommand(drag.intent, 'selection');
    // Submitted through the ordinary composer path, so the gesture shows up in
    // the thread as an ask like any other and can be undone by asking again.
    if (command) submitCommand(command);
  }

  function clearScreenPoints() {
    if (!screenPointLayer) return;
    screenPointLayer.replaceChildren();
    screenPointLayer.hidden = true;
  }

  function clearCaptureProof() {
    if (!captureProofLayer) return;
    captureProofLayer.replaceChildren();
    captureProofLayer.hidden = true;
  }

  function applyVoiceTriggerEffects(outcome: any) {
    const effects = Array.isArray(outcome?.effects) ? outcome.effects : [];
    const wantsSubmit = effects.includes('submit');
    const pendingTranscript = session.pendingFinalTranscript;
    if (wantsSubmit) session.submitOnFinal = true;
    if (effects.includes('start') && !dictationActive) {
      dictationActive = true;
      session.voiceState = 'warming';
      capsule.dataset.voiceState = session.voiceState;
      if (api && typeof api.startDictation === 'function') api.startDictation();
    }
    if (effects.includes('stop') && dictationActive) {
      dictationActive = false;
      if (api && typeof api.stopDictation === 'function') {
        api.stopDictation({ graceful: wantsSubmit && !pendingTranscript });
      }
    }
    if (wantsSubmit && pendingTranscript) {
      session.pendingFinalTranscript = '';
      submitCommand(pendingTranscript);
    }
  }

  function dispatchVoiceTrigger(event: any) {
    if (!voiceTriggerPolicy) return;
    applyVoiceTriggerEffects(voiceTriggerPolicy.dispatch(event));
  }

  function resetVoiceTrigger() {
    voiceTriggerPolicy = null;
    previousPointerButtons = 0;
    pointerWasOverCapsule = false;
    capsuleDrag = null;
    surfaceDrag = null;
    session.submitOnFinal = false;
    session.pendingFinalTranscript = '';
    session.voiceState = 'idle';
    capsule.dataset.voiceState = session.voiceState;
  }

  // Dragging used to start anywhere inside a surface that was not a button,
  // textarea or input. That negative list could never enumerate everything —
  // native scrollbars are not elements, so pulling one dragged the whole
  // bubble across the screen. Dragging is now positive: it starts only on an
  // element that declares itself a handle, and never inside [data-no-drag].
  // Pick mode: ask what element is under this screen point and outline the whole
  // thing. Screen coordinates, because the answer comes from the target app's
  // automation tree, not from our window.
  async function pickElementAt(screenX: number, screenY: number) {
    if (pickInFlight || !api || typeof api.pickElement !== 'function') return;
    pickInFlight = true;
    try {
      const response = await api.pickElement({
        x: screenX,
        y: screenY,
        selectionSessionToken: session.token,
      });
      if (response?.ok !== true || !response.rect) return;
      const picked = { rect: response.rect, label: String(response.label || '') };
      const pickPolicy = globalThis.StagePickPolicy;
      // Repainting the same rectangle restarts its animation; skip it.
      if (pickPolicy && pickPolicy.isSameTarget(pickTargetShown, picked)) return;
      pickTargetShown = picked;
      // A pick is not just a highlight: it becomes what the next question is
      // about. Without this the element lights up and the command still goes to
      // whatever was selected before, which is the worst kind of near-miss.
      pickedElement = {
        rect: picked.rect,
        label: String(picked.label || '').slice(0, 40),
        source: String(response.source || 'structured'),
      };
      renderStrokeRefs();
      showPickHighlight(picked);
    } catch (_) {
      // A failed pick is a no-op: the user sees nothing light up, which is the
      // honest outcome, and nothing else about the session changes.
    } finally {
      pickInFlight = false;
    }
  }

  // Reuses the frozen-glow surface and its sweep-band styling, so a picked
  // element looks like a drawn selection rather than a second visual language.
  function showPickHighlight(picked: any) {
    const rect = picked.rect;
    // Screen -> stage-window coordinates. The stage window's own origin is the
    // offset, and it is tracked from the pointer stream (screenX minus x).
    placeRect(frozenGlow, {
      x: rect.x - stageOriginX,
      y: rect.y - stageOriginY,
      width: rect.width,
      height: rect.height,
    });
    frozenGlow.hidden = false;
    frozenGlow.classList.remove('is-picked');
    // Force a reflow so the animation restarts for a genuinely new target.
    void frozenGlow.offsetWidth;
    frozenGlow.classList.add('is-picked');
  }

  // One chip per stroke, numbered the way the composed command numbers them, so
  // the ① on screen is the ① the model is told about.
  function renderStrokeRefs() {
    if (!capsuleRefs) return;
    const stream = globalThis.StageTurnStream;
    const marks = stream?.ORDINAL_MARKS || [];
    const pickSignature = pickedElement ? `pick:${pickedElement.label}:${pickedElement.rect?.x},${pickedElement.rect?.y}` : '';
    const signature = [...strokeRefs.map((ref) => `${ref.strokeIndex}:${ref.label}`), pickSignature].join('|');
    if (signature === renderedRefSignature) {
      capsuleRefs.hidden = strokeRefs.length === 0 && !pickedElement;
      return;
    }
    renderedRefSignature = signature;
    capsuleRefs.replaceChildren();
    if (strokeRefs.length === 0 && !pickedElement) {
      capsuleRefs.hidden = true;
      return;
    }
    strokeRefs.forEach((ref, index) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'capsule-ref';
      chip.dataset.noDrag = '1';
      chip.setAttribute('role', 'listitem');
      const mark = marks[index] || String(index + 1);
      chip.textContent = ref.label ? `${mark} ${ref.label}` : mark;
      chip.title = '点击移除这一处';
      chip.setAttribute('aria-label', `移除第 ${index + 1} 处选中`);
      chip.addEventListener('click', () => {
        strokeRefs = strokeRefs.filter((item) => item !== ref);
        renderStrokeRefs();
        syncHitRegions();
      });
      capsuleRefs.appendChild(chip);
    });
    if (pickedElement) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'capsule-ref is-picked';
      chip.dataset.noDrag = '1';
      chip.dataset.source = pickedElement.source;
      chip.setAttribute('role', 'listitem');
      chip.textContent = pickedElement.label || '指定的这一块';
      chip.title = '点击取消这一块';
      chip.setAttribute('aria-label', '取消选中的元件');
      chip.addEventListener('click', () => {
        pickedElement = null;
        frozenGlow.hidden = true;
        pickTargetShown = null;
        renderStrokeRefs();
        syncHitRegions();
      });
      capsuleRefs.appendChild(chip);
    }
    capsuleRefs.hidden = false;
  }

  function isPointInside(x: number, y: number, element: HTMLElement | null) {
    if (!element || element.hidden) return false;
    const rect = element.getBoundingClientRect();
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  }

  // A press on our own floating surfaces (chips, selection handles, error card,
  // consent bar, notice, delivery row) belongs to the UI, not to pick mode.
  // Without this, clicking a chip also picked the element behind it in the
  // target app and hijacked the next question's target.
  function isInsideStageSurface(x: number, y: number, element: HTMLElement | null) {
    return Boolean(element && !element.hidden && isPointInside(x, y, element));
  }

  function isDragHandleAt(x: number, y: number, rootEl: HTMLElement | null) {
    if (!rootEl || rootEl.hidden) return false;
    let node = document.elementFromPoint(x, y) as HTMLElement | null;
    if (!node || !rootEl.contains(node)) return false;
    while (node && node !== document.body) {
      if (node.dataset && node.dataset.noDrag) return false;
      if (node.dataset && node.dataset.dragHandle) return true;
      if (node === rootEl) return false;
      node = node.parentElement;
    }
    return false;
  }

  function handleVoicePointerInput(payload: any) {
    const t = Number(payload?.t);
    const x = Number(payload?.x);
    const y = Number(payload?.y);
    const buttons = Number(payload?.buttons || 0);
    if (![t, x, y, buttons].every(Number.isFinite)) return;
    lastPointerPoint = { x, y };
    if (Number.isFinite(payload?.screenX) && Number.isFinite(payload?.screenY)) {
      stageOriginX = Number(payload.screenX) - x;
      stageOriginY = Number(payload.screenY) - y;
    }
    syncHitRegions();
    const capsuleRect = capsule.getBoundingClientRect();
    const overCapsule = !capsule.hidden
      && x >= capsuleRect.left && x <= capsuleRect.right
      && y >= capsuleRect.top && y <= capsuleRect.bottom;
    const primaryDown = (buttons & 1) !== 0;
    const previousPrimaryDown = (previousPointerButtons & 1) !== 0;
    const resultRect = threadPanel.getBoundingClientRect();
    const overResult = !threadPanel.hidden
      && x >= resultRect.left && x <= resultRect.right
      && y >= resultRect.top && y <= resultRect.bottom;
    // Pick mode: a click that lands outside our own surfaces, while the composer
    // is open, means "tell me about that thing" — the element under the cursor
    // lights up whole. Inside our surfaces the click belongs to the UI.
    const overOwnSurface = isInsideStageSurface(x, y, chipsBox)
      || isInsideStageSurface(x, y, selectionStretch)
      || isInsideStageSurface(x, y, errorCard)
      || isInsideStageSurface(x, y, consentBox)
      || isInsideStageSurface(x, y, deliveryBox)
      || isInsideStageSurface(x, y, noticeBox)
      || isInsideStageSurface(x, y, passageExpand);
    if (primaryDown && !previousPrimaryDown && !overCapsule && !overResult && !overOwnSurface && !surfaceDrag) {
      const composerOpen = state.name === 'capsule-text' || state.name === 'capsule-voice';
      if (composerOpen && Number.isFinite(payload?.screenX) && Number.isFinite(payload?.screenY)) {
        pickElementAt(Number(payload.screenX), Number(payload.screenY));
      }
    }
    // Selection handles first: they sit outside our panels, on the user's own
    // content, so a press there is unambiguous.
    if (primaryDown && !previousPrimaryDown && !selectionStretchDrag && selectionStretch && !selectionStretch.hidden) {
      for (const handle of selectionStretch.querySelectorAll<HTMLElement>('.selection-stretch-handle')) {
        if (isPointInside(x, y, handle)) {
          beginSelectionStretch(handle.dataset.edge, y);
          break;
        }
      }
    }
    if (selectionStretchDrag) {
      updateSelectionStretch(y);
      if (!primaryDown && previousPrimaryDown) endSelectionStretch();
    }
    // 答案底边那条拉伸把手已经撤掉了：现在改答案长度的做法是在答案里划中一段
    // 再点「展开讲讲」（见 expandPickedPassage）。那条把手会开新的一轮，而这里
    // 用户只是想把第一轮的一段话讲细一点。
    if (overResult && primaryDown && !previousPrimaryDown && !surfaceDrag) {
      if (isDragHandleAt(x, y, threadPanel)) {
        surfaceDrag = { element: threadPanel, startX: x, startY: y, originLeft: resultRect.left, originTop: resultRect.top };
        threadPanel.classList.add('is-dragging');
      }
    }
    if (surfaceDrag) {
      const dx = x - surfaceDrag.startX;
      const dy = y - surfaceDrag.startY;
      const currentRect = surfaceDrag.element.getBoundingClientRect();
      const left = Math.max(4, Math.min(window.innerWidth - currentRect.width - 4, surfaceDrag.originLeft + dx));
      const top = Math.max(4, Math.min(window.innerHeight - currentRect.height - 4, surfaceDrag.originTop + dy));
      surfaceDrag.element.style.left = `${left}px`;
      surfaceDrag.element.style.top = `${top}px`;
      session.resultPlacement = { x: left, y: top };
      syncHitRegions();
    }
    if (surfaceDrag && !primaryDown && previousPrimaryDown) {
      surfaceDrag.element.classList.remove('is-dragging');
      surfaceDrag = null;
      session.resultDragged = true;
      // Release pointer capture in the same tick the button came up.
      syncHitRegions();
    }
    // Drag the capsule: press on its body (not inside the text input) and move.
    if (overCapsule && primaryDown && !previousPrimaryDown && !capsuleDrag) {
      if (isDragHandleAt(x, y, capsule)) {
        capsuleDrag = { startX: x, startY: y, originLeft: capsuleRect.left, originTop: capsuleRect.top };
      }
    }
    if (capsuleDrag) {
      const dx = x - capsuleDrag.startX;
      const dy = y - capsuleDrag.startY;
      const currentRect = capsule.getBoundingClientRect();
      const left = Math.max(4, Math.min(window.innerWidth - currentRect.width - 4, capsuleDrag.originLeft + dx));
      const top = Math.max(4, Math.min(window.innerHeight - currentRect.height - 4, capsuleDrag.originTop + dy));
      capsule.style.left = `${left}px`;
      capsule.style.top = `${top}px`;
      if (session.capsulePlacement) {
        session.capsulePlacement = { ...session.capsulePlacement, x: left, y: top };
      }
      syncHitRegions();
    }
    if (capsuleDrag && !primaryDown && previousPrimaryDown) {
      capsuleDrag = null;
      session.capsuleDragged = true;
      syncHitRegions();
    }
    previousPointerButtons = buttons;
    if (!voiceTriggerPolicy || state.name !== 'capsule-voice') return;
    if (session.voiceStartStrategy === 'push_to_talk') {
      if (primaryDown && !previousPrimaryDown) dispatchVoiceTrigger({ type: 'press', t });
      else if (!primaryDown && previousPrimaryDown) dispatchVoiceTrigger({ type: 'release', t });
    } else if (session.voiceStartStrategy === 'hover') {
      const rect = capsule.getBoundingClientRect();
      const overCapsule = !capsule.hidden
        && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
      if (overCapsule && !pointerWasOverCapsule) dispatchVoiceTrigger({ type: 'enter', t });
      if (overCapsule) dispatchVoiceTrigger({ type: 'tick', t, overTarget: true });
      else if (pointerWasOverCapsule) dispatchVoiceTrigger({ type: 'leave', t });
      pointerWasOverCapsule = overCapsule;
    }
  }

  // The transparent stage may ask main to receive mouse events only while it
  // has a control a user can actually operate. A result/error card is usually
  // presentation only, so its presence alone must not turn the full-screen
  // stage into a click-blocking layer.
  function hasInteractiveStageSurface() {
    const name = state.name;
    if (name === 'hidden' || name === 'dismissing') return false;
    if (name === 'capsule-text') return !capsule.hidden && !capsuleInput.disabled;
    // The voice capsule needs pointer events too: drag-to-move and
    // push-to-talk / hover triggering both rely on stage mouse capture.
    if (name === 'capsule-voice') return !capsule.hidden;
    // Anything the user can grab or press counts, in every remaining state.
    // While processing, the fixed thread is the only visible surface; it owns
    // the stop affordance and must not fall through to the app underneath.
    if (!capsule.hidden || !threadPanel.hidden) return true;
    const hasEnabledButton = (element: HTMLElement) => !element.hidden
      && Boolean(element.querySelector('button:not([disabled])'));
    return hasEnabledButton(chipsBox)
      || hasEnabledButton(errorCard);
  }

  function visibleStageRegions() {
    // consentBox 是「要送出去」那一路的点头按钮：它悬在胶囊下方，若不在
    // shape 区域内，点击会穿透到下层应用，整个同意流程点不响。
    return [targetingOutline, frozenGlow, capsule, threadPanel, errorCard, chipsBox, consentBox, deliveryBox, passageExpand]
      .filter((element) => !element.hidden)
      .map((element) => ({ element, rect: element.getBoundingClientRect() }))
      .filter(({ rect }) => rect.width > 0 && rect.height > 0)
      .map(({ element, rect: measuredRect }) => {
        const rect = measuredRect;
        const isTargetFeedback = element === targetingOutline || element === frozenGlow;
        const padding = isTargetFeedback && session.selectionVisual === 'sweep_band' ? 28 : 8;
        const x = Math.max(0, Math.floor(rect.left - padding));
        const y = Math.max(0, Math.floor(rect.top - padding));
        const right = Math.min(window.innerWidth, Math.ceil(rect.right + padding));
        const bottom = Math.min(window.innerHeight, Math.ceil(rect.bottom + padding));
        return { x, y, width: right - x, height: bottom - y };
      })
      .filter((rect) => rect.width > 0 && rect.height > 0)
      .slice(0, 16);
  }

  function interactiveStageRegions() {
    const elements = [];
    // The capsule is operable only while it is the visible entry surface.
    if (!capsule.hidden && !(state.name === 'capsule-text' && capsuleInput.disabled)) {
      elements.push(capsule);
    }
    if (!threadPanel.hidden) elements.push(threadPanel);
    if (!passageExpand.hidden) elements.push(passageExpand);
    if (!consentBox.hidden) elements.push(consentBox);
    for (const container of [chipsBox, threadPanel, errorCard]) {
      if (container.hidden) continue;
      elements.push(...container.querySelectorAll('button:not([disabled])'));
    }
    return elements
      .map((element) => element.getBoundingClientRect())
      .filter((rect) => rect.width > 0 && rect.height > 0)
      .map((rect) => {
        const padding = 4;
        const x = Math.max(0, Math.floor(rect.left - padding));
        const y = Math.max(0, Math.floor(rect.top - padding));
        const right = Math.min(window.innerWidth, Math.ceil(rect.right + padding));
        const bottom = Math.min(window.innerHeight, Math.ceil(rect.bottom + padding));
        return { x, y, width: right - x, height: bottom - y };
      })
      .filter((rect) => rect.width > 0 && rect.height > 0)
      .slice(0, 16);
  }

  function syncHitRegions() {
    const name = state.name;
    // One source of truth. The old form gated every state other than
    // capsule-text/result/error behind `!chipsBox.hidden`, which silently
    // disabled capture during `processing` — exactly when the thread and the
    // composer are both on screen and grabbable.
    const hasInteractiveSurface = hasInteractiveStageSurface();
    const interactiveRegions = interactiveStageRegions();
    const wantCapture = hitPolicy.shouldCaptureMouse({
      hasInteractiveSurface,
      pointer: lastPointerPoint,
      interactiveRegions,
      dragging: Boolean(capsuleDrag || surfaceDrag),
    });
    const requestFocus = name === 'capsule-text';
    // A shaped window clips the pointer to its regions. During a drag that
    // would hand the mouse back to the app underneath the moment the cursor
    // outruns the panel, so the stage claims the whole viewport until release.
    const regions = (capsuleDrag || surfaceDrag)
      ? [{ x: 0, y: 0, width: window.innerWidth, height: window.innerHeight }]
      : visibleStageRegions();
    const nextHitRegionKey = JSON.stringify(regions);
    if (
      wantCapture !== mouseCaptureOn
      || requestFocus !== keyboardFocusRequested
      || nextHitRegionKey !== hitRegionKey
    ) {
      mouseCaptureOn = wantCapture;
      keyboardFocusRequested = requestFocus;
      hitRegionKey = nextHitRegionKey;
      if (api && typeof api.setMouseCapture === 'function') {
        api.setMouseCapture(wantCapture, { requestFocus, regions });
      }
    }
  }

  function scheduleHitRegionRefresh() {
    requestAnimationFrame(syncHitRegions);
    if (hitRegionRefreshTimer) clearTimeout(hitRegionRefreshTimer);
    hitRegionRefreshTimer = setTimeout(syncHitRegions, 240);
  }

  // Side effects that follow the machine, not the DOM: dictation lifecycle,
  // main-process mouse capture (the stage window is click-through by default),
  // and state reporting for the main-process log.
  function syncEffects() {
    const name = state.name;
    const wantDictation = name === 'capsule-voice' && session.groundingReady === true;
    if (wantDictation && !voiceTriggerPolicy) {
      voiceTriggerPolicy = new voiceTrigger.VoiceTriggerPolicy({
        strategy: session.voiceStartStrategy,
        hoverThresholdMs: 500,
      });
      if (session.voiceStartStrategy === 'auto') {
        dispatchVoiceTrigger({ type: 'capsule-ready' });
      }
    } else if (!wantDictation && dictationActive) {
      dictationActive = false;
      if (api && typeof api.stopDictation === 'function') api.stopDictation({ graceful: false });
      resetVoiceTrigger();
    } else if (!wantDictation && voiceTriggerPolicy) {
      resetVoiceTrigger();
    }
    syncHitRegions();
    if (name !== reportedState) {
      reportedState = name;
      if (api && typeof api.reportState === 'function') {
        api.reportState({ state: name, selectionSessionToken: session.token });
      }
    }
  }

  function submitCommand(command: string) {
    const trimmed = String(command == null ? '' : command).trim();
    if (!trimmed) return;
    const inputMode = state.inputMode;
    // Chips the user removed are removed from the request too, or the chip is a
    // decoration that lies about what was sent.
    const keptStrokeIndexes = strokeRefs.map((ref) => ref.strokeIndex);
    if (state.name === 'processing') {
      // A turn is already running: this is a steer, not a second request. The
      // text goes into the durable session inbox and the loop claims it at the
      // next round boundary (next-step), so mid-run course corrections no
      // longer require killing the run (O1/O2).
      steerSelectionCommand(trimmed);
      return;
    }
    dispatch({ type: 'SUBMIT', command: trimmed });
    if (state.name !== 'processing') return;
    if (api && typeof api.submitSelectionCommand === 'function') {
      api.submitSelectionCommand({
        selectionSessionToken: session.token,
        command: trimmed,
        inputMode,
        keptStrokeIndexes,
        pickedElement: pickedElement ? { rect: pickedElement.rect, source: pickedElement.source } : null,
      });
    }
  }

  function steerSelectionCommand(command: string) {
    const trimmed = String(command == null ? '' : command).trim();
    if (!trimmed) return;
    capsuleInput.value = '';
    if (!api || typeof api.steerSelectionCommand !== 'function') {
      dispatch({ type: 'NOTICE', notice: { message: '这一轮不支持中途插话，等它跑完再发。' } });
      return;
    }
    api
      .steerSelectionCommand({ selectionSessionToken: session.token, text: trimmed })
      .then((reply: any) => {
        if (reply?.ok === true) {
          dispatch({ type: 'NOTICE', notice: { message: '已插话，当前步骤结束后生效。' } });
        } else {
          const reason = String(reply?.error || '');
          const message = reason === 'no_agent_session'
            ? '这一轮还没有可插话的会话，等它跑完再发。'
            : `插话没有送达：${reason || '未知原因'}`;
          dispatch({ type: 'NOTICE', notice: { message } });
        }
        if (state.notice) {
          setTimeout(() => { if (state.notice) dispatch({ type: 'NOTICE', notice: { message: '' } }); }, 4000);
        }
      })
      .catch(() => {
        dispatch({ type: 'NOTICE', notice: { message: '插话没有送达，等它跑完再发。' } });
      });
  }

  function requestDismiss() {
    if (state.name === 'hidden' || state.name === 'dismissing') return;
    dispatch({ type: 'DISMISS' });
    if (api && typeof api.dismiss === 'function') api.dismiss();
  }

  function placeRect(element: HTMLElement, rect: any) {
    if (!rect) {
      element.hidden = true;
      return;
    }
    element.hidden = false;
    element.style.left = `${rect.x}px`;
    element.style.top = `${rect.y}px`;
    element.style.width = `${rect.width}px`;
    element.style.height = `${rect.height}px`;
  }

  function isUsableTargetRect(rect: any) {
    if (!rect || typeof rect !== 'object') return false;
    const x = Number(rect.x);
    const y = Number(rect.y);
    const width = Number(rect.width);
    const height = Number(rect.height);
    if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return false;
    return x < window.innerWidth && y < window.innerHeight && x + width > 0 && y + height > 0;
  }

  function sweepBandRect(rect: any) {
    if (!isUsableTargetRect(rect)) return null;
    const sourceHeight = Math.max(1, Number(rect.height));
    const height = Math.min(
      session.visualTuning.sweepMaxHeightDip,
      Math.max(
        session.visualTuning.sweepMinHeightDip,
        Math.round(sourceHeight * session.visualTuning.sweepHeightRatio),
      ),
    );
    const horizontalPadding = Math.min(10, Math.max(4, Math.round(sourceHeight * 0.12)));
    const left = Math.max(0, Math.round(Number(rect.x) - horizontalPadding));
    const top = Math.max(0, Math.round(Number(rect.y) - ((height - sourceHeight) / 2)));
    const right = Math.min(
      window.innerWidth,
      Math.round(Number(rect.x) + Number(rect.width) + horizontalPadding),
    );
    const bottom = Math.min(window.innerHeight, top + height);
    return {
      x: left,
      y: top,
      width: Math.max(1, right - left),
      height: Math.max(1, bottom - top),
    };
  }

  function targetFeedbackRect(rect: any) {
    if (!isUsableTargetRect(rect)) return null;
    if (session.targetGeometryKind !== 'resolved') return null;
    if (session.selectionVisual === 'sweep_band') return sweepBandRect(rect);
    if (session.selectionVisual === 'soft_glow') {
      const padding = 6;
      const left = Math.max(0, Number(rect.x) - padding);
      const top = Math.max(0, Number(rect.y) - padding);
      return {
        x: left,
        y: top,
        width: Math.max(1, Math.min(window.innerWidth - left, Number(rect.width) + (padding * 2))),
        height: Math.max(1, Math.min(window.innerHeight - top, Number(rect.height) + (padding * 2))),
      };
    }
    return rect;
  }

  function clearTranscript() {
    renderedTranscript = '';
    transcriptBox.textContent = '';
  }

  function renderTranscript() {
    const text = state.transcript || '';
    if (text === renderedTranscript) return;
    // A single text node avoids thousands of spans during streaming dictation.
    transcriptBox.textContent = text;
    renderedTranscript = text;
  }

  function voiceStateForStatus(status: unknown) {
    const value = String(status || '').toLowerCase();
    if (value === 'warming') return 'warming';
    if (value === 'ready' || value === 'microphone_started') return 'listening';
    if (value === 'microphone_stopped') return 'idle';
    return null;
  }

  function syncCapsuleWidth() {
    const content = state.transcript || capsuleInput.value || '';
    capsule.dataset.empty = content ? 'false' : 'true';
    const size = surfacePolicy.surfaceSize('composer', {
      width: window.innerWidth,
      height: window.innerHeight,
    });
    capsule.style.setProperty('--stage-composer-width', `${size.width}px`);
    capsule.style.setProperty('--stage-composer-height', `${size.height}px`);
    return size.width;
  }

  function anchorNearPointer(element: HTMLElement, fallbackWidth = 200, fallbackHeight = 44) {
    const rect = element.getBoundingClientRect();
    const point = session.pointer || (state.target
      ? { x: state.target.x + state.target.width / 2, y: state.target.y + state.target.height / 2 }
      : { x: window.innerWidth / 2, y: window.innerHeight / 2 });
    const placement = anchor.choosePointerAnchor(
      point,
      { width: rect.width || fallbackWidth, height: rect.height || fallbackHeight },
      { width: window.innerWidth, height: window.innerHeight },
    );
    element.style.left = `${placement.x}px`;
    element.style.top = `${placement.y}px`;
    element.dataset.quadrant = placement.quadrant;
  }

  // Process/result surfaces prefer the free gutter beside the source app and
  // preserve that side for the whole session. The capsule is only the fallback
  // anchor when the adaptive placement policy is unavailable.
  function placeThreadSurface() {
    if (session.resultDragged && session.resultPlacement) {
      threadPanel.style.left = `${session.resultPlacement.x}px`;
      threadPanel.style.top = `${session.resultPlacement.y}px`;
      return;
    }
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const focus = isUsableTargetRect(state.target)
      ? state.target
      : (session.pointer ? { ...session.pointer, width: 0, height: 0 } : null);
    const placement = surfacePolicy.stableSurfacePlacement({
      previous: session.panelPlacement,
      sessionToken: session.token,
      role: 'work-panel',
      viewport,
      place: (size: { width: number; height: number }) => {
        if (typeof anchor.chooseAdaptivePanelAnchor === 'function') {
          return anchor.chooseAdaptivePanelAnchor({
            source: isUsableTargetRect(session.targetWindowRect) ? session.targetWindowRect : null,
            focus,
            surface: size,
            viewport,
            preferredSide: session.panelPlacement?.side,
          });
        }
        const point = session.capsulePlacement || session.pointer || { x: 8, y: 8 };
        return {
          x: Math.max(8, Math.min(point.x, window.innerWidth - size.width - 8)),
          y: Math.max(8, Math.min(point.y, window.innerHeight - size.height - 8)),
          side: 'right',
          mode: 'screen-edge',
        };
      },
    });
    session.panelPlacement = placement;
    threadPanel.style.setProperty('--stage-work-panel-width', `${placement.width}px`);
    threadPanel.style.setProperty('--stage-work-panel-height', `${placement.height}px`);
    threadPanel.style.left = `${placement.x}px`;
    threadPanel.style.top = `${placement.y}px`;
    threadPanel.dataset.side = placement.side;
    threadPanel.dataset.quadrant = placement.side;
    threadPanel.dataset.placementMode = placement.mode;
  }

  function anchorCapsuleToTarget(width: number) {
    // Anchor exactly once per session: the capsule must appear next to the
    // selection and then stay put (the user can drag it). Re-anchoring when
    // grounding later resolves made the bubble jump across the screen.
    if (session.capsulePlaced || session.capsuleDragged) return;
    const height = surfacePolicy.surfaceSize('composer', {
      width: window.innerWidth,
      height: window.innerHeight,
    }).height;
    if (typeof anchor.chooseStableCapsuleAnchor === 'function') {
      const point = session.pointer || (state.target
        ? { x: state.target.x + state.target.width / 2, y: state.target.y + state.target.height / 2 }
        : { x: window.innerWidth / 2, y: window.innerHeight / 2 });
      const targetMode = (
        session.capsuleAnchor === 'target'
        && session.targetGeometryKind === 'resolved'
        && isUsableTargetRect(state.target)
      );
      const placement = anchor.chooseStableCapsuleAnchor({
        previous: session.capsulePlacement,
        sessionToken: session.token,
        mode: targetMode ? 'target' : 'pointer',
        pointer: point,
        target: targetMode ? state.target : null,
        surface: { width, height },
        viewport: { width: window.innerWidth, height: window.innerHeight },
        options: targetMode
          ? { gap: session.visualTuning.capsuleInlineGapDip }
          : undefined,
      });
      session.capsulePlacement = placement;
      capsule.style.left = `${placement.x}px`;
      capsule.style.top = `${placement.y}px`;
      capsule.dataset.quadrant = placement.quadrant;
      session.capsulePlaced = true;
      return;
    }
    if (
      session.capsuleAnchor === 'target'
      &&
      session.targetGeometryKind === 'resolved'
      && isUsableTargetRect(state.target)
      && typeof anchor.chooseTargetInlineAnchor === 'function'
    ) {
      const placement = anchor.chooseTargetInlineAnchor(
        state.target,
        { width, height },
        { width: window.innerWidth, height: window.innerHeight },
        { gap: session.visualTuning.capsuleInlineGapDip },
      );
      capsule.style.left = `${placement.x}px`;
      capsule.style.top = `${placement.y}px`;
      capsule.dataset.quadrant = placement.quadrant;
      session.capsulePlaced = true;
      return;
    }
    anchorNearPointer(capsule, width, height);
    session.capsulePlaced = true;
  }

  function applyVisualTuning() {
    stageRoot.style.setProperty('--stage-sweep-duration', `${session.visualTuning.sweepDurationMs}ms`);
    stageRoot.style.setProperty('--stage-sweep-fade', `${session.visualTuning.sweepFadeMs}ms`);
    // One assignment retints every accent in the stage, because stage.css
    // composes all of them from these channels rather than repeating literals.
    if (session.accentRgb) {
      stageRoot.style.setProperty('--stage-accent-rgb', session.accentRgb);
    }
  }



  // 失败也是一张卡——同一套版式，只是 state 是 failed。原来它走的是另一条
  // 渲染路径，于是「成功长这样、失败长那样」，用户看到的是两个产品。
  function renderFailure(container: HTMLElement, error: any) {
    const message = typeof error === 'string'
      ? error
      : String(error?.message || error?.answer || '这次没能完成。');
    container.replaceChildren(renderCard(
      CardModel.normalizeCard({ kind: 'prose', state: 'failed', error: message }),
      { density: 'capsule' },
    ));
  }

  function cloneTemplate(template: HTMLTemplateElement) {
    return template.content.firstElementChild!.cloneNode(true) as HTMLElement;
  }



  // renderCalendarDraft / renderTableCompare / renderTextDraft 三个渲染器已经
  // 并进 renderer/card_render.js（对应 calendar / table / diff 三种卡）。
  // 舞台、随行窗、工作室从此共用同一份实现——不再是三份各写一遍。


  function safeAgentSession(raw: any) {
    if (!raw || typeof raw !== 'object') return null;
    const provider = String(raw.provider || '').toLowerCase();
    const sessionId = String(raw.sessionId || '');
    if (!['codex', 'claude', 'gemini', 'pi'].includes(provider) || !sessionId) return null;
    if (raw.live !== true) return null;
    if (raw.cwdMatch && raw.cwdMatch !== 'strict' && raw.cwdMatch !== 'subtree') return null;
    const title = String(raw.title || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
    return {
      provider,
      sessionId,
      title: (title || `${provider} · ${sessionId.slice(0, 8)}`).slice(0, 72),
      state: String(raw.state || ''),
    };
  }

  function loadAgentSessions(promptKey: string) {
    if (agentPromptUi.loading || !api || typeof api.listAgentSessions !== 'function') return;
    agentPromptUi.loading = true;
    api.listAgentSessions(session.token).then((result) => {
      if (agentPromptUi.key !== promptKey) return;
      const sessions = Array.isArray(result?.sessions) ? result.sessions : [];
      const seen = new Set();
      agentPromptUi.sessions = sessions.flatMap((raw: any) => {
        const item = safeAgentSession(raw);
        if (!item) return [];
        const key = `${item.provider}:${item.sessionId}`;
        if (seen.has(key)) return [];
        seen.add(key);
        return [item];
      }).slice(0, 5);
      agentPromptUi.loading = false;
      if (state.name === 'result' && state.result?.kind === 'agent-prompt-draft') render();
    }).catch(() => {
      if (agentPromptUi.key !== promptKey) return;
      agentPromptUi.sessions = [];
      agentPromptUi.loading = false;
      if (state.name === 'result' && state.result?.kind === 'agent-prompt-draft') render();
    });
  }

  function renderAgentPromptDraft(container: HTMLElement, payload: any) {
    const promptKey = `${session.token || ''}:${String(payload.prompt || '')}`;
    if (agentPromptUi.key !== promptKey) {
      agentPromptUi.key = promptKey;
      agentPromptUi.prompt = String(payload.prompt || '');
      agentPromptUi.sessions = [];
      agentPromptUi.selectedSession = null;
      agentPromptUi.loading = false;
      loadAgentSessions(promptKey);
    }
    const draft = cloneTemplate(tplAgentPromptDraft);
    const editor = draft.querySelector('.agent-prompt-editor') as HTMLTextAreaElement;
    const note = draft.querySelector('.agent-prompt-note') as HTMLElement;
    const sessionsRow = draft.querySelector('.agent-session-row') as HTMLElement;
    const close = draft.querySelector('.agent-prompt-close') as HTMLElement;
    const confirm = draft.querySelector('.agent-prompt-confirm') as HTMLButtonElement;
    editor.value = agentPromptUi.prompt;
    editor.addEventListener('input', () => {
      agentPromptUi.prompt = editor.value.slice(0, 60000);
      confirm.disabled = !agentPromptUi.prompt.trim() || !agentPromptUi.selectedSession;
    });
    if (payload.generatedBy === 'grounded_fallback') {
      note.textContent = 'Model 暂不可用，当前为本地 grounded 草稿，可直接编辑。';
      note.hidden = false;
    }
    if (agentPromptUi.loading) {
      sessionsRow.textContent = '正在读取运行中的 Agent…';
      sessionsRow.classList.add('is-empty');
    } else if (!agentPromptUi.sessions.length) {
      sessionsRow.textContent = '当前没有可验证的运行中 Agent 会话';
      sessionsRow.classList.add('is-empty');
    } else {
      agentPromptUi.sessions.forEach((item) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'agent-session-chip';
        button.dataset.provider = item.provider;
        button.title = `${item.provider} · ${item.title}`;
        button.setAttribute('role', 'radio');
        const selected = agentPromptUi.selectedSession?.sessionId === item.sessionId
          && agentPromptUi.selectedSession?.provider === item.provider;
        button.setAttribute('aria-checked', selected ? 'true' : 'false');
        button.classList.toggle('is-selected', selected);
        const dot = document.createElement('i');
        const label = document.createElement('span');
        label.textContent = item.title;
        button.append(dot, label);
        button.addEventListener('click', () => {
          agentPromptUi.selectedSession = item;
          renderStructured(container, payload);
          scheduleHitRegionRefresh();
        });
        sessionsRow.appendChild(button);
      });
    }
    close.addEventListener('click', requestDismiss);
    confirm.textContent = '确认';
    confirm.disabled = !agentPromptUi.prompt.trim() || !agentPromptUi.selectedSession;
    confirm.addEventListener('click', async () => {
      const selected = agentPromptUi.selectedSession;
      const prompt = agentPromptUi.prompt.trim();
      if (!selected || !prompt || !api || typeof api.dispatchAgentPrompt !== 'function') return;
      dispatch({ type: 'ACTION_START', command: `交给 ${selected.provider}` });
      const result = await api.dispatchAgentPrompt({
        selectionSessionToken: session.token,
        prompt,
        provider: selected.provider,
        sessionId: selected.sessionId,
      });
      if (result?.ok === true) {
        const task = result.task && typeof result.task === 'object' ? result.task : {};
        dispatch({
          type: 'RESULT',
          result: {
            kind: 'inline',
            answer: String(result.answer || `已交给 ${selected.title}，任务开始执行。`),
            status: String(result.state || 'accepted'),
            statusLabel: '已发送，正在执行',
            taskId: String(task.taskId || ''),
            provider: selected.provider,
          },
        });
      } else {
        dispatch({ type: 'ERROR', error: { message: String(result?.error || '发送到 Agent 失败。') } });
      }
    });
    container.appendChild(draft);
  }

  // Action buttons carry only opaque tokens/ids from the stage contract; the
  // renderer never sees prompts or proposal parameters.
  // Copy the answers, not the scaffolding: the ask labels are there to orient
  // the reader on screen, and the wait dots are not content at all.
  function resultPlainText(container: HTMLElement) {
    const clone = container.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('button, .turn-ask, .turn-wait').forEach((node) => node.remove());
    return (clone.textContent || '')
      .split('\n')
      .map((line) => line.trimEnd())
      .join('\n')
      .trim();
  }

  function copyResultText(container: HTMLElement, button: HTMLButtonElement) {
    const text = resultPlainText(container);
    const done = () => {
      const original = button.textContent;
      button.textContent = '已复制';
      setTimeout(() => { button.textContent = original; }, 1400);
    };
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopyText(text, done));
    } else fallbackCopyText(text, done);
  }

  function fallbackCopyText(text: string, done: () => void) {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    try { document.execCommand('copy'); done(); } catch (_) { /* clipboard unavailable */ }
    document.body.removeChild(area);
  }

  // --- 就地展开 ---------------------------------------------------------------
  //
  // 在回答里划中一段字，贴着选区冒出一个小按钮；点它，那一段被展开后的字换掉。
  //
  // 三条它必须守住的规矩：
  // 1. **不是第二轮。** 不走 submitCommand，不 dispatch，不动 state.turns。
  //    轮次计数因此不变——用户只是在第一轮的答案上做了一处修改。
  // 2. **换掉的是那一段，不是整张卡。** 记的是 Range（节点+偏移），不是「第几
  //    个字」，所以卡里有加粗、代码、图片时位置也不会错。
  // 3. **换回去的字要能看出来。** 新的那一段自己黄一下再褪掉，用户不用去比对。
  const PASSAGE_MIN_CHARS = 8;

  function hidePassageExpand() {
    if (passageExpand.hidden) return;
    passageExpand.hidden = true;
    passagePick = null;
    scheduleHitRegionRefresh();
  }

  // 选区必须整个落在一条已经出完的回答里。落在提问行上、跨了两轮、或者那一轮
  // 还在跑，都不给按钮——展开一段还在变的字没有意义。
  function passageRangeFrom(selection: Selection | null) {
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
    const range = selection.getRangeAt(0);
    if (!resultCard.contains(range.commonAncestorContainer)) return null;
    const start = range.startContainer.nodeType === 1
      ? range.startContainer
      : range.startContainer.parentElement;
    const end = range.endContainer.nodeType === 1
      ? range.endContainer
      : range.endContainer.parentElement;
    if (!start || !end) return null;
    const answer = (start as Element).closest<HTMLElement>('.turn-answer');
    if (!answer || answer !== (end as Element).closest<HTMLElement>('.turn-answer')) return null;
    if (answer.dataset.kind === 'error') return null;
    const turn = answer.closest<HTMLElement>('.thread-turn');
    if (!turn || turn.dataset.status !== 'done') return null;
    const text = range.toString().trim();
    if (text.length < PASSAGE_MIN_CHARS) return null;
    return { range: range.cloneRange(), text, answer };
  }

  function syncPassageExpand() {
    if (passageBusy) return;
    const pick = passageRangeFrom(document.getSelection());
    if (!pick) {
      hidePassageExpand();
      return;
    }
    passagePick = pick;
    passageExpand.hidden = false;
    // 贴在选区下缘的左端；下面放不下就翻到上缘。和胶囊的锚定同一套规矩：
    // 一次算好，不跟着鼠标漂。
    const rect = pick.range.getBoundingClientRect();
    const size = passageExpand.getBoundingClientRect();
    const width = size.width || 108;
    const height = size.height || 30;
    const below = rect.bottom + 6;
    const top = below + height > window.innerHeight - 4 ? rect.top - height - 6 : below;
    passageExpand.style.left = `${Math.max(4, Math.min(window.innerWidth - width - 4, rect.left))}px`;
    passageExpand.style.top = `${Math.max(4, top)}px`;
    scheduleHitRegionRefresh();
  }

  // 桥回来的是纯文本。它可能有换行，所以按行拆成 <br> 分隔的文本节点——
  // 这里一律 createTextNode：这是一块渲染模型输出的界面，转义必须是结构性的，
  // 不能靠记得转义（stage.js 因此被钉死不许出现那个赋值 HTML 字符串的属性）。
  function passageNodes(value: unknown) {
    const span = document.createElement('span');
    span.className = 'passage-fresh';
    const lines = String(value || '').split('\n');
    lines.forEach((line, index) => {
      if (index > 0) span.appendChild(document.createElement('br'));
      span.appendChild(document.createTextNode(line));
    });
    return span;
  }

  async function expandPickedPassage() {
    if (passageBusy || !passagePick) return;
    if (!api || typeof api.expandPassage !== 'function') return;
    const pick = passagePick;
    passageBusy = true;
    passageExpand.dataset.busy = 'true';
    const label = passageExpand.querySelector('span');
    const originalLabel = label ? label.textContent : '';
    if (label) label.textContent = '正在展开…';
    let reply = null;
    try {
      reply = await api.expandPassage({
        selectionSessionToken: session.token,
        passage: pick.text,
        // 整段回答只作参考，让展开出来的话接得上前后文。
        context: (pick.answer.textContent || '').trim(),
      });
    } catch (error) {
      reply = { ok: false, error: String((error as { message?: unknown } | null)?.message || error || '展开失败。') };
    }
    passageBusy = false;
    passageExpand.dataset.busy = 'false';
    if (label) label.textContent = originalLabel;
    if (!reply || reply.ok !== true || !String(reply.text || '').trim()) {
      // 说清楚哪一段没被改动，而不是静默地什么都不发生。
      // 说清楚哪一段没被改动，而不是静默地什么都不发生。走已有的那一行提示，
      // 不另开一个只有这里用得上的红字条。
      dispatch({ type: 'NOTICE', notice: { message: String(reply?.error || '这次没能展开，那一段保持原样。') } });
      setTimeout(() => {
        if (state.notice) dispatch({ type: 'NOTICE', notice: { message: '' } });
      }, 4500);
      hidePassageExpand();
      return;
    }
    // 等模型的这几秒里用户可能已经问了下一个问题，那一轮重画会把这些节点
    // 摘掉。往一堆孤儿节点里塞字是看不见的，所以先确认它还挂在树上。
    if (!resultCard.contains(pick.range.commonAncestorContainer)) {
      hidePassageExpand();
      return;
    }
    pick.range.deleteContents();
    pick.range.insertNode(passageNodes(reply.text));
    const selection = document.getSelection();
    if (selection) selection.removeAllRanges();
    hidePassageExpand();
    placeThreadSurface();
  }

  // mousedown 上就阻止默认行为，否则按钮一拿到焦点选区就塌了，
  // 等 click 到达时已经没有可展开的东西。
  passageExpand.addEventListener('mousedown', (event) => event.preventDefault());
  passageExpand.addEventListener('click', () => { void expandPickedPassage(); });
  document.addEventListener('selectionchange', syncPassageExpand);
  workPanelScroller.addEventListener('scroll', () => {
    if (!passageExpand.hidden) syncPassageExpand();
  });

  // The thread bar replaces the per-answer toolbar: with the composer always
  // live underneath, a "追问" button is redundant — you just type.
  threadCopy.addEventListener('click', () => copyResultText(resultCard, threadCopy));

  // --- 追问条 -----------------------------------------------------------------
  // 底栏那条输入不是第二个输入框：它和胶囊走同一条提交路径，只是手更近——
  // 你刚读完这段回答，光标就在这儿。
  function syncFollowupReady() {
    threadSend.dataset.ready = threadFollowup.value.trim() ? 'true' : 'false';
  }

  function submitFollowup() {
    const text = threadFollowup.value.trim();
    if (!text) return;
    threadFollowup.value = '';
    syncFollowupReady();
    submitCommand(text);
  }

  threadFollowup.addEventListener('input', syncFollowupReady);
  threadFollowup.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') submitFollowup();
    else if (event.key === 'Escape') requestDismiss();
  });
  threadSend.addEventListener('mousedown', (event) => event.preventDefault());
  threadSend.addEventListener('click', submitFollowup);

  // --- 点头的那一下 -------------------------------------------------------------
  // 只有「要送出去」的那一类才有。定稿的那段话先回到问题框里，你看着它按同意，
  // 才真的往别人的窗口里写。拒绝＝什么都不做，框留着，可以继续改。
  function syncConsent() {
    const currentTurnId = state.turns.at(-1)?.id ?? null;
    const want = answerShape.needsConsent
      && state.name === 'result'
      && !threadPanel.hidden
      && session.consentDismissedForTurn !== currentTurnId
      && Boolean(resultPlainText(resultCard));
    threadPanel.dataset.consent = want ? 'true' : 'false';
    if (!want) {
      if (!consentBox.hidden) {
        consentBox.hidden = true;
        scheduleHitRegionRefresh();
      }
      // 新的一轮重新点亮同意按钮：上一轮的写入早已结束或失败。
      resetConsentButton();
      return;
    }
    // 那段话只在框刚出现的那一下复制回去一次。之后用户改了框里的字，
    // 任何一次重画（NOTICE、模型健康、语音状态）都不能把它改回原样。
    consentTarget.textContent = session.targetAppLabel
      ? `写回 ${session.targetAppLabel}`
      : '写回你刚才那个窗口';
    if (consentBox.hidden) {
      resetConsentButton();
      const text = resultPlainText(resultCard);
      if (capsuleInput.value.trim() !== text) capsuleInput.value = text;
      consentBox.hidden = false;
      scheduleHitRegionRefresh();
    }
  }

  consentReject.addEventListener('click', () => {
    session.consentDismissedForTurn = state.turns.at(-1)?.id ?? null;
    consentBox.hidden = true;
    threadPanel.dataset.consent = 'false';
    capsuleInput.value = '';
    resetConsentButton();
    scheduleHitRegionRefresh();
  });

  // 写入是异步的（桥可能跑好几秒）。上一版用 setTimeout 1.6s 重新点亮按钮，
  // 用户在此期间再点一次就是往同一个窗口里写两遍同一段话。
  let consentBusy = false;
  function resetConsentButton() {
    consentBusy = false;
    consentApprove.disabled = false;
    consentApprove.textContent = '同意';
  }
  consentApprove.addEventListener('click', () => {
    if (consentBusy) return;
    const text = capsuleInput.value.trim() || resultPlainText(resultCard);
    if (!text || !api || typeof api.insertResultText !== 'function') return;
    consentBusy = true;
    consentApprove.disabled = true;
    consentApprove.textContent = '写入中';
    api.insertResultText({ text, selectionSessionToken: session.token });
  });
  threadClose.addEventListener('click', requestDismiss);
  // 重问一次：把上一轮问过的那句话原样再提交一遍。参考图里那张提案卡左下角
  // 那个重跑图标就是这件事——不满意的时候，最省事的动作是「再来一次」，
  // 而不是把问题重新打一遍。
  threadRetry.addEventListener('click', () => {
    const last = [...state.turns].reverse().find((turn) => turn.status !== 'pending');
    const ask = String(last?.ask || '').trim();
    if (ask) submitCommand(ask);
  });

  // Result payloads are discriminated by `kind`; anything unknown falls back
  // to the plain inline text rendering.
  // 结果按 kind 分派。
  //
  // 除了 agent-prompt-draft，全部走共享的 renderCard——舞台、随行窗、工作室
  // 因此渲染的是同一张卡，同一次问答在三个界面上长得一模一样。上一版是三份
  // 各写一遍的模板，于是它们各长各的。
  //
  // agent-prompt-draft 留在原地：它不是一张卡，是一个带会话选择器和自己那套
  // IPC 的控件。硬塞进卡片契约只会两头不讨好。
  function renderStructured(container: HTMLElement, payload: any) {
    container.replaceChildren();
    const kind = payload && typeof payload === 'object' ? payload.kind : null;
    container.dataset.kind = kind || 'inline';
    if (kind === 'agent-prompt-draft') {
      renderAgentPromptDraft(container, payload);
      return;
    }
    const card = CardModel.normalizeCard(payload && typeof payload === 'object'
      ? payload
      : { kind: 'prose', answer: String(payload || '') });
    card.runningLabel = CardModel.runningLabel(card);
    // 要送出去的那一路不解析 markdown。对面读到的是字面量的 `**` 和 `-`，
    // 所以在我们这儿就不能把它渲染成粗体和列表——渲染出来的样子会让人以为
    // 发过去也是那样。渲染层和系统提示词说的必须是同一件事。
    const shape = shapePolicy
      ? shapePolicy.answerShape({ result: payload, command: String(state.turns.at(-1)?.ask || '') })
      : { allowMarkdown: true };
    card.plainText = shape.allowMarkdown === false;
    container.dataset.shape = shape.allowMarkdown === false ? 'deliver' : 'inspect';
    container.replaceChildren(renderCard(card, { density: 'capsule' }));
    bindCardActions(container, payload);
  }

  // 卡片本身是纯 HTML，动作用一次事件委托挂上来。按钮做什么由 payload.actions
  // 决定——和原来逐个 addEventListener 时的行为一致，只是绑定点变成了一个。
  function bindCardActions(container: HTMLElement, payload: any) {
    const actions: any[] = payload && Array.isArray(payload.actions) ? payload.actions : [];
    if (!actions.length) return;
    container.addEventListener('click', (event) => {
      const button = (event.target as Element | null)?.closest<HTMLElement>('[data-act="action"]');
      if (!button || !container.contains(button)) return;
      const action = actions.find((a) => a && String(a.id || '') === button.dataset.actionId);
      if (!action) return;
      if (action.kind === 'proposal' && action.actionToken) {
        dispatch({ type: 'ACTION_START', command: String(action.label || '') });
        if (api && typeof api.executeAction === 'function') {
          api.executeAction({
            actionToken: action.actionToken,
            proposalId: action.id,
            confirmed: true,
            selectionSessionToken: session.token,
          });
        }
      } else if (action.kind === 'context' && api && typeof api.contextAction === 'function') {
        api.contextAction({ id: action.id, selectionSessionToken: session.token });
      }
    });
  }

  // 等待中的那张卡。它和最终那张是同一张——同一个 id、同一种 kind、同一套
  // 版式，只是 state 还是 running。所以结果到了不是「换一张卡」，是这张卡
  // 自己长出身子来。上一版这里是一个通用的转圈加一个秒数，那是在告诉用户
  // 「我不打算让你知道我在干什么」。
  const runningCards = new Map();   // turnId -> card

  function runningCardFor(turn: any) {
    const id = `t${turn.id}`;
    if (!runningCards.has(id)) {
      runningCards.set(id, CardModel.normalizeCard({
        id,
        kind: turn.expectKind || 'prose',
        state: 'running',
        startedAt: Date.now(),
      }, { id }));
    }
    return runningCards.get(id)!;
  }

  function paintRunningCard(container: HTMLElement, turn: any) {
    const card = runningCardFor(turn);
    card.runningLabel = CardModel.runningLabel(card);
    container.replaceChildren(renderCard(card, { density: 'capsule' }));
  }

  // 桥报上来一步，就给正在等的那张卡打一个补丁并重画。
  function patchRunningCard(patch: any) {
    const turn = [...state.turns].reverse().find((t) => t.status === 'pending');
    if (!turn) return;
    const id = `t${turn.id}`;
    const current = runningCards.get(id);
    if (!current) return;
    runningCards.set(id, CardModel.applyPatch(current, patch));
    const node = resultCard.querySelector<HTMLElement>(`.thread-turn[data-turn-id="${turn.id}"] .turn-answer`);
    if (node) paintRunningCard(node, turn);
  }

  function buildTurn(turn: any) {
    const node = tplThreadTurn.content.firstElementChild!.cloneNode(true) as HTMLElement;
    node.dataset.turnId = String(turn.id);
    node.dataset.status = turn.status;
    const ask = node.querySelector<HTMLElement>('.turn-ask')!;
    const answer = node.querySelector<HTMLElement>('.turn-answer')!;
    if (turn.ask) ask.textContent = turn.ask;
    else ask.hidden = true;
    if (turn.status === 'pending') {
      paintRunningCard(answer, turn);
    } else if (turn.status === 'failed') {
      runningCards.delete(`t${turn.id}`);
      answer.dataset.kind = 'error';
      renderFailure(answer, turn.error);
    } else {
      runningCards.delete(`t${turn.id}`);
      renderStructured(answer, turn.result);
    }
    return node;
  }

  // 秒数仍然要走——一个两分钟的卡死和一个两秒的等待，只靠步骤行是分不出来的。
  // 但它现在只是卡上的一个附注，不再是唯一的信息。
  function syncWaitClock(hasPending: boolean) {
    if (!hasPending) {
      if (waitTimer) clearInterval(waitTimer);
      waitTimer = null;
      waitStartedAt = 0;
      return;
    }
    if (!waitStartedAt) waitStartedAt = Date.now();
    const paint = () => {
      const label = resultCard.querySelector<HTMLElement>('.thread-turn[data-status="pending"] [data-elapsed]');
      if (!label) return;
      const seconds = Math.max(0, Math.round((Date.now() - waitStartedAt) / 1000));
      label.textContent = seconds >= 1 ? `${seconds}s` : '';
      label.dataset.slow = seconds >= 8 ? 'true' : 'false';
    };
    paint();
    if (waitTimer) return;
    waitTimer = setInterval(paint, 500);
  }

  // Turns are rebuilt only when one is added or settles. Skipping the no-op
  // re-render keeps the scroll position and, more importantly, does not wipe
  // the agent-prompt textarea while the user is editing it.
  function renderThread(turns: any[]) {
    const signature = turns.map((turn) => `${turn.id}:${turn.status}`).join(',');
    if (signature !== renderedTurnSignature) {
      renderedTurnSignature = signature;
      const existing = new Map();
      for (const node of resultCard.children) existing.set((node as HTMLElement).dataset.turnId, node);
      const nodes = turns.map((turn) => {
        const found = existing.get(String(turn.id));
        return found && found.dataset.status === turn.status ? found : buildTurn(turn);
      });
      resultCard.replaceChildren(...nodes);
      const newest = nodes[nodes.length - 1];
      if (newest) newest.scrollIntoView({ block: 'end' });
    }
    threadCount.textContent = turns.length > 1 ? `${turns.length} 轮` : '';
    threadCount.hidden = turns.length <= 1;
    const pending = turns.some((turn) => turn.status === 'pending');
    threadPanel.dataset.turnCount = String(turns.length);
    syncWaitClock(pending);
    // 眉毛行写的是你问的那句话。参考里那张卡的标题就是这次任务本身
    // （"DietControl landing page update"），不是一个产品名。
    //
    // 写上去之后第一轮那行 .turn-ask 就得收起来——同一句话在一张卡上出现两次，
    // 第二次不提供任何信息，只是把卡撑高。第二轮起照常显示：那时候标题说的是
    // 整场对话，行内那句说的是这一轮。
    const firstAsk = String(turns[0]?.ask || '').trim();
    threadTitle.textContent = firstAsk || '选中的内容';
    threadTitle.title = firstAsk;
    // 眉毛照抄参考里那行 `▽ TASK FINISHED`：它说的是这张卡此刻的状态，
    // 用等宽 + 拉开的字距，因为在这套版式里等宽始终代表「机器说的事实」。
    const failed = turns[turns.length - 1]?.status === 'failed';
    const awaiting = turns[turns.length - 1]?.status === 'awaiting';
    const eyebrowState = pending || awaiting ? 'running' : failed ? 'failed' : 'done';
    threadPanel.dataset.phase = pending ? 'running' : awaiting ? 'awaiting' : failed ? 'failed' : 'finished';
    threadClose.setAttribute('aria-label', pending ? '停止' : '关闭');
    threadClose.title = pending ? '停止' : '关闭';
    threadEyebrow.dataset.state = eyebrowState;
    threadEyebrow.querySelector('use')?.setAttribute(
      'href',
      pending ? '#ic-circle' : awaiting ? '#ic-circle' : failed ? '#ic-warn' : '#ic-check',
    );
    threadEyebrowText.textContent = pending
      ? 'WORKING'
      : awaiting
        ? 'YOUR INPUT NEEDED'
        : failed
          ? 'NEEDS ATTENTION'
          : 'TASK FINISHED';
    const firstAskRow = resultCard.firstElementChild?.querySelector<HTMLElement>('.turn-ask');
    if (firstAskRow) firstAskRow.hidden = Boolean(firstAsk);
    // 还在跑的时候没有可复制的东西。一个点了没反应的按钮比一个明显不能点的
    // 按钮更让人以为是坏了。
    const settled = !pending && turns.some((turn) => turn.status === 'done');
    threadCopy.disabled = !settled;
    // 追问框绑当前这张卡在讲什么，用户因此不用交代背景（Vida.md §3 第 5 条）。
    threadFollowup.placeholder = firstAsk
      ? `继续问关于「${firstAsk.slice(0, 12)}${firstAsk.length > 12 ? '…' : ''}」的`
      : '继续问点什么…';
    // 这一轮定下来之后，形态才算数：桥可能在结果里明说，也可能要靠命令猜。
    const newest = turns[turns.length - 1];
    if (shapePolicy && settled) {
      answerShape = shapePolicy.answerShape({
        result: newest?.result,
        command: String(newest?.ask || firstAsk || ''),
      });
    }
    threadPanel.dataset.shape = answerShape.shape;
    syncConsent();
    // 卡重画过，之前记住的那段选区已经指向摘掉的节点了。
    hidePassageExpand();
  }

  function clearChips() {
    renderedChipIds = '';
    chipsBox.replaceChildren();
    chipsBox.hidden = true;
  }

  function buildChip(chip: any) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'stage-chip';
    button.textContent = String(chip.label || chip.id);
    button.addEventListener('click', () => {
      // Clarification chips carry the option text on chip.command and submit
      // that string as a follow-up. Idle canned chips still map id → command
      // through StageChipsPolicy; a clarification option named "rewrite"
      // must not become "改写这段文字".
      const direct = String(chip.command || '').trim();
      if (direct) {
        submitCommand(direct);
        return;
      }
      const policy = globalThis.StageChipsPolicy;
      const command = policy && typeof policy.commandForChip === 'function'
        ? policy.commandForChip(chip.id)
        : null;
      if (command) submitCommand(command);
    });
    return button;
  }

  // Idle canned chips: click-selected object + idle capsule only.
  // Clarification chips: newest turn is awaiting with ≥2 pendingInput options.
  // Awaiting wins — the two sets never show together. Defensive: missing
  // helper → no chips of that kind.
  function renderChips(idleAllowed: boolean) {
    const newest = state.turns[state.turns.length - 1];
    const awaiting = newest?.status === 'awaiting';
    const clarify = globalThis.ClarificationChips;
    let chips: any[] = [];
    if (clarify && typeof clarify.clarificationChips === 'function') {
      chips = clarify.clarificationChips(newest).slice(0, 4);
    }
    const policy = globalThis.StageChipsPolicy;
    if (!chips.length && !awaiting && idleAllowed && policy
      && typeof policy.shouldShowChips === 'function'
      && typeof policy.deriveChips === 'function'
      && policy.shouldShowChips({
        selectionSource: meta.selectionSource,
        inputMode: state.inputMode,
        capsuleText: state.transcript || capsuleInput.value,
      })) {
      chips = policy.deriveChips({ objectKind: meta.objectKind }).slice(0, 3);
    }
    if (!chips.length) {
      clearChips();
      return;
    }
    const ids = chips.map((chip) => chip.id).join('|');
    if (ids !== renderedChipIds) {
      renderedChipIds = ids;
      chipsBox.replaceChildren(...chips.map(buildChip));
    }
    chipsBox.hidden = false;
    const anchorEl = awaiting && !threadPanel.hidden ? threadPanel : capsule;
    const anchor = anchorEl.getBoundingClientRect();
    chipsBox.style.left = `${anchor.left}px`;
    chipsBox.style.top = `${anchor.bottom + 8}px`;
  }

  function resetDeliveryBox() {
    deliveryBox.hidden = true;
    deliveryLabel.textContent = '';
    deliveryCount.textContent = '';
    deliveryBar.style.width = '0%';
  }

  // Delivery progress mirrors REAL UIA draft-write events only: the bar moves
  // exclusively when a genuine deliveryProgress payload arrives. No events ->
  // this stays hidden and the shimmer alone communicates "working"
  // (design §2.2: no fake foreign-app animation).
  function renderDelivery(name: string) {
    const progress = state.deliveryProgress;
    const anchorEl = name === 'processing' ? threadPanel : name === 'result' ? threadPanel : null;
    if (!progress || !anchorEl || anchorEl.hidden) {
      resetDeliveryBox();
      return;
    }
    deliveryLabel.textContent = progress.label || '正在写入草稿';
    deliveryCount.textContent = `${progress.step}/${progress.totalSteps}`;
    const percent = Math.round((progress.step / progress.totalSteps) * 100);
    deliveryBar.style.width = `${Math.min(100, Math.max(0, percent))}%`;
    deliveryBox.hidden = false;
    const anchor = anchorEl.getBoundingClientRect();
    deliveryBox.style.left = `${anchor.left}px`;
    deliveryBox.style.top = `${anchor.bottom + 8}px`;
  }

  function clearAll() {
    clearTranscript();
    clearChips();
    resetDeliveryBox();
    hidePassageExpand();
    resultCard.replaceChildren();
    errorCard.replaceChildren();
    capsuleInput.value = '';
    meta.selectionSource = null;
    meta.objectKind = null;
    agentPromptUi.key = '';
    agentPromptUi.prompt = '';
    agentPromptUi.sessions = [];
    agentPromptUi.selectedSession = null;
    agentPromptUi.loading = false;
    if (hitRegionRefreshTimer) clearTimeout(hitRegionRefreshTimer);
    hitRegionRefreshTimer = null;
    if (targetSweepTimer) clearTimeout(targetSweepTimer);
    targetSweepTimer = null;
    targetingOutline.classList.remove('is-visible');
    capsule.classList.remove('is-entering', 'is-exiting');
    [targetingOutline, frozenGlow, capsule, shimmer, threadPanel, errorCard,
      chipsBox, consentBox, deliveryBox, passageExpand].forEach((el) => {
      el.hidden = true;
    });
    resultCard.replaceChildren();
    renderedTurnSignature = '';
    syncWaitClock(false);
  }

  function render() {
    const name = state.name;
    stageRoot.dataset.state = name;
    stageRoot.dataset.selectionVisual = session.selectionVisual;
    renderSelectionStretch();
    stageRoot.dataset.targetGeometryKind = session.targetGeometryKind;
    capsule.dataset.voiceState = session.voiceState;

    if (name === 'hidden') {
      // Empty state renders nothing: zero dynamic DOM content while hidden.
      clearAll();
      stageRoot.hidden = true;
      if (api && hasShown && typeof api.hidden === 'function') api.hidden();
      hasShown = false;
      return;
    }

    stageRoot.hidden = false;
    hasShown = true;

    const showTargeting = name === 'targeting';
    if (showTargeting && state.target) {
      placeRect(targetingOutline, targetFeedbackRect(state.target));
      requestAnimationFrame(() => targetingOutline.classList.add('is-visible'));
    } else {
      targetingOutline.classList.remove('is-visible');
      targetingOutline.hidden = true;
    }

    const showGlow = name === 'frozen' || name === 'capsule-voice'
      || name === 'capsule-text' || name === 'processing';
    const sweepCanRender = session.selectionVisual !== 'sweep_band' || !targetSweepComplete;
    if (showGlow && sweepCanRender && state.target) {
      const sweepWasHidden = frozenGlow.hidden;
      placeRect(frozenGlow, targetFeedbackRect(state.target));
      if (
        sweepWasHidden
        && !frozenGlow.hidden
        && session.selectionVisual === 'sweep_band'
        && !targetSweepTimer
      ) {
        // animationend can be skipped when a transparent window is hidden or
        // moved between displays. The timer is a deterministic cleanup guard.
        targetSweepTimer = setTimeout(() => {
          targetSweepTimer = null;
          targetSweepComplete = true;
          frozenGlow.hidden = true;
          syncHitRegions();
        }, session.visualTuning.sweepDurationMs + 34);
      }
    } else frozenGlow.hidden = true;

    const resultOwnsComposer = (name === 'result' || name === 'error')
      && state.turns.length > 0;
    const capsuleOpen = name === 'capsule-voice' || name === 'capsule-text'
      || ((name === 'result' || name === 'error') && !resultOwnsComposer)
      || (name === 'dismissing' && !capsule.hidden);
    // Once submitted, the question belongs to the fixed work panel. Clear the
    // input transcript even though that separate entry surface is now hidden.
    if ((name === 'processing' || name === 'result' || name === 'error') && state.transcript) {
      state = { ...state, transcript: '' };
    }
    if (capsuleOpen) {
      renderStrokeRefs();
      // The bare "2 处" badge is redundant once each stroke has its own chip:
      // the chips say how many, and which.
      const showCount = session.selectionCount > 1 && strokeRefs.length === 0;
      if (showCount) {
        capsuleCount.textContent = `${session.selectionCount} 处`;
        capsuleCount.hidden = false;
      } else {
        capsuleCount.hidden = true;
      }
      const capsuleWasHidden = capsule.hidden;
      const capsuleHadFocus = document.activeElement === capsuleInput;
      if (name === 'dismissing') {
        capsule.classList.remove('is-entering');
        capsule.classList.add('is-exiting');
      } else if (capsuleWasHidden) {
        capsule.classList.remove('is-exiting');
        capsule.classList.add('is-entering');
      }
      // An unsolicited result (no capsule was ever opened) still gets a
      // typeable composer, so a follow-up costs one keystroke rather than a
      // hunt for the right button.
      const composerMode = state.inputMode
        || (name === 'result' || name === 'error' ? 'text' : 'voice');
      capsule.dataset.mode = composerMode === 'text' ? 'text' : 'voice';
      capsule.dataset.phase = 'input';
      capsuleInput.placeholder = composerMode === 'text' ? '问点什么…' : '';
      // Once submitted, the question lives in the thread. Emptying the field
      // here is what makes the composer feel like a composer instead of a box
      // still holding the thing you already sent.
      if (name === 'result' || name === 'error') capsuleInput.value = '';
      renderTranscript();
      const capsuleWidth = syncCapsuleWidth();
      anchorCapsuleToTarget(capsuleWidth);
      // Coordinates are committed before the element becomes paintable, so a
      // new session can never expose the browser's default (0,0) position.
      if (capsuleWasHidden) capsule.hidden = false;
      scheduleHitRegionRefresh();
      // Focus follows the user, never the machine: it is taken when they open
      // the composer, and kept if they were already typing when a turn landed.
      if (name === 'capsule-text') capsuleInput.focus();
      else if (capsuleHadFocus && composerMode === 'text' && !capsuleInput.disabled) capsuleInput.focus();
    } else {
      capsule.hidden = true;
      clearTranscript();
      capsuleInput.value = '';
    }
    shimmer.hidden = name !== 'processing';

    // The thread is driven by `turns`, not by the latest result, so a question
    // and its answer stay on screen once a follow-up is under way.
    if (state.turns.length && name !== 'hidden') {
      renderThread(state.turns);
      threadPanel.hidden = false;
      placeThreadSurface();
    } else {
      threadPanel.hidden = true;
      renderedTurnSignature = '';
      resultCard.replaceChildren();
      syncWaitClock(false);
    }
    // Idle canned chips only while the capsule is open. Clarification chips
    // still render when the newest turn is awaiting (closeTurn → `result`).
    renderChips(name === 'capsule-voice' || name === 'capsule-text');

    // Errors that belong to a turn already render inside the thread. The
    // standalone card is only for failures with no thread to attach to.
    if (name === 'error' && !state.turns.length) {
      errorCard.replaceChildren();
      renderFailure(errorCard, state.error);
      anchorNearPointer(errorCard, 300, 44);
      errorCard.hidden = false;
    } else {
      errorCard.hidden = true;
    }

    // After the result/error surfaces have been placed, so the progress row
    // can anchor below whichever surface is live.
    renderDelivery(name);
    renderModelNotice(name);

    if (name === 'dismissing') {
      if (dismissTimer) clearTimeout(dismissTimer);
      const fadeMs = state.config.reducedMotion ? 0 : DISMISS_FADE_MS;
      dismissTimer = setTimeout(() => {
        dismissTimer = null;
        dispatch({ type: 'HIDDEN' });
      }, fadeMs);
    }
  }

  // One notice line, two sources. A transient status from the main process
  // ("正在读取选中的内容…") wins over the standing gateway warning: it is about
  // what is happening right now, and it clears itself when the outcome lands.
  function renderModelNotice(name: string) {
    if (!noticeBox) return;
    const transient = String(state.notice?.message || '');
    const composerOpen = name === 'capsule-text' || name === 'capsule-voice' || name === 'processing';
    const gatewayWarning = modelHealth.circuitOpen === true && Boolean(modelHealth.message) && composerOpen
      ? modelHealth.message
      : '';
    const message = transient || gatewayWarning;
    if (!message) {
      noticeBox.hidden = true;
      return;
    }
    noticeText.textContent = message;
    noticeBox.dataset.kind = transient ? 'progress' : 'warning';
    noticeBox.hidden = false;
    noticeBox.hidden = false;
    const anchorSurface = name === 'processing' && !threadPanel.hidden ? threadPanel : capsule;
    const rect = anchorSurface.getBoundingClientRect();
    const top = Math.min(window.innerHeight - 40, rect.bottom + 8);
    const left = Math.max(6, Math.min(window.innerWidth - noticeBox.offsetWidth - 6, rect.left));
    noticeBox.style.left = `${left}px`;
    noticeBox.style.top = `${top}px`;
  }

  capsuleInput.addEventListener('input', () => {
    dispatch({ type: 'TRANSCRIPT', transcript: capsuleInput.value });
  });
  capsule.addEventListener('transitionend', syncHitRegions);
  capsule.addEventListener('animationend', (event) => {
    if (event.animationName === 'stage-surface-appear') capsule.classList.remove('is-entering');
    syncHitRegions();
  });
  frozenGlow.addEventListener('animationend', (event) => {
    if (event.animationName !== 'selection-sweep-fade') return;
    if (targetSweepTimer) clearTimeout(targetSweepTimer);
    targetSweepTimer = null;
    targetSweepComplete = true;
    frozenGlow.hidden = true;
    syncHitRegions();
  });

  capsuleInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && capsuleInput.value.trim()) {
      submitCommand(capsuleInput.value);
    } else if (event.key === 'Escape') {
      requestDismiss();
    }
  });

  // 提交键。跑起来之后同一个按钮是「停」——按下去等于放弃这一轮，界面立刻
  // 回到可以再问的状态，而不是让用户对着一个转不停的圈干等。
  capsuleSend.addEventListener('mousedown', (event) => event.preventDefault());
  capsuleSend.addEventListener('click', () => {
    if (state.name === 'processing') {
      requestDismiss();
      return;
    }
    const text = capsuleInput.value.trim() || String(state.transcript || '').trim();
    if (text) submitCommand(text);
  });

  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') requestDismiss();
  });
  window.addEventListener('mousemove', (event) => {
    lastPointerPoint = { x: event.clientX, y: event.clientY };
    syncHitRegions();
    if (state.name === 'capsule-voice') {
      handleVoicePointerInput({
        t: performance.now(),
        x: event.clientX,
        y: event.clientY,
        buttons: event.buttons,
      });
    }
  });
  window.addEventListener('mouseleave', () => {
    lastPointerPoint = null;
    syncHitRegions();
  });

  function applyMeta(payload: any) {
    if (!payload || typeof payload !== 'object') return false;
    let changed = false;
    if ('selectionSource' in payload && meta.selectionSource !== payload.selectionSource) {
      meta.selectionSource = payload.selectionSource;
      changed = true;
    }
    if ('objectKind' in payload && meta.objectKind !== payload.objectKind) {
      meta.objectKind = payload.objectKind;
      changed = true;
    }
    return changed;
  }

  function applySession(payload: any) {
    if (!payload || typeof payload !== 'object') return;
    if ('selectionSessionToken' in payload) {
      session.token = payload.selectionSessionToken ? String(payload.selectionSessionToken) : null;
    }
    if ('voiceAutoSubmit' in payload) {
      session.voiceAutoSubmit = payload.voiceAutoSubmit !== false;
    }
    if ('voiceStartStrategy' in payload) {
      const strategy = String(payload.voiceStartStrategy || 'auto');
      session.voiceStartStrategy = ['auto', 'push_to_talk', 'hover'].includes(strategy)
        ? strategy
        : 'auto';
    }
    if ('groundingReady' in payload) {
      session.groundingReady = payload.groundingReady === true;
    }
    if ('selectionChars' in payload) {
      const chars = Number(payload.selectionChars);
      session.selectionChars = Number.isFinite(chars) && chars > 0 ? Math.round(chars) : 0;
    }
    // 目标窗口在舞台坐标系里的那一块，以及一个显示用的名字。「要送出去」的
    // 回答框贴在它右侧外沿，「同意」那一行也用这个名字说清写到哪儿去。
    if ('targetWindowRect' in payload) {
      const rect = payload.targetWindowRect;
      session.targetWindowRect = rect && Number.isFinite(Number(rect.width)) && Number(rect.width) > 0
        ? {
          x: Number(rect.x) || 0,
          y: Number(rect.y) || 0,
          width: Number(rect.width) || 0,
          height: Number(rect.height) || 0,
        }
        : null;
    }
    if ('targetAppLabel' in payload) {
      session.targetAppLabel = String(payload.targetAppLabel || '').slice(0, 60);
    }
    if ('selectionVisual' in payload) {
      const visual = String(payload.selectionVisual || 'sweep_band');
      session.selectionVisual = ['sweep_band', 'soft_glow', 'outline'].includes(visual)
        ? visual
        : 'sweep_band';
    }
    if ('targetGeometryKind' in payload) {
      const previousKind = session.targetGeometryKind;
      const kind = String(payload.targetGeometryKind || 'invalid');
      session.targetGeometryKind = ['resolved', 'pointer_only', 'invalid'].includes(kind)
        ? kind
        : 'invalid';
      if (session.targetGeometryKind === 'resolved' && previousKind !== 'resolved') {
        targetSweepComplete = false;
      }
    }
    if ('capsuleAnchor' in payload) {
      session.capsuleAnchor = payload.capsuleAnchor === 'pointer' ? 'pointer' : 'target';
    }
    if ('selectionCount' in payload) {
      const count = Number(payload.selectionCount);
      session.selectionCount = Number.isFinite(count) ? Math.max(1, Math.min(8, Math.round(count))) : 1;
      // Multi-stroke gestures become one chip per stroke. Rebuilt only when the
      // count actually changes, so a re-render never resurrects a chip the user
      // just removed.
      if (session.selectionCount !== strokeRefs.length && session.selectionCount > 1) {
        strokeRefs = Array.from({ length: session.selectionCount }, (_unused, index) => ({
          strokeIndex: index,
          label: '',
        }));
        renderedRefSignature = '';
      } else if (session.selectionCount <= 1 && strokeRefs.length) {
        strokeRefs = [];
        renderedRefSignature = '';
      }
    }
    if ('capsuleDelayMs' in payload) {
      const delay = Number(payload.capsuleDelayMs);
      session.capsuleDelayMs = Number.isFinite(delay) ? Math.max(0, Math.min(1500, delay)) : null;
    }
    if (payload.pointer && Number.isFinite(Number(payload.pointer.x)) && Number.isFinite(Number(payload.pointer.y))) {
      session.pointer = { x: Number(payload.pointer.x), y: Number(payload.pointer.y) };
    }
    if (typeof payload.accentRgb === 'string') {
      // Validated in the main process; the renderer only checks the shape so a
      // malformed value cannot inject arbitrary CSS.
      session.accentRgb = /^\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*$/.test(payload.accentRgb)
        ? payload.accentRgb.trim()
        : '';
    }
    if (payload.visualTuning && typeof payload.visualTuning === 'object') {
      for (const [name, fallback] of Object.entries(DEFAULT_VISUAL_TUNING)) {
        const value = Number(payload.visualTuning[name]);
        session.visualTuning[name as keyof typeof DEFAULT_VISUAL_TUNING] = Number.isFinite(value) ? value : fallback;
      }
    }
    applyVisualTuning();
  }

  if (api) {
    api.onShow((payload) => {
      if (!payload) return;
      state = initialState({ reducedMotion: reducedMotionQuery.matches });
      renderedTranscript = '';
      reportedState = '';
      session.token = null;
      session.groundingReady = false;
      session.voiceAutoSubmit = true;
      session.voiceStartStrategy = 'auto';
      session.selectionVisual = 'sweep_band';
      session.targetGeometryKind = 'pointer_only';
      session.submitOnFinal = false;
      session.pendingFinalTranscript = '';
      session.pointer = null;
      session.capsuleAnchor = 'target';
      session.capsuleDelayMs = null;
      session.capsulePlacement = null;
      session.capsulePlaced = false;
      session.capsuleDragged = false;
      session.panelPlacement = null;
      session.resultPlacement = null;
      session.resultDragged = false;
      session.consentDismissedForTurn = null;
      session.selectionCount = 1;
      session.voiceState = 'idle';
      session.visualTuning = { ...DEFAULT_VISUAL_TUNING };
      lastPointerPoint = null;
      if (targetSweepTimer) clearTimeout(targetSweepTimer);
      targetSweepTimer = null;
      targetSweepComplete = false;
      resetVoiceTrigger();
      clearCaptureProof();
      clearScreenPoints();
      pickedElement = null;
      pickTargetShown = null;
      meta.selectionSource = null;
      meta.objectKind = null;
      applySession(payload);
      applyMeta(payload);
      dispatch({ type: 'WAKE', target: payload?.target || null });
      const events = Array.isArray(payload?.eventSequence) ? payload.eventSequence : [payload?.event];
      for (const event of events) if (event) dispatch(event);
    });
    api.onUpdate((payload) => {
      const previousGroundingReady = session.groundingReady;
      applySession(payload);
      const groundingChanged = previousGroundingReady !== session.groundingReady;
      const metaChanged = applyMeta(payload);
      if (payload?.deliveryProgress) {
        // Only legal in processing/result; the machine drops it elsewhere.
        dispatch({ type: 'DELIVERY_PROGRESS', progress: payload.deliveryProgress });
      }
      const events = Array.isArray(payload?.eventSequence) ? payload.eventSequence : [payload?.event];
      for (const event of events) if (event) dispatch(event);
      if ((metaChanged || groundingChanged) && state.name !== 'hidden') {
        render();
        syncEffects();
      }
    });
    api.onHide(() => {
      clearCaptureProof();
      clearScreenPoints();
      if (state.name === 'hidden') return;
      dispatch({ type: 'DISMISS' });
    });
    // 阶段补丁不走状态机：它不改变舞台处在哪个状态，只是给正在等的那张卡
    // 添一行。过状态机会引起整轮重建，把用户正在读的东西闪掉。
    if (typeof api.onCardPatch === 'function') {
      api.onCardPatch((payload) => {
        if (!payload || state.name === 'hidden') return;
        if (payload.selectionSessionToken && payload.selectionSessionToken !== session.token) return;
        patchRunningCard(payload.patch || {});
      });
    }
    api.onDictationResult((payload) => {
      if (!payload || state.name === 'hidden' || state.name === 'dismissing') return;
      if (payload.ok === false) {
        dispatch({ type: 'ERROR', error: { message: String(payload.error || '本地语音识别失败。') } });
        return;
      }
      const statusState = voiceStateForStatus(payload.status);
      if (statusState) {
        session.voiceState = statusState;
        render();
      }
      const transcript = typeof payload.transcript === 'string' ? payload.transcript : '';
      if (!transcript) return;
      session.voiceState = payload.final === true ? 'settling' : 'transcribing';
      dispatch({ type: 'TRANSCRIPT', transcript });
      if (payload.final === true) {
        dictationActive = false;
        if (session.voiceStartStrategy === 'push_to_talk' && !session.submitOnFinal) {
          session.pendingFinalTranscript = transcript;
        } else if (session.voiceAutoSubmit || session.submitOnFinal) {
          submitCommand(transcript);
        } else {
          // No auto-submit: hand the transcript to the text capsule for review.
          dispatch({ type: 'OPEN_CAPSULE', mode: 'text' });
          capsuleInput.value = transcript;
          syncCapsuleWidth();
        }
      }
    });
    if (typeof api.onPointerInput === 'function') {
      api.onPointerInput((payload) => handleVoicePointerInput(payload));
    }
    if (typeof api.onModelHealth === 'function') {
      api.onModelHealth((payload) => {
        modelHealth = {
          circuitOpen: payload?.circuitOpen === true,
          message: String(payload?.message || ''),
          state: String(payload?.state || 'unknown'),
        };
        render();
      });
    }
    if (typeof api.ready === 'function') api.ready();
  }

  render();
})();
