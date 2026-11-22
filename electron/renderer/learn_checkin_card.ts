'use strict';

interface LearnCheckinOption {
  label: string;
  description?: string;
  unsure?: boolean;
}

interface LearnCheckinSpec {
  id: string;
  kicker?: string;
  prompt: string;
  options: LearnCheckinOption[];
  allowUnsure?: boolean;
  allowNote?: boolean;
  notePlaceholder?: string;
  submitLabel?: string;
  answered?: {
    selectedIndex: number | null;
    selectedLabel: string;
    unsure: boolean;
    reasoningNote?: string;
  };
}

interface LearnCheckinSubmitPayload {
  id: string;
  prompt: string;
  selectedIndex: number | null;
  selectedLabel: string;
  unsure: boolean;
  reasoningNote: string;
}

interface LearnCheckinCardApi {
  render(
    spec: LearnCheckinSpec,
    handlers: {
      onSubmit: (payload: LearnCheckinSubmitPayload) => void | Promise<void>;
    },
  ): HTMLElement;
  parseBlock(rawBody: string, fallbackId?: string): LearnCheckinSpec | null;
  formatReplyForAgent(payload: LearnCheckinSubmitPayload): string;
}

declare global {
  var LearnCheckinCard: LearnCheckinCardApi | undefined;
}

