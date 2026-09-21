/* Pending tool input is a form, separate from the chat composer. */
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
    question?: string;
    questions?: MagicPointerDecisionQuestion[];
    presentation?: 'inline' | 'dock';
  }
  type MagicPointerDecisionResponse = { decision: 'once' | 'grant' | 'deny' }
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
      if (request.actionPreview || request.prefix) card.append(element('pre', 'mp-decision-command', request.actionPreview || request.prefix));
      const actions = element('div', 'mp-decision-actions');
      const deny = button('Deny', () => submit({ decision: 'deny' }));
      deny.dataset.decision = 'deny';
      const allow = element('div', 'mp-decision-allow');
      const session = button('Allow for this session', () => submit({ decision: 'grant' }));
      session.dataset.decision = 'grant';
      const once = button('Allow once', () => submit({ decision: 'once' }), 'is-primary');
      once.dataset.decision = 'once';
      allow.append(session, once); actions.append(deny, allow); card.append(actions);
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
      if (existing?.request.key === request.key) { existing.submit = submit; host.hidden = false; return; }
      const questions = request.questions || [];
      const draft = drafts.get(request.key) || { page: 0, selected: questions.map(() => []), custom: questions.map(() => ''), other: questions.map(() => false), skipped: questions.map(() => false) };
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
