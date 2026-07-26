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
  if (!machine) return;
  const { initialState, transition } = machine;
  const api = window.magicPointerStage;

  const stageRoot = document.getElementById('stage');
  const targetingOutline = document.getElementById('targeting-outline');
  const frozenGlow = document.getElementById('frozen-glow');
  const capsule = document.getElementById('capsule');
  const capsuleInput = document.getElementById('capsule-input');
  const transcriptBox = document.getElementById('transcript');
  const shimmer = document.getElementById('processing-shimmer');
  const resultCard = document.getElementById('stage-result');
  const errorCard = document.getElementById('stage-error');

  const LETTER_STAGGER_MS = 30;
  const CAPSULE_VOICE_WIDTH = 72;
  const CAPSULE_TEXT_WIDTH = 176;
  const CAPSULE_MAX_WIDTH = 560;
  const DISMISS_FADE_MS = 160;

  const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  let state = initialState({ reducedMotion: reducedMotionQuery.matches });
  let renderedTranscript = '';
  let dismissTimer = null;
  let hasShown = false;

  reducedMotionQuery.addEventListener('change', (event) => {
    dispatch({ type: 'SET_REDUCED_MOTION', value: event.matches });
  });

  function dispatch(event) {
    const next = transition(state, event);
    if (next === state) return;
    state = next;
    render();
  }

  function placeRect(element, rect) {
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

  function anchorBelowTarget(element, offsetY = 12) {
    const rect = state.target;
    const x = rect ? rect.x : Math.round(window.innerWidth / 2 - 100);
    const y = rect ? rect.y + rect.height + offsetY : Math.round(window.innerHeight / 2);
    element.style.left = `${Math.max(8, Math.min(x, window.innerWidth - 200))}px`;
    element.style.top = `${Math.max(8, Math.min(y, window.innerHeight - 60))}px`;
  }

  function clearTranscript() {
    renderedTranscript = '';
    transcriptBox.replaceChildren();
  }

  function renderTranscript() {
    const text = state.transcript || '';
    if (text === renderedTranscript) return;
    if (!text.startsWith(renderedTranscript)) clearTranscript();
    const fresh = Array.from(text).slice(Array.from(renderedTranscript).length);
    fresh.forEach((letter, index) => {
      const span = document.createElement('span');
      span.className = 'fly-letter';
      span.textContent = letter;
      // Reduced motion: fly-in is disabled in CSS; skip the stagger so the
      // text appears immediately as a plain opacity change.
      if (!state.config.reducedMotion) {
        span.style.animationDelay = `${index * LETTER_STAGGER_MS}ms`;
      }
      transcriptBox.appendChild(span);
    });
    renderedTranscript = text;
  }

  function syncCapsuleWidth() {
    const mode = state.inputMode === 'text' ? 'text' : 'voice';
    const base = mode === 'text' ? CAPSULE_TEXT_WIDTH : CAPSULE_VOICE_WIDTH;
    const content = state.transcript || capsuleInput.value || '';
    const grown = base + Array.from(content).length * 9;
    capsule.style.width = `${Math.min(CAPSULE_MAX_WIDTH, Math.max(base, grown))}px`;
  }

  function renderStructured(container, payload) {
    container.replaceChildren();
    const primary = document.createElement('p');
    primary.textContent = typeof payload === 'string'
      ? payload
      : String(payload?.answer || payload?.message || '');
    container.appendChild(primary);
    const secondary = typeof payload === 'object' && payload ? payload.detail : '';
    if (secondary) {
      const detail = document.createElement('p');
      detail.className = 'result-secondary';
      detail.textContent = String(secondary);
      container.appendChild(detail);
    }
  }

  function clearAll() {
    clearTranscript();
    resultCard.replaceChildren();
    errorCard.replaceChildren();
    capsuleInput.value = '';
    targetingOutline.classList.remove('is-visible');
    [targetingOutline, frozenGlow, capsule, shimmer, resultCard, errorCard].forEach((el) => {
      el.hidden = true;
    });
  }

  function render() {
    const name = state.name;
    stageRoot.dataset.state = name;

    if (name === 'hidden') {
      // Empty state renders nothing: zero dynamic DOM content while hidden.
      clearAll();
      stageRoot.hidden = true;
      if (api && hasShown) api.hide();
      hasShown = false;
      return;
    }

    stageRoot.hidden = false;
    hasShown = true;

    const showTargeting = name === 'targeting';
    if (showTargeting && state.target) {
      placeRect(targetingOutline, state.target);
      requestAnimationFrame(() => targetingOutline.classList.add('is-visible'));
    } else {
      targetingOutline.classList.remove('is-visible');
      targetingOutline.hidden = true;
    }

    const showGlow = name === 'frozen' || name === 'capsule-voice'
      || name === 'capsule-text' || name === 'processing';
    if (showGlow && state.target) placeRect(frozenGlow, state.target);
    else frozenGlow.hidden = true;

    const capsuleOpen = name === 'capsule-voice' || name === 'capsule-text' || name === 'processing';
    capsule.hidden = !capsuleOpen;
    if (capsuleOpen) {
      capsule.dataset.mode = state.inputMode === 'text' ? 'text' : 'voice';
      capsule.dataset.phase = name === 'processing' ? 'processing' : 'input';
      anchorBelowTarget(capsule);
      renderTranscript();
      syncCapsuleWidth();
      if (name === 'capsule-text') capsuleInput.focus();
    } else {
      clearTranscript();
      capsuleInput.value = '';
    }
    shimmer.hidden = name !== 'processing';

    if (name === 'result') {
      renderStructured(resultCard, state.result);
      anchorBelowTarget(resultCard);
      resultCard.hidden = false;
    } else {
      resultCard.hidden = true;
    }

    if (name === 'error') {
      renderStructured(errorCard, state.error);
      anchorBelowTarget(errorCard);
      errorCard.hidden = false;
    } else {
      errorCard.hidden = true;
    }

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

  capsuleInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && capsuleInput.value.trim()) {
      dispatch({ type: 'SUBMIT', command: capsuleInput.value.trim() });
    } else if (event.key === 'Escape') {
      dispatch({ type: 'DISMISS' });
    }
  });

  if (api) {
    api.onShow((payload) => {
      state = initialState({ reducedMotion: reducedMotionQuery.matches });
      dispatch({ type: 'WAKE', target: payload?.target || null });
      if (payload?.event) dispatch(payload.event);
    });
    api.onUpdate((payload) => {
      if (payload?.event) dispatch(payload.event);
    });
    api.onHide(() => {
      if (state.name === 'hidden') return;
      dispatch({ type: 'DISMISS' });
    });
  }

  render();
})();
