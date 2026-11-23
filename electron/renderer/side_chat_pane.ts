'use strict';

declare global {
  interface SideChatDraft {
    conversationId: string;
    parentTurnIndex: number;
    parentBranchId?: string | null;
    blockIndex?: number;
    quote: string;
    snippet: string;
  }

  interface SideChatLiveState {
    requestId: string;
    branchId: string;
    question: string;
    quote?: string;
    answer: string;
    thinking: string;
  }

  interface SideChatPaneHandlers {
    onSend: (payload: {
      conversationId: string;
      branchId?: string;
      parentBranchId?: string | null;
      parentTurnIndex: number;
      blockIndex?: number;
      anchorLabel: string;
      anchorSnippet: string;
      question: string;
    }) => Promise<void>;
    onStop?: (requestId: string) => void;
    onToggleMount: (
      conversationId: string,
      branchId: string,
      mounted: boolean,
      mountNote?: string,
    ) => Promise<void>;
    onTailCite?: (branch: MagicPointerLearnBranch) => void;
    onPromoteToArtifact?: (
      branch: MagicPointerLearnBranch,
    ) => void | Promise<void>;
    onOpenBranch?: (branchId: string) => void;
    onBack?: () => void;
  }

  interface SideChatPaneApi {
    openDraft(draft: SideChatDraft): void;
    openBranch(branchId: string): void;
    setLiveState(next: SideChatLiveState | null): void;
    getActiveBranchId(): string | null;
    renderPane(
      hostEl: HTMLElement | null,
      conversation: MagicPointerConversation | null | undefined,
      handlers: SideChatPaneHandlers,
    ): void;
    renderMountedCards(
      streamEl: HTMLElement | null,
      conversation: MagicPointerConversation | null | undefined,
      handlers: SideChatPaneHandlers,
    ): void;
  }

  var SideChatPane: SideChatPaneApi | undefined;
}

