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
  const frozenGlow = document.getElementById('frozen-glow');
  const capsule = document.getElementById('capsule');
  const capsuleCount = document.getElementById('capsule-count');
  const capsuleInput = document.getElementById('capsule-input');
  const transcriptBox = document.getElementById('transcript');
  const shimmer = document.getElementById('processing-shimmer');
  const resultCard = document.getElementById('stage-result');
  const errorCard = document.getElementById('stage-error');
  const chipsBox = document.getElementById('stage-chips');
  const deliveryBox = document.getElementById('delivery-progress');
  const deliveryLabel = document.getElementById('delivery-label');
  const deliveryBar = document.getElementById('delivery-bar');
  const deliveryCount = document.getElementById('delivery-count');
  const tplCalendarDraft = document.getElementById('tpl-calendar-draft');
  const tplTableCompare = document.getElementById('tpl-table-compare');
  const tplTextDraft = document.getElementById('tpl-text-draft');

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
    const next = transition(state, event);
    if (next === state) return;
    state = next;
    render();
    syncEffects();
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

  function handleVoicePointerInput(payload) {
    const t = Number(payload?.t);
    const x = Number(payload?.x);
    const y = Number(payload?.y);
    const buttons = Number(payload?.buttons || 0);
    if (![t, x, y, buttons].every(Number.isFinite)) return;
    lastPointerPoint = { x, y };
    syncHitRegions();
    const capsuleRect = capsule.getBoundingClientRect();
    const overCapsule = !capsule.hidden
      && x >= capsuleRect.left && x <= capsuleRect.right
      && y >= capsuleRect.top && y <= capsuleRect.bottom;
    const primaryDown = (buttons & 1) !== 0;
    const previousPrimaryDown = (previousPointerButtons & 1) !== 0;
    const resultRect = resultCard.getBoundingClientRect();
    const overResult = state.name === 'result' && !resultCard.hidden
      && x >= resultRect.left && x <= resultRect.right
      && y >= resultRect.top && y <= resultRect.bottom;
    if (overResult && primaryDown && !previousPrimaryDown && !surfaceDrag) {
      const overAction = [...resultCard.querySelectorAll('button:not([disabled])')].some((button) => {
        const rect = button.getBoundingClientRect();
        return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
      });
      if (!overAction) {
        surfaceDrag = { element: resultCard, startX: x, startY: y, originLeft: resultRect.left, originTop: resultRect.top };
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
      surfaceDrag = null;
      session.resultDragged = true;
    }
    // Drag the capsule: press on its body (not inside the text input) and move.
    if (overCapsule && primaryDown && !previousPrimaryDown && !capsuleDrag) {
      const inputRect = capsuleInput.getBoundingClientRect();
      const overInput = x >= inputRect.left && x <= inputRect.right && y >= inputRect.top && y <= inputRect.bottom;
      if (!overInput) {
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
    if (name === 'result') return !resultCard.hidden;
    const hasEnabledButton = (element) => !element.hidden
      && Boolean(element.querySelector('button:not([disabled])'));
    return hasEnabledButton(chipsBox)
      || hasEnabledButton(resultCard)
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
    return [targetingOutline, frozenGlow, capsule, resultCard, errorCard, chipsBox, deliveryBox]
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
    if (state.name === 'capsule-text') {
      if (!capsule.hidden && !capsuleInput.disabled) elements.push(capsule);
    } else if (state.name === 'capsule-voice') {
      if (!capsule.hidden) elements.push(capsule);
    }
    if (state.name === 'result' && !resultCard.hidden) elements.push(resultCard);
    for (const container of [chipsBox, resultCard, errorCard]) {
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
    const hasInteractiveSurface = name === 'capsule-text' || name === 'result' || name === 'error'
      ? hasInteractiveStageSurface()
      : !chipsBox.hidden && hasInteractiveStageSurface();
    const interactiveRegions = interactiveStageRegions();
    const wantCapture = hitPolicy.shouldCaptureMouse({
      hasInteractiveSurface,
      pointer: lastPointerPoint,
      interactiveRegions,
    });
    const requestFocus = name === 'capsule-text';
    const regions = visibleStageRegions();
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
    dispatch({ type: 'SUBMIT', command: trimmed });
    if (state.name !== 'processing') return;
    if (api && typeof api.submitSelectionCommand === 'function') {
      api.submitSelectionCommand({
        selectionSessionToken: session.token,
        command: trimmed,
        inputMode,
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
      const baseWidth = Number.parseFloat(window.getComputedStyle(capsule).getPropertyValue('--capsule-base-width')) || rect.width;
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

  function anchorBelowTarget(element, offsetY = 12) {
    const rect = state.target;
    const x = rect ? rect.x : Math.round(window.innerWidth / 2 - 100);
    const y = rect ? rect.y + rect.height + offsetY : Math.round(window.innerHeight / 2);
    element.style.left = `${Math.max(8, Math.min(x, window.innerWidth - 200))}px`;
    element.style.top = `${Math.max(8, Math.min(y, window.innerHeight - 60))}px`;
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

  function anchorResultToCapsule(element) {
    if (session.resultDragged && session.resultPlacement) {
      element.style.left = `${session.resultPlacement.x}px`;
      element.style.top = `${session.resultPlacement.y}px`;
      return;
    }
    const rect = element.getBoundingClientRect();
    const fallback = session.capsulePlacement || session.pointer || { x: 8, y: 8 };
    const width = rect.width || Math.min(360, window.innerWidth - 16);
    const height = rect.height || 80;
    const x = Math.max(8, Math.min(fallback.x, window.innerWidth - width - 8));
    const y = Math.max(8, Math.min(fallback.y, window.innerHeight - height - 8));
    element.style.left = `${x}px`;
    element.style.top = `${y}px`;
    element.dataset.quadrant = session.capsulePlacement?.quadrant || 'bottom-right';
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

  // Result payloads are discriminated by `kind`; anything unknown falls back
  // to the plain inline text rendering.
  function renderStructured(container, payload) {
    container.replaceChildren();
    const kind = payload && typeof payload === 'object' ? payload.kind : null;
    if (kind === 'calendar-draft') renderCalendarDraft(container, payload);
    else if (kind === 'table-compare') renderTableCompare(container, payload);
    else if (kind === 'text-draft') renderTextDraft(container, payload);
    else renderInline(container, payload);
    renderActions(container, payload);
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
    const anchorEl = name === 'processing' ? capsule : name === 'result' ? resultCard : null;
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
    if (hitRegionRefreshTimer) clearTimeout(hitRegionRefreshTimer);
    hitRegionRefreshTimer = null;
    if (targetSweepTimer) clearTimeout(targetSweepTimer);
    targetSweepTimer = null;
    targetingOutline.classList.remove('is-visible');
    capsule.classList.remove('is-entering', 'is-exiting');
    [targetingOutline, frozenGlow, capsule, shimmer, resultCard, errorCard,
      chipsBox, deliveryBox].forEach((el) => {
      el.hidden = true;
    });
  }

  function render() {
    const name = state.name;
    stageRoot.dataset.state = name;
    stageRoot.dataset.selectionVisual = session.selectionVisual;
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
      || (name === 'dismissing' && !capsule.hidden);
    if (capsuleOpen) {
      if (session.selectionCount > 1) {
        capsuleCount.textContent = `${session.selectionCount} 处`;
        capsuleCount.hidden = false;
      } else {
        capsuleCount.hidden = true;
      }
      const capsuleWasHidden = capsule.hidden;
      if (name === 'dismissing') {
        capsule.classList.remove('is-entering');
        capsule.classList.add('is-exiting');
      } else if (capsuleWasHidden) {
        capsule.classList.remove('is-exiting');
        capsule.classList.add('is-entering');
      }
      capsule.dataset.mode = state.inputMode === 'text' ? 'text' : 'voice';
      capsule.dataset.phase = name === 'processing' ? 'processing' : 'input';
      renderTranscript();
      const capsuleWidth = syncCapsuleWidth();
      anchorCapsuleToTarget(capsuleWidth);
      // Coordinates are committed before the element becomes paintable, so a
      // new session can never expose the browser's default (0,0) position.
      if (capsuleWasHidden) capsule.hidden = false;
      scheduleHitRegionRefresh();
      if (name === 'capsule-text') capsuleInput.focus();
    } else {
      capsule.hidden = true;
      clearTranscript();
      capsuleInput.value = '';
    }
    shimmer.hidden = name !== 'processing';
    // Chips only while the capsule is awaiting input (never during processing).
    renderChips(name === 'capsule-voice' || name === 'capsule-text');

    if (name === 'result') {
      renderStructured(resultCard, state.result);
      resultCard.hidden = false;
      anchorResultToCapsule(resultCard);
    } else {
      resultCard.hidden = true;
    }

    if (name === 'error') {
      // Error payloads always take the inline path (no card kinds).
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

    if (name === 'dismissing') {
      if (dismissTimer) clearTimeout(dismissTimer);
      const fadeMs = state.config.reducedMotion ? 0 : DISMISS_FADE_MS;
      dismissTimer = setTimeout(() => {
        dismissTimer = null;
        dispatch({ type: 'HIDDEN' });
      }, fadeMs);
    }
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
    }
    if ('capsuleDelayMs' in payload) {
      const delay = Number(payload.capsuleDelayMs);
      session.capsuleDelayMs = Number.isFinite(delay) ? Math.max(0, Math.min(1500, delay)) : null;
    }
    if (payload.pointer && Number.isFinite(Number(payload.pointer.x)) && Number.isFinite(Number(payload.pointer.y))) {
      session.pointer = { x: Number(payload.pointer.x), y: Number(payload.pointer.y) };
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
    if (typeof api.ready === 'function') api.ready();
  }

  render();
})();
