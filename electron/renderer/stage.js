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
  if (!machine || !anchor) return;
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
  const chipsBox = document.getElementById('stage-chips');
  const deliveryBox = document.getElementById('delivery-progress');
  const deliveryLabel = document.getElementById('delivery-label');
  const deliveryBar = document.getElementById('delivery-bar');
  const deliveryCount = document.getElementById('delivery-count');
  const tplCalendarDraft = document.getElementById('tpl-calendar-draft');
  const tplTableCompare = document.getElementById('tpl-table-compare');
  const tplTextDraft = document.getElementById('tpl-text-draft');

  const CAPSULE_VOICE_WIDTH = 40;
  const CAPSULE_TEXT_WIDTH = 144;
  const CAPSULE_MAX_WIDTH = 440;
  const DISMISS_FADE_MS = 160;

  const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  let state = initialState({ reducedMotion: reducedMotionQuery.matches });
  let renderedTranscript = '';
  let dismissTimer = null;
  let hasShown = false;
  // Selection metadata rides on stage:show/stage:update payloads (not the
  // machine): the chips policy needs it, the lifecycle does not.
  const meta = { selectionSource: null, objectKind: null };
  let renderedChipIds = '';
  // Live wiring context from main (stage:show / stage:update payloads).
  const session = { token: null, voiceAutoSubmit: true, pointer: null };
  const textCanvas = document.createElement('canvas');
  const textMeasure = textCanvas.getContext('2d');
  let dictationActive = false;
  let mouseCaptureOn = false;
  let reportedState = '';

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

  // Side effects that follow the machine, not the DOM: dictation lifecycle,
  // main-process mouse capture (the stage window is click-through by default),
  // and state reporting for the main-process log.
  function syncEffects() {
    const name = state.name;
    const wantDictation = name === 'capsule-voice';
    if (wantDictation && !dictationActive) {
      dictationActive = true;
      if (api && typeof api.startDictation === 'function') api.startDictation();
    } else if (!wantDictation && dictationActive) {
      dictationActive = false;
      if (api && typeof api.stopDictation === 'function') api.stopDictation();
    }
    const chipsVisible = !chipsBox.hidden;
    const wantCapture = name === 'capsule-text' || name === 'result' || name === 'error' || chipsVisible;
    if (wantCapture !== mouseCaptureOn) {
      mouseCaptureOn = wantCapture;
      if (api && typeof api.setMouseCapture === 'function') api.setMouseCapture(wantCapture);
    }
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
    transcriptBox.textContent = '';
  }

  function renderTranscript() {
    const text = state.transcript || '';
    if (text === renderedTranscript) return;
    // A single text node avoids thousands of spans during streaming dictation.
    transcriptBox.textContent = text;
    renderedTranscript = text;
  }

  function syncCapsuleWidth() {
    const mode = state.inputMode === 'text' ? 'text' : 'voice';
    const base = mode === 'text' ? CAPSULE_TEXT_WIDTH : CAPSULE_VOICE_WIDTH;
    const content = state.transcript || capsuleInput.value || '';
    const style = window.getComputedStyle(transcriptBox);
    if (textMeasure) textMeasure.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const measured = textMeasure ? textMeasure.measureText(content).width : content.length * 8;
    const grown = content ? measured + 58 : base;
    capsule.style.width = `${Math.min(CAPSULE_MAX_WIDTH, Math.max(base, grown))}px`;
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

  function renderInline(container, payload) {
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
    targetingOutline.classList.remove('is-visible');
    [targetingOutline, frozenGlow, capsule, shimmer, resultCard, errorCard,
      chipsBox, deliveryBox].forEach((el) => {
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
      if (api && hasShown && typeof api.hidden === 'function') api.hidden();
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
      renderTranscript();
      syncCapsuleWidth();
      anchorNearPointer(capsule, CAPSULE_TEXT_WIDTH, 44);
      if (name === 'capsule-text') capsuleInput.focus();
    } else {
      clearTranscript();
      capsuleInput.value = '';
    }
    shimmer.hidden = name !== 'processing';
    // Chips only while the capsule is awaiting input (never during processing).
    renderChips(name === 'capsule-voice' || name === 'capsule-text');

    if (name === 'result') {
      renderStructured(resultCard, state.result);
      anchorNearPointer(resultCard, 300, 44);
      resultCard.hidden = false;
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

  capsuleInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && capsuleInput.value.trim()) {
      submitCommand(capsuleInput.value);
    } else if (event.key === 'Escape') {
      requestDismiss();
    }
  });

  // Clicking anywhere that is not an interactive surface dismisses the stage
  // (only reachable while main has granted mouse capture; the root itself is
  // pointer-events:none, so listen at the document level).
  document.addEventListener('pointerdown', (event) => {
    if (!mouseCaptureOn) return;
    const interactive = event.target instanceof Element
      && event.target.closest('#capsule, #stage-result, #stage-error, #stage-chips, #delivery-progress');
    if (!interactive) requestDismiss();
  });
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') requestDismiss();
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
    if (payload.pointer && Number.isFinite(Number(payload.pointer.x)) && Number.isFinite(Number(payload.pointer.y))) {
      session.pointer = { x: Number(payload.pointer.x), y: Number(payload.pointer.y) };
    }
  }

  if (api) {
    api.onShow((payload) => {
      state = initialState({ reducedMotion: reducedMotionQuery.matches });
      renderedTranscript = '';
      reportedState = '';
      session.token = null;
      session.voiceAutoSubmit = true;
      session.pointer = null;
      meta.selectionSource = null;
      meta.objectKind = null;
      applySession(payload);
      applyMeta(payload);
      dispatch({ type: 'WAKE', target: payload?.target || null });
      if (payload?.event) dispatch(payload.event);
    });
    api.onUpdate((payload) => {
      applySession(payload);
      const metaChanged = applyMeta(payload);
      if (payload?.deliveryProgress) {
        // Only legal in processing/result; the machine drops it elsewhere.
        dispatch({ type: 'DELIVERY_PROGRESS', progress: payload.deliveryProgress });
      }
      if (payload?.event) dispatch(payload.event);
      if (metaChanged && state.name !== 'hidden') {
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
      const transcript = typeof payload.transcript === 'string' ? payload.transcript : '';
      if (!transcript) return;
      dispatch({ type: 'TRANSCRIPT', transcript });
      if (payload.final === true) {
        if (session.voiceAutoSubmit) {
          submitCommand(transcript);
        } else {
          // No auto-submit: hand the transcript to the text capsule for review.
          dispatch({ type: 'OPEN_CAPSULE', mode: 'text' });
          capsuleInput.value = transcript;
          syncCapsuleWidth();
        }
      }
    });
  }

  render();
})();
