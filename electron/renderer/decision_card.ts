declare global {
  interface MagicPointerDecisionQuestion {
    header?: string;
    question: string;
    options: Array<{label: string; description?: string; preview?: string}>;
    multiSelect?: boolean;
  }
  interface MagicPointerDecisionRequest {
    key: string;
    kind?: string;
    artifactId?: string;
    artifactRevision?: number;
    openArtifact?: () => void;
    tool?: string;
    prefix?: string;
    plan?: string;
    actionPreview?: string;
    action?: {tool?: string; arguments?: Record<string, unknown>};
    question?: string;
    options?: string[];
    modeRaise?: 'auto';
    questions?: MagicPointerDecisionQuestion[];
    presentation?: 'inline' | 'dock';
    historySources?: Array<{id: string; title?: string}>;
    historySourcesError?: string;
    retryHistorySources?: () => void;
  }
  type MagicPointerDecisionResponse =
    | {
        decision: 'once' | 'grant' | 'deny';
        modeRaise?: 'auto';
        actionArguments?: {
          from_ms: number;
          to_ms: number;
          conversation_ids: string[];
          limit?: number;
        };
      }
    | {answers: Record<string, string | string[]>};
  var DecisionCard: {
    render(
      host: HTMLElement,
      request: MagicPointerDecisionRequest,
      submit: (response: MagicPointerDecisionResponse) => void,
    ): void;
    pending(host: HTMLElement, busy: boolean, error?: string): void;
    resolve(host: HTMLElement): void;
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
    errorKey?: 'decision.missing';
    submitFocus?: string;
    language: StudioLanguage;
    submit: (response: MagicPointerDecisionResponse) => void;
  }
  const drafts = new Map<string, Draft>();
  const resolved = new Set<string>();
  const views = new WeakMap<HTMLElement, View>();
  const element = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className: string,
    text?: string,
  ) => {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) {
      node.textContent = text;
    }
    return node;
  };
  const record = (value: unknown): Record<string, unknown> =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const words = (value: unknown): string =>
    typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  const localTime = (value: unknown, scale = 1): string => {
    const time = Number(value) * scale;
    return Number.isFinite(time)
      ? new Date(time).toLocaleString()
      : words(value);
  };
  const dateTimeInput = (value: unknown): string => {
    const time = Number(value);
    if (!Number.isFinite(time)) {
      return '';
    }
    const date = new Date(time);
    return Number.isNaN(date.getTime())
      ? ''
      : new Date(time - date.getTimezoneOffset() * 60000)
          .toISOString()
          .slice(0, 19);
  };
  const dailyWrapRequest = (request: MagicPointerDecisionRequest): boolean =>
    request.kind === 'permission' &&
    request.tool === 'DailyWrap.read' &&
    request.action?.tool === request.tool;
  function dailyWrapArguments(
    request: MagicPointerDecisionRequest,
    draft: Draft,
  ): {
    from_ms: number;
    to_ms: number;
    conversation_ids: string[];
    limit?: number;
  } | null {
    const selection = draft.dailyWrap;
    const sources = request.historySources;
    if (
      !selection ||
      !sources ||
      request.historySourcesError ||
      !Number.isFinite(selection.fromMs) ||
      !Number.isFinite(selection.toMs) ||
      selection.toMs <= selection.fromMs ||
      !selection.sourceMode
    ) {
      return null;
    }
    const available = new Set(sources.map(source => source.id));
    const conversationIds =
      selection.sourceMode === 'all'
        ? []
        : selection.selectedIds.filter(id => available.has(id));
    if (selection.sourceMode === 'selected' && !conversationIds.length) {
      return null;
    }
    const result: {
      from_ms: number;
      to_ms: number;
      conversation_ids: string[];
      limit?: number;
    } = {
      from_ms: selection.fromMs,
      to_ms: selection.toMs,
      conversation_ids: conversationIds,
    };
    const limit = request.action?.arguments?.limit;
    if (typeof limit === 'number' && Number.isFinite(limit)) {
      result.limit = limit;
    }
    return result;
  }
  function dailyWrapScope(
    request: MagicPointerDecisionRequest,
    draft: Draft,
    allow: HTMLButtonElement,
    busy: boolean,
  ): HTMLElement {
    const scope = element('section', 'mp-decision-scope mp-decision-dailywrap');
    scope.setAttribute('aria-label', studioT('decision.daily_scope'));
    scope.append(
      element(
        'div',
        'mp-decision-scope-title',
        studioT('decision.daily_heading'),
      ),
    );
    const selection = draft.dailyWrap!;
    const range = element('div', 'mp-decision-dailywrap-range');
    const rangeError = element('p', 'mp-decision-error');
    rangeError.setAttribute('role', 'alert');
    const sourceHint = element('p', 'mp-decision-hint');
    const timeField = (
      label: string,
      value: string,
      marker: string,
      update: (value: string) => void,
    ) => {
      const field = element('label', 'mp-decision-dailywrap-field');
      field.append(element('span', '', label));
      const input = element('input', 'mp-decision-dailywrap-time');
      input.type = 'datetime-local';
      input.step = '1';
      input.value = value;
      input.disabled = busy;
      input.setAttribute(marker, '');
      input.dataset.decisionControl = marker;
      input.addEventListener('input', () => update(input.value));
      field.append(input);
      return field;
    };
    const refreshApproval = () => {
      const validRange =
        Number.isFinite(selection.fromMs) &&
        Number.isFinite(selection.toMs) &&
        selection.toMs > selection.fromMs;
      rangeError.textContent = validRange
        ? ''
        : studioT('decision.range_error');
      rangeError.hidden = validRange;
      const available = new Set(
        request.historySources?.map(source => source.id) || [],
      );
      sourceHint.textContent = !selection.sourceMode
        ? studioT('decision.choose_sources')
        : selection.sourceMode === 'selected' &&
            !selection.selectedIds.some(id => available.has(id))
          ? studioT('decision.select_task')
          : '';
      sourceHint.hidden = !sourceHint.textContent;
      allow.disabled = busy || !dailyWrapArguments(request, draft);
    };
    range.append(
      timeField(
        studioT('decision.from'),
        selection.fromText,
        'data-dailywrap-from',
        value => {
          selection.fromText = value;
          selection.fromMs = value ? new Date(value).getTime() : NaN;
          refreshApproval();
        },
      ),
      timeField(
        studioT('decision.to'),
        selection.toText,
        'data-dailywrap-to',
        value => {
          selection.toText = value;
          selection.toMs = value ? new Date(value).getTime() : NaN;
          refreshApproval();
        },
      ),
    );
    scope.append(range, rangeError);
    const maxRecords = Math.max(
      0,
      Math.min(500, Number(request.action?.arguments?.limit ?? 200)),
    );
    scope.append(
      element(
        'p',
        'mp-decision-hint',
        studioT('decision.read_limit', {n: maxRecords}),
      ),
    );
    const sources = request.historySources;
    if (!sources) {
      const status = element(
        'p',
        request.historySourcesError ? 'mp-decision-error' : 'mp-decision-hint',
        request.historySourcesError || studioT('decision.loading_tasks'),
      );
      if (request.historySourcesError) {
        status.setAttribute('role', 'alert');
        if (request.retryHistorySources) {
          const retry = element(
            'button',
            'mp-decision-button',
            studioT('decision.retry_tasks'),
          );
          retry.type = 'button';
          retry.dataset.decisionControl = 'history-retry';
          retry.disabled = busy;
          retry.addEventListener('click', request.retryHistorySources);
          scope.append(status, retry);
        } else {
          scope.append(status);
        }
      } else {
        scope.append(status);
      }
      allow.disabled = true;
      return scope;
    }
    const sourceGroup = element('div', 'mp-decision-dailywrap-sources');
    sourceGroup.setAttribute('role', 'group');
    sourceGroup.setAttribute('aria-label', studioT('decision.saved_sources'));
    const mode = (label: string, value: 'all' | 'selected', marker: string) => {
      const row = element('label', 'mp-decision-dailywrap-mode');
      const radio = element('input', '');
      radio.type = 'radio';
      radio.name = `dailywrap-source-${request.key}`;
      radio.value = value;
      radio.dataset.decisionControl = `history-${value}`;
      radio.checked = selection.sourceMode === value;
      radio.disabled = busy;
      radio.setAttribute(marker, '');
      radio.setAttribute('data-history-source-mode', value);
      radio.addEventListener('change', () => {
        selection.sourceMode = value;
        refreshApproval();
      });
      row.append(radio, element('span', '', label));
      return {row, radio};
    };
    const all = mode(
      studioT('decision.all_tasks', {n: sources.length}),
      'all',
      'data-dailywrap-source-all',
    );
    const chosen = mode(
      studioT('decision.choose_tasks'),
      'selected',
      'data-dailywrap-source-selected',
    );
    sourceGroup.append(
      element('div', 'mp-decision-scope-title', studioT('decision.sources')),
      all.row,
      chosen.row,
    );
    const search = element('input', 'mp-decision-dailywrap-search');
    search.type = 'search';
    search.dataset.decisionControl = 'history-search';
    search.placeholder = studioT('decision.find_task');
    search.value = selection.search;
    search.disabled = busy;
    search.setAttribute('aria-label', studioT('decision.find_task'));
    const list = element('div', 'mp-decision-dailywrap-list');
    const empty = element(
      'p',
      'mp-decision-hint',
      studioT(
        sources.length ? 'decision.no_matching_tasks' : 'decision.no_tasks',
      ),
    );
    empty.setAttribute('role', 'status');
    const selectedCount = element('span', 'mp-decision-hint', '');
    const count = () => {
      const available = new Set(sources.map(source => source.id));
      selectedCount.textContent = studioT('decision.selected_count', {
        n: selection.selectedIds.filter(id => available.has(id)).length,
      });
    };
    const filter = () => {
      const query = selection.search.trim().toLocaleLowerCase();
      let matches = 0;
      for (const row of list.querySelectorAll<HTMLElement>(
        '.mp-decision-dailywrap-source',
      )) {
        row.hidden = Boolean(
          query && !row.textContent?.toLocaleLowerCase().includes(query),
        );
        if (!row.hidden) {
          matches++;
        }
      }
      empty.hidden = matches > 0;
    };
    search.addEventListener('input', () => {
      selection.search = search.value;
      filter();
    });
    for (const source of sources) {
      const row = element('label', 'mp-decision-dailywrap-source');
      const check = element('input', '');
      check.type = 'checkbox';
      check.dataset.decisionControl = `history-source:${source.id}`;
      check.checked = selection.selectedIds.includes(source.id);
      check.disabled = busy;
      check.setAttribute('data-dailywrap-source-id', source.id);
      check.setAttribute('data-history-source-id', source.id);
      check.addEventListener('change', () => {
        selection.selectedIds = check.checked
          ? [...new Set([...selection.selectedIds, source.id])]
          : selection.selectedIds.filter(id => id !== source.id);
        selection.sourceMode = 'selected';
        chosen.radio.checked = true;
        all.radio.checked = false;
        count();
        refreshApproval();
      });
      const name = element(
        'span',
        'mp-decision-dailywrap-source-name',
        source.title || source.id,
      );
      const id = element('span', 'mp-decision-dailywrap-source-id', source.id);
      row.append(check, name, id);
      list.append(row);
    }
    list.append(empty);
    filter();
    count();
    sourceGroup.append(search, list, selectedCount);
    scope.append(sourceGroup, sourceHint);
    refreshApproval();
    return scope;
  }
  function historyScope(
    request: MagicPointerDecisionRequest,
  ): HTMLElement | null {
    const action = request.action;
    if (!action || action.tool !== request.tool || !action.arguments) {
      return null;
    }
    const args = record(action.arguments);
    const rows: Array<[string, string]> = [];
    const add = (label: string, value: unknown) => {
      const text = words(value);
      if (text) {
        rows.push([studioT(`decision.scope_${label}`), text]);
      }
    };
    if (request.tool === 'Recall') {
      if (args.session_id) {
        add(
          'source',
          studioT('decision.saved_task', {id: words(args.session_id)}),
        );
        add('event', args.event_seq);
        add('offset', args.offset ?? 0);
        add('characters', args.max_chars ?? 4000);
      } else {
        add('source', studioT('decision.all_evidence'));
        add('search', args.query);
        add('tasks', args.max_results ?? 8);
        add('screens', args.limit ?? args.max_results ?? 8);
        if (args.since !== undefined) {
          add('screen_from', localTime(args.since, 1000));
        }
        if (args.until !== undefined) {
          add('screen_to', localTime(args.until, 1000));
        }
      }
    } else if (request.tool === 'DailyWrap.read') {
      add('source', studioT('decision.task_records'));
      add('from', localTime(args.from_ms));
      add('to', localTime(args.to_ms));
      const conversations = Array.isArray(args.conversation_ids)
        ? args.conversation_ids.map(words).filter(Boolean)
        : [];
      add(
        'conversations',
        conversations.length
          ? conversations.join(', ')
          : studioT('decision.all_conversations'),
      );
      add('max_records', args.limit ?? 200);
    } else if (request.tool === 'Recipe' && args.operation === 'execute') {
      const plan = record(args.plan);
      const parameters = record(plan.parameters);
      const recipe = words(plan.recipeId);
      const provider = words(plan.provider);
      if (
        !['memory.recall', 'clipboard.history'].includes(recipe) &&
        !['local.memory', 'clipboard.history'].includes(provider)
      ) {
        return null;
      }
      add('recipe', recipe || provider);
      if (recipe === 'clipboard.history' || provider === 'clipboard.history') {
        add(
          'action',
          parameters.digest
            ? studioT('decision.restore_clipboard')
            : studioT('decision.search_clipboard'),
        );
        add('clipboard', parameters.digest);
        add('search', parameters.query);
      } else {
        add('action', studioT('decision.search_screen'));
        add('search', parameters.query || plan.command);
        if (parameters.since !== undefined) {
          add('from', localTime(parameters.since, 1000));
        }
        if (parameters.until !== undefined) {
          add('to', localTime(parameters.until, 1000));
        }
        add('max_matches', parameters.limit ?? 20);
      }
      const objectIds = Array.isArray(plan.objectIds)
        ? plan.objectIds.map(words).filter(Boolean)
        : [];
      if (objectIds.length) {
        add('objects', objectIds.join(', '));
      }
      if (Array.isArray(parameters.objects)) {
        for (const item of parameters.objects) {
          const object = record(item);
          const source = record(object.source);
          const identity =
            words(object.id || object.objectId || object.kind) ||
            studioT('decision.selected_object');
          const location = words(
            source.path ||
              source.absolutePath ||
              source.documentUrl ||
              source.url ||
              source.title ||
              source.windowTitle ||
              source.sourceId,
          );
          const app = words(source.app);
          add(
            'object_source',
            [identity, app, location].filter(Boolean).join(' · '),
          );
        }
      }
      if (Array.isArray(parameters.attachments)) {
        for (const attachment of parameters.attachments) {
          add('attachment', attachment);
        }
      }
    } else {
      return null;
    }
    const scope = element('section', 'mp-decision-scope');
    scope.setAttribute('aria-label', studioT('decision.approval_scope'));
    scope.append(
      element(
        'div',
        'mp-decision-scope-title',
        studioT('decision.scope_heading'),
      ),
    );
    const list = element('dl', 'mp-decision-scope-list');
    for (const [label, value] of rows) {
      list.append(
        element('dt', 'mp-decision-scope-label', label),
        element('dd', 'mp-decision-scope-value', value),
      );
    }
    scope.append(list);
    return scope;
  }
  function paint(host: HTMLElement, view: View): void {
    view.language = getStudioLanguage();
    const hadFocus = host.contains(document.activeElement);
    const focused = document.activeElement as HTMLElement | null;
    const selection =
      hadFocus &&
      (focused instanceof HTMLTextAreaElement ||
        focused instanceof HTMLInputElement) &&
      focused.selectionStart !== null
        ? {
            start: focused.selectionStart,
            end: focused.selectionEnd,
            direction: focused.selectionDirection ?? 'none',
          }
        : undefined;
    const focusControl = hadFocus
      ? (focused?.dataset.decisionControl ??
        (focused?.classList.contains('mp-decision-saving')
          ? view.submitFocus
          : undefined))
      : undefined;
    const {request, draft} = view;
    const card = element('section', 'mp-decision-card');
    const inline = request.presentation === 'inline';
    card.dataset.presentation = inline ? 'inline' : 'dock';
    card.dataset.kind =
      request.kind === 'artifact'
        ? 'artifact'
        : request.kind === 'plan'
          ? 'plan'
          : request.kind === 'permission'
            ? 'permission'
            : 'question';
    card.setAttribute(
      'aria-label',
      request.kind === 'permission'
        ? studioT('decision.permission')
        : studioT('decision.question'),
    );
    card.setAttribute('aria-busy', String(view.busy));
    let controlIndex = 0;
    const button = (label: string, action: () => void, className = '') => {
      const node = element('button', `mp-decision-button ${className}`, label);
      node.dataset.decisionControl = String(controlIndex++);
      node.type = 'button';
      node.disabled = view.busy;
      node.addEventListener('click', () => {
        if (!view.busy) {
          action();
        }
      });
      return node;
    };
    const submit = (response: MagicPointerDecisionResponse) => {
      if (view.busy) {
        return;
      }
      view.submitFocus = host.contains(document.activeElement)
        ? (document.activeElement as HTMLElement).dataset.decisionControl
        : undefined;
      view.busy = true;
      view.error = '';
      view.errorKey = undefined;
      paint(host, view);
      view.submit(response);
    };
    if (request.kind === 'artifact') {
      const label =
        typeof studioT === 'function'
          ? studioT('artifact.review_changes')
          : 'Review changes';
      const hint =
        typeof studioT === 'function'
          ? studioT('artifact.review_continue')
          : 'Review and apply this version in the editor. The task will continue after the changes are verified.';
      card.setAttribute('aria-label', label);
      card.append(
        element('div', 'mp-decision-heading', label),
        element('p', 'mp-decision-question', request.question || ''),
        element('p', 'mp-decision-caption', hint),
      );
      const actions = element('div', 'mp-decision-actions');
      actions.append(
        button(label, () => request.openArtifact?.(), 'is-primary'),
      );
      card.append(actions);
    } else if (request.kind === 'plan') {
      card.setAttribute('aria-label', studioT('decision.plan_approval'));
      const heading = element('div', 'mp-decision-heading');
      heading.append(
        element('span', 'mp-decision-tool', studioT('decision.plan')),
        element(
          'span',
          'mp-decision-caption',
          studioT('decision.ready_review'),
        ),
      );
      // chat_markdown.js is a classic script: its const is a global binding, not a globalThis property.
      const body =
        typeof ChatMarkdown !== 'undefined'
          ? (ChatMarkdown.render(request.plan || '') as unknown as HTMLElement)
          : element('pre', 'mp-decision-command', request.plan || '');
      body.classList.add('mp-decision-plan');
      card.append(heading, body);
      const actions = element('div', 'mp-decision-actions');
      const approvals = element('div', 'mp-decision-allow');
      for (const [label, decision] of [
        [studioT('decision.keep_planning'), 'deny'],
        [studioT('decision.approve_manual'), 'once'],
        [studioT('decision.approve_edits'), 'grant'],
      ] as const) {
        const action = button(
          label,
          () => submit({decision}),
          decision === 'grant' ? 'is-primary' : '',
        );
        action.dataset.decision = decision;
        (decision === 'deny' ? actions : approvals).append(action);
      }
      actions.append(approvals);
      card.append(actions);
    } else if (request.kind === 'permission') {
      const head = element('div', 'mp-decision-heading');
      head.append(
        element(
          'span',
          'mp-decision-eyebrow',
          studioT('decision.permission_heading'),
        ),
        element(
          'span',
          'mp-decision-caption',
          request.tool || studioT('decision.tool'),
        ),
      );
      const question = element(
        'p',
        'mp-decision-question',
        request.question ||
          studioT('decision.allow_question', {
            tool: request.tool || studioT('decision.this_action'),
          }),
      );
      card.append(head, question);
      const actions = element('div', 'mp-decision-actions');
      const labels = request.options || [];
      const deny = button(labels.at(-1) || studioT('decision.deny'), () =>
        submit({decision: 'deny'}),
      );
      deny.dataset.decision = 'deny';
      const allow = element('div', 'mp-decision-allow');
      if (!labels.length || labels.length > 2) {
        const session = button(
          labels[1] || studioT('decision.allow_session'),
          () => submit({decision: 'grant'}),
        );
        session.dataset.decision = 'grant';
        allow.append(session);
      }
      if (request.modeRaise === 'auto') {
        const raise = button(
          studioT('decision.allow_mode_raise'),
          () => submit({decision: 'once', modeRaise: 'auto'}),
        );
        raise.dataset.decision = 'mode-raise';
        allow.append(raise);
      }
      const once = button(
        labels[0] || studioT('decision.allow_once'),
        () => {
          const actionArguments = dailyWrapRequest(request)
            ? dailyWrapArguments(request, draft)
            : null;
          if (dailyWrapRequest(request)) {
            if (actionArguments) {
              submit({decision: 'once', actionArguments});
            }
          } else {
            submit({decision: 'once'});
          }
        },
        'is-primary',
      );
      once.dataset.decision = 'once';
      const scope = dailyWrapRequest(request)
        ? dailyWrapScope(request, draft, once, view.busy)
        : historyScope(request);
      if (scope) {
        card.append(scope);
      } else if (request.actionPreview || request.prefix) {
        card.append(
          element(
            'pre',
            'mp-decision-command',
            request.actionPreview || request.prefix,
          ),
        );
      }
      allow.append(once);
      actions.append(deny, allow);
      card.append(actions);
    } else {
      const questions = request.questions || [];
      const current = questions[draft.page];
      if (!current) {
        host.hidden = true;
        return;
      }
      const goToPage = (page: number) => {
        draft.page = page;
        paint(host, view);
        host
          .querySelector<HTMLElement>(
            '[role="radio"][tabindex="0"], [role="checkbox"], .mp-decision-custom',
          )
          ?.focus({preventScroll: true});
      };
      const header = element('div', 'mp-decision-heading');
      header.append(
        element(
          'span',
          'mp-decision-eyebrow',
          current.header || studioT('decision.choose'),
        ),
      );
      const navigation = element('div', 'mp-decision-pages');
      const back = button('‹', () => {
        goToPage(draft.page - 1);
      });
      back.setAttribute('aria-label', studioT('decision.previous'));
      back.disabled = view.busy || draft.page === 0;
      const forward = button('›', () => {
        goToPage(draft.page + 1);
      });
      forward.setAttribute('aria-label', studioT('decision.next_question'));
      forward.disabled = view.busy || draft.page >= questions.length - 1;
      navigation.append(
        back,
        element('span', '', `${draft.page + 1} / ${questions.length}`),
        forward,
      );
      if (questions.length > 1) {
        header.append(navigation);
      }
      card.append(header);
      card.append(element('p', 'mp-decision-question', current.question));
      if (current.multiSelect) {
        card.append(
          element('p', 'mp-decision-hint', studioT('decision.multi_hint')),
        );
      }
      const options = element('div', 'mp-decision-options');
      options.setAttribute(
        'role',
        current.multiSelect ? 'group' : 'radiogroup',
      );
      options.setAttribute('aria-label', current.question);
      current.options.forEach((option, index) => {
        const selected = draft.selected[draft.page].includes(index);
        const row = button(
          '',
          () => {
            draft.skipped[draft.page] = false;
            view.error = '';
            view.errorKey = undefined;
            const selection = draft.selected[draft.page];
            draft.selected[draft.page] = current.multiSelect
              ? selected
                ? selection.filter(value => value !== index)
                : [...selection, index]
              : [index];
            if (!current.multiSelect) {
              draft.custom[draft.page] = '';
              draft.other[draft.page] = false;
            }
            paint(host, view);
            host
              .querySelector<HTMLButtonElement>(
                `[data-option-index="${index}"]`,
              )
              ?.focus({preventScroll: true});
          },
          `mp-decision-option${selected ? ' is-selected' : ''}`,
        );
        row.dataset.optionIndex = String(index);
        row.setAttribute('role', current.multiSelect ? 'checkbox' : 'radio');
        row.setAttribute('aria-checked', String(selected));
        if (!current.multiSelect) {
          row.tabIndex =
            selected ||
            (!draft.other[draft.page] &&
              !draft.selected[draft.page].length &&
              index === 0)
              ? 0
              : -1;
        }
        const mark = element(
          'span',
          `mp-decision-choice-mark${current.multiSelect ? ' is-multi' : ''}`,
          selected ? '✓' : inline ? '' : String(index + 1),
        );
        mark.setAttribute('aria-hidden', 'true');
        const copy = element('span', 'mp-decision-option-copy');
        copy.append(element('span', 'mp-decision-option-label', option.label));
        if (option.description) {
          copy.append(
            element(
              'span',
              'mp-decision-option-description',
              option.description,
            ),
          );
        }
        if (option.preview) {
          copy.append(
            element(
              'pre',
              'mp-decision-option-preview mp-decision-command',
              option.preview,
            ),
          );
        }
        row.append(mark, copy);
        options.append(row);
      });
      card.append(options);
      const custom = element('textarea', 'mp-decision-custom');
      custom.dataset.decisionControl = 'custom';
      custom.rows = 1;
      custom.placeholder = studioT('decision.custom');
      custom.setAttribute(
        'aria-label',
        studioT('decision.your_answer', {question: current.question}),
      );
      custom.value = draft.custom[draft.page];
      custom.disabled = view.busy;
      const selectOther = () => {
        draft.other[draft.page] = true;
        custom.tabIndex = 0;
        draft.skipped[draft.page] = false;
        if (!current.multiSelect) {
          draft.selected[draft.page] = [];
          options.querySelectorAll('[aria-checked]').forEach((row, index) => {
            row.setAttribute('aria-checked', 'false');
            (row as HTMLElement).tabIndex = -1;
            row.classList.remove('is-selected');
            const mark = row.querySelector('.mp-decision-choice-mark');
            if (mark) {
              mark.textContent = inline ? '' : String(index + 1);
            }
          });
        }
        const row = host.querySelector('.mp-decision-other-choice');
        row?.setAttribute('aria-checked', 'true');
        if (row && !current.multiSelect) {
          (row as HTMLElement).tabIndex = 0;
        }
        row?.classList.add('is-selected');
        const mark = row?.querySelector('.mp-decision-choice-mark');
        if (mark) {
          mark.textContent = '✓';
        }
      };
      custom.addEventListener('focus', () => {
        selectOther();
        continueButton.disabled = view.busy || !hasAnswer();
      });
      custom.addEventListener('input', () => {
        draft.custom[draft.page] = custom.value;
        selectOther();
        if (hasAnswer()) {
          view.error = '';
          view.errorKey = undefined;
          host.querySelector('.mp-decision-error[role="alert"]')?.remove();
        }
        continueButton.disabled = view.busy || !hasAnswer();
        custom.style.height = 'auto';
        custom.style.height = `${Math.min(88, custom.scrollHeight)}px`;
      });
      if (inline) {
        const other = element('div', 'mp-decision-other');
        custom.tabIndex = draft.other[draft.page] ? 0 : -1;
        const choice = button(
          '',
          () => {
            if (current.multiSelect && draft.other[draft.page]) {
              draft.other[draft.page] = false;
              draft.custom[draft.page] = '';
              paint(host, view);
            } else {
              selectOther();
              continueButton.disabled = view.busy || !hasAnswer();
              custom.focus();
            }
          },
          `mp-decision-other-choice${draft.other[draft.page] ? ' is-selected' : ''}`,
        );
        choice.setAttribute('role', current.multiSelect ? 'checkbox' : 'radio');
        choice.setAttribute('aria-checked', String(draft.other[draft.page]));
        if (!current.multiSelect) {
          choice.tabIndex =
            draft.other[draft.page] || !current.options.length ? 0 : -1;
        }
        const mark = element(
          'span',
          `mp-decision-choice-mark${current.multiSelect ? ' is-multi' : ''}`,
          draft.other[draft.page] ? '✓' : '',
        );
        mark.setAttribute('aria-hidden', 'true');
        choice.append(
          mark,
          element('span', 'mp-decision-other-label', studioT('decision.other')),
        );
        other.append(choice, custom);
        options.append(other);
      } else {
        card.append(custom);
      }
      if (!current.multiSelect) {
        options.addEventListener('keydown', event => {
          if (
            event.defaultPrevented ||
            event.isComposing ||
            event.altKey ||
            event.ctrlKey ||
            event.metaKey ||
            view.busy
          ) {
            return;
          }
          const radios = Array.from(
            options.querySelectorAll<HTMLButtonElement>('[role="radio"]'),
          );
          const index = radios.indexOf(event.target as HTMLButtonElement);
          if (index < 0) {
            return;
          }
          let next: number;
          if (event.key === 'Home') {
            next = 0;
          } else if (event.key === 'End') {
            next = radios.length - 1;
          } else if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
            next = (index + 1) % radios.length;
          } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
            next = (index + radios.length - 1) % radios.length;
          } else {
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          radios[next].click();
          const updated =
            host.querySelectorAll<HTMLButtonElement>('[role="radio"]');
          updated[next]?.focus({preventScroll: true});
        });
      }
      const hasAnswer = () =>
        draft.selected[draft.page].length > 0 ||
        Boolean(draft.custom[draft.page].trim());
      const finish = () => {
        const missing = questions.findIndex(
          (_question, index) =>
            !draft.skipped[index] &&
            !draft.selected[index].length &&
            !draft.custom[index].trim(),
        );
        if (missing >= 0) {
          view.errorKey = 'decision.missing';
          goToPage(missing);
          return;
        }
        const answers: Record<string, string | string[]> = {};
        questions.forEach((question, index) => {
          const selected = draft.selected[index]
            .map(option => question.options[option]?.label)
            .filter(Boolean);
          const free = draft.custom[index].trim();
          answers[question.question] = question.multiSelect
            ? [...selected, ...(free ? [free] : [])]
            : free || selected[0] || '';
        });
        submit({answers});
      };
      const advance = () => {
        if (draft.page === questions.length - 1) {
          finish();
        } else {
          goToPage(draft.page + 1);
        }
      };
      const actions = element('div', 'mp-decision-actions');
      const skip = button(studioT('decision.skip'), () => {
        draft.selected[draft.page] = [];
        draft.custom[draft.page] = '';
        draft.other[draft.page] = false;
        draft.skipped[draft.page] = true;
        view.error = '';
        view.errorKey = undefined;
        advance();
      });
      skip.dataset.questionSkip = '';
      const continueButton = button(
        studioT(
          draft.page === questions.length - 1
            ? 'decision.submit'
            : 'decision.next',
        ),
        advance,
        'is-primary',
      );
      continueButton.disabled = view.busy || !hasAnswer();
      if (draft.page === questions.length - 1) {
        continueButton.dataset.questionSubmit = '';
      } else {
        continueButton.dataset.questionNext = '';
      }
      actions.append(skip, continueButton);
      card.append(actions);
    }
    if (view.busy) {
      card.classList.add('is-saving');
      const status = element(
        'p',
        'mp-decision-saving',
        studioT('decision.saving'),
      );
      status.setAttribute('role', 'status');
      status.tabIndex = -1;
      card.prepend(status);
    }
    if (view.error || view.errorKey) {
      const error = element(
        'p',
        'mp-decision-error',
        view.errorKey ? studioT(view.errorKey) : view.error,
      );
      error.setAttribute('role', 'alert');
      card.append(error);
    }
    const content = element('div', 'mp-decision-body');
    const heading = card.querySelector('.mp-decision-heading');
    const actions = card.querySelector('.mp-decision-actions');
    for (const child of Array.from(card.children)) {
      if (child !== heading && child !== actions) {
        content.append(child);
      }
    }
    card.replaceChildren(
      ...[heading, content, actions].filter(
        (item): item is HTMLElement => item instanceof HTMLElement,
      ),
    );
    mount(host, card, request.key);
    if (view.busy && hadFocus) {
      host
        .querySelector<HTMLElement>('.mp-decision-saving')
        ?.focus({preventScroll: true});
    } else if (focusControl !== undefined) {
      const control = host.querySelector<HTMLElement>(
        `[data-decision-control="${CSS.escape(focusControl)}"]`,
      );
      control?.focus({preventScroll: true});
      if (
        selection &&
        (control instanceof HTMLTextAreaElement ||
          control instanceof HTMLInputElement)
      ) {
        control.setSelectionRange(
          selection.start,
          selection.end,
          selection.direction,
        );
      }
    }
  }
  function mount(host: HTMLElement, card: HTMLElement, key: string): void {
    const existing = host.firstElementChild as HTMLElement | null;
    if (
      host.dataset.decisionKey === key &&
      existing?.classList.contains('mp-decision-card')
    ) {
      existing.className = card.className;
      existing.dataset.kind = card.dataset.kind;
      existing.dataset.presentation = card.dataset.presentation;
      existing.setAttribute(
        'aria-label',
        card.getAttribute('aria-label') || '',
      );
      existing.setAttribute(
        'aria-busy',
        card.getAttribute('aria-busy') || 'false',
      );
      existing.replaceChildren(...Array.from(card.childNodes));
    } else {
      host.dataset.decisionKey = key;
      host.replaceChildren(card);
    }
    host.hidden = false;
  }
  globalThis.DecisionCard = {
    render(host, request, submit) {
      if (resolved.has(request.key)) {
        if (!views.has(host) || views.get(host)?.request.key === request.key) {
          DecisionCard.clear(host);
        }
        return;
      }
      const existing = views.get(host);
      if (existing?.request.key === request.key) {
        const changedSources =
          existing.request.historySources !== request.historySources ||
          existing.request.historySourcesError !== request.historySourcesError;
        existing.request = request;
        existing.submit = submit;
        host.hidden = false;
        if (changedSources || existing.language !== getStudioLanguage()) {
          paint(host, existing);
        }
        return;
      }
      const questions = request.questions || [];
      const draft: Draft = drafts.get(request.key) || {
        page: 0,
        selected: questions.map(() => []),
        custom: questions.map(() => ''),
        other: questions.map(() => false),
        skipped: questions.map(() => false),
      };
      if (dailyWrapRequest(request) && !draft.dailyWrap) {
        const args = record(request.action?.arguments);
        draft.dailyWrap = {
          fromText: dateTimeInput(args.from_ms),
          toText: dateTimeInput(args.to_ms),
          fromMs: Number(args.from_ms),
          toMs: Number(args.to_ms),
          sourceMode: null,
          selectedIds: Array.isArray(args.conversation_ids)
            ? [...new Set(args.conversation_ids.map(words).filter(Boolean))]
            : [],
          search: '',
        };
      }
      drafts.set(request.key, draft);
      const view = {
        request,
        submit,
        draft,
        busy: false,
        error: '',
        language: getStudioLanguage(),
      };
      views.set(host, view);
      paint(host, view);
    },
    pending(host, busy, error = '') {
      const view = views.get(host);
      if (!view) {
        return;
      }
      view.busy = busy;
      view.error = error;
      view.errorKey = undefined;
      paint(host, view);
    },
    resolve(host) {
      const view = views.get(host);
      if (!view) {
        return;
      }
      resolved.add(view.request.key);
      const card = host.firstElementChild as HTMLElement | null;
      if (
        card &&
        !host.hidden &&
        !matchMedia('(prefers-reduced-motion: reduce)').matches
      ) {
        const bounds = card.getBoundingClientRect();
        const exit = card.cloneNode(true) as HTMLElement;
        exit.inert = true;
        exit.setAttribute('aria-hidden', 'true');
        exit.classList.add('mp-decision-exit');
        Object.assign(exit.style, {
          left: `${bounds.left}px`,
          top: `${bounds.top}px`,
          width: `${bounds.width}px`,
          height: `${bounds.height}px`,
        });
        document.body.append(exit);
        void exit
          .animate(
            [
              {opacity: 0.8, transform: 'translateY(0)'},
              {opacity: 0, transform: 'translateY(6px)'},
            ],
            {duration: 140, easing: 'ease-out'},
          )
          .finished.then(
            () => exit.remove(),
            () => exit.remove(),
          );
      }
      DecisionCard.clear(host, true);
    },
    clear(host, forget = false) {
      const view = views.get(host);
      if (forget && view) {
        drafts.delete(view.request.key);
      }
      views.delete(host);
      host.hidden = true;
      host.replaceChildren();
      delete host.dataset.decisionKey;
    },
  };
  if (typeof window !== 'undefined') {
    window.addEventListener('mp:language-change', () => {
      for (const host of document.querySelectorAll<HTMLElement>(
        '[data-decision-key]',
      )) {
        const view = views.get(host);
        if (view && view.language !== getStudioLanguage()) {
          paint(host, view);
        }
      }
    });
  }
})();