(() => {

  let activeBranchId: string | null = null;
  let activeDraft: SideChatDraft | null = null;
  let liveState: SideChatLiveState | null = null;
  let historyMenuOpen = false;
  const expandedMountedIds = new Set<string>();
  const collapsedBriefKeys = new Set<string>();

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

  function hasCompleteInteractiveFences(source: string): boolean {
    const htmlFences = (source.match(/```html\b/gi) || []).length;
    const allFences = (source.match(/```/g) || []).length;
    const uiOpens = (source.match(/^:::\s*ui\b/gim) || []).length;
    const uiCloses = (source.match(/^:::\s*$/gim) || []).length;
    if (htmlFences > 0 && allFences % 2 !== 0) {
      return false;
    }
    if (uiOpens > uiCloses) {
      return false;
    }
    return true;
  }

  function hydrateRichWidgets(
    host: HTMLElement,
    options: {allowInteractive?: boolean} = {},
  ): void {
    const g = globalThis as unknown as {
      LearnLab?: {hydrate?: (el: Element) => void};
      IntelligenceUI?: {hydrate?: (el: Element) => void};
    };
    if (typeof g.LearnLab?.hydrate === 'function') {
      g.LearnLab.hydrate(host);
    }
    if (
      options.allowInteractive !== false &&
      typeof g.IntelligenceUI?.hydrate === 'function'
    ) {
      g.IntelligenceUI.hydrate(host);
    }
  }

  function renderRichMarkdown(
    host: HTMLElement,
    text: string,
    options: {streaming?: boolean} = {},
  ): void {
    const source = String(text || '').trim();
    if (!source) {
      return;
    }
    if (
      typeof ChatMarkdown !== 'undefined' &&
      typeof ChatMarkdown.render === 'function'
    ) {
      host.appendChild(ChatMarkdown.render(source));
      hydrateRichWidgets(host, {
        allowInteractive:
          !options.streaming || hasCompleteInteractiveFences(source),
      });
      return;
    }
    host.textContent = source;
  }

  function branchTitle(branch: MagicPointerLearnBranch): string {
    return (
      String(branch.title || branch.anchor?.label || '并排探讨').trim() ||
      '并排探讨'
    );
  }

  function openDraft(draft: SideChatDraft): void {
    activeDraft = {
      conversationId: draft.conversationId,
      parentTurnIndex: Math.max(0, Math.floor(Number(draft.parentTurnIndex) || 0)),
      parentBranchId: draft.parentBranchId ?? null,
      ...(Number.isInteger(draft.blockIndex) ? {blockIndex: draft.blockIndex} : {}),
      quote: String(draft.quote || '').trim().slice(0, 220),
      snippet: String(draft.snippet || draft.quote || '').trim().slice(0, 800),
    };
    activeBranchId = null;
    historyMenuOpen = false;
  }

  function openBranch(branchId: string): void {
    activeBranchId = String(branchId || '').trim() || null;
    activeDraft = null;
    historyMenuOpen = false;
  }

  function setLiveState(next: SideChatLiveState | null): void {
    liveState = next;
  }

  function getActiveBranchId(): string | null {
    return activeBranchId;
  }

  function renderLiveThinkingRow(): HTMLElement {
    const thinkingRow = el('div', 'mp-sidechat-thinking');
    const sparkApi = (
      globalThis as unknown as {
        ActivityMarks?: {spark?: (state: string) => string};
      }
    ).ActivityMarks;
    if (typeof sparkApi?.spark === 'function') {
      const sparkWrap = el('span', 'mp-sidechat-spark');
      sparkWrap.innerHTML = sparkApi.spark('thinking');
      thinkingRow.appendChild(sparkWrap);
    }
    thinkingRow.appendChild(el('span', '', 'Thinking…'));
    return thinkingRow;
  }

  function resolveBranchAncestors(
    branches: MagicPointerLearnBranch[],
    startParentId: string | null | undefined,
  ): MagicPointerLearnBranch[] {
    const chain: MagicPointerLearnBranch[] = [];
    const seen = new Set<string>();
    let cursor = startParentId ? String(startParentId) : '';
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      const found = branches.find(item => item.id === cursor);
      if (!found) {
        break;
      }
      chain.unshift(found);
      cursor = found.parentBranchId ? String(found.parentBranchId) : '';
    }
    return chain;
  }

  function renderPane(
    hostEl: HTMLElement | null,
    conversation: MagicPointerConversation | null | undefined,
    handlers: SideChatPaneHandlers,
  ): void {
    if (!hostEl) {
      return;
    }

    if (liveState) {
      const liveBody = hostEl.querySelector<HTMLElement>(
        `[data-sidechat-live-id="${liveState.requestId}"]`,
      );
      const streamNode = hostEl.querySelector<HTMLElement>('.mp-sidechat-stream');
      if (liveBody && streamNode) {
        liveBody.replaceChildren();
        if (liveState.answer) {
          renderRichMarkdown(liveBody, liveState.answer, {streaming: true});
        } else {
          liveBody.appendChild(renderLiveThinkingRow());
        }
        streamNode.scrollTop = streamNode.scrollHeight;
        return;
      }
    }

    hostEl.replaceChildren();
    const pane = el('div', 'mp-sidechat-pane');

    if (!conversation) {
      pane.appendChild(
        el(
          'div',
          'mp-sidechat-empty',
          document.documentElement.lang.startsWith('zh')
            ? '顺手聊点相关的，不打断主线'
            : 'Ask a quick question in parallel.',
        ),
      );
      hostEl.appendChild(pane);
      return;
    }

    const branches = Array.isArray(conversation.branches)
      ? conversation.branches
      : [];
    if (
      !activeDraft &&
      (!activeBranchId || !branches.some(item => item.id === activeBranchId))
    ) {
      activeBranchId = branches[branches.length - 1]?.id || null;
    }
    const currentBranch = activeBranchId
      ? branches.find(item => item.id === activeBranchId) || null
      : null;

    // 1. Clean图5 header (`< Title` + branch switcher / new discussion)
    const ancestors = resolveBranchAncestors(
      branches,
      activeDraft ? activeDraft.parentBranchId : currentBranch?.parentBranchId,
    );
    const hasNestedCrumbs = ancestors.length > 0;
    const hasMultipleThreads = branches.length > 1;
    const headerTitle = activeDraft
      ? activeDraft.quote || '新探讨'
      : currentBranch
        ? branchTitle(currentBranch)
        : 'Side chat';
    const topbar = el('div', 'mp-sidechat-topbar');
    const backBtn = el('button', 'mp-sidechat-back-btn');
    backBtn.type = 'button';
    backBtn.title = hasNestedCrumbs ? '返回上一级探讨' : '收起右侧分栏';
    const backIcon = el('span', 'cds-icon mp-sidechat-back-chevron');
    backIcon.dataset.size = 'xs';
    backIcon.dataset.glyph = '\uE02B';
    backIcon.setAttribute('aria-hidden', 'true');
    backBtn.append(
      backIcon,
      el('span', 'mp-sidechat-header-title', headerTitle),
    );
    backBtn.addEventListener('click', () => {
      if (hasNestedCrumbs) {
        const parent = ancestors[ancestors.length - 1];
        if (parent) {
          openBranch(parent.id);
          renderPane(hostEl, conversation, handlers);
          return;
        }
      }
      handlers.onBack?.();
    });
    topbar.appendChild(backBtn);

    if (hasNestedCrumbs) {
      const crumbs = el('nav', 'mp-sidechat-crumbs');
      crumbs.setAttribute('aria-label', 'Side chat hierarchy');
      for (let i = 0; i < ancestors.length; i++) {
        const anc = ancestors[i];
        if (i > 0) {
          crumbs.appendChild(el('span', 'mp-sidechat-crumb-sep', '›'));
        }
        const crumbBtn = el(
          'button',
          'mp-sidechat-crumb',
          branchTitle(anc).slice(0, 18),
        );
        crumbBtn.type = 'button';
        crumbBtn.title = branchTitle(anc);
        crumbBtn.addEventListener('click', () => {
          openBranch(anc.id);
          renderPane(hostEl, conversation, handlers);
        });
        crumbs.appendChild(crumbBtn);
      }
      topbar.appendChild(crumbs);
    }

    const topActions = el('div', 'mp-sidechat-top-actions');
    if (hasMultipleThreads) {
      const histBtn = el(
        'button',
        'mp-sidechat-top-btn',
        `全部 (${branches.length}) ▾`,
      );
      histBtn.type = 'button';
      histBtn.setAttribute('aria-expanded', String(historyMenuOpen));

      const menu = el('div', 'mp-sidechat-history-menu');
      menu.hidden = !historyMenuOpen;
      for (const branch of branches) {
        const isCurrent = !activeDraft && currentBranch?.id === branch.id;
        const item = el(
          'button',
          `mp-sidechat-history-item${isCurrent ? ' is-on' : ''}`,
        );
        item.type = 'button';
        item.appendChild(
          el('span', 'mp-sidechat-history-title', branchTitle(branch)),
        );
        if (branch.mountedToParent) {
          item.appendChild(el('span', 'mp-sidechat-crumb-sep', '已外挂'));
        }
        item.addEventListener('click', () => {
          openBranch(branch.id);
          renderPane(hostEl, conversation, handlers);
        });
        menu.appendChild(item);
      }

      histBtn.addEventListener('click', ev => {
        ev.stopPropagation();
        historyMenuOpen = !historyMenuOpen;
        menu.hidden = !historyMenuOpen;
        histBtn.setAttribute('aria-expanded', String(historyMenuOpen));
      });
      topActions.appendChild(histBtn);
      topbar.appendChild(menu);
    }

    const newBtn = el('button', 'mp-sidechat-top-btn', '+ 新探讨');
    newBtn.type = 'button';
    newBtn.addEventListener('click', () => {
      openDraft({
        conversationId: conversation.id,
        parentTurnIndex: Math.max(0, (conversation.turns?.length || 1) - 1),
        parentBranchId: null,
        quote: '',
        snippet: '',
      });
      renderPane(hostEl, conversation, handlers);
    });
    topActions.appendChild(newBtn);
    topbar.appendChild(topActions);
    pane.appendChild(topbar);

    // 2. Normal Claude conversation stream
    const stream = el('div', 'mp-sidechat-stream');
    const turns = currentBranch?.turns || [];
    const persistedQuote =
      currentBranch?.anchor?.snippet || currentBranch?.anchor?.label || '';
    const renderQuoteChip = (text: string, briefKey = 'brief') => {
      const isLongBrief = text.length > 180 || text.includes('\n');
      if (isLongBrief) {
        const collapsed = collapsedBriefKeys.has(briefKey);
        const box = el('div', `mp-sidechat-brief-card${collapsed ? ' is-collapsed' : ''}`);
        const body = el('div', 'mp-sidechat-brief-body mp-chat-markdown');
        renderRichMarkdown(body, text);
        const toggleBtn = el(
          'button',
          'mp-sidechat-brief-toggle',
          collapsed ? 'Show more' : 'Show less',
        );
        toggleBtn.type = 'button';
        toggleBtn.addEventListener('click', () => {
          if (collapsedBriefKeys.has(briefKey)) {
            collapsedBriefKeys.delete(briefKey);
          } else {
            collapsedBriefKeys.add(briefKey);
          }
          renderPane(hostEl, conversation, handlers);
        });
        box.append(body, toggleBtn);
        return box;
      }
      const quoteChip = el('div', 'mp-sidechat-msg-quote');
      const qIcon = el('span', 'cds-icon');
      qIcon.dataset.size = 'xs';
      qIcon.dataset.glyph = '\uF087';
      qIcon.setAttribute('aria-hidden', 'true');
      const qText = el('span', 'mp-sidechat-msg-quote-text', text);
      quoteChip.append(qIcon, qText);
      return quoteChip;
    };

    if (!turns.length && !liveState) {
      if (activeDraft?.quote) {
        stream.appendChild(
          renderQuoteChip(
            activeDraft.snippet || activeDraft.quote,
            `draft:${conversation.id}`,
          ),
        );
      } else {
        const empty = el('div', 'mp-sidechat-empty');
        empty.textContent = document.documentElement.lang.startsWith('zh')
          ? '顺手聊点相关的，不打断主线'
          : 'Ask a quick follow-up without interrupting the main chat.';
        stream.appendChild(empty);
      }
    } else {
      for (let idx = 0; idx < turns.length; idx++) {
        const turn = turns[idx];
        if (turn.question) {
          const userRow = el('div', 'mp-sidechat-msg is-user');
          if (currentBranch) {
            userRow.dataset.branchId = currentBranch.id;
          }
          const userStack = el('div', 'mp-sidechat-user-stack');
          if (idx === 0 && persistedQuote) {
            userStack.appendChild(
              renderQuoteChip(persistedQuote, currentBranch?.id || `turn:${idx}`),
            );
          }
          userStack.appendChild(el('div', 'mp-sidechat-bubble', turn.question));
          userRow.appendChild(userStack);
          stream.appendChild(userRow);
        }
        const assistantRow = el('div', 'mp-sidechat-msg is-assistant');
        if (currentBranch) {
          assistantRow.dataset.branchId = currentBranch.id;
        }
        const body = el('div', 'mp-chat-markdown');
        if (turn.answer) {
          renderRichMarkdown(body, turn.answer);
        } else if (turn.error) {
          body.appendChild(el('p', 'mp-sidechat-error', String(turn.error)));
        }
        assistantRow.appendChild(body);
        stream.appendChild(assistantRow);
      }
    }

    if (
      liveState &&
      ((currentBranch && liveState.branchId === currentBranch.id) ||
        !currentBranch ||
        !liveState.branchId)
    ) {
      const liveUser = el('div', 'mp-sidechat-msg is-user');
      const liveUserStack = el('div', 'mp-sidechat-user-stack');
      if (liveState.quote) {
        liveUserStack.appendChild(renderQuoteChip(liveState.quote));
      }
      liveUserStack.appendChild(el('div', 'mp-sidechat-bubble', liveState.question));
      liveUser.appendChild(liveUserStack);
      stream.appendChild(liveUser);

      const liveAssistant = el('div', 'mp-sidechat-msg is-assistant is-live');
      if (currentBranch) {
        liveAssistant.dataset.branchId = currentBranch.id;
      }
      const body = el('div', 'mp-chat-markdown');
      body.dataset.sidechatLiveId = liveState.requestId;
      if (liveState.answer) {
        renderRichMarkdown(body, liveState.answer, {streaming: true});
      } else {
        body.appendChild(renderLiveThinkingRow());
      }
      liveAssistant.appendChild(body);
      stream.appendChild(liveAssistant);
    }

    if (currentBranch && turns.length > 0 && !liveState) {
      const isMounted = Boolean(currentBranch.mountedToParent);
      const footActions = el('div', 'mp-sidechat-foot-actions');
      const mountBtn = el(
        'button',
        `mp-sidechat-mount-btn${isMounted ? ' is-mounted' : ''}`,
      );
      mountBtn.type = 'button';
      mountBtn.dataset.sidechatAction = 'toggle-mount';
      mountBtn.title = '零上下文外挂：仅作为主对话卡片保留，未注入上下文';
      const mountIcon = el('span', 'cds-icon');
      mountIcon.dataset.size = 'xs';
      mountIcon.dataset.glyph = isMounted ? '\uE03B' : '\uE012';
      mountIcon.setAttribute('aria-hidden', 'true');
      mountBtn.append(
        mountIcon,
        document.createTextNode(isMounted ? '已外挂到主对话' : '外挂到主对话'),
      );
      mountBtn.addEventListener('click', () => {
        void handlers.onToggleMount(
          conversation.id,
          currentBranch.id,
          !isMounted,
          currentBranch.mountNote || currentBranch.insightSummary || '',
        );
      });
      footActions.appendChild(mountBtn);
      if (handlers.onPromoteToArtifact) {
        const promoteBtn = el(
          'button',
          'mp-sidechat-foot-btn mp-sidechat-promote-btn',
          '收入笔记',
        );
        promoteBtn.type = 'button';
        promoteBtn.title = '把此条引理收入右侧精读笔记';
        promoteBtn.addEventListener('click', () => {
          promoteBtn.disabled = true;
          promoteBtn.textContent = '已收入笔记 ✓';
          void Promise.resolve(handlers.onPromoteToArtifact?.(currentBranch))
            .catch(() => {
              promoteBtn.textContent = '收入笔记';
              promoteBtn.disabled = false;
            });
        });
        footActions.appendChild(promoteBtn);
      }
      stream.appendChild(footActions);
    }

    pane.appendChild(stream);

    // 3. Clean Claude-style bottom composer
    const composer = el('form', 'mp-sidechat-composer');
    const card = el('div', 'mp-sidechat-card');

    if (activeDraft?.quote) {
      const replyBar = el('div', 'mp-sidechat-reply-bar');
      const replyIcon = el('span', 'cds-icon');
      replyIcon.dataset.size = 'xs';
      replyIcon.dataset.glyph = '\uF087';
      replyIcon.setAttribute('aria-hidden', 'true');
      const replyText = el('span', 'mp-sidechat-reply-text', activeDraft.quote);
      replyText.title = activeDraft.quote;
      const dismissBtn = el('button', 'mp-sidechat-reply-dismiss');
      dismissBtn.type = 'button';
      dismissBtn.setAttribute('aria-label', 'Remove quote');
      const closeIcon = el('span', 'cds-icon');
      closeIcon.dataset.size = 'xs';
      closeIcon.dataset.glyph = '\uE10F';
      closeIcon.setAttribute('aria-hidden', 'true');
      dismissBtn.appendChild(closeIcon);
      dismissBtn.addEventListener('click', () => {
        if (activeDraft) {
          activeDraft = {...activeDraft, quote: '', snippet: ''};
        }
        renderPane(hostEl, conversation, handlers);
      });
      replyBar.append(replyIcon, replyText, dismissBtn);
      card.appendChild(replyBar);
    }

    const row = el('div', 'mp-sidechat-input-row');
    const textarea = el('textarea', 'mp-sidechat-input');
    textarea.rows = 1;
    textarea.placeholder = document.documentElement.lang.startsWith('zh')
      ? '顺手问一句…'
      : 'Ask a quick question…';

    const actionBtn = el(
      'button',
      `mp-sidechat-send${liveState ? ' is-stop' : ''}`,
    );
    actionBtn.type = liveState ? 'button' : 'submit';
    actionBtn.title = liveState ? 'Stop' : 'Send';
    actionBtn.setAttribute('aria-label', liveState ? 'Stop' : 'Send');
    const actionGlyph = el('span', 'cds-icon');
    actionGlyph.dataset.size = liveState ? 'large' : 'small';
    if (!liveState) {
      actionGlyph.dataset.weight = 'strong';
    }
    actionGlyph.dataset.glyph = liveState ? '\uE0EC' : '\uE013';
    actionGlyph.setAttribute('aria-hidden', 'true');
    actionBtn.appendChild(actionGlyph);
    if (!liveState) {
      actionBtn.disabled = true;
    }

    const syncSideComposer = () => {
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(140, Math.max(24, textarea.scrollHeight))}px`;
      if (!liveState) {
        actionBtn.disabled = !textarea.value.trim();
      }
    };
    textarea.addEventListener('input', syncSideComposer);
    textarea.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        composer.requestSubmit();
      }
    });

    if (liveState && handlers.onStop) {
      const reqId = liveState.requestId;
      actionBtn.addEventListener('click', () => handlers.onStop?.(reqId));
    }

    row.append(textarea, actionBtn);
    card.appendChild(row);
    composer.appendChild(card);

    composer.addEventListener('submit', event => {
      event.preventDefault();
      if (liveState) {
        return;
      }
      const question = textarea.value.trim();
      if (!question) {
        return;
      }
      const sentQuote = activeDraft?.quote || '';
      const sentSnippet = activeDraft?.snippet || sentQuote;
      const sentParentBranchId = activeDraft?.parentBranchId ?? null;
      if (activeDraft) {
        activeDraft = {...activeDraft, quote: '', snippet: ''};
      }
      card.querySelector('.mp-sidechat-reply-bar')?.remove();
      textarea.value = '';
      syncSideComposer();
      const targetTurnIndex = currentBranch
        ? currentBranch.parentTurnIndex
        : activeDraft?.parentTurnIndex ??
          Math.max(0, (conversation.turns?.length || 1) - 1);
      const targetBlockIndex = currentBranch
        ? currentBranch.anchor?.blockIndex
        : activeDraft?.blockIndex;
      void handlers.onSend({
        conversationId: conversation.id,
        ...(currentBranch ? {branchId: currentBranch.id} : {}),
        ...(currentBranch ? {} : {parentBranchId: sentParentBranchId}),
        parentTurnIndex: targetTurnIndex,
        ...(Number.isInteger(targetBlockIndex)
          ? {blockIndex: targetBlockIndex}
          : {}),
        anchorLabel:
          currentBranch?.anchor?.label || sentQuote || question.slice(0, 40),
        anchorSnippet:
          currentBranch?.anchor?.snippet || sentSnippet || '',
        question,
      });
    });

    pane.appendChild(composer);

    hostEl.appendChild(pane);
    stream.scrollTop = stream.scrollHeight;
  }

  function renderMountedCards(
    streamEl: HTMLElement | null,
    conversation: MagicPointerConversation | null | undefined,
    handlers: SideChatPaneHandlers,
  ): void {
    if (!streamEl) {
      return;
    }
    streamEl
      .querySelectorAll('.mp-mounted-sidechat')
      .forEach(existing => existing.remove());

    const mounted = (conversation?.branches || []).filter(
      branch => branch.mountedToParent === true,
    );
    if (!conversation || !mounted.length) {
      return;
    }

    const assistantNodes = Array.from(
      streamEl.querySelectorAll<HTMLElement>('.mp-chat-assistant'),
    );

    for (const branch of mounted) {
      const card = el('section', 'mp-mounted-sidechat');
      card.dataset.mountedBranchId = branch.id;
      const isExpanded = expandedMountedIds.has(branch.id);

      const header = el('header', 'mp-mounted-sidechat-head');
      const left = el('div', 'mp-mounted-sidechat-title-wrap');
      left.appendChild(el('span', 'mp-mounted-sidechat-kind', '外挂探讨'));
      left.appendChild(
        el('strong', 'mp-mounted-sidechat-title', branchTitle(branch)),
      );
      left.appendChild(
        el(
          'span',
          'mp-mounted-sidechat-count',
          `${branch.turns?.length || 0} 轮`,
        ),
      );
      const cachePill = el(
        'span',
        'mp-mounted-sidechat-cache',
        '未注入上下文 · 保护缓存',
      );
      cachePill.title =
        '此整段探讨仅作为视觉外挂挂载于此，不会进入父对话发给模型的上下文，避免破坏 Prompt Cache。';
      left.appendChild(cachePill);

      const actions = el('div', 'mp-mounted-sidechat-actions');
      const toggleBtn = el(
        'button',
        'mp-mounted-sidechat-btn',
        isExpanded ? '收起全文' : '展开全文',
      );
      toggleBtn.type = 'button';
      toggleBtn.addEventListener('click', () => {
        if (expandedMountedIds.has(branch.id)) {
          expandedMountedIds.delete(branch.id);
        } else {
          expandedMountedIds.add(branch.id);
        }
        renderMountedCards(streamEl, conversation, handlers);
      });

      const continueBtn = el('button', 'mp-mounted-sidechat-btn', '并排继续');
      continueBtn.type = 'button';
      continueBtn.addEventListener('click', () => {
        openBranch(branch.id);
        handlers.onOpenBranch?.(branch.id);
      });

      actions.append(toggleBtn, continueBtn);

      if (handlers.onTailCite) {
        const citeBtn = el(
          'button',
          'mp-mounted-sidechat-btn',
          '尾部引用 1 句',
        );
        citeBtn.type = 'button';
        citeBtn.title =
          '仅把 1 句提炼结论附在下一条用户消息末尾，绝不改写历史前缀。';
        citeBtn.addEventListener('click', () => handlers.onTailCite?.(branch));
        actions.appendChild(citeBtn);
      }

      const unmountBtn = el('button', 'mp-mounted-sidechat-btn is-subtle', '取消外挂');
      unmountBtn.type = 'button';
      unmountBtn.addEventListener('click', () => {
        void handlers.onToggleMount(conversation.id, branch.id, false);
      });
      actions.appendChild(unmountBtn);

      header.append(left, actions);
      card.appendChild(header);

      const summaryText = String(
        branch.mountNote || branch.insightSummary || '',
      ).trim();
      if (summaryText && !isExpanded) {
        card.appendChild(el('p', 'mp-mounted-sidechat-summary', summaryText));
      }

      if (isExpanded) {
        const body = el('div', 'mp-mounted-sidechat-body');
        for (const turn of branch.turns || []) {
          if (turn.question) {
            body.appendChild(
              el('div', 'mp-mounted-sidechat-q', `问：${turn.question}`),
            );
          }
          if (turn.answer) {
            const ans = el('div', 'mp-mounted-sidechat-a mp-chat-markdown');
            renderRichMarkdown(ans, turn.answer);
            body.appendChild(ans);
          }
        }
        card.appendChild(body);
      }

      const targetTurn =
        assistantNodes[branch.parentTurnIndex] ||
        assistantNodes[assistantNodes.length - 1];
      if (targetTurn && targetTurn.parentElement) {
        targetTurn.insertAdjacentElement('afterend', card);
      } else {
        streamEl.appendChild(card);
      }
    }
  }

  const api: SideChatPaneApi = {
    openDraft,
    openBranch,
    setLiveState,
    getActiveBranchId,
    renderPane,
    renderMountedCards,
  };

  globalThis.SideChatPane = api;
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
})();
