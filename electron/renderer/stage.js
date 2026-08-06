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
  const voiceTrigger = globalThis.MagicPointerVoiceTrigger;
  const hitPolicy = globalThis.MagicPointerStageHitPolicy;
  if (!machine || !anchor || !voiceTrigger || !hitPolicy) return;
  const { initialState, transition } = machine;
  const api = window.magicPointerStage;

  const stageRoot = document.getElementById('stage');
  const targetingOutline = document.getElementById('targeting-outline');
  const captureProofLayer = document.getElementById('capture-proof');
  const screenPointLayer = document.getElementById('screen-points');
  const selectionStretch = document.getElementById('selection-stretch');
  const selectionStretchHint = document.getElementById('selection-stretch-hint');
  // Live drag on a selection handle, or null. Mirrors stretchDrag on the answer
  // card and shares its policy, so the same pull means the same thing.
  let selectionStretchDrag = null;
  const frozenGlow = document.getElementById('frozen-glow');
  const capsule = document.getElementById('capsule');
  const capsuleCount = document.getElementById('capsule-count');
  const capsuleRefs = document.getElementById('capsule-refs');
  // One entry per stroke the user drew, in draw order. Dropping one here drops
  // it from the command, so a mis-drawn stroke costs one click rather than a
  // whole redraw.
  let strokeRefs = [];
  let renderedRefSignature = '';
  const capsuleInput = document.getElementById('capsule-input');
  const transcriptBox = document.getElementById('transcript');
  const shimmer = document.getElementById('processing-shimmer');
  const resultCard = document.getElementById('stage-result');
  const threadPanel = document.getElementById('stage-thread');
  const threadCount = document.getElementById('thread-count');
  const threadCopy = document.getElementById('thread-copy');
  const threadInsert = document.getElementById('thread-insert');
  const threadClose = document.getElementById('thread-close');
  const errorCard = document.getElementById('stage-error');
  const chipsBox = document.getElementById('stage-chips');
  const stretchBar = document.getElementById('thread-stretch');
  const stretchHint = document.getElementById('thread-stretch-hint');
  const stretchPolicy = globalThis.StageStretchPolicy || null;
  // Live drag state for the answer-length handle, or null.
  let stretchDrag = null;
  // Pick mode: the element the user last picked, so an unchanged pick does not
  // restart the highlight animation (that reads as flicker).
  let pickTargetShown = null;
  // The element the user last clicked on, and therefore what a question is about.
  let pickedElement = null;
  let pickInFlight = false;
  // Where this window sits on the virtual desktop, learned from the pointer
  // stream (which carries both spaces) rather than assumed to be zero.
  let stageOriginX = 0;
  let stageOriginY = 0;
  const noticeBox = document.getElementById('stage-notice');
  const noticeText = document.getElementById('stage-notice-text');
  let modelHealth = { circuitOpen: false, message: '', state: 'unknown' };
  const deliveryBox = document.getElementById('delivery-progress');
  const deliveryLabel = document.getElementById('delivery-label');
  const deliveryBar = document.getElementById('delivery-bar');
  const deliveryCount = document.getElementById('delivery-count');
  const tplThreadTurn = document.getElementById('tpl-thread-turn');
  const tplTurnWait = document.getElementById('tpl-turn-wait');
  const tplCalendarDraft = document.getElementById('tpl-calendar-draft');
  const tplTableCompare = document.getElementById('tpl-table-compare');
  const tplTextDraft = document.getElementById('tpl-text-draft');
  const tplAgentPromptDraft = document.getElementById('tpl-agent-prompt-draft');

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
  let dismissTimer = null;
  let hasShown = false;
  // Selection metadata rides on stage:show/stage:update payloads (not the
  // machine): the chips policy needs it, the lifecycle does not.
  const meta = { selectionSource: null, objectKind: null };
  let renderedChipIds = '';
  // Signature of the turns currently in the DOM, so an unchanged thread is
  // never rebuilt (see renderThread).
  let renderedTurnSignature = '';
  // Wall clock for the pending turn's elapsed label.
  let waitTimer = null;
  let waitStartedAt = 0;
  // Live wiring context from main (stage:show / stage:update payloads).
  const session = {
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
    resultPlacement: null,
    resultDragged: false,
    selectionCount: 1,
    voiceState: 'idle',
    // "r, g, b" from appearance settings; empty means keep the stylesheet default.
    accentRgb: '',
    visualTuning: { ...DEFAULT_VISUAL_TUNING },
  };
  const textCanvas = document.createElement('canvas');
  const textMeasure = textCanvas.getContext('2d');
  let dictationActive = false;
  let mouseCaptureOn = false;
  let keyboardFocusRequested = false;
  let hitRegionKey = '';
  let hitRegionRefreshTimer = null;
  let voiceTriggerPolicy = null;
  const agentPromptUi = {
    key: '',
    prompt: '',
    sessions: [],
    selectedSession: null,
    loading: false,
  };
  let previousPointerButtons = 0;
  let pointerWasOverCapsule = false;
  let lastPointerPoint = null;
  let capsuleDrag = null; // { startX, startY, originLeft, originTop }
  let surfaceDrag = null; // { element, startX, startY, originLeft, originTop }
  let reportedState = '';
  let targetSweepComplete = false;
  let targetSweepTimer = null;

  // Honest receipt copy: mirrors the TRUE state verbatim — a queued/accepted
  // draft is never rendered as succeeded (design §2.2/§3.1).
  const RECEIPT_STATUS_LABELS = Object.freeze({
    draft: '草稿(未提交)',
    accepted: '已受理(尚未完成)',
    succeeded: '已写入成功',
  });

  reducedMotionQuery.addEventListener('change', (event) => {
    dispatch({ type: 'SET_REDUCED_MOTION', value: event.matches });
  });

  function dispatch(event) {
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
  function renderCaptureProof(bands) {
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
  function renderScreenPoints(points) {
    if (!screenPointLayer) return;
    screenPointLayer.replaceChildren();
    const list = Array.isArray(points) ? points : [];
    let drawn = 0;
    for (const point of list) {
      const x = Math.round(Number(point.x) - stageOriginX);
      const y = Math.round(Number(point.y) - stageOriginY);
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

  function beginSelectionStretch(edge, y) {
    selectionStretchDrag = { edge, startY: y, currentLines: selectionLineCount(), intent: null };
    selectionStretch.classList.add('is-dragging');
  }

  function updateSelectionStretch(y) {
    if (!selectionStretchDrag || !stretchPolicy) return;
    // The top handle moves the opposite way: dragging it up makes the region
    // taller, which is the same "more" as dragging the bottom one down.
    const raw = y - selectionStretchDrag.startY;
    const dragPx = selectionStretchDrag.edge === 'top' ? -raw : raw;
    selectionStretchDrag.intent = stretchPolicy.stretchIntent({
      dragPx,
      currentLines: selectionStretchDrag.currentLines,
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

  function applyVoiceTriggerEffects(outcome) {
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

  function dispatchVoiceTrigger(event) {
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
  async function pickElementAt(screenX, screenY) {
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
  function showPickHighlight(picked) {
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

  function isPointInside(x, y, element) {
    if (!element || element.hidden) return false;
    const rect = element.getBoundingClientRect();
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  }

  // How many lines the newest answer occupies on screen. Measured rather than
  // counted from the text, because wrapping is what the user actually sees.
  function answerLineCount() {
    const answers = resultCard.querySelectorAll('.turn-answer');
    const last = answers[answers.length - 1];
    if (!last) return 1;
    const height = last.getBoundingClientRect().height;
    const lineHeight = stretchPolicy?.LINE_HEIGHT_PX || 20;
    return Math.max(1, Math.round(height / lineHeight));
  }

  function isDragHandleAt(x, y, rootEl) {
    if (!rootEl || rootEl.hidden) return false;
    let node = document.elementFromPoint(x, y);
    if (!node || !rootEl.contains(node)) return false;
    while (node && node !== document.body) {
      if (node.dataset && node.dataset.noDrag) return false;
      if (node.dataset && node.dataset.dragHandle) return true;
      if (node === rootEl) return false;
      node = node.parentElement;
    }
    return false;
  }

  function handleVoicePointerInput(payload) {
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
    if (primaryDown && !previousPrimaryDown && !overCapsule && !overResult && !surfaceDrag && !stretchDrag) {
      const composerOpen = state.name === 'capsule-text' || state.name === 'capsule-voice';
      if (composerOpen && Number.isFinite(payload?.screenX) && Number.isFinite(payload?.screenY)) {
        pickElementAt(Number(payload.screenX), Number(payload.screenY));
      }
    }
    // Selection handles first: they sit outside our panels, on the user's own
    // content, so a press there is unambiguous.
    if (primaryDown && !previousPrimaryDown && !selectionStretchDrag && selectionStretch && !selectionStretch.hidden) {
      for (const handle of selectionStretch.querySelectorAll('.selection-stretch-handle')) {
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
    // The stretch handle is checked before the panel-drag handle: it lives
    // inside the panel, and a drag that starts on it changes the answer's
    // length rather than moving the surface.
    if (overResult && primaryDown && !previousPrimaryDown && !surfaceDrag && !stretchDrag) {
      if (stretchPolicy && stretchBar && !stretchBar.hidden && isPointInside(x, y, stretchBar)) {
        stretchDrag = { startY: y, currentLines: answerLineCount(), intent: null };
        stretchBar.classList.add('is-dragging');
      }
    }
    if (stretchDrag) {
      stretchDrag.intent = stretchPolicy.stretchIntent({
        dragPx: y - stretchDrag.startY,
        currentLines: stretchDrag.currentLines,
      });
      // Live preview while the finger is down: the number the hint promises is
      // the number the command will ask for.
      if (stretchHint) stretchHint.textContent = stretchDrag.intent.hint;
      stretchBar.dataset.direction = stretchDrag.intent.direction;
      if (!primaryDown && previousPrimaryDown) {
        const command = stretchPolicy.stretchCommand(stretchDrag.intent);
        stretchBar.classList.remove('is-dragging');
        delete stretchBar.dataset.direction;
        if (stretchHint) stretchHint.textContent = '';
        stretchDrag = null;
        // Submitted through the ordinary composer path, so the gesture appears
        // in the thread as an ask like any other — the user can see what their
        // hand asked for, and it is undoable by asking again.
        if (command) submitCommand(command);
        syncHitRegions();
        return;
      }
      previousPointerButtons = buttons;
      return;
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
    // `processing` in particular: the thread and its composer are both on
    // screen while a turn runs, and dragging them there used to fall straight
    // through and select text in the app underneath.
    if (!capsule.hidden || !threadPanel.hidden) return true;
    const hasEnabledButton = (element) => !element.hidden
      && Boolean(element.querySelector('button:not([disabled])'));
    return hasEnabledButton(chipsBox)
      || hasEnabledButton(errorCard);
  }

  function capsuleVisualRegion(element, rect) {
    if (element !== capsule) return rect;
    const desiredWidth = Number.parseFloat(
      window.getComputedStyle(capsule).getPropertyValue('--capsule-width'),
    );
    if (!Number.isFinite(desiredWidth) || desiredWidth <= rect.width) return rect;
    return {
      left: rect.left,
      top: rect.top,
      right: Math.min(window.innerWidth, rect.left + desiredWidth),
      bottom: rect.bottom,
      width: Math.min(desiredWidth, window.innerWidth - rect.left),
      height: rect.height,
    };
  }

  function visibleStageRegions() {
    return [targetingOutline, frozenGlow, capsule, threadPanel, errorCard, chipsBox, deliveryBox]
      .filter((element) => !element.hidden)
      .map((element) => ({ element, rect: element.getBoundingClientRect() }))
      .filter(({ rect }) => rect.width > 0 && rect.height > 0)
      .map(({ element, rect: measuredRect }) => {
        const rect = capsuleVisualRegion(element, measuredRect);
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
    // The capsule is operable in every state where it is on screen — including
    // under a finished thread, where it is the composer for the follow-up.
    // Leaving it out here made clicking it fall through to the app below.
    if (!capsule.hidden && !(state.name === 'capsule-text' && capsuleInput.disabled)) {
      elements.push(capsule);
    }
    if (!threadPanel.hidden) elements.push(threadPanel);
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

  function submitCommand(command) {
    const trimmed = String(command == null ? '' : command).trim();
    if (!trimmed) return;
    const inputMode = state.inputMode;
    // Chips the user removed are removed from the request too, or the chip is a
    // decoration that lies about what was sent.
    const keptStrokeIndexes = strokeRefs.map((ref) => ref.strokeIndex);
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

  function requestDismiss() {
    if (state.name === 'hidden' || state.name === 'dismissing') return;
    dispatch({ type: 'DISMISS' });
    if (api && typeof api.dismiss === 'function') api.dismiss();
  }

  function placeRect(element, rect) {
    if (!rect) {
      element.hidden = true;
      return;
    }
    element.hidden = false;
    element.style.left = `${rect.x}px`;
    element.style.top = `${rect.y}px`;
    if (element === capsule) {
      const finalWidth = Number.parseFloat(window.getComputedStyle(capsule).getPropertyValue('--capsule-width')) || rect.width;
      // Cold start throttle: ensure double windows ready before pen fall.
      // Smooth cross-frame handover for shape switch, no half-ball or ghost.
      element.style.width = `${Math.min(finalWidth, window.innerWidth - rect.left)}px`;
      element.style.height = `${rect.height}px`;
      // Reserve for smooth transition
      if (element === capsule) {
        capsule.style.width = `${Math.min(finalWidth, window.innerWidth - rect.left)}px`;
      }
    } else {
      element.style.width = `${rect.width}px`;
    }
    element.style.height = `${rect.height}px`;
  }

  function isUsableTargetRect(rect) {
    if (!rect || typeof rect !== 'object') return false;
    const x = Number(rect.x);
    const y = Number(rect.y);
    const width = Number(rect.width);
    const height = Number(rect.height);
    if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return false;
    return x < window.innerWidth && y < window.innerHeight && x + width > 0 && y + height > 0;
  }

  function sweepBandRect(rect) {
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

  function targetFeedbackRect(rect) {
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

  function voiceStateForStatus(status) {
    const value = String(status || '').toLowerCase();
    if (value === 'warming') return 'warming';
    if (value === 'ready' || value === 'microphone_started') return 'listening';
    if (value === 'microphone_stopped') return 'idle';
    return null;
  }

  function syncCapsuleWidth() {
    const mode = state.inputMode === 'text' ? 'text' : 'voice';
    const base = mode === 'text'
      ? session.visualTuning.capsuleTextWidthDip
      : session.visualTuning.capsuleVoiceWidthDip;
    const content = state.transcript || capsuleInput.value || '';
    capsule.dataset.empty = mode === 'voice' && !content ? 'true' : 'false';
    const style = window.getComputedStyle(transcriptBox);
    if (textMeasure) textMeasure.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const measured = textMeasure ? textMeasure.measureText(content).width : content.length * 8;
    const grown = content ? measured + 58 : base;
    const width = Math.min(session.visualTuning.capsuleMaxWidthDip, Math.max(base, grown));
    // Pre-reserve final capsule width for smooth shape switching across one frame.
    // Prevents half-ball cut, ghost residual, or split during transition.
    // High DPI auto scaling applied via CSS var.
    capsule.style.setProperty('--capsule-width', `${width}px`);
    capsule.style.setProperty('--capsule-base-width', `${base}px`);
    return width;
  }

  function anchorNearPointer(element, fallbackWidth = 200, fallbackHeight = 44) {
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

  // The thread hangs off the composer rather than replacing it. It grows
  // downward from the capsule's bottom edge — reading order is question then
  // answer — and flips above only when the capsule sits too low to fit below.
  function anchorThreadToCapsule() {
    if (session.resultDragged && session.resultPlacement) {
      threadPanel.style.left = `${session.resultPlacement.x}px`;
      threadPanel.style.top = `${session.resultPlacement.y}px`;
      return;
    }
    const rect = threadPanel.getBoundingClientRect();
    const capsuleRect = capsule.hidden ? null : capsule.getBoundingClientRect();
    const fallback = session.capsulePlacement || session.pointer || { x: 8, y: 8 };
    const width = rect.width || Math.min(380, window.innerWidth - 16);
    const height = rect.height || 96;
    const gap = 10;
    const anchorLeft = capsuleRect && capsuleRect.width ? capsuleRect.left : fallback.x;
    const anchorTop = capsuleRect && capsuleRect.height ? capsuleRect.top : fallback.y;
    const anchorBottom = capsuleRect && capsuleRect.height ? capsuleRect.bottom : fallback.y;
    const x = Math.max(8, Math.min(anchorLeft, window.innerWidth - width - 8));
    let y = anchorBottom + gap;
    let side = 'below';
    if (y + height > window.innerHeight - 8) {
      const above = anchorTop - gap - height;
      if (above >= 8) {
        y = above;
        side = 'above';
      }
    }
    y = Math.max(8, Math.min(y, window.innerHeight - height - 8));
    threadPanel.style.left = `${x}px`;
    threadPanel.style.top = `${y}px`;
    threadPanel.dataset.side = side;
    threadPanel.dataset.quadrant = session.capsulePlacement?.quadrant || 'bottom-right';
  }

  function anchorCapsuleToTarget(width) {
    // Anchor exactly once per session: the capsule must appear next to the
    // selection and then stay put (the user can drag it). Re-anchoring when
    // grounding later resolves made the bubble jump across the screen.
    if (session.capsulePlaced || session.capsuleDragged) return;
    if (typeof anchor.chooseStableCapsuleAnchor === 'function') {
      const point = session.pointer || (state.target
        ? { x: state.target.x + state.target.width / 2, y: state.target.y + state.target.height / 2 }
        : { x: window.innerWidth / 2, y: window.innerHeight / 2 });
      const targetMode = (
        session.capsuleAnchor === 'target'
        && session.targetGeometryKind === 'resolved'
        && isUsableTargetRect(state.target)
      );
      session.capsulePlacement = anchor.chooseStableCapsuleAnchor({
        previous: session.capsulePlacement,
        sessionToken: session.token,
        mode: targetMode ? 'target' : 'pointer',
        pointer: point,
        target: targetMode ? state.target : null,
        surface: { width, height: session.visualTuning.capsuleVoiceWidthDip },
        viewport: { width: window.innerWidth, height: window.innerHeight },
        options: targetMode
          ? { gap: session.visualTuning.capsuleInlineGapDip }
          : undefined,
      });
      capsule.style.left = `${session.capsulePlacement.x}px`;
      capsule.style.top = `${session.capsulePlacement.y}px`;
      capsule.dataset.quadrant = session.capsulePlacement.quadrant;
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
        { width, height: session.visualTuning.capsuleVoiceWidthDip },
        { width: window.innerWidth, height: window.innerHeight },
        { gap: session.visualTuning.capsuleInlineGapDip },
      );
      capsule.style.left = `${placement.x}px`;
      capsule.style.top = `${placement.y}px`;
      capsule.dataset.quadrant = placement.quadrant;
      session.capsulePlaced = true;
      return;
    }
    anchorNearPointer(capsule, width, session.visualTuning.capsuleVoiceWidthDip);
    session.capsulePlaced = true;
  }

  function applyVisualTuning() {
    stageRoot.style.setProperty('--stage-sweep-duration', `${session.visualTuning.sweepDurationMs}ms`);
    stageRoot.style.setProperty('--stage-sweep-fade', `${session.visualTuning.sweepFadeMs}ms`);
    stageRoot.style.setProperty('--stage-capsule-spawn', `${session.visualTuning.capsuleSpawnMs}ms`);
    stageRoot.style.setProperty('--stage-capsule-expand', `${session.visualTuning.capsuleExpandMs}ms`);
    stageRoot.style.setProperty(
      '--stage-capsule-delay',
      `${session.capsuleDelayMs === null ? session.visualTuning.sweepDurationMs : session.capsuleDelayMs}ms`,
    );
    stageRoot.style.setProperty('--stage-capsule-size', `${session.visualTuning.capsuleVoiceWidthDip}px`);
    // One assignment retints every accent in the stage, because stage.css
    // composes all of them from these channels rather than repeating literals.
    if (session.accentRgb) {
      stageRoot.style.setProperty('--stage-accent-rgb', session.accentRgb);
    }
  }

  function appendInlineMarkdown(container, text) {
    const fragments = String(text || '').split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean);
    for (const fragment of fragments) {
      if (fragment.startsWith('**') && fragment.endsWith('**')) {
        const strong = document.createElement('strong');
        strong.textContent = fragment.slice(2, -2);
        container.appendChild(strong);
      } else if (fragment.startsWith('`') && fragment.endsWith('`')) {
        const code = document.createElement('code');
        code.textContent = fragment.slice(1, -1);
        container.appendChild(code);
      } else container.appendChild(document.createTextNode(fragment));
    }
  }

  function renderMarkdownText(container, text) {
    const blocks = String(text || '').replace(/\r\n?/g, '\n').split(/\n\s*\n/).filter(Boolean);
    for (const block of blocks) {
      const lines = block.split('\n');
      let element;
      if (lines.every((line) => /^\s*[-*]\s+/.test(line))) {
        element = document.createElement('ul');
        for (const line of lines) {
          const item = document.createElement('li');
          appendInlineMarkdown(item, line.replace(/^\s*[-*]\s+/, ''));
          element.appendChild(item);
        }
      } else if (lines.every((line) => /^\s*\d+[.)]\s+/.test(line))) {
        element = document.createElement('ol');
        for (const line of lines) {
          const item = document.createElement('li');
          appendInlineMarkdown(item, line.replace(/^\s*\d+[.)]\s+/, ''));
          element.appendChild(item);
        }
      } else if (/^#{1,3}\s+/.test(block)) {
        element = document.createElement('h3');
        appendInlineMarkdown(element, block.replace(/^#{1,3}\s+/, ''));
      } else if (/^```[\s\S]*```$/.test(block)) {
        element = document.createElement('pre');
        const code = document.createElement('code');
        code.textContent = block.replace(/^```[^\n]*\n?/, '').replace(/```$/, '');
        element.appendChild(code);
      } else {
        element = document.createElement('p');
        appendInlineMarkdown(element, lines.join('\n'));
      }
      container.appendChild(element);
    }
  }

  function renderInline(container, payload) {
    const primary = document.createElement('div');
    primary.className = 'result-answer';
    renderMarkdownText(primary, typeof payload === 'string'
      ? payload
      : String(payload?.answer || payload?.message || ''));
    container.appendChild(primary);
    const secondary = typeof payload === 'object' && payload ? payload.detail : '';
    if (secondary) {
      const detail = document.createElement('p');
      detail.className = 'result-secondary';
      detail.textContent = String(secondary);
      container.appendChild(detail);
    }
    appendReceiptStatus(container, payload);
  }

  // The receipt line mirrors the TRUE bridge status verbatim (accepted stays
  // accepted; nothing is upgraded to look finished).
  function appendReceiptStatus(container, payload) {
    if (!payload || typeof payload !== 'object' || !payload.statusLabel) return;
    const status = document.createElement('p');
    status.className = 'result-status';
    status.dataset.status = String(payload.status || 'unknown');
    status.textContent = String(payload.statusLabel);
    container.appendChild(status);
  }

  function cloneTemplate(template) {
    return template.content.firstElementChild.cloneNode(true);
  }

  function fillRow(row, text) {
    if (text) {
      row.textContent = text;
      row.hidden = false;
    } else {
      row.textContent = '';
      row.hidden = true;
    }
  }

  function calendarTimeRange(payload) {
    if (payload.timeRange) return String(payload.timeRange);
    const start = payload.start ? String(payload.start) : '';
    const end = payload.end ? String(payload.end) : '';
    if (start && end) return `${start} – ${end}`;
    return start || end || '';
  }

  function renderCalendarDraft(container, payload) {
    const card = cloneTemplate(tplCalendarDraft);
    card.querySelector('.card-title').textContent = String(payload.title || '(未命名日程)');
    fillRow(card.querySelector('.card-time'), calendarTimeRange(payload));
    fillRow(card.querySelector('.card-location'), payload.location ? `地点:${payload.location}` : '');
    fillRow(card.querySelector('.card-conflict'), payload.conflict ? `冲突:${payload.conflict}` : '');
    const statusLine = card.querySelector('.card-status');
    const rawStatus = typeof payload.status === 'string' && payload.status ? payload.status : 'draft';
    // Unknown statuses render verbatim rather than being upgraded to a
    // friendlier label — the status line mirrors the true receipt state.
    statusLine.textContent = RECEIPT_STATUS_LABELS[rawStatus] || rawStatus;
    statusLine.dataset.status = RECEIPT_STATUS_LABELS[rawStatus] ? rawStatus : 'unknown';
    container.appendChild(card);
  }

  function renderTableCompare(container, payload) {
    const card = cloneTemplate(tplTableCompare);
    const sources = Array.isArray(payload.sources) ? payload.sources.slice(0, 2).map(String) : [];
    card.querySelector('.card-sources').textContent = sources.length === 2
      ? `${sources[0]} ↔ ${sources[1]}`
      : sources[0] || '两个来源对比';
    const count = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
    card.querySelector('.count-added').textContent = `新增 ${count(payload.added)}`;
    card.querySelector('.count-removed').textContent = `删除 ${count(payload.removed)}`;
    card.querySelector('.count-changed').textContent = `变更 ${count(payload.changed)}`;
    const body = card.querySelector('tbody');
    const samples = Array.isArray(payload.samples) ? payload.samples.slice(0, 3) : [];
    samples.forEach((sample) => {
      const cells = Array.isArray(sample?.cells) ? sample.cells.slice(0, 4) : [];
      if (!cells.length) return;
      const row = document.createElement('tr');
      const type = sample.type === 'added' || sample.type === 'removed' ? sample.type : 'changed';
      row.className = `row-${type}`;
      cells.forEach((cell) => {
        const td = document.createElement('td');
        td.textContent = String(cell);
        row.appendChild(td);
      });
      body.appendChild(row);
    });
    if (!body.children.length) card.querySelector('.compare-table').hidden = true;
    container.appendChild(card);
  }

  function renderTextDraft(container, payload) {
    const card = cloneTemplate(tplTextDraft);
    card.querySelector('.card-title').textContent = String(payload.title || '文本草稿');
    const diffBox = card.querySelector('.card-diff');
    const original = String(payload.original || '');
    const proposed = String(payload.proposed || '');
    if (typeof machine.wordDiff === 'function') {
      machine.wordDiff(original, proposed).forEach((segment) => {
        const span = document.createElement('span');
        span.className = segment.type === 'ins' ? 'diff-ins'
          : segment.type === 'del' ? 'diff-del' : 'diff-eq';
        span.textContent = segment.text;
        diffBox.appendChild(span);
      });
    } else {
      diffBox.textContent = proposed;
    }
    appendReceiptStatus(card, payload);
    container.appendChild(card);
  }

  function safeAgentSession(raw) {
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

  function loadAgentSessions(promptKey) {
    if (agentPromptUi.loading || !api || typeof api.listAgentSessions !== 'function') return;
    agentPromptUi.loading = true;
    api.listAgentSessions(session.token).then((result) => {
      if (agentPromptUi.key !== promptKey) return;
      const sessions = Array.isArray(result?.sessions) ? result.sessions : [];
      const seen = new Set();
      agentPromptUi.sessions = sessions.flatMap((raw) => {
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

  function renderAgentPromptDraft(container, payload) {
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
    const editor = draft.querySelector('.agent-prompt-editor');
    const note = draft.querySelector('.agent-prompt-note');
    const sessionsRow = draft.querySelector('.agent-session-row');
    const close = draft.querySelector('.agent-prompt-close');
    const confirm = draft.querySelector('.agent-prompt-confirm');
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
  function renderActions(container, payload) {
    const actions = payload && typeof payload === 'object' && Array.isArray(payload.actions)
      ? payload.actions.slice(0, 3)
      : [];
    if (!actions.length) return;
    const row = document.createElement('div');
    row.className = 'stage-actions';
    actions.forEach((action) => {
      if (!action || typeof action !== 'object') return;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = action.kind === 'context' ? 'stage-action is-context' : 'stage-action';
      button.textContent = String(action.label || '执行');
      button.addEventListener('click', () => {
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
        } else if (action.kind === 'context') {
          if (api && typeof api.contextAction === 'function') {
            api.contextAction({ id: action.id, selectionSessionToken: session.token });
          }
        }
      });
      row.appendChild(button);
    });
    container.appendChild(row);
  }

  // Copy the answers, not the scaffolding: the ask labels are there to orient
  // the reader on screen, and the wait dots are not content at all.
  function resultPlainText(container) {
    const clone = container.cloneNode(true);
    clone.querySelectorAll('button, .turn-ask, .turn-wait').forEach((node) => node.remove());
    return (clone.textContent || '')
      .split('\n')
      .map((line) => line.trimEnd())
      .join('\n')
      .trim();
  }

  function copyResultText(container, button) {
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

  function fallbackCopyText(text, done) {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    try { document.execCommand('copy'); done(); } catch (_) { /* clipboard unavailable */ }
    document.body.removeChild(area);
  }

  // The thread bar replaces the per-answer toolbar: with the composer always
  // live underneath, a "追问" button is redundant — you just type.
  threadCopy.addEventListener('click', () => copyResultText(resultCard, threadCopy));
  // 填入 sends exactly what is on screen, so an answer the user edited or
  // re-asked is what travels. Whether it can actually be written -- and whether
  // the write can be confirmed -- is decided in the main process and Python; the
  // reply arrives as a normal turn saying what really happened.
  threadInsert.addEventListener('click', () => {
    const text = resultPlainText(resultCard);
    if (!text) return;
    if (!api || typeof api.insertResultText !== 'function') return;
    const original = threadInsert.textContent;
    threadInsert.disabled = true;
    threadInsert.textContent = '填入中';
    setTimeout(() => {
      threadInsert.disabled = false;
      threadInsert.textContent = original;
    }, 1600);
    api.insertResultText({ text, selectionSessionToken: session.token });
  });
  threadClose.addEventListener('click', () => dispatch({ type: 'DISMISS' }));

  // Result payloads are discriminated by `kind`; anything unknown falls back
  // to the plain inline text rendering.
  function renderStructured(container, payload) {
    container.replaceChildren();
    const kind = payload && typeof payload === 'object' ? payload.kind : null;
    container.dataset.kind = kind || 'inline';
    if (kind === 'calendar-draft') renderCalendarDraft(container, payload);
    else if (kind === 'table-compare') renderTableCompare(container, payload);
    else if (kind === 'text-draft') renderTextDraft(container, payload);
    else if (kind === 'agent-prompt-draft') renderAgentPromptDraft(container, payload);
    else renderInline(container, payload);
    if (kind !== 'agent-prompt-draft') renderActions(container, payload);
  }

  function buildTurn(turn) {
    const node = tplThreadTurn.content.firstElementChild.cloneNode(true);
    node.dataset.turnId = String(turn.id);
    node.dataset.status = turn.status;
    const ask = node.querySelector('.turn-ask');
    const answer = node.querySelector('.turn-answer');
    if (turn.ask) ask.textContent = turn.ask;
    else ask.hidden = true;
    if (turn.status === 'pending') {
      answer.appendChild(tplTurnWait.content.firstElementChild.cloneNode(true));
    } else if (turn.status === 'failed') {
      answer.dataset.kind = 'error';
      renderInline(answer, turn.error);
    } else {
      renderStructured(answer, turn.result);
    }
    return node;
  }

  // A spinner that never says how long it has been spinning is how a two
  // minute stall reads as identical to a two second one. The elapsed seconds
  // are the only honest progress signal we have.
  function syncWaitClock(hasPending) {
    if (!hasPending) {
      if (waitTimer) clearInterval(waitTimer);
      waitTimer = null;
      waitStartedAt = 0;
      return;
    }
    if (!waitStartedAt) waitStartedAt = Date.now();
    const paint = () => {
      const label = resultCard.querySelector('.thread-turn[data-status="pending"] .turn-elapsed');
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
  function renderThread(turns) {
    const signature = turns.map((turn) => `${turn.id}:${turn.status}`).join(',');
    if (signature !== renderedTurnSignature) {
      renderedTurnSignature = signature;
      const existing = new Map();
      for (const node of resultCard.children) existing.set(node.dataset.turnId, node);
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
    syncWaitClock(pending);
    // The handle only means something over a finished text answer: there is
    // nothing to lengthen while a turn is still running, and a card result
    // (calendar draft, table diff) is not prose to stretch.
    if (stretchBar) {
      const newest = turns[turns.length - 1];
      const kind = newest?.result?.kind;
      const isProse = kind === undefined || kind === null || kind === 'inline';
      const stretchable = Boolean(stretchPolicy) && !pending && newest?.status === 'done' && isProse;
      stretchBar.hidden = !stretchable;
      if (!stretchable && stretchHint) stretchHint.textContent = '';
    }
  }

  function clearChips() {
    renderedChipIds = '';
    chipsBox.replaceChildren();
    chipsBox.hidden = true;
  }

  function buildChip(chip) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'stage-chip';
    button.textContent = String(chip.label || chip.id);
    button.addEventListener('click', () => {
      // A chip is a canned command: it submits through the same path as
      // typed/spoken input (policy owns the chip -> command mapping).
      const policy = globalThis.StageChipsPolicy;
      const command = policy && typeof policy.commandForChip === 'function'
        ? policy.commandForChip(chip.id)
        : null;
      if (command) submitCommand(command);
    });
    return button;
  }

  // Chips: click-selected object + idle capsule only; first keystroke or
  // voice mode hides them (policy owns the rule). Defensive: no policy
  // module loaded -> no chips, ever.
  function renderChips(allowed) {
    const policy = globalThis.StageChipsPolicy;
    let chips = [];
    if (allowed && policy
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
    const anchor = capsule.getBoundingClientRect();
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
  function renderDelivery(name) {
    const progress = state.deliveryProgress;
    const anchorEl = name === 'processing' ? capsule : name === 'result' ? threadPanel : null;
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
      chipsBox, deliveryBox].forEach((el) => {
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

    const capsuleOpen = name === 'capsule-voice' || name === 'capsule-text' || name === 'processing'
      || name === 'result' || name === 'error'
      || (name === 'dismissing' && !capsule.hidden);
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
      capsule.dataset.phase = name === 'processing' ? 'processing' : 'input';
      // Once submitted, the question lives in the thread. Emptying the field
      // here is what makes the composer feel like a composer instead of a box
      // still holding the thing you already sent.
      if (name === 'processing' || name === 'result' || name === 'error') capsuleInput.value = '';
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
    // Chips only while the capsule is awaiting input (never during processing).
    renderChips(name === 'capsule-voice' || name === 'capsule-text');

    // The thread is driven by `turns`, not by the latest result, so a question
    // and its answer stay on screen once a follow-up is under way.
    if (state.turns.length && name !== 'hidden') {
      renderThread(state.turns);
      threadPanel.hidden = false;
      anchorThreadToCapsule();
    } else {
      threadPanel.hidden = true;
      renderedTurnSignature = '';
      resultCard.replaceChildren();
      syncWaitClock(false);
    }

    // Errors that belong to a turn already render inside the thread. The
    // standalone card is only for failures with no thread to attach to.
    if (name === 'error' && !state.turns.length) {
      errorCard.replaceChildren();
      renderInline(errorCard, state.error);
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
  function renderModelNotice(name) {
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
    const rect = capsule.getBoundingClientRect();
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
    if (event.animationName === 'stage-capsule-expand') capsule.classList.remove('is-entering');
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

  function applyMeta(payload) {
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

  function applySession(payload) {
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
        session.visualTuning[name] = Number.isFinite(value) ? value : fallback;
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
      session.resultPlacement = null;
      session.resultDragged = false;
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
