declare global {
  interface MagicPointerDecisionQuestion {
    header?: string;
    question: string;
    options: Array<{ label: string; description?: string; preview?: string }>;
    multiSelect?: boolean;
  }
  interface MagicPointerDecisionRequest {
    key: string;
    kind?: string;
    tool?: string;
    prefix?: string;
    plan?: string;
    actionPreview?: string;
    action?: { tool?: string; arguments?: Record<string, unknown> };
    question?: string;
    options?: string[];
    questions?: MagicPointerDecisionQuestion[];
    presentation?: 'inline' | 'dock';
    historySources?: Array<{ id: string; title?: string }>;
    historySourcesError?: string;
    retryHistorySources?: () => void;
  }
  type MagicPointerDecisionResponse = { decision: 'once' | 'grant' | 'deny'; actionArguments?: {
    from_ms: number; to_ms: number; conversation_ids: string[]; limit?: number;
  } }
    | { answers: Record<string, string | string[]> };
  var DecisionCard: {
    render(host: HTMLElement, request: MagicPointerDecisionRequest,
      submit: (response: MagicPointerDecisionResponse) => void): void;
    pending(host: HTMLElement, busy: boolean, error?: string): void;
    clear(host: HTMLElement, forget?: boolean): void;
  };
}

(() => {
  interface Draft {
    page: number;
    selected: number[][];
    custom: string[];
    other: boolean[];
    skipped: boolean[];
    dailyWrap?: {
      fromText: string;
      toText: string;
      fromMs: number;
      toMs: number;
      sourceMode: 'all' | 'selected' | null;
      selectedIds: string[];
      search: string;
    };
  }
  interface View {
    request: MagicPointerDecisionRequest;
    draft: Draft;
    busy: boolean;
    error: string;
    submit: (response: MagicPointerDecisionResponse) => void;
  }
  const drafts = new Map<string, Draft>();
  const views = new WeakMap<HTMLElement, View>();
  const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string) => {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  const words = (value: unknown): string => typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  const localTime = (value: unknown, scale = 1): string => {
    const time = Number(value) * scale;
    return Number.isFinite(time) ? new Date(time).toLocaleString() : words(value);
  };
  const dateTimeInput = (value: unknown): string => {
    const time = Number(value);
    if (!Number.isFinite(time)) return '';
    const date = new Date(time);
    return Number.isNaN(date.getTime()) ? ''
      : new Date(time - date.getTimezoneOffset() * 60000).toISOString().slice(0, 19);
  };
  const dailyWrapRequest = (request: MagicPointerDecisionRequest): boolean => request.kind === 'permission'
    && request.tool === 'DailyWrap.read' && request.action?.tool === request.tool;
  function dailyWrapArguments(request: MagicPointerDecisionRequest, draft: Draft): {
    from_ms: number; to_ms: number; conversation_ids: string[]; limit?: number;
  } | null {
    const selection = draft.dailyWrap;
    const sources = request.historySources;
    if (!selection || !sources || request.historySourcesError || !Number.isFinite(selection.fromMs)
      || !Number.isFinite(selection.toMs) || selection.toMs <= selection.fromMs || !selection.sourceMode) return null;
    const available = new Set(sources.map(source => source.id));
    const conversationIds = selection.sourceMode === 'all' ? []
      : selection.selectedIds.filter(id => available.has(id));
    if (selection.sourceMode === 'selected' && !conversationIds.length) return null;
    const result: { from_ms: number; to_ms: number; conversation_ids: string[]; limit?: number } = {
      from_ms: selection.fromMs, to_ms: selection.toMs, conversation_ids: conversationIds,
    };
    const limit = request.action?.arguments?.limit;
    if (typeof limit === 'number' && Number.isFinite(limit)) result.limit = limit;
    return result;
  }
  function dailyWrapScope(request: MagicPointerDecisionRequest, draft: Draft, allow: HTMLButtonElement, busy: boolean): HTMLElement {
    const scope = element('section', 'mp-decision-scope mp-decision-dailywrap');
    scope.setAttribute('aria-label', 'Choose DailyWrap time and saved tasks');
    scope.append(element('div', 'mp-decision-scope-title', 'Choose the time and saved tasks to include'));
    const selection = draft.dailyWrap!;
    const range = element('div', 'mp-decision-dailywrap-range');
    const rangeError = element('p', 'mp-decision-error');
    rangeError.setAttribute('role', 'alert');
    const sourceHint = element('p', 'mp-decision-hint');
    const timeField = (label: string, value: string, marker: string, update: (value: string) => void) => {
      const field = element('label', 'mp-decision-dailywrap-field');
      field.append(element('span', '', label));
      const input = element('input', 'mp-decision-dailywrap-time');
      input.type = 'datetime-local'; input.step = '1'; input.value = value;
      input.disabled = busy;
      input.setAttribute(marker, '');
      input.addEventListener('input', () => update(input.value));
      field.append(input);
      return field;
    };
    const refreshApproval = () => {
      const validRange = Number.isFinite(selection.fromMs) && Number.isFinite(selection.toMs)
        && selection.toMs > selection.fromMs;
      rangeError.textContent = validRange ? '' : 'Choose a valid time range with To after From.';
      rangeError.hidden = validRange;
      const available = new Set(request.historySources?.map(source => source.id) || []);
      sourceHint.textContent = !selection.sourceMode ? 'Choose the source set before allowing this read.'
        : selection.sourceMode === 'selected' && !selection.selectedIds.some(id => available.has(id))
          ? 'Select at least one saved task.' : '';
      sourceHint.hidden = !sourceHint.textContent;
      allow.disabled = busy || !dailyWrapArguments(request, draft);
    };
    range.append(timeField('From', selection.fromText, 'data-dailywrap-from', value => {
      selection.fromText = value; selection.fromMs = value ? new Date(value).getTime() : NaN; refreshApproval();
    }), timeField('To', selection.toText, 'data-dailywrap-to', value => {
      selection.toText = value; selection.toMs = value ? new Date(value).getTime() : NaN; refreshApproval();
    }));
    scope.append(range, rangeError);
    const maxRecords = Math.max(0, Math.min(500, Number(request.action?.arguments?.limit ?? 200)));
    scope.append(element('p', 'mp-decision-hint', `Read up to ${maxRecords} records.`));
    const sources = request.historySources;
    if (!sources) {
      const status = element('p', request.historySourcesError ? 'mp-decision-error' : 'mp-decision-hint',
        request.historySourcesError || 'Loading saved tasks…');
      if (request.historySourcesError) {
        status.setAttribute('role', 'alert');
        if (request.retryHistorySources) {
          const retry = element('button', 'mp-decision-button', 'Retry loading tasks');
          retry.type = 'button'; retry.disabled = busy; retry.addEventListener('click', request.retryHistorySources);
          scope.append(status, retry);
        } else scope.append(status);
      } else scope.append(status);
      allow.disabled = true;
      return scope;
    }
    const sourceGroup = element('div', 'mp-decision-dailywrap-sources');
    sourceGroup.setAttribute('role', 'group');
    sourceGroup.setAttribute('aria-label', 'Saved task sources');
    const mode = (label: string, value: 'all' | 'selected', marker: string) => {
      const row = element('label', 'mp-decision-dailywrap-mode');
      const radio = element('input', '');
      radio.type = 'radio'; radio.name = `dailywrap-source-${request.key}`; radio.value = value;
      radio.checked = selection.sourceMode === value; radio.disabled = busy; radio.setAttribute(marker, '');
      radio.setAttribute('data-history-source-mode', value);
      radio.addEventListener('change', () => { selection.sourceMode = value; refreshApproval(); });
      row.append(radio, element('span', '', label));
      return { row, radio };
    };
    const all = mode(`All saved tasks (${sources.length})`, 'all', 'data-dailywrap-source-all');
    const chosen = mode('Choose saved tasks', 'selected', 'data-dailywrap-source-selected');
    sourceGroup.append(element('div', 'mp-decision-scope-title', 'Sources'), all.row, chosen.row);
    const search = element('input', 'mp-decision-dailywrap-search');
    search.type = 'search'; search.placeholder = 'Find a saved task'; search.value = selection.search; search.disabled = busy;
    search.setAttribute('aria-label', 'Find a saved task');
    const list = element('div', 'mp-decision-dailywrap-list');
    const selectedCount = element('span', 'mp-decision-hint', '');
    const count = () => {
      const available = new Set(sources.map(source => source.id));
      selectedCount.textContent = `${selection.selectedIds.filter(id => available.has(id)).length} selected`;
    };
    const filter = () => {
      const query = selection.search.trim().toLocaleLowerCase();
      for (const row of Array.from(list.children) as HTMLElement[]) {
        row.hidden = Boolean(query && !row.textContent?.toLocaleLowerCase().includes(query));
      }
    };
    search.addEventListener('input', () => { selection.search = search.value; filter(); });
    for (const source of sources) {
      const row = element('label', 'mp-decision-dailywrap-source');
      const check = element('input', '');
      check.type = 'checkbox'; check.checked = selection.selectedIds.includes(source.id); check.disabled = busy;
      check.setAttribute('data-dailywrap-source-id', source.id);
      check.setAttribute('data-history-source-id', source.id);
      check.addEventListener('change', () => {
        selection.selectedIds = check.checked ? [...new Set([...selection.selectedIds, source.id])]
          : selection.selectedIds.filter(id => id !== source.id);
        selection.sourceMode = 'selected'; chosen.radio.checked = true; all.radio.checked = false;
        count(); refreshApproval();
      });
      const name = element('span', 'mp-decision-dailywrap-source-name', source.title || source.id);
      const id = element('span', 'mp-decision-dailywrap-source-id', source.id);
      row.append(check, name, id); list.append(row);
    }
    if (!sources.length) list.append(element('p', 'mp-decision-hint', 'No saved tasks are available.'));
    filter(); count();
    sourceGroup.append(search, list, selectedCount);
    scope.append(sourceGroup, sourceHint);
    refreshApproval();
    return scope;
  }
  function historyScope(request: MagicPointerDecisionRequest): HTMLElement | null {
    const action = request.action;
    if (!action || action.tool !== request.tool || !action.arguments) return null;
    const args = record(action.arguments);
    const rows: Array<[string, string]> = [];
    const add = (label: string, value: unknown) => { const text = words(value); if (text) rows.push([label, text]); };
    if (request.tool === 'Recall') {
      if (args.session_id) {
        add('Source', `saved task ${words(args.session_id)}`);
        add('Event', args.event_seq);
        add('Text offset', args.offset ?? 0);
        add('Characters', args.max_chars ?? 4000);
      } else {
        add('Source', 'all saved tasks and recent screen evidence');
        add('Search', args.query);
        add('Task matches', args.max_results ?? 8);
        add('Screen matches', args.limit ?? args.max_results ?? 8);
        if (args.since !== undefined) add('Screen from', localTime(args.since, 1000));
        if (args.until !== undefined) add('Screen to', localTime(args.until, 1000));
      }
    } else if (request.tool === 'DailyWrap.read') {
      add('Source', 'saved task records');
      add('From', localTime(args.from_ms));
      add('To', localTime(args.to_ms));
      const conversations = Array.isArray(args.conversation_ids) ? args.conversation_ids.map(words).filter(Boolean) : [];
      add('Conversations', conversations.length ? conversations.join(', ') : 'all conversations');
      add('Maximum records', args.limit ?? 200);
    } else if (request.tool === 'Recipe' && args.operation === 'execute') {
      const plan = record(args.plan), parameters = record(plan.parameters);
      const recipe = words(plan.recipeId), provider = words(plan.provider);
      if (!['memory.recall', 'clipboard.history'].includes(recipe) && !['local.memory', 'clipboard.history'].includes(provider)) return null;
      add('Recipe', recipe || provider);
      if (recipe === 'clipboard.history' || provider === 'clipboard.history') {
        add('Action', parameters.digest ? 'restore one saved clipboard entry' : 'search saved clipboard history');
        add('Clipboard entry', parameters.digest);
        add('Search', parameters.query);
      } else {
        add('Action', 'search recent screen memory');
        add('Search', parameters.query || plan.command);
        if (parameters.since !== undefined) add('From', localTime(parameters.since, 1000));
        if (parameters.until !== undefined) add('To', localTime(parameters.until, 1000));
        add('Maximum matches', parameters.limit ?? 20);
      }
      const objectIds = Array.isArray(plan.objectIds) ? plan.objectIds.map(words).filter(Boolean) : [];
      if (objectIds.length) add('Selected objects', objectIds.join(', '));
      if (Array.isArray(parameters.objects)) for (const item of parameters.objects) {
        const object = record(item), source = record(object.source);
        const identity = words(object.id || object.objectId || object.kind) || 'selected object';
        const location = words(source.path || source.absolutePath || source.documentUrl || source.url || source.title || source.windowTitle || source.sourceId);
        const app = words(source.app);
        add('Object source', [identity, app, location].filter(Boolean).join(' · '));
      }
      if (Array.isArray(parameters.attachments)) for (const attachment of parameters.attachments) add('Attachment', attachment);
    } else return null;
    const scope = element('section', 'mp-decision-scope');
    scope.setAttribute('aria-label', 'Scope of this approval');
    scope.append(element('div', 'mp-decision-scope-title', 'This approval covers'));
    const list = element('dl', 'mp-decision-scope-list');
    for (const [label, value] of rows) {
      list.append(element('dt', 'mp-decision-scope-label', label), element('dd', 'mp-decision-scope-value', value));
    }
    scope.append(list);
    return scope;
  }
  function paint(host: HTMLElement, view: View): void {
    const { request, draft } = view;
    const card = element('section', 'mp-decision-card');
    const inline = request.presentation === 'inline';
    card.dataset.presentation = inline ? 'inline' : 'dock';
    card.dataset.kind = request.kind === 'plan' ? 'plan' : request.kind === 'permission' ? 'permission' : 'question';
    card.setAttribute('aria-label', request.kind === 'permission' ? 'Permission request' : 'Question from Magic Pointer');
    card.setAttribute('aria-busy', String(view.busy));
    const button = (label: string, action: () => void, className = '') => {
      const node = element('button', `mp-decision-button ${className}`, label);
      node.type = 'button'; node.disabled = view.busy;
      node.addEventListener('click', () => { if (!view.busy) action(); });
      return node;
    };
    const submit = (response: MagicPointerDecisionResponse) => {
      if (view.busy) return;
      view.busy = true; view.error = '';
      paint(host, view);
      view.submit(response);
    };
    if (request.kind === 'plan') {
      card.setAttribute('aria-label', 'Plan approval');
      card.append(element('div', 'mp-decision-heading', 'Review plan'),
        element('pre', 'mp-decision-command', request.plan || ''));
      const actions = element('div', 'mp-decision-actions');
      for (const [label, decision] of [['Keep planning', 'deny'], ['Approve · manual', 'once'], ['Approve · accept edits', 'grant']] as const) {
        const action = button(label, () => submit({ decision }), decision === 'grant' ? 'is-primary' : '');
        action.dataset.decision = decision; actions.append(action);
      }
      card.append(actions);
    } else if (request.kind === 'permission') {
      const head = element('div', 'mp-decision-heading');
      head.append(element('span', 'mp-decision-tool', request.tool || 'Tool'),
        element('span', 'mp-decision-caption', 'Permission needed'));
      const question = element('p', 'mp-decision-question', request.question || `Allow ${request.tool || 'this action'}?`);
      card.append(head, question);
      const actions = element('div', 'mp-decision-actions');
      const labels = request.options || [];
      const deny = button(labels.at(-1) || 'Deny', () => submit({ decision: 'deny' }));
      deny.dataset.decision = 'deny';
      const allow = element('div', 'mp-decision-allow');
      if (!labels.length || labels.length > 2) {
        const session = button(labels[1] || 'Allow for this session', () => submit({ decision: 'grant' }));
        session.dataset.decision = 'grant'; allow.append(session);
      }
      const once = button(labels[0] || 'Allow once', () => {
        const actionArguments = dailyWrapRequest(request) ? dailyWrapArguments(request, draft) : null;
        if (dailyWrapRequest(request)) {
          if (actionArguments) submit({ decision: 'once', actionArguments });
        } else submit({ decision: 'once' });
      }, 'is-primary');
      once.dataset.decision = 'once';
      const scope = dailyWrapRequest(request) ? dailyWrapScope(request, draft, once, view.busy) : historyScope(request);
      if (scope) card.append(scope);
      else if (request.actionPreview || request.prefix) card.append(element('pre', 'mp-decision-command', request.actionPreview || request.prefix));
      allow.append(once); actions.append(deny, allow); card.append(actions);
    } else {
      const questions = request.questions || [];
      const current = questions[draft.page];
      if (!current) { host.hidden = true; return; }
      const header = element('div', 'mp-decision-heading');
      header.append(element('span', inline ? 'mp-decision-question' : 'mp-decision-caption', inline ? current.question : current.header || 'Question'));
      const navigation = element('div', 'mp-decision-pages');
      const back = button('‹', () => { draft.page--; paint(host, view); });
      back.setAttribute('aria-label', 'Previous question');
      back.disabled = view.busy || draft.page === 0;
      const forward = button('›', () => { draft.page++; paint(host, view); });
      forward.setAttribute('aria-label', 'Next question');
      forward.disabled = view.busy || draft.page >= questions.length - 1;
      navigation.append(back, element('span', '', `${draft.page + 1} / ${questions.length}`), forward);
      if (questions.length > 1) header.append(navigation);
      card.append(header);
      if (!inline) card.append(element('p', 'mp-decision-question', current.question));
      if (current.multiSelect) card.append(element('p', 'mp-decision-hint', 'Select all that apply'));
      const options = element('div', 'mp-decision-options');
      options.setAttribute('role', current.multiSelect ? 'group' : 'radiogroup');
      options.setAttribute('aria-label', current.question);
      current.options.forEach((option, index) => {
        const selected = draft.selected[draft.page].includes(index);
        const row = button('', () => {
          draft.skipped[draft.page] = false; view.error = '';
          const selection = draft.selected[draft.page];
          draft.selected[draft.page] = current.multiSelect
            ? selected ? selection.filter(value => value !== index) : [...selection, index]
            : [index];
          if (!current.multiSelect) { draft.custom[draft.page] = ''; draft.other[draft.page] = false; }
          paint(host, view);
        }, `mp-decision-option${selected ? ' is-selected' : ''}`);
        row.dataset.optionIndex = String(index);
        row.setAttribute('role', current.multiSelect ? 'checkbox' : 'radio');
        row.setAttribute('aria-checked', String(selected));
        const mark = element('span', `mp-decision-choice-mark${current.multiSelect ? ' is-multi' : ''}`, selected ? '✓' : inline ? '' : String(index + 1));
        mark.setAttribute('aria-hidden', 'true');
        const copy = element('span', 'mp-decision-option-copy');
        copy.append(element('span', 'mp-decision-option-label', option.label));
        if (option.description) copy.append(element('span', 'mp-decision-option-description', option.description));
        if (option.preview) copy.append(element('pre', 'mp-decision-option-preview mp-decision-command', option.preview));
        row.append(mark, copy); options.append(row);
      });
      card.append(options);
      const custom = element('textarea', 'mp-decision-custom');
      custom.rows = 1; custom.placeholder = 'Type something else…';
      custom.setAttribute('aria-label', `Your answer: ${current.question}`);
      custom.value = draft.custom[draft.page]; custom.disabled = view.busy;
      const selectOther = () => {
        draft.other[draft.page] = true;
        custom.tabIndex = 0;
        draft.skipped[draft.page] = false;
        if (!current.multiSelect) {
          draft.selected[draft.page] = [];
          options.querySelectorAll('[aria-checked]').forEach((row, index) => {
            row.setAttribute('aria-checked', 'false'); row.classList.remove('is-selected');
            const mark = row.querySelector('.mp-decision-choice-mark');
            if (mark) mark.textContent = inline ? '' : String(index + 1);
          });
        }
        const row = card.querySelector('.mp-decision-other-choice');
        row?.setAttribute('aria-checked', 'true'); row?.classList.add('is-selected');
        const mark = row?.querySelector('.mp-decision-choice-mark');
        if (mark) mark.textContent = '✓';
      };
      custom.addEventListener('focus', () => { selectOther(); continueButton.disabled = view.busy || !hasAnswer(); });
      custom.addEventListener('input', () => {
        draft.custom[draft.page] = custom.value;
        selectOther();
        continueButton.disabled = view.busy || !hasAnswer();
        custom.style.height = 'auto';
        custom.style.height = `${Math.min(88, custom.scrollHeight)}px`;
      });
      if (inline) {
        const other = element('div', 'mp-decision-other');
        custom.tabIndex = draft.other[draft.page] ? 0 : -1;
        const choice = button('', () => {
          if (current.multiSelect && draft.other[draft.page]) {
            draft.other[draft.page] = false; draft.custom[draft.page] = ''; paint(host, view);
          } else { selectOther(); continueButton.disabled = view.busy || !hasAnswer(); custom.focus(); }
        }, `mp-decision-other-choice${draft.other[draft.page] ? ' is-selected' : ''}`);
        choice.setAttribute('role', current.multiSelect ? 'checkbox' : 'radio');
        choice.setAttribute('aria-checked', String(draft.other[draft.page]));
        const mark = element('span', `mp-decision-choice-mark${current.multiSelect ? ' is-multi' : ''}`, draft.other[draft.page] ? '✓' : '');
        mark.setAttribute('aria-hidden', 'true');
        choice.append(mark, element('span', 'mp-decision-other-label', 'Other'));
        other.append(choice, custom);
        card.append(other);
      } else card.append(custom);
      const hasAnswer = () => draft.selected[draft.page].length > 0 || Boolean(draft.custom[draft.page].trim());
      const finish = () => {
        const missing = questions.findIndex((_question, index) => !draft.skipped[index]
          && !draft.selected[index].length && !draft.custom[index].trim());
        if (missing >= 0) {
          draft.page = missing;
          view.error = 'Choose an answer or explicitly skip this question.';
          paint(host, view); return;
        }
        const answers: Record<string, string | string[]> = {};
        questions.forEach((question, index) => {
          const selected = draft.selected[index].map(option => question.options[option]?.label).filter(Boolean);
          const free = draft.custom[index].trim();
          answers[question.question] = question.multiSelect ? [...selected, ...(free ? [free] : [])] : free || selected[0] || '';
        });
        submit({ answers });
      };
      const advance = () => {
        if (draft.page === questions.length - 1) finish();
        else { draft.page++; paint(host, view); }
      };
      const actions = element('div', 'mp-decision-actions');
      const skip = button('Skip', () => {
        draft.selected[draft.page] = []; draft.custom[draft.page] = ''; draft.other[draft.page] = false; draft.skipped[draft.page] = true;
        view.error = ''; advance();
      });
      skip.dataset.questionSkip = '';
      const continueButton = button(draft.page === questions.length - 1 ? 'Submit' : 'Next', advance, 'is-primary');
      continueButton.disabled = view.busy || !hasAnswer();
      if (draft.page === questions.length - 1) continueButton.dataset.questionSubmit = '';
      else continueButton.dataset.questionNext = '';
      actions.append(skip, continueButton); card.append(actions);
    }
    if (view.error) {
      const error = element('p', 'mp-decision-error', view.error);
      error.setAttribute('role', 'alert'); card.append(error);
    }
    if (view.busy) card.append(element('p', 'mp-decision-hint', 'Sending your response…'));
    host.hidden = false; host.replaceChildren(card);
  }
  globalThis.DecisionCard = {
    render(host, request, submit) {
      const existing = views.get(host);
      if (existing?.request.key === request.key) {
        const changedSources = existing.request.historySources !== request.historySources
          || existing.request.historySourcesError !== request.historySourcesError;
        existing.request = request; existing.submit = submit; host.hidden = false;
        if (changedSources) paint(host, existing);
        return;
      }
      const questions = request.questions || [];
      const draft: Draft = drafts.get(request.key) || { page: 0, selected: questions.map(() => []), custom: questions.map(() => ''), other: questions.map(() => false), skipped: questions.map(() => false) };
      if (dailyWrapRequest(request) && !draft.dailyWrap) {
        const args = record(request.action?.arguments);
        draft.dailyWrap = {
          fromText: dateTimeInput(args.from_ms), toText: dateTimeInput(args.to_ms),
          fromMs: Number(args.from_ms), toMs: Number(args.to_ms), sourceMode: null,
          selectedIds: Array.isArray(args.conversation_ids) ? [...new Set(args.conversation_ids.map(words).filter(Boolean))] : [], search: '',
        };
      }
      drafts.set(request.key, draft);
      const view = { request, submit, draft, busy: false, error: '' };
      views.set(host, view); paint(host, view);
    },
    pending(host, busy, error = '') {
      const view = views.get(host);
      if (!view) return;
      view.busy = busy; view.error = error; paint(host, view);
    },
    clear(host, forget = false) {
      const view = views.get(host);
      if (forget && view) drafts.delete(view.request.key);
      views.delete(host); host.hidden = true; host.replaceChildren();
    },
  };
})();
