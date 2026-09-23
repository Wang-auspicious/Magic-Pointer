(() => {
  const machine = globalThis.StageState;
  const anchor = globalThis.StageAnchor;
  const surfacePolicy = globalThis.StageSurfacePolicy;
  const hitPolicy = globalThis.MagicPointerStageHitPolicy;
  if (!machine || !anchor || !surfacePolicy || !hitPolicy) return;
  const { initialState, transition } = machine;
  const api = window.magicPointerStage;

  const stageRoot = document.getElementById('stage') as HTMLElement;
  const targetingOutline = document.getElementById('targeting-outline') as HTMLElement;
  const captureProofLayer = document.getElementById('capture-proof') as HTMLElement;
  const screenPointLayer = document.getElementById('screen-points') as HTMLElement;
  const selectionStretch = document.getElementById('selection-stretch') as HTMLElement;
  const selectionStretchHint = document.getElementById('selection-stretch-hint') as HTMLElement;
  let selectionStretchDrag: {
    edge: string | undefined; startY: number; currentLines: number; currentChars: number; intent: any;
  } | null = null;
  const frozenGlow = document.getElementById('frozen-glow') as HTMLElement;
  const capsule = document.getElementById('capsule') as HTMLElement;
  const capsuleCount = document.getElementById('capsule-count') as HTMLElement;
  const capsuleRefs = document.getElementById('capsule-refs') as HTMLElement;
  let strokeRefs: { strokeIndex: number; label: string; referenceId: string | null }[] = [];
  let referenceBindings = new Map<string, any>();
  let taskInputSequence = 0;
  let renderedRefSignature = '';
  const capsuleInput = document.getElementById('capsule-input') as HTMLInputElement;
  const capsuleSend = document.getElementById('capsule-send') as HTMLButtonElement;
  const transcriptBox = document.getElementById('transcript') as HTMLElement;
  const shimmer = document.getElementById('processing-shimmer') as HTMLElement;
  const resultCard = document.getElementById('stage-result') as HTMLElement;
  const stageDecision = document.getElementById('stage-decision') as HTMLElement;
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
  const threadStop = document.getElementById('thread-stop') as HTMLButtonElement;
  const consentBox = document.getElementById('capsule-consent') as HTMLElement;
  const consentTarget = document.getElementById('consent-target') as HTMLElement;
  const consentReject = document.getElementById('consent-reject') as HTMLButtonElement;
  const consentApprove = document.getElementById('consent-approve') as HTMLButtonElement;
  const shapePolicy = globalThis.AnswerShapePolicy || null;
  let answerShape: { shape: string; allowMarkdown: boolean; needsConsent: boolean; reason: string } = { shape: 'inspect', allowMarkdown: true, needsConsent: false, reason: 'init' };
  const passageExpand = document.getElementById('passage-expand') as HTMLElement;
  let passagePick: { range: Range; text: string; answer: HTMLElement } | null = null;
  let passageBusy = false;
  const errorCard = document.getElementById('stage-error') as HTMLElement;
  const chipsBox = document.getElementById('stage-chips') as HTMLElement;
  const stretchPolicy = globalThis.StageStretchPolicy || null;
  let pickTargetShown: { rect: any; label: string } | null = null;
  let pickedElement: { rect: any; label: string; source: string } | null = null;
  let pickInFlight = false;
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
  const meta: { selectionSource: string | null; objectKind: string | null } = { selectionSource: null, objectKind: null };
  let renderedChipIds = '';
  let renderedTurnSignature = '';
  const session: {
    token: string | null;
    taskId: string | null;
    selectionSnapshotId: string | null;
    groundingReady: boolean;
    selectionVisual: string;
    targetGeometryKind: string;
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
    selectionChars: number;
    targetWindowRect: { x: number; y: number; width: number; height: number } | null;
    targetAppLabel: string;
    accentRgb: string;
    visualTuning: Record<keyof typeof DEFAULT_VISUAL_TUNING, number>;
  } = {
    token: null,
    taskId: null,
    selectionSnapshotId: null,
    groundingReady: false,
    selectionVisual: 'sweep_band',
    targetGeometryKind: 'pointer_only',
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
    selectionChars: 0,
    targetWindowRect: null,
    targetAppLabel: '',
    accentRgb: '',
    visualTuning: { ...DEFAULT_VISUAL_TUNING },
  };
  let mouseCaptureOn = false;
  let keyboardFocusRequested = false;
  let hitRegionKey = '';
  let hitRegionRefreshTimer: ReturnType<typeof setTimeout> | null = null;
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
  let lastPointerPoint: { x: number; y: number } | null = null;
  let capsuleDrag: { startX: number; startY: number; originLeft: number; originTop: number } | null = null;  
  let surfaceDrag: { element: HTMLElement; startX: number; startY: number; originLeft: number; originTop: number } | null = null;  
  let reportedState = '';
  let targetSweepComplete = false;
  let targetSweepTimer: ReturnType<typeof setTimeout> | null = null;

  reducedMotionQuery.addEventListener('change', (event) => {
    dispatch({ type: 'SET_REDUCED_MOTION', value: event.matches });
  });

  function dispatch(event: any) {
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

  function renderCaptureProof(bands: any) {
    if (!captureProofLayer) return;
    captureProofLayer.replaceChildren();
    const policy = globalThis.CaptureProofPolicy;
    const list = Array.isArray(bands) ? bands : [];
    if (!policy || list.length === 0) {
      captureProofLayer.hidden = true;
      return;
    }
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

  function renderScreenPoints(points: any) {
    if (!screenPointLayer) return;
    screenPointLayer.replaceChildren();
    const list = Array.isArray(points) ? points : [];
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

  function renderSelectionStretch() {
    if (!selectionStretch) return;
    const rect = state.target;
    const composerOpen = state.name === 'capsule-text';
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

  function resetPointerState() {
    previousPointerButtons = 0;
    capsuleDrag = null;
    surfaceDrag = null;
  }

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
      if (pickPolicy && pickPolicy.isSameTarget(pickTargetShown, picked)) return;
      pickTargetShown = picked;
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

  function showPickHighlight(picked: any) {
    const rect = picked.rect;
    placeRect(frozenGlow, {
      x: rect.x - stageOriginX,
      y: rect.y - stageOriginY,
      width: rect.width,
      height: rect.height,
    });
    frozenGlow.hidden = false;
    frozenGlow.classList.remove('is-picked');
    void frozenGlow.offsetWidth;
    frozenGlow.classList.add('is-picked');
  }

  function renderStrokeRefs() {
    if (!capsuleRefs) return;
    const stream = globalThis.StageTurnStream;
    const pickSignature = pickedElement ? `pick:${pickedElement.label}:${pickedElement.rect?.x},${pickedElement.rect?.y}` : '';
    const signature = [...strokeRefs.map((ref) => `${ref.strokeIndex}:${ref.referenceId || ''}:${ref.label}`), pickSignature].join('|');
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
    strokeRefs.forEach((ref) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'capsule-ref';
      chip.dataset.noDrag = '1';
      chip.setAttribute('role', 'listitem');
      const mark = stream?.referenceMark?.(ref.strokeIndex) || String(ref.strokeIndex + 1);
      chip.textContent = ref.label ? `${mark} ${ref.label}` : mark;
      chip.title = '点击移除这一处';
      chip.setAttribute('aria-label', `移除第 ${ref.strokeIndex + 1} 处选中`);
      chip.addEventListener('click', () => {
        const removeLocally = () => {
          strokeRefs = stream?.removeStrokeReference?.(strokeRefs, ref.strokeIndex)
            || strokeRefs.filter((item) => item !== ref);
          renderStrokeRefs();
          syncHitRegions();
        };
        const binding = ref.referenceId ? referenceBindings.get(ref.referenceId) : null;
        if (state.name === 'processing' && binding) {
          chip.disabled = true;
          steerSelectionCommand('', [{
            operation: 'remove',
            binding: { ...binding, active: false },
          }], [binding.sourceId], removeLocally);
        } else {
          removeLocally();
        }
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

  function handlePointerInput(payload: any) {
    const t = Number(payload?.t);
    const x = Number(payload?.x);
    const y = Number(payload?.y);
    const buttons = Number(payload?.buttons || 0);
    if (![t, x, y, buttons].every(Number.isFinite)) return;
    lastPointerPoint = { x, y };
    if (Number.isFinite(payload?.stageOriginX) && Number.isFinite(payload?.stageOriginY)) {
      stageOriginX = Number(payload.stageOriginX);
      stageOriginY = Number(payload.stageOriginY);
    } else if (Number.isFinite(payload?.screenX) && Number.isFinite(payload?.screenY)) {
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
    const overOwnSurface = isInsideStageSurface(x, y, chipsBox)
      || isInsideStageSurface(x, y, selectionStretch)
      || isInsideStageSurface(x, y, errorCard)
      || isInsideStageSurface(x, y, consentBox)
      || isInsideStageSurface(x, y, deliveryBox)
      || isInsideStageSurface(x, y, noticeBox)
      || isInsideStageSurface(x, y, passageExpand);
    if (primaryDown && !previousPrimaryDown && !overCapsule && !overResult && !overOwnSurface && !surfaceDrag) {
      const composerOpen = state.name === 'capsule-text';
      if (composerOpen && Number.isFinite(payload?.screenX) && Number.isFinite(payload?.screenY)) {
        pickElementAt(Number(payload.screenX), Number(payload.screenY));
      }
    }
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
      syncHitRegions();
    }
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

  }

  function hasInteractiveStageSurface() {
    const name = state.name;
    if (name === 'hidden' || name === 'dismissing') return false;
    if (name === 'capsule-text') return !capsule.hidden && !capsuleInput.disabled;
    if (!capsule.hidden || !threadPanel.hidden) return true;
    const hasEnabledButton = (element: HTMLElement) => !element.hidden
      && Boolean(element.querySelector('button:not([disabled])'));
    return hasEnabledButton(chipsBox)
      || hasEnabledButton(errorCard);
  }

  function visibleStageRegions() {
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
    const hasInteractiveSurface = hasInteractiveStageSurface();
    const interactiveRegions = interactiveStageRegions();
    const wantCapture = hitPolicy.shouldCaptureMouse({
      hasInteractiveSurface,
      pointer: lastPointerPoint,
      interactiveRegions,
      dragging: Boolean(capsuleDrag || surfaceDrag),
    });
    const requestFocus = name === 'capsule-text';
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

  function syncEffects() {
    const name = state.name;
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
    const keptStrokeIndexes = globalThis.StageTurnStream?.keptStrokeIndexes?.(strokeRefs)
      || strokeRefs.map((ref) => ref.strokeIndex);
    if (state.name === 'processing') {
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

  function steerSelectionCommand(
    command: string,
    referenceUpdates: any[] = [],
    sourceIds: string[] = [],
    onAccepted: () => void = () => {},
  ) {
    const trimmed = String(command == null ? '' : command).trim();
    if (!trimmed && referenceUpdates.length === 0 && sourceIds.length === 0) return;
    if (!api || typeof api.steerSelectionCommand !== 'function') {
      dispatch({ type: 'NOTICE', notice: { message: '这一轮不支持中途插话，等它跑完再发。' } });
      return;
    }
    const capturedAtMs = Date.now();
    const inputId = `input:${session.token || 'stage'}:${capturedAtMs}:${taskInputSequence += 1}`;
    const timeline = [
      ...(trimmed ? [{
        eventId: `utterance:${inputId}`,
        kind: 'utterance',
        startMs: capturedAtMs,
        endMs: capturedAtMs,
        text: trimmed,
      }] : []),
      ...referenceUpdates.map((update, index) => ({
        eventId: `point:${inputId}:${index}`,
        kind: 'point',
        startMs: capturedAtMs,
        endMs: capturedAtMs,
        referenceId: String(update?.binding?.referenceId || ''),
      })),
    ];
    const taskInput = globalThis.TaskSources?.normalizeTaskInput?.({
      inputId,
      taskId: session.taskId || `agent-${session.token}`,
      target: 'next-step',
      instruction: trimmed,
      referenceUpdates,
      sourceIds,
      timeline,
      capturedAtMs,
    });
    if (!taskInput || !globalThis.TaskInputTransport?.createTaskInputTransport) {
      dispatch({ type: 'NOTICE', notice: { message: '这一轮的结构化输入不可用，内容已保留。' } });
      return;
    }
    const transport = globalThis.TaskInputTransport.createTaskInputTransport({
      send: (value: any) => api.steerSelectionCommand({
        selectionSessionToken: session.token,
        taskInput: value,
      }),
      onState: (status: any) => {
        if (status.status === 'queueing') {
          dispatch({ type: 'NOTICE', notice: { message: '正在排队，收到持久化确认前保留输入。' } });
        } else if (status.status === 'accepted') {
          dispatch({ type: 'NOTICE', notice: { message: '已接收，下一个安全边界前生效。' } });
        } else {
          dispatch({ type: 'NOTICE', notice: { message: `输入没有送达：${String(status.error || '未知原因')}` } });
        }
      },
    });
    void transport.submit(taskInput, {
      onAccepted: () => {
        if (trimmed && capsuleInput.value.trim() === trimmed) capsuleInput.value = '';
        onAccepted();
      },
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
    transcriptBox.textContent = text;
    renderedTranscript = text;
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
    if (session.accentRgb) {
      stageRoot.style.setProperty('--stage-accent-rgb', session.accentRgb);
    }
  }



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

  function resultPlainText(container: HTMLElement) {
    const clone = container.cloneNode(true) as HTMLElement;
    clone.querySelectorAll<HTMLElement>('.turn-answer[data-answer]').forEach((node) => { node.textContent = node.dataset.answer || ''; });
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

  const PASSAGE_MIN_CHARS = 8;

  function hidePassageExpand() {
    if (passageExpand.hidden) return;
    passageExpand.hidden = true;
    passagePick = null;
    scheduleHitRegionRefresh();
  }

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
        context: (pick.answer.textContent || '').trim(),
      });
    } catch (error) {
      reply = { ok: false, error: String((error as { message?: unknown } | null)?.message || error || '展开失败。') };
    }
    passageBusy = false;
    passageExpand.dataset.busy = 'false';
    if (label) label.textContent = originalLabel;
    if (!reply || reply.ok !== true || !String(reply.text || '').trim()) {
      dispatch({ type: 'NOTICE', notice: { message: String(reply?.error || '这次没能展开，那一段保持原样。') } });
      setTimeout(() => {
        if (state.notice) dispatch({ type: 'NOTICE', notice: { message: '' } });
      }, 4500);
      hidePassageExpand();
      return;
    }
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

  passageExpand.addEventListener('mousedown', (event) => event.preventDefault());
  passageExpand.addEventListener('click', () => {
    console.log('[stage] passage-expand click pick=', passagePick ? 'present' : 'null',
      'busy=', passageExpand.dataset.busy || 'false');
    void expandPickedPassage();
  });
  document.addEventListener('selectionchange', syncPassageExpand);
  workPanelScroller.addEventListener('scroll', () => {
    if (!passageExpand.hidden) syncPassageExpand();
  });

  threadCopy.addEventListener('click', () => copyResultText(resultCard, threadCopy));

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
      resetConsentButton();
      return;
    }
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
  threadStop.addEventListener('click', async () => {
    if (threadStop.disabled || !api?.stopSelectionCommand) return;
    threadStop.disabled = true;
    try {
      const response = await api.stopSelectionCommand({ selectionSessionToken: session.token });
      if (response?.ok !== true) threadStop.disabled = false;
    } catch { threadStop.disabled = false; }
  });
  threadRetry.addEventListener('click', () => {
    const last = [...state.turns].reverse().find((turn) => turn.status !== 'pending');
    const ask = String(last?.ask || '').trim();
    if (ask) submitCommand(ask);
  });

  function renderStructured(container: HTMLElement, payload: any, scope?: string) {
    container.replaceChildren();
    const kind = payload && typeof payload === 'object' ? payload.kind : null;
    container.dataset.kind = kind || 'inline';
    if (kind === 'agent-prompt-draft') {
      renderAgentPromptDraft(container, payload);
      return;
    }
    if (!kind || kind === 'inline' || kind === 'prose' || kind === 'text') {
      const turn = payload && typeof payload === 'object' ? payload : { answer: String(payload || '') };
      container.replaceChildren(...ChatView.assistantTurnNode(turn, scope));
      container.dataset.answer = String(turn.answer || '');
      const actions = Array.isArray(payload?.actions) ? payload.actions : [];
      if (actions.length) {
        const footer = document.createElement('footer');
        footer.className = 'mcard-acts';
        actions.forEach((action: any) => {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'btn btn-quiet';
          button.dataset.act = 'action';
          button.dataset.actionId = String(action.id || '');
          button.textContent = String(action.label || '执行');
          footer.appendChild(button);
        });
        container.appendChild(footer);
        bindCardActions(container, payload);
      }
      if (Array.isArray(payload?.receipts) && payload.receipts.some((receipt: any) => receipt?.status === 'unverified')) {
        const note = document.createElement('p');
        note.className = 'stage-verification-note';
        note.textContent = '已尝试写入，尚未核对';
        container.appendChild(note);
      }
      ChatView.bindDelegation(container);
      return;
    }
    const card = CardModel.normalizeCard(payload && typeof payload === 'object'
      ? payload
      : { kind: 'prose', answer: String(payload || '') });
    card.runningLabel = CardModel.runningLabel(card);
    const shape = shapePolicy
      ? shapePolicy.answerShape({ result: payload, command: String(state.turns.at(-1)?.ask || '') })
      : { allowMarkdown: true };
    card.plainText = shape.allowMarkdown === false;
    container.dataset.shape = shape.allowMarkdown === false ? 'deliver' : 'inspect';
    container.replaceChildren(renderCard(card, { density: 'capsule' }));
    bindCardActions(container, payload);
  }

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
      } else if (action.kind === 'undo' && api && typeof api.undoAction === 'function') {
        const button = (event.target as Element).closest<HTMLElement>('[data-act="action"]') || (event.target as HTMLElement);
        button.setAttribute('disabled', 'true');
        api.undoAction({
          taskId: action.taskId || payload?.taskId,
          actionId: action.actionId || action.id,
        }).then((result: any) => {
          if (result?.ok !== true) button.removeAttribute('disabled');
        }).catch(() => button.removeAttribute('disabled'));
      } else if (action.kind === 'context' && api && typeof api.contextAction === 'function') {
        api.contextAction({ id: action.id, selectionSessionToken: session.token });
      }
    });
  }

  const runningCards = new Map<string, { snapshot: MagicPointerLiveProgress; renderer?: MagicPointerLiveTurn }>();

  function stageTurnScope(turn: any): string {
    return `stage:${session.token}#${turn.id}`;
  }

  function runningCardFor(turn: any) {
    const id = `t${turn.id}`;
    if (!runningCards.has(id)) {
      runningCards.set(id, { snapshot: { answer: '', thinking: '', records: [] } });
    }
    return runningCards.get(id)!;
  }

  function paintRunningCard(container: HTMLElement, turn: any) {
    const card = runningCardFor(turn);
    if (!card.renderer) {
      card.renderer = ChatView.createLiveTurn(container, stageTurnScope(turn));
      ChatView.bindDelegation(container);
    }
    card.renderer.update(card.snapshot);
  }

  function patchRunningCard(patch: any) {
    const turn = [...state.turns].reverse().find((t) => t.status === 'pending');
    if (!turn) return;
    const id = `t${turn.id}`;
    const current = runningCards.get(id);
    if (!current) return;
    if (!patch.liveProgress) return;
    current.snapshot = patch.liveProgress;
    const node = resultCard.querySelector<HTMLElement>(`.thread-turn[data-turn-id="${turn.id}"] .turn-answer`);
    if (node) {
      const follow = workPanelScroller.scrollHeight - workPanelScroller.scrollTop - workPanelScroller.clientHeight <= 48;
      paintRunningCard(node, turn);
      if (follow) workPanelScroller.scrollTop = workPanelScroller.scrollHeight;
    }
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
      if (turn.result?.answer) renderStructured(answer, turn.result, stageTurnScope(turn));
      else renderFailure(answer, turn.error);
    } else {
      runningCards.delete(`t${turn.id}`);
      renderStructured(answer, turn.result, stageTurnScope(turn));
    }
    return node;
  }

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
    threadStop.hidden = !pending;
    if (!pending) threadStop.disabled = false;
    threadPanel.dataset.turnCount = String(turns.length);
    const firstAsk = String(turns[0]?.ask || '').trim();
    const surfaceTitle = session.targetAppLabel || '选中的内容';
    threadTitle.textContent = surfaceTitle;
    threadTitle.title = surfaceTitle;
    const failed = turns[turns.length - 1]?.status === 'failed';
    const awaiting = turns[turns.length - 1]?.status === 'awaiting';
    const verificationPending = turns[turns.length - 1]?.result?.receipts?.some((receipt: any) => receipt?.status === 'unverified') === true;
    threadEyebrow.hidden = true;
    threadPanel.dataset.phase = pending ? 'running' : awaiting ? 'awaiting' : failed ? 'failed' : 'finished';
    threadClose.setAttribute('aria-label', '关闭');
    threadClose.title = pending ? '关闭小窗，任务在主界面继续' : '关闭';
    threadEyebrow.dataset.state = pending || awaiting ? 'running' : failed ? 'failed' : 'done';
    threadEyebrowText.textContent = pending
      ? '正在处理'
      : awaiting
        ? '需要你补充'
        : failed
          ? '这次没完成'
          : verificationPending
            ? '待核对'
          : '已完成';
    const settled = !pending && turns.some((turn) => turn.status === 'done');
    threadCopy.disabled = !settled;
    threadFollowup.placeholder = firstAsk
      ? `继续问关于「${firstAsk.slice(0, 12)}${firstAsk.length > 12 ? '…' : ''}」的`
      : '继续问点什么…';
    const newest = turns[turns.length - 1];
    if (shapePolicy && settled) {
      answerShape = shapePolicy.answerShape({
        result: newest?.result,
        command: String(newest?.ask || firstAsk || ''),
      });
    }
    threadPanel.dataset.shape = answerShape.shape;
    syncConsent();
    hidePassageExpand();
  }

  let pendingStageInput: {
    turnId: number; sessionToken: string; requestId: string; requestToken: string;
    original: any; accepted: boolean; transcript: ReturnType<typeof ConversationControl.createTranscript>;
  } | null = null;
  let stageHistorySources: { key: string; sources?: Array<{ id: string; title?: string }>; error?: string } | null = null;

  async function loadStageHistorySources(key: string) {
    try {
      if (!api?.listHistorySources) throw new Error('无法读取已保存任务。');
      const sources = await api.listHistorySources();
      if (!Array.isArray(sources)) throw new Error('无法读取已保存任务。');
      if (stageHistorySources?.key !== key) return;
      stageHistorySources = { key, sources };
    } catch (error) {
      if (stageHistorySources?.key !== key) return;
      stageHistorySources = { key, error: error instanceof Error ? error.message : String(error) };
    }
    renderStageDecision();
  }

  function currentStageInput(request: NonNullable<typeof pendingStageInput>): boolean {
    return pendingStageInput === request && session.token === request.sessionToken
      && state.name === 'processing' && state.turns.at(-1)?.id === request.turnId
      && state.turns.at(-1)?.status === 'pending';
  }

  function renderStageDecision() {
    const turn = state.turns.at(-1);
    const request = pendingStageInput;
    const active = request && currentStageInput(request) ? request : null;
    const input = active ? active.accepted ? null : active.original?.pendingInput
      : turn?.status === 'awaiting' ? turn.result?.pendingInput : null;
    if (!input || !session.token || ['hidden', 'dismissing'].includes(state.name)) {
      DecisionCard.clear(stageDecision); return;
    }
    const key = `stage:${session.token}:${input.requestId}`;
    const dailyWrap = input.kind === 'permission' && input.tool === 'DailyWrap.read'
      && input.action?.tool === 'DailyWrap.read';
    if (dailyWrap && stageHistorySources?.key !== key) {
      stageHistorySources = { key };
      void loadStageHistorySources(key);
    }
    DecisionCard.render(stageDecision, {
      ...input, key,
      ...(dailyWrap ? {
        historySources: stageHistorySources?.sources,
        historySourcesError: stageHistorySources?.error,
        retryHistorySources: () => {
          stageHistorySources = { key };
          renderStageDecision();
          void loadStageHistorySources(key);
        },
      } : {}),
      questions: input.questions || (input.kind !== 'permission' ? [{
        question: input.question || '需要你的决定',
        options: (input.options || []).map((label: string) => ({ label })),
      }] : undefined),
    }, response => { void respondToStageInput(turn.id, input.requestId, response); });
    if (active) DecisionCard.pending(stageDecision, true);
  }

  async function respondToStageInput(turnId: number, requestId: string, response: MagicPointerDecisionResponse) {
    const turn = state.turns.at(-1);
    if (pendingStageInput || !session.token || turn?.id !== turnId || turn.status !== 'awaiting') return;
    if (!requestId || turn.result?.pendingInput?.requestId !== requestId || !api?.respondInput) {
      DecisionCard.pending(stageDecision, false, '无法找到这条请求的执行记录，请重新打开任务。'); return;
    }
    const transcript = ConversationControl.createTranscript();
    transcript.trajectory = (turn.result?.trajectory || []).map((record: Record<string, unknown>) => ({ ...record }));
    const request = {
      turnId, requestId, sessionToken: session.token,
      requestToken: `stage-response-${Date.now()}-${++taskInputSequence}`,
      original: turn.result, accepted: false, transcript,
    };
    pendingStageInput = request;
    runningCards.set(`t${turnId}`, { snapshot: { ...transcript, records: [] } });
    dispatch({ type: 'RESUME_INPUT', turnId, requestId });
    if (!currentStageInput(request)) { pendingStageInput = null; return; }
    try {
      const result = await api.respondInput({ selectionSessionToken: request.sessionToken,
        requestId, requestToken: request.requestToken, response });
      if (!currentStageInput(request)) return;
      request.accepted = request.accepted || result?.accepted === true;
      if (!request.accepted) {
        pendingStageInput = null;
        dispatch({ type: 'RESULT', result: request.original });
        DecisionCard.pending(stageDecision, false, String(result?.error || '回答未保存，请重试。'));
        return;
      }
      DecisionCard.clear(stageDecision, true);
      pendingStageInput = null;
      dispatch(result?.ok === true
        ? { type: 'RESULT', result }
        : { type: 'ERROR', result, error: { message: String(result?.error || '继续执行失败。') } });
    } catch (error) {
      if (!currentStageInput(request)) return;
      pendingStageInput = null;
      const message = error instanceof Error ? error.message : String(error);
      if (request.accepted) {
        DecisionCard.clear(stageDecision, true);
        dispatch({ type: 'ERROR', result: { ...request.transcript }, error: { message } });
      } else {
        dispatch({ type: 'RESULT', result: request.original });
        DecisionCard.pending(stageDecision, false, message);
      }
    }
  }

  function onStageInputProgress(payload: any) {
    const request = pendingStageInput;
    if (!request || !currentStageInput(request) || payload.requestId !== request.requestToken || !payload.record) return;
    if (payload.record.phase === 'user_input_accepted') {
      if (payload.record.fields?.inputRequestId !== request.requestId) return;
      request.accepted = true;
      DecisionCard.clear(stageDecision, true);
    }
    ConversationControl.appendTranscript(request.transcript, payload.record);
    patchRunningCard({ liveProgress: { ...request.transcript, records: [] } });
    scheduleHitRegionRefresh();
  }

  async function openStageArtifact(artifactId: string) {
    const token = session.token;
    if (!token || !artifactId || !api?.openArtifact) return;
    try {
      const result = await api.openArtifact({ selectionSessionToken: token, artifactId });
      if (session.token === token && result?.ok === false) {
        dispatch({ type: 'NOTICE', notice: { message: String(result.error || '无法打开产物。') } });
      }
    } catch (error) {
      if (session.token === token) dispatch({ type: 'NOTICE', notice: { message: String(error) } });
    }
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
      const policy = globalThis.StageChipsPolicy;
      const command = policy && typeof policy.commandForChip === 'function'
        ? policy.commandForChip(chip.id)
        : null;
      if (command) submitCommand(command);
    });
    return button;
  }

  function renderChips(idleAllowed: boolean) {
    const newest = state.turns[state.turns.length - 1];
    const awaiting = newest?.status === 'awaiting';
    let chips: any[] = [];
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
    deliveryBar.style.transform = 'scaleX(0)';
  }

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
    deliveryBar.style.transform = `scaleX(${Math.min(100, Math.max(0, percent)) / 100})`;
    deliveryBox.hidden = false;
    const anchor = anchorEl.getBoundingClientRect();
    deliveryBox.style.left = `${anchor.left}px`;
    deliveryBox.style.top = `${anchor.bottom + 8}px`;
  }

  function clearAll() {
    runningCards.clear();
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
  }

  function render() {
    const name = state.name;
    stageRoot.dataset.state = name;
    stageRoot.dataset.selectionVisual = session.selectionVisual;
    renderSelectionStretch();
    stageRoot.dataset.targetGeometryKind = session.targetGeometryKind;

    if (name === 'hidden') {
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

    const showGlow = name === 'frozen'
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
    const capsuleOpen = name === 'capsule-text'
      || ((name === 'result' || name === 'error') && !resultOwnsComposer)
      || (name === 'dismissing' && !capsule.hidden);
    if ((name === 'processing' || name === 'result' || name === 'error') && state.transcript) {
      state = { ...state, transcript: '' };
    }
    if (capsuleOpen) {
      renderStrokeRefs();
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
      const composerMode = 'text';
      capsule.dataset.mode = composerMode;
      capsule.dataset.phase = 'input';
      capsuleInput.placeholder = composerMode === 'text' ? '问点什么…' : '';
      if (name === 'result' || name === 'error') capsuleInput.value = '';
      renderTranscript();
      const capsuleWidth = syncCapsuleWidth();
      anchorCapsuleToTarget(capsuleWidth);
      if (capsuleWasHidden) capsule.hidden = false;
      scheduleHitRegionRefresh();
      if (name === 'capsule-text') capsuleInput.focus();
      else if (capsuleHadFocus && composerMode === 'text' && !capsuleInput.disabled) capsuleInput.focus();
    } else {
      capsule.hidden = true;
      clearTranscript();
      capsuleInput.value = '';
    }
    shimmer.hidden = name !== 'processing';

    if (state.turns.length && name !== 'hidden') {
      renderThread(state.turns);
      renderStageDecision();
      threadPanel.hidden = false;
      placeThreadSurface();
    } else {
      threadPanel.hidden = true;
      renderedTurnSignature = '';
      resultCard.replaceChildren();
      renderStageDecision();
    }
    renderChips(name === 'capsule-text');

    if (name === 'error' && !state.turns.length) {
      errorCard.replaceChildren();
      renderFailure(errorCard, state.error);
      anchorNearPointer(errorCard, 300, 44);
      errorCard.hidden = false;
    } else {
      errorCard.hidden = true;
    }

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

  function renderModelNotice(name: string) {
    if (!noticeBox) return;
    const transient = String(state.notice?.message || '');
    const composerOpen = name === 'capsule-text' || name === 'processing';
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
    if ('taskId' in payload) {
      session.taskId = payload.taskId ? String(payload.taskId) : null;
    }
    if ('selectionSnapshotId' in payload) {
      session.selectionSnapshotId = payload.selectionSnapshotId
        ? String(payload.selectionSnapshotId)
        : null;
    }
    if (payload.taskContext && typeof payload.taskContext === 'object') {
      const refs = Array.isArray(payload.taskContext.references)
        ? payload.taskContext.references.filter((item: any) => item && typeof item === 'object')
        : [];
      referenceBindings = new Map(refs.map((item: any) => [String(item.referenceId || ''), item]));
      strokeRefs = strokeRefs.map((ref) => {
        const binding = refs.find((item: any) => Number(item.ordinal) === ref.strokeIndex + 1);
        return binding ? {
          ...ref,
          label: String(binding.label || ref.label),
          referenceId: String(binding.referenceId || '') || null,
        } : ref;
      });
      renderedRefSignature = '';
    }
    if ('groundingReady' in payload) {
      session.groundingReady = payload.groundingReady === true;
    }
    if ('selectionChars' in payload) {
      const chars = Number(payload.selectionChars);
      session.selectionChars = Number.isFinite(chars) && chars > 0 ? Math.round(chars) : 0;
    }
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
      if (session.selectionCount !== strokeRefs.length && session.selectionCount > 1) {
        strokeRefs = Array.from({ length: session.selectionCount }, (_unused, index) => ({
          strokeIndex: index,
          label: '',
          referenceId: null,
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
    if (typeof api.onConversationProgress === 'function') api.onConversationProgress(onStageInputProgress);
    document.addEventListener('mp:open-artifact', (event) => {
      const artifactId = String((event as CustomEvent).detail?.artifactId || '');
      void openStageArtifact(artifactId);
    });
    api.onShow((payload) => {
      if (!payload) return;
      pendingStageInput = null;
      DecisionCard.clear(stageDecision, true);
      state = initialState({ reducedMotion: reducedMotionQuery.matches });
      renderedTranscript = '';
      reportedState = '';
      session.token = null;
      session.taskId = null;
      session.selectionSnapshotId = null;
      session.groundingReady = false;
      session.selectionVisual = 'sweep_band';
      session.targetGeometryKind = 'pointer_only';
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
      session.visualTuning = { ...DEFAULT_VISUAL_TUNING };
      lastPointerPoint = null;
      if (targetSweepTimer) clearTimeout(targetSweepTimer);
      targetSweepTimer = null;
      targetSweepComplete = false;
      resetPointerState();
      clearCaptureProof();
      clearScreenPoints();
      pickedElement = null;
      referenceBindings = new Map();
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
    if (typeof api.onCardPatch === 'function') {
      api.onCardPatch((payload) => {
        if (!payload || state.name === 'hidden') return;
        if (payload.selectionSessionToken && payload.selectionSessionToken !== session.token) return;
        patchRunningCard(payload.patch || {});
      });
    }
    if (typeof api.onPointerInput === 'function') {
      api.onPointerInput((payload) => handlePointerInput(payload));
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