(() => {
  interface OptionEntry {
    option: LearnCheckinOption;
    origIndex: number | null;
    isUnsure: boolean;
  }

  const DEFAULT_KICKER = 'CHECK-IN · 思考校验';
  const UNSURE_OPTION_LABEL =
    '我不太确定 / 没接触过（跳过猜题，直接拆解）';
  const DEFAULT_NOTE_PLACEHOLDER =
    '顺手写下你的直觉或卡在哪一步（可选，老师会针对你的思路拆解）…';
  const DEFAULT_SUBMIT_LABEL = '提交并继续';
  const MAX_NOTE_HEIGHT_PX = 108;
  const UNSURE_TEXT_RE =
    /不太确定|没接触过|不知道|跳过猜题|don'?t\s+know|not\s+sure|unsure/i;
  const MATH_SNIPPET_RE =
    /\$\$[\s\S]+?\$\$|\$[^$\n]+?\$|\\\([\s\S]+?\\\)|\\\[[\s\S]+?\\\]/;

  function el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string,
    text?: string,
  ): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (className) {
      node.className = className;
    }
    if (text !== undefined) {
      node.textContent = text;
    }
    return node;
  }

  function readNonEmptyString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
  }

  function isUnsureText(text: string): boolean {
    return UNSURE_TEXT_RE.test(text);
  }

  function stableBlockId(prompt: string): string {
    let hash = 2166136261;
    for (let i = 0; i < prompt.length; i += 1) {
      hash ^= prompt.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return `checkin-${(hash >>> 0).toString(36)}`;
  }

  function summarizeText(text: string, maxLen: number): string {
    const compact = String(text || '')
      .replace(/\s+/g, ' ')
      .trim();
    if (compact.length <= maxLen) {
      return compact;
    }
    let cut = compact.slice(0, maxLen).trimEnd();
    // Avoid slicing inside an unclosed inline $...$ TeX span.
    let dollarCount = 0;
    let lastOpenDollar = -1;
    for (let i = 0; i < cut.length; i += 1) {
      if (cut[i] === '$' && (i === 0 || cut[i - 1] !== '\\')) {
        dollarCount += 1;
        if (dollarCount % 2 === 1) {
          lastOpenDollar = i;
        }
      }
    }
    if (dollarCount % 2 === 1 && lastOpenDollar > 12) {
      cut = cut.slice(0, lastOpenDollar).trimEnd();
    }
    return `${cut}…`;
  }

  function getMarkdownRenderer(): ((src: string) => Element) | null {
    const g = globalThis as unknown as {
      ChatMarkdown?: {render?: (s: string) => Element};
    };
    if (g.ChatMarkdown && typeof g.ChatMarkdown.render === 'function') {
      return g.ChatMarkdown.render.bind(g.ChatMarkdown);
    }
    if (
      typeof ChatMarkdown !== 'undefined' &&
      typeof ChatMarkdown.render === 'function'
    ) {
      return ChatMarkdown.render.bind(ChatMarkdown);
    }
    return null;
  }

  function renderRichContent(
    target: HTMLElement,
    text: string,
    onlyWhenMath: boolean,
  ): void {
    if (!text) {
      return;
    }
    const renderMd = getMarkdownRenderer();
    if (renderMd && (!onlyWhenMath || MATH_SNIPPET_RE.test(text))) {
      const rendered = renderMd(text);
      if (rendered) {
        target.appendChild(rendered);
        return;
      }
    }
    target.textContent = text;
  }

  function parseBooleanFlag(raw: string): boolean | undefined {
    const norm = raw.trim().toLowerCase();
    if (norm === 'true' || norm === 'yes' || norm === '1') {
      return true;
    }
    if (norm === 'false' || norm === 'no' || norm === '0') {
      return false;
    }
    return undefined;
  }

  function parseJsonCheckin(
    body: string,
    fallbackId?: string,
  ): LearnCheckinSpec | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const obj = parsed as Record<string, unknown>;
    const prompt =
      readNonEmptyString(obj.prompt) || readNonEmptyString(obj.question);
    if (!prompt || !Array.isArray(obj.options)) {
      return null;
    }

    const options: LearnCheckinOption[] = [];
    for (const item of obj.options) {
      if (typeof item === 'string') {
        const label = item.trim();
        if (label) {
          options.push(
            isUnsureText(label) ? {label, unsure: true} : {label},
          );
        }
        continue;
      }
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        continue;
      }
      const optObj = item as Record<string, unknown>;
      const label =
        readNonEmptyString(optObj.label) ||
        readNonEmptyString(optObj.text) ||
        readNonEmptyString(optObj.title);
      if (!label) {
        continue;
      }
      const description =
        readNonEmptyString(optObj.description) ||
        readNonEmptyString(optObj.desc);
      const unsure =
        typeof optObj.unsure === 'boolean'
          ? optObj.unsure
          : isUnsureText(label);
      const option: LearnCheckinOption = {label};
      if (description) {
        option.description = description;
      }
      if (unsure) {
        option.unsure = true;
      }
      options.push(option);
    }

    if (options.length === 0) {
      return null;
    }

    const spec: LearnCheckinSpec = {
      id:
        readNonEmptyString(obj.id) ||
        readNonEmptyString(fallbackId) ||
        stableBlockId(prompt),
      prompt,
      options,
    };
    const kicker =
      readNonEmptyString(obj.kicker) || readNonEmptyString(obj.type);
    if (kicker) {
      spec.kicker = kicker;
    }
    if (typeof obj.allowUnsure === 'boolean') {
      spec.allowUnsure = obj.allowUnsure;
    }
    if (typeof obj.allowNote === 'boolean') {
      spec.allowNote = obj.allowNote;
    }
    const notePlaceholder = readNonEmptyString(obj.notePlaceholder);
    if (notePlaceholder) {
      spec.notePlaceholder = notePlaceholder;
    }
    const submitLabel = readNonEmptyString(obj.submitLabel);
    if (submitLabel) {
      spec.submitLabel = submitLabel;
    }
    if (
      obj.answered &&
      typeof obj.answered === 'object' &&
      !Array.isArray(obj.answered)
    ) {
      const ans = obj.answered as Record<string, unknown>;
      const selectedIndex =
        typeof ans.selectedIndex === 'number' &&
        Number.isInteger(ans.selectedIndex)
          ? ans.selectedIndex
          : null;
      const selectedLabel = readNonEmptyString(ans.selectedLabel);
      const unsure = Boolean(ans.unsure);
      const reasoningNote = readNonEmptyString(ans.reasoningNote);
      if (selectedLabel || unsure || reasoningNote) {
        spec.answered = {
          selectedIndex,
          selectedLabel,
          unsure,
          ...(reasoningNote ? {reasoningNote} : {}),
        };
      }
    }
    return spec;
  }

  function parseLinesCheckin(
    body: string,
    fallbackId?: string,
  ): LearnCheckinSpec | null {
    const lines = body.split('\n');
    let id = '';
    let kicker = '';
    let allowUnsure: boolean | undefined;
    let allowNote: boolean | undefined;
    let notePlaceholder = '';
    let submitLabel = '';
    let optionsStarted = false;
    const promptLines: string[] = [];
    const options: LearnCheckinOption[] = [];

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) {
        if (promptLines.length > 0 && !optionsStarted) {
          promptLines.push('');
        }
        continue;
      }

      const idMatch = /^id\s*[:：]\s*(.+)$/i.exec(line);
      if (idMatch) {
        id = idMatch[1].trim();
        continue;
      }

      const kickerMatch = /^(?:kicker|type)\s*[:：]\s*(.+)$/i.exec(line);
      if (kickerMatch) {
        kicker = kickerMatch[1].trim();
        continue;
      }

      const allowUnsureMatch =
        /^(?:allowUnsure|allow_unsure)\s*[:：]\s*(.+)$/i.exec(line);
      if (allowUnsureMatch) {
        const parsedBool = parseBooleanFlag(allowUnsureMatch[1]);
        if (parsedBool !== undefined) {
          allowUnsure = parsedBool;
          continue;
        }
      }

      const allowNoteMatch =
        /^(?:allowNote|allow_note)\s*[:：]\s*(.+)$/i.exec(line);
      if (allowNoteMatch) {
        const parsedBool = parseBooleanFlag(allowNoteMatch[1]);
        if (parsedBool !== undefined) {
          allowNote = parsedBool;
          continue;
        }
      }

      const placeholderMatch =
        /^(?:notePlaceholder|note_placeholder)\s*[:：]\s*(.+)$/i.exec(line);
      if (placeholderMatch) {
        notePlaceholder = placeholderMatch[1].trim();
        continue;
      }

      const submitMatch =
        /^(?:submitLabel|submit_label)\s*[:：]\s*(.+)$/i.exec(line);
      if (submitMatch) {
        submitLabel = submitMatch[1].trim();
        continue;
      }

      if (!optionsStarted) {
        const promptMatch = /^(?:prompt|question)\s*[:：]\s*(.*)$/i.exec(line);
        if (promptMatch) {
          const rest = promptMatch[1].trim();
          if (rest) {
            promptLines.push(rest);
          }
          continue;
        }
      }

      const unsureBulletMatch = /^[-*+]\s*\[\s*\?\s*\]\s*(.*)$/.exec(line);
      if (unsureBulletMatch) {
        optionsStarted = true;
        const label = unsureBulletMatch[1].trim() || UNSURE_OPTION_LABEL;
        options.push({label, unsure: true});
        continue;
      }

      const checkboxMatch = /^[-*+]\s*\[\s*[xX ]?\s*\]\s*(.+)$/.exec(line);
      if (checkboxMatch) {
        optionsStarted = true;
        const label = checkboxMatch[1].trim();
        options.push(isUnsureText(label) ? {label, unsure: true} : {label});
        continue;
      }

      const numberedMatch = /^\d+[.)]\s+(.+)$/.exec(line);
      if (numberedMatch) {
        optionsStarted = true;
        const label = numberedMatch[1].trim();
        options.push(isUnsureText(label) ? {label, unsure: true} : {label});
        continue;
      }

      const bulletMatch = /^[-*+]\s+(.+)$/.exec(line);
      if (bulletMatch) {
        optionsStarted = true;
        const label = bulletMatch[1].trim();
        options.push(isUnsureText(label) ? {label, unsure: true} : {label});
        continue;
      }

      if (optionsStarted && options.length > 0 && /^\s{2,}/.test(rawLine)) {
        const descMatch = /^\s{2,}desc(?:ription)?\s*[:：]\s*(.+)$/i.exec(
          rawLine,
        );
        if (descMatch) {
          options[options.length - 1].description = descMatch[1].trim();
        }
        continue;
      }

      if (!optionsStarted) {
        promptLines.push(line);
      }
    }

    const prompt = promptLines
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (!prompt || options.length === 0) {
      return null;
    }

    const spec: LearnCheckinSpec = {
      id: id || readNonEmptyString(fallbackId) || stableBlockId(prompt),
      prompt,
      options,
    };
    if (kicker) {
      spec.kicker = kicker;
    }
    if (allowUnsure !== undefined) {
      spec.allowUnsure = allowUnsure;
    }
    if (allowNote !== undefined) {
      spec.allowNote = allowNote;
    }
    if (notePlaceholder) {
      spec.notePlaceholder = notePlaceholder;
    }
    if (submitLabel) {
      spec.submitLabel = submitLabel;
    }
    return spec;
  }

  function parseBlock(
    rawBody: string,
    fallbackId?: string,
  ): LearnCheckinSpec | null {
    const normalized = String(rawBody ?? '')
      .replace(/\r\n?/g, '\n')
      .trim();
    if (!normalized) {
      return null;
    }
    const fenceMatch = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(normalized);
    const body = fenceMatch ? fenceMatch[1].trim() : normalized;
    if (!body) {
      return null;
    }
    if (body.startsWith('{')) {
      return parseJsonCheckin(body, fallbackId);
    }
    return parseLinesCheckin(body, fallbackId);
  }

  function formatReplyForAgent(payload: LearnCheckinSubmitPayload): string {
    const note = String(payload.reasoningNote || '').trim();
    const shortPrompt = summarizeText(String(payload.prompt || ''), 56);
    if (payload.unsure) {
      return `这道题我不太确定（先跳过猜题）。${note ? `我的直觉/卡点：${note}` : ''}`;
    }
    const label = String(payload.selectedLabel || '').trim();
    if (!label && note) {
      return shortPrompt
        ? `关于「${shortPrompt}」，我的思路：${note}`
        : `我的思路：${note}`;
    }
    const prefix = shortPrompt ? `关于「${shortPrompt}」，` : '';
    return `${prefix}我选「${label}」。${note ? `\n我的思路：${note}` : ''}`;
  }

  function buildOptionEntries(spec: LearnCheckinSpec): {
    regularEntries: OptionEntry[];
    unsureEntries: OptionEntry[];
  } {
    const regularEntries: OptionEntry[] = [];
    const unsureEntries: OptionEntry[] = [];
    spec.options.forEach((option, index) => {
      if (option.unsure) {
        unsureEntries.push({option, origIndex: index, isUnsure: true});
      } else {
        regularEntries.push({option, origIndex: index, isUnsure: false});
      }
    });
    if (spec.allowUnsure !== false && unsureEntries.length === 0) {
      unsureEntries.push({
        option: {label: UNSURE_OPTION_LABEL, unsure: true},
        origIndex: null,
        isUnsure: true,
      });
    }
    return {regularEntries, unsureEntries};
  }

  function render(
    spec: LearnCheckinSpec,
    handlers: {
      onSubmit: (payload: LearnCheckinSubmitPayload) => void | Promise<void>;
    },
  ): HTMLElement {
    const card = el('section', 'mp-checkin-card');
    card.dataset.checkinId = spec.id;
    card.tabIndex = -1;
    const kickerText = readNonEmptyString(spec.kicker) || DEFAULT_KICKER;
    card.setAttribute('aria-label', kickerText);

    let answeredState = spec.answered ? {...spec.answered} : null;
    let selectedIndex: number | null = answeredState
      ? answeredState.selectedIndex
      : null;
    let selectedLabel = answeredState ? answeredState.selectedLabel : '';
    let selectedUnsure = answeredState ? answeredState.unsure : false;
    let noteValue = answeredState?.reasoningNote || '';
    let submitting = false;

    let currentRegularEntries: OptionEntry[] = [];
    let currentRegularButtons: HTMLButtonElement[] = [];
    let currentUnsureEntry: OptionEntry | null = null;
    let currentUnsureButton: HTMLButtonElement | null = null;
    let currentSelectOption:
      | ((entry: OptionEntry, btn: HTMLButtonElement) => void)
      | null = null;
    let currentCanSubmit: (() => boolean) | null = null;
    let currentHandleSubmit: (() => void) | null = null;

    function paintReceipt(): void {
      if (!answeredState) {
        return;
      }
      card.className = 'mp-checkin-card is-answered';
      card.replaceChildren();
      currentRegularEntries = [];
      currentRegularButtons = [];
      currentUnsureEntry = null;
      currentUnsureButton = null;
      currentSelectOption = null;
      currentCanSubmit = null;
      currentHandleSubmit = null;

      const receipt = el('div', 'mp-checkin-receipt');

      const head = el('div', 'mp-checkin-receipt-head');
      head.appendChild(el('span', 'mp-checkin-kicker', kickerText));
      const reopenBtn = el('button', 'mp-checkin-reopen', '重答');
      reopenBtn.type = 'button';
      reopenBtn.setAttribute('aria-label', '重新作答');
      reopenBtn.addEventListener('click', () => {
        answeredState = null;
        submitting = false;
        paintInteractive();
        const focusTarget = card.querySelector<HTMLButtonElement>(
          '.mp-checkin-option.is-selected, .mp-checkin-option',
        );
        focusTarget?.focus?.({preventScroll: true});
      });
      head.appendChild(reopenBtn);
      receipt.appendChild(head);

      const summary = summarizeText(spec.prompt, 140);
      if (summary) {
        const questionEl = el('div', 'mp-checkin-receipt-question');
        renderRichContent(questionEl, summary, true);
        receipt.appendChild(questionEl);
      }

      const choiceLine = el('div', 'mp-checkin-receipt-choice');
      const choiceText =
        answeredState.selectedLabel ||
        (answeredState.unsure ? UNSURE_OPTION_LABEL : '仅提交思路');
      const choiceLabel = el('span', 'mp-checkin-receipt-label', '已选：');
      const choiceValue = el('span', 'mp-checkin-receipt-value');
      renderRichContent(choiceValue, choiceText, true);
      choiceLine.append(choiceLabel, choiceValue);
      receipt.appendChild(choiceLine);

      const noteTrimmed = (answeredState.reasoningNote || '').trim();
      if (noteTrimmed) {
        receipt.appendChild(
          el('div', 'mp-checkin-receipt-note', `思路：「${noteTrimmed}」`),
        );
      }

      card.appendChild(receipt);
    }

    function paintInteractive(): void {
      card.className = 'mp-checkin-card';
      card.replaceChildren();

      const {regularEntries, unsureEntries} = buildOptionEntries(spec);
      const allEntries = [...regularEntries, ...unsureEntries];

      const header = el('div', 'mp-checkin-head');
      header.appendChild(el('span', 'mp-checkin-kicker', kickerText));
      card.appendChild(header);

      const promptEl = el('div', 'mp-checkin-prompt');
      renderRichContent(promptEl, spec.prompt, false);
      card.appendChild(promptEl);

      const optionsEl = el('div', 'mp-checkin-options');
      optionsEl.setAttribute('role', 'radiogroup');
      optionsEl.setAttribute('aria-label', kickerText);

      const allButtons: HTMLButtonElement[] = [];
      const regularButtons: HTMLButtonElement[] = [];
      let firstUnsureEntry: OptionEntry | null = null;
      let firstUnsureButton: HTMLButtonElement | null = null;
      let noteInput: HTMLTextAreaElement | null = null;

      const submitText =
        readNonEmptyString(spec.submitLabel) || DEFAULT_SUBMIT_LABEL;
      const submitBtn = el('button', 'mp-checkin-submit', submitText);
      submitBtn.type = 'button';

      function canSubmit(): boolean {
        const hasOption =
          selectedUnsure || selectedIndex !== null || selectedLabel.length > 0;
        const hasNote = noteValue.trim().length > 0;
        return hasOption || hasNote;
      }

      function syncSubmitState(): void {
        submitBtn.disabled = submitting || !canSubmit();
      }

      function isEntrySelected(entry: OptionEntry): boolean {
        if (entry.isUnsure) {
          return (
            selectedUnsure &&
            (entry.origIndex === selectedIndex || selectedIndex === null)
          );
        }
        return !selectedUnsure && selectedIndex === entry.origIndex;
      }

      function selectOption(entry: OptionEntry, btn: HTMLButtonElement): void {
        if (submitting) {
          return;
        }
        selectedIndex = entry.origIndex;
        selectedLabel = entry.option.label;
        selectedUnsure = entry.isUnsure;

        for (const buttonItem of allButtons) {
          const active = buttonItem === btn;
          buttonItem.classList.toggle('is-selected', active);
          buttonItem.setAttribute('aria-checked', active ? 'true' : 'false');
        }
        syncSubmitState();
        btn.focus?.({preventScroll: true});
      }

      function handleSubmit(): void {
        if (submitting || !canSubmit()) {
          return;
        }
        submitting = true;
        const trimmedNote = noteValue.trim();
        const payload: LearnCheckinSubmitPayload = {
          id: spec.id,
          prompt: spec.prompt,
          selectedIndex,
          selectedLabel,
          unsure: selectedUnsure,
          reasoningNote: trimmedNote,
        };

        submitBtn.disabled = true;
        if (noteInput) {
          noteInput.disabled = true;
        }
        for (const btn of allButtons) {
          btn.disabled = true;
        }

        answeredState = {
          selectedIndex: payload.selectedIndex,
          selectedLabel: payload.selectedLabel,
          unsure: payload.unsure,
          reasoningNote: trimmedNote || undefined,
        };

        try {
          const maybePromise = handlers.onSubmit(payload);
          if (
            maybePromise &&
            typeof (maybePromise as Promise<void>).then === 'function'
          ) {
            void (maybePromise as Promise<void>).catch(() => undefined);
          }
        } catch {
          // Transition synchronously to receipt even if caller callback throws.
        }

        paintReceipt();
      }

      let regularCounter = 0;
      for (const entry of allEntries) {
        const isSelected = isEntrySelected(entry);
        const classes = ['mp-checkin-option'];
        if (entry.isUnsure) {
          classes.push('is-unsure');
        }
        if (isSelected) {
          classes.push('is-selected');
        }

        const btn = el('button', classes.join(' '));
        btn.type = 'button';
        btn.setAttribute('role', 'radio');
        btn.setAttribute('aria-checked', isSelected ? 'true' : 'false');
        if (entry.isUnsure) {
          btn.dataset.optionUnsure = 'true';
        }
        if (entry.origIndex !== null) {
          btn.dataset.optionIndex = String(entry.origIndex);
        }

        const keycapLabel = entry.isUnsure ? '?' : String(regularCounter + 1);
        const keycap = el('span', 'mp-checkin-keycap', keycapLabel);
        keycap.setAttribute('aria-hidden', 'true');

        const body = el('span', 'mp-checkin-option-body');
        const title = el('span', 'mp-checkin-option-title');
        renderRichContent(title, entry.option.label, true);
        body.appendChild(title);

        if (entry.option.description) {
          const desc = el('span', 'mp-checkin-option-desc');
          renderRichContent(desc, entry.option.description, true);
          body.appendChild(desc);
        }

        btn.append(keycap, body);
        btn.addEventListener('click', () => {
          selectOption(entry, btn);
        });

        allButtons.push(btn);
        if (entry.isUnsure) {
          if (!firstUnsureEntry) {
            firstUnsureEntry = entry;
            firstUnsureButton = btn;
          }
        } else {
          regularCounter += 1;
          regularButtons.push(btn);
        }
        optionsEl.appendChild(btn);
      }

      card.appendChild(optionsEl);

      if (spec.allowNote !== false) {
        noteInput = el('textarea', 'mp-checkin-note');
        noteInput.rows = 1;
        noteInput.placeholder =
          readNonEmptyString(spec.notePlaceholder) || DEFAULT_NOTE_PLACEHOLDER;
        noteInput.setAttribute('aria-label', noteInput.placeholder);
        noteInput.value = noteValue;
        noteInput.addEventListener('input', () => {
          if (!noteInput) {
            return;
          }
          noteValue = noteInput.value;
          noteInput.style.height = 'auto';
          const nextHeight = Math.min(
            MAX_NOTE_HEIGHT_PX,
            noteInput.scrollHeight,
          );
          if (nextHeight > 0) {
            noteInput.style.height = `${nextHeight}px`;
          }
          syncSubmitState();
        });
        card.appendChild(noteInput);
      }

      const footer = el('div', 'mp-checkin-footer');
      if (regularEntries.length > 0 && regularEntries.length <= 4) {
        footer.appendChild(el('span', 'mp-checkin-hint', '键盘 1–4 可直选'));
      } else {
        footer.appendChild(el('span', 'mp-checkin-hint'));
      }
      submitBtn.addEventListener('click', handleSubmit);
      syncSubmitState();
      footer.appendChild(submitBtn);
      card.appendChild(footer);

      currentRegularEntries = regularEntries;
      currentRegularButtons = regularButtons;
      currentUnsureEntry = firstUnsureEntry;
      currentUnsureButton = firstUnsureButton;
      currentSelectOption = selectOption;
      currentCanSubmit = canSubmit;
      currentHandleSubmit = handleSubmit;
    }

    card.addEventListener('keydown', ev => {
      if (answeredState || submitting || ev.isComposing) {
        return;
      }
      if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') {
        if (currentCanSubmit?.() && currentHandleSubmit) {
          ev.preventDefault();
          currentHandleSubmit();
        }
        return;
      }

      const target = ev.target as HTMLElement | null;
      const tag = target?.tagName?.toUpperCase() || '';
      if (tag === 'TEXTAREA' || tag === 'INPUT' || target?.isContentEditable) {
        return;
      }
      if (ev.ctrlKey || ev.metaKey || ev.altKey) {
        return;
      }

      if (/^[1-9]$/.test(ev.key)) {
        const idx = Number(ev.key) - 1;
        const entry = currentRegularEntries[idx];
        const btn = currentRegularButtons[idx];
        if (entry && btn && currentSelectOption) {
          ev.preventDefault();
          currentSelectOption(entry, btn);
        }
        return;
      }

      if (
        ev.key === '?' &&
        currentUnsureEntry &&
        currentUnsureButton &&
        currentSelectOption
      ) {
        ev.preventDefault();
        currentSelectOption(currentUnsureEntry, currentUnsureButton);
      }
    });

    if (answeredState) {
      paintReceipt();
    } else {
      paintInteractive();
    }
    return card;
  }

  const api: LearnCheckinCardApi = {
    render,
    parseBlock,
    formatReplyForAgent,
  };

  globalThis.LearnCheckinCard = api;
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
})();
