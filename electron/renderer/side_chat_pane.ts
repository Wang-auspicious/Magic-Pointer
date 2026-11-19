'use strict';

declare global {
  interface SideChatDraft {
    conversationId: string;
    parentTurnIndex: number;
    blockIndex?: number;
    quote: string;
    snippet: string;
  }

  interface SideChatLiveState {
    requestId: string;
    branchId: string;
    question: string;
    answer: string;
    thinking: string;
  }

  interface SideChatPaneHandlers {
    onSend: (payload: {
      conversationId: string;
      branchId?: string;
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
    onOpenBranch?: (branchId: string) => void;
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
  const expandedMountedIds = new Set<string>();

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

  function renderRichMarkdown(host: HTMLElement, text: string): void {
    const source = String(text || '').trim();
    if (!source) {
      return;
    }
    if (
      typeof ChatMarkdown !== 'undefined' &&
      typeof ChatMarkdown.render === 'function'
    ) {
      host.appendChild(ChatMarkdown.render(source));
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
      ...(Number.isInteger(draft.blockIndex) ? {blockIndex: draft.blockIndex} : {}),
      quote: String(draft.quote || '').trim().slice(0, 220),
      snippet: String(draft.snippet || draft.quote || '').trim().slice(0, 800),
    };
    activeBranchId = null;
  }

  function openBranch(branchId: string): void {
    activeBranchId = String(branchId || '').trim() || null;
    activeDraft = null;
  }

  function setLiveState(next: SideChatLiveState | null): void {
    liveState = next;
  }

  function getActiveBranchId(): string | null {
    return activeBranchId;
  }

  function renderPane(
    hostEl: HTMLElement | null,
    conversation: MagicPointerConversation | null | undefined,
    handlers: SideChatPaneHandlers,
  ): void {
    if (!hostEl) {
      return;
    }
    hostEl.replaceChildren();
    const pane = el('div', 'mp-sidechat-pane');

    if (!conversation) {
      pane.appendChild(
        el(
          'div',
          'mp-sidechat-empty',
          '在左侧对话中划选任意一句，点击 “Start a side chat” 即可在此并排深入讨论；结束后可一键外挂回主对话，且绝不污染父对话上下文与 Prompt Cache。',
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

    // 1. Thread switcher strip
    if (branches.length > 0 || activeDraft) {
      const strip = el('div', 'mp-sidechat-tabs');
      for (const branch of branches) {
        const isCurrent = !activeDraft && currentBranch?.id === branch.id;
        const tab = el(
          'button',
          `mp-sidechat-tab${isCurrent ? ' is-on' : ''}${branch.mountedToParent ? ' is-mounted' : ''}`,
        );
        tab.type = 'button';
        tab.textContent = branchTitle(branch).slice(0, 22);
        tab.title = branchTitle(branch);
        tab.addEventListener('click', () => {
          openBranch(branch.id);
          renderPane(hostEl, conversation, handlers);
        });
        strip.appendChild(tab);
      }
      if (activeDraft) {
        const draftTab = el('span', 'mp-sidechat-tab is-on is-draft', '新探讨');
        strip.appendChild(draftTab);
      }
      pane.appendChild(strip);
    }

    // 2. Context & Cache Protection header
    const head = el('div', 'mp-sidechat-head');
    const quoteText = activeDraft
      ? activeDraft.quote
      : currentBranch?.anchor?.label || currentBranch?.title || '';
    if (quoteText) {
      const quoteBox = el('div', 'mp-sidechat-anchor');
      quoteBox.appendChild(el('span', 'mp-sidechat-anchor-tag', '引出小点'));
      quoteBox.appendChild(
        el('span', 'mp-sidechat-anchor-text', `「${quoteText}」`),
      );
      head.appendChild(quoteBox);
    }

    const metaRow = el('div', 'mp-sidechat-meta');
    const cacheBadge = el(
      'span',
      'mp-sidechat-cache-badge',
      '独立分叉缓存 · 未注入父上下文',
    );
    cacheBadge.title =
      '此并排探讨在独立 Session 分叉运行，父对话消息历史保持逐字节不变，Prompt Cache 零失效。';
    metaRow.appendChild(cacheBadge);

    if (currentBranch) {
      const isMounted = Boolean(currentBranch.mountedToParent);
      const mountBtn = el(
        'button',
        `mp-sidechat-mount-btn${isMounted ? ' is-mounted' : ''}`,
      );
      mountBtn.type = 'button';
      mountBtn.dataset.sidechatAction = 'toggle-mount';
      const mountIcon = el('span', 'cds-icon');
      mountIcon.dataset.size = 'xs';
      mountIcon.setAttribute('aria-hidden', 'true');
      mountIcon.textContent = isMounted ? '\uE03B' : '\uE012';
      mountBtn.append(
        mountIcon,
        document.createTextNode(
          isMounted
            ? '已外挂到主对话（零上下文）'
            : '外挂到主对话（不入上下文）',
        ),
      );
      mountBtn.addEventListener('click', () => {
        void handlers.onToggleMount(
          conversation.id,
          currentBranch.id,
          !isMounted,
          currentBranch.mountNote || currentBranch.insightSummary || '',
        );
      });
      metaRow.appendChild(mountBtn);
    }
    head.appendChild(metaRow);
    pane.appendChild(head);

    // 3. Multi-turn side chat stream
    const stream = el('div', 'mp-sidechat-stream');
    const turns = currentBranch?.turns || [];
    if (!turns.length && !liveState) {
      const intro = el(
        'div',
        'mp-sidechat-empty',
        activeDraft
          ? '针对这个小点单独展开多轮追问；结束后可一键整段外挂回主对话，不占主对话上下文。'
          : '在主对话中划选任意文本，点击 “Start a side chat” 开启并排探讨。',
      );
      stream.appendChild(intro);
    } else {
      for (const turn of turns) {
        if (turn.question) {
          const userRow = el('div', 'mp-sidechat-msg is-user');
          userRow.appendChild(el('div', 'mp-sidechat-bubble', turn.question));
          stream.appendChild(userRow);
        }
        const assistantRow = el('div', 'mp-sidechat-msg is-assistant');
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
        (!currentBranch && activeDraft))
    ) {
      const liveUser = el('div', 'mp-sidechat-msg is-user');
      liveUser.appendChild(el('div', 'mp-sidechat-bubble', liveState.question));
      stream.appendChild(liveUser);

      const liveAssistant = el('div', 'mp-sidechat-msg is-assistant is-live');
      const body = el('div', 'mp-chat-markdown');
      if (liveState.answer) {
        renderRichMarkdown(body, liveState.answer);
      } else {
        body.appendChild(
          el(
            'span',
            'mp-sidechat-thinking',
            liveState.thinking ? '正在推演…' : '思考中…',
          ),
        );
      }
      liveAssistant.appendChild(body);
      stream.appendChild(liveAssistant);
    }

    pane.appendChild(stream);

    // 4. Independent bottom composer
    if (activeDraft || currentBranch) {
      const composer = el('form', 'mp-sidechat-composer');
      if (!turns.length && !liveState) {
        const chips = el('div', 'mp-sidechat-chips');
        const starters = [
          '把这一点拆到底层原理讲透',
          '举一个容易踩坑的反例或边界条件',
          '用 2 句话提炼成可复用的核心结论',
        ];
        for (const starter of starters) {
          const chip = el('button', 'mp-sidechat-chip', starter);
          chip.type = 'button';
          chip.addEventListener('click', () => {
            textarea.value = starter;
            textarea.focus();
            composer.requestSubmit();
          });
          chips.appendChild(chip);
        }
        composer.appendChild(chips);
      }

      const row = el('div', 'mp-sidechat-input-row');
      const textarea = el('textarea', 'mp-sidechat-input');
      textarea.rows = 2;
      textarea.placeholder = '单独深挖这个小点…（Enter 发送，Shift+Enter 换行）';
      textarea.addEventListener('keydown', event => {
        if (
          event.key === 'Enter' &&
          !event.shiftKey &&
          !event.isComposing
        ) {
          event.preventDefault();
          composer.requestSubmit();
        }
      });

      const actionBtn = el(
        'button',
        'mp-sidechat-send',
        liveState ? '停止' : '发送',
      );
      actionBtn.type = liveState ? 'button' : 'submit';
      if (liveState && handlers.onStop) {
        const reqId = liveState.requestId;
        actionBtn.addEventListener('click', () => handlers.onStop?.(reqId));
      }

      row.append(textarea, actionBtn);
      composer.appendChild(row);

      composer.addEventListener('submit', event => {
        event.preventDefault();
        if (liveState) {
          return;
        }
        const question = textarea.value.trim();
        if (!question) {
          return;
        }
        textarea.value = '';
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
          parentTurnIndex: targetTurnIndex,
          ...(Number.isInteger(targetBlockIndex)
            ? {blockIndex: targetBlockIndex}
            : {}),
          anchorLabel:
            currentBranch?.anchor?.label || activeDraft?.quote || question.slice(0, 40),
          anchorSnippet:
            currentBranch?.anchor?.snippet || activeDraft?.snippet || '',
          question,
        });
      });

      pane.appendChild(composer);
    }

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
