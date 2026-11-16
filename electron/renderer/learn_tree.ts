'use strict';

declare global {
  interface LearnTreeHooks {
    getConversation(): MagicPointerConversation | null;
    getEffort(): string;
    openDeckInInspector(): void;
    openConversationById(id: string): void;
    refreshConversation(id: string): Promise<void>;
    onMainLemmasChanged?(): void;
  }

  interface LearnTreeController {
    init(hooks: LearnTreeHooks): void;
    mountConversation(
      streamEl: HTMLElement,
      conversation: MagicPointerConversation | null | undefined,
    ): void;
    renderDeck(
      hostEl: HTMLElement | null,
      conversation: MagicPointerConversation | null | undefined,
    ): void;
    renderMainComposerLemmas(hostEl: HTMLElement | null): void;
    formatQuestionWithMainLemmas(question: string): string;
    hasDockedBranches(
      conversation: MagicPointerConversation | null | undefined,
    ): boolean;
  }

  var LearnTree: LearnTreeController | undefined;
}

(() => {
  type LearnHooks = LearnTreeHooks;

  interface DraftSpawnState {
    conversationId: string;
    parentBranchId: string | null;
    parentTurnIndex: number;
    anchor: MagicPointerLearnAnchor;
  }

  interface LiveBranchStream {
    requestId: string;
    branchId: string;
    turnIndex: number;
    answer: string;
    thinking: string;
  }

  const LEMMA_MIME = 'application/x-mp-learn-lemma';
  const BRANCH_MIME = 'application/x-mp-learn-branch';

  let hooks: LearnHooks | null = null;
  let initialized = false;
  let draftSpawn: DraftSpawnState | null = null;
  let highlightedBranchId = '';
  let glossPopover: HTMLElement | null = null;
  let glossTimer: ReturnType<typeof setTimeout> | null = null;
  let selectionBar: HTMLElement | null = null;
  let dockDropzone: HTMLElement | null = null;
  let pendingSelectionContext: {
    parentBranchId: string | null;
    parentTurnIndex: number;
    quote: string;
  } | null = null;

  // Per root-turn focus shift target: key = `${conversationId}:${rootTurnIndex}` -> focused branchId
  const focusShiftByRoot = new Map<string, string>();
  // Per composer lemma chips: key = branchId or '__draft__' or '__main__'
  const composerLemmas = new Map<string, MagicPointerLearnLemmaRef[]>();
  const liveStreams = new Map<string, LiveBranchStream>();

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

  function renderMarkdownNode(markdown: string): HTMLElement {
    const rendered = ChatMarkdown.render(markdown || '');
    if (rendered instanceof HTMLElement) {
      return rendered;
    }
    const fallback = el('div', 'mp-chat-markdown');
    fallback.textContent = markdown || '';
    return fallback;
  }

  function branchSummaryForLemma(branch: MagicPointerLearnBranch): string {
    if (branch.insightSummary && branch.insightSummary.trim()) {
      return branch.insightSummary.trim();
    }
    const lastSettled = [...(branch.turns || [])]
      .reverse()
      .find(turn => String(turn.answer || '').trim());
    if (!lastSettled) {
      return branch.anchor.snippet || branch.title;
    }
    return String(lastSettled.answer || '')
      .replace(/:::card[^\n]*\n?/g, '')
      .replace(/:::\s*$/gm, '')
      .replace(/\[\[([^\]|\n]+)(?:\|[^\]\n]+)?\]\]/g, '$1')
      .replace(/==([^=\n]+)==/g, '$1')
      .trim()
      .slice(0, 600);
  }

  function quickPromptsFor(
    anchor: MagicPointerLearnAnchor,
  ): Array<{label: string; prompt: string}> {
    const target = anchor.label.slice(0, 80);
    if (anchor.kind === 'math') {
      return [
        {
          label: '逐项解释符号',
          prompt: `请逐项解释这个公式中每个符号的含义与量纲/定义域：$${anchor.snippet || target}$`,
        },
        {
          label: '补全推导步骤',
          prompt: `这个公式是怎么一步步推导出来的？请把中间省略的跳步完整展开。`,
        },
        {
          label: '直觉与几何意义',
          prompt: `不要堆砌术语，用物理/几何直觉讲透这个公式到底在刻画什么。`,
        },
      ];
    }
    if (anchor.kind === 'card') {
      return [
        {
          label: '拆解核心卡点',
          prompt: `针对「${target}」这一块，把最容易卡住的核心逻辑再往下拆细一层讲透。`,
        },
        {
          label: '检验隐含前提',
          prompt: `「${target}」成立依赖哪些隐含假设或边界条件？如果条件失效会发生什么？`,
        },
        {
          label: '给个具体算例',
          prompt: `针对「${target}」，构造一个最小但完整的具体算例走一遍。`,
        },
      ];
    }
    if (anchor.kind === 'term') {
      return [
        {
          label: '直觉讲透',
          prompt: `用最通俗的直觉和图像把这里的「${target}」彻底讲透，它在当前上下文里起什么作用？`,
        },
        {
          label: '补全跳步',
          prompt: `为什么这里会用到「${target}」？把前后的逻辑衔接与隐含推导补全。`,
        },
        {
          label: '举个例子',
          prompt: `给「${target}」举一个正例和一个容易混淆的反例。`,
        },
      ];
    }
    return [
      {
        label: '解释这段话',
        prompt: `请深入解释这一处：「${target}」，我在这里卡住了。`,
      },
      {
        label: '为什么成立？',
        prompt: `为什么「${target}」成立？请补全严格推理或反证。`,
      },
      {
        label: '举个例子',
        prompt: `针对「${target}」举一个具体例子帮我建立直觉。`,
      },
    ];
  }

  function kindBadgeText(kind: MagicPointerLearnAnchor['kind']): string {
    if (kind === 'term') {
      return '概念';
    }
    if (kind === 'math') {
      return '公式';
    }
    if (kind === 'card') {
      return '分块';
    }
    return '划词';
  }

  function applyUserHighlightsToContainer(
    container: HTMLElement,
    highlights: MagicPointerLearnUserHighlight[],
  ): void {
    if (!highlights.length) {
      return;
    }
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    const textNodes: Text[] = [];
    let current = walker.nextNode();
    while (current) {
      const parent = current.parentElement;
      if (
        parent &&
        !parent.closest('code, pre, .katex, .mp-learn-user-mark, button')
      ) {
        textNodes.push(current as Text);
      }
      current = walker.nextNode();
    }
    for (const hl of highlights) {
      const quote = String(hl.quote || '').trim();
      if (!quote) {
        continue;
      }
      for (const node of textNodes) {
        const val = node.nodeValue || '';
        const idx = val.indexOf(quote);
        if (idx < 0 || !node.parentNode) {
          continue;
        }
        const before = val.slice(0, idx);
        const after = val.slice(idx + quote.length);
        const mark = el('mark', 'mp-learn-user-mark', quote);
        mark.dataset.highlightId = hl.id;
        mark.title = '点击移除荧光笔标注';
        const frag = document.createDocumentFragment();
        if (before) {
          frag.appendChild(document.createTextNode(before));
        }
        frag.appendChild(mark);
        if (after) {
          frag.appendChild(document.createTextNode(after));
        }
        node.parentNode.replaceChild(frag, node);
        break;
      }
    }
  }

  function lemmasForKey(key: string): MagicPointerLearnLemmaRef[] {
    return composerLemmas.get(key) || [];
  }

  function addLemmaToKey(key: string, lemma: MagicPointerLearnLemmaRef): void {
    const list = [...lemmasForKey(key)];
    if (!list.some(item => item.branchId === lemma.branchId)) {
      list.push(lemma);
      composerLemmas.set(key, list);
    }
    if (key === '__main__') {
      hooks?.onMainLemmasChanged?.();
    }
  }

  function removeLemmaFromKey(key: string, branchId: string): void {
    const list = lemmasForKey(key).filter(item => item.branchId !== branchId);
    if (list.length) {
      composerLemmas.set(key, list);
    } else {
      composerLemmas.delete(key);
    }
    if (key === '__main__') {
      hooks?.onMainLemmasChanged?.();
    }
  }

  function renderLemmaStrip(strip: HTMLElement, key: string): void {
    strip.replaceChildren();
    for (const lemma of lemmasForKey(key)) {
      const chip = el('span', 'mp-learn-lemma-chip');
      chip.appendChild(el('span', '', `🔗 引理：${lemma.title}`));
      const rm = el('button', '', '×');
      rm.type = 'button';
      rm.title = '移除引理引用';
      rm.addEventListener('click', () => {
        removeLemmaFromKey(key, lemma.branchId);
        renderLemmaStrip(strip, key);
      });
      chip.appendChild(rm);
      strip.appendChild(chip);
    }
  }

  function bindLemmaDropTarget(
    box: HTMLElement,
    lemmaKey: string,
    strip?: HTMLElement,
  ): void {
    box.addEventListener('dragover', ev => {
      if (ev.dataTransfer?.types.includes(LEMMA_MIME)) {
        ev.preventDefault();
        ev.dataTransfer.dropEffect = 'copy';
        box.classList.add('is-lemma-drop-target');
      }
    });
    box.addEventListener('dragleave', () => {
      box.classList.remove('is-lemma-drop-target');
    });
    box.addEventListener('drop', ev => {
      box.classList.remove('is-lemma-drop-target');
      const raw = ev.dataTransfer?.getData(LEMMA_MIME);
      if (!raw) {
        return;
      }
      ev.preventDefault();
      ev.stopPropagation();
      try {
        const parsed = JSON.parse(raw) as MagicPointerLearnLemmaRef;
        if (parsed?.branchId && parsed?.title) {
          addLemmaToKey(lemmaKey, parsed);
          if (strip) {
            renderLemmaStrip(strip, lemmaKey);
          }
        }
      } catch {
        /* ignore malformed drag payload */
      }
    });
  }

  function depthOfBranch(
    branch: MagicPointerLearnBranch,
    byId: Map<string, MagicPointerLearnBranch>,
  ): number {
    let depth = 1;
    let cursor: MagicPointerLearnBranch | undefined = branch;
    const seen = new Set<string>();
    while (cursor?.parentBranchId && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      cursor = byId.get(cursor.parentBranchId);
      if (cursor) {
        depth += 1;
      }
    }
    return depth;
  }

  function rootTurnOfBranch(
    branch: MagicPointerLearnBranch,
    byId: Map<string, MagicPointerLearnBranch>,
  ): number {
    let cursor: MagicPointerLearnBranch = branch;
    const seen = new Set<string>();
    while (cursor.parentBranchId && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      const parent = byId.get(cursor.parentBranchId);
      if (!parent) {
        break;
      }
      cursor = parent;
    }
    return cursor.parentTurnIndex;
  }

  function countDescendants(
    branchId: string,
    all: MagicPointerLearnBranch[],
  ): number {
    let count = 0;
    for (const item of all) {
      if (item.parentBranchId === branchId) {
        count += 1 + countDescendants(item.id, all);
      }
    }
    return count;
  }

  async function submitBranchPrompt(params: {
    conversationId: string;
    branchId?: string;
    parentBranchId: string | null;
    parentTurnIndex: number;
    anchor?: MagicPointerLearnAnchor;
    question: string;
    lemmaKey: string;
  }): Promise<void> {
    const trimmed = params.question.trim();
    if (!trimmed) {
      return;
    }
    const lemmaRefs = [...lemmasForKey(params.lemmaKey)];
    composerLemmas.delete(params.lemmaKey);
    if (!params.branchId) {
      draftSpawn = null;
    }
    const requestId = `learn-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 7)}`;
    const result = await Data.learnSend({
      conversationId: params.conversationId,
      branchId: params.branchId,
      parentBranchId: params.parentBranchId,
      parentTurnIndex: params.parentTurnIndex,
      anchor: params.anchor,
      question: trimmed,
      lemmaRefs,
      requestId,
      effort: hooks?.getEffort() || 'high',
    });
    if (result?.branchId) {
      liveStreams.delete(String(result.branchId));
      // Auto-activate Focus Shift if newly created/updated branch is at Depth >= 3
      const conv =
        (result.conversation as MagicPointerConversation | undefined) ||
        hooks?.getConversation();
      if (conv?.branches) {
        const byId = new Map(conv.branches.map(b => [b.id, b] as const));
        const created = byId.get(String(result.branchId));
        if (created && !created.docked) {
          const depth = depthOfBranch(created, byId);
          if (depth >= 3 && created.parentBranchId) {
            const rootTurn = rootTurnOfBranch(created, byId);
            focusShiftByRoot.set(
              `${params.conversationId}:${rootTurn}`,
              created.parentBranchId,
            );
          }
        }
      }
    }
    await hooks?.refreshConversation(params.conversationId);
  }

  function buildComposerElement(options: {
    conversationId: string;
    branchId?: string;
    parentBranchId: string | null;
    parentTurnIndex: number;
    anchor?: MagicPointerLearnAnchor;
    isDraftSpawn: boolean;
    placeholder: string;
    runningRequestId?: string;
  }): HTMLElement {
    const lemmaKey = options.branchId || '__draft__';
    const wrap = el(
      'div',
      'mp-learn-composer' + (options.isDraftSpawn ? ' is-draft-spawn' : ''),
    );
    if (options.isDraftSpawn && options.anchor) {
      const top = el('div', 'mp-learn-composer-anchor');
      top.appendChild(
        el(
          'span',
          '',
          `↘ 新建右下支线 · ${kindBadgeText(options.anchor.kind)}：「${options.anchor.label.slice(0, 60)}」`,
        ),
      );
      const closeBtn = el('button', 'mp-learn-composer-cancel', '取消');
      closeBtn.type = 'button';
      closeBtn.addEventListener('click', () => {
        draftSpawn = null;
        rerenderActive();
      });
      top.appendChild(closeBtn);
      wrap.appendChild(top);

      const chipsRow = el('div', 'mp-learn-quick-chips');
      for (const chip of quickPromptsFor(options.anchor)) {
        const btn = el('button', 'mp-learn-quick-chip', chip.label);
        btn.type = 'button';
        btn.addEventListener('click', () => {
          void submitBranchPrompt({
            conversationId: options.conversationId,
            parentBranchId: options.parentBranchId,
            parentTurnIndex: options.parentTurnIndex,
            anchor: options.anchor,
            question: chip.prompt,
            lemmaKey,
          });
        });
        chipsRow.appendChild(btn);
      }
      wrap.appendChild(chipsRow);
    }

    const strip = el('div', 'mp-learn-lemma-strip');
    renderLemmaStrip(strip, lemmaKey);
    wrap.appendChild(strip);
    bindLemmaDropTarget(wrap, lemmaKey, strip);

    const row = el('div', 'mp-learn-composer-row');
    const input = el('textarea', 'mp-learn-composer-input');
    input.rows = 1;
    input.placeholder = options.placeholder;
    const sendBtn = el('button', 'mp-learn-composer-send', '追问 ↵');
    sendBtn.type = 'button';
    sendBtn.disabled = true;

    input.addEventListener('input', () => {
      sendBtn.disabled = !input.value.trim();
    });
    const triggerSend = () => {
      if (!input.value.trim()) {
        return;
      }
      const text = input.value;
      input.value = '';
      sendBtn.disabled = true;
      void submitBranchPrompt({
        conversationId: options.conversationId,
        branchId: options.branchId,
        parentBranchId: options.parentBranchId,
        parentTurnIndex: options.parentTurnIndex,
        anchor: options.anchor,
        question: text,
        lemmaKey,
      });
    };
    input.addEventListener('keydown', ev => {
      if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
        ev.preventDefault();
        triggerSend();
      } else if (ev.key === 'Escape' && options.isDraftSpawn) {
        ev.preventDefault();
        draftSpawn = null;
        rerenderActive();
      }
    });
    sendBtn.addEventListener('click', triggerSend);
    row.appendChild(input);

    if (options.runningRequestId && options.branchId) {
      const stopBtn = el('button', 'mp-learn-composer-stop', '停止');
      stopBtn.type = 'button';
      stopBtn.addEventListener('click', () => {
        void Data.learnStop({
          branchId: options.branchId,
          requestId: options.runningRequestId,
        });
      });
      row.appendChild(stopBtn);
    } else {
      row.appendChild(sendBtn);
    }
    wrap.appendChild(row);
    return wrap;
  }

  function renderBranchCard(options: {
    conversation: MagicPointerConversation;
    branch: MagicPointerLearnBranch;
    allBranches: MagicPointerLearnBranch[];
    byId: Map<string, MagicPointerLearnBranch>;
    visualIndent: number;
    inDeck: boolean;
  }): HTMLElement {
    const {conversation, branch, allBranches, byId, visualIndent, inDeck} =
      options;
    const row = el('div', 'mp-learn-node-row');
    row.style.setProperty('--mp-learn-indent', String(inDeck ? 0 : visualIndent));
    row.dataset.branchId = branch.id;

    if (!inDeck) {
      const spine = el('button', 'mp-learn-spine');
      spine.type = 'button';
      spine.title = branch.collapsed ? '点击展开此支线' : '点击折叠为一行摘要胶囊';
      spine.setAttribute('aria-label', spine.title);
      spine.addEventListener('click', () => {
        void Data.learnPatch({
          conversationId: conversation.id,
          action: 'update-branch',
          branchId: branch.id,
          collapsed: !branch.collapsed,
        });
      });
      row.appendChild(spine);
    }

    // If docked in right pane and we are rendering the main stream, show Portal Pill!
    if (branch.docked && !inDeck) {
      const subCount = countDescendants(branch.id, allBranches);
      const pill = el('div', 'mp-learn-portal-pill');
      const main = el('div', 'mp-learn-portal-main');
      main.appendChild(el('span', 'mp-learn-kind-chip', '↗ 对照台'));
      main.appendChild(el('span', 'mp-learn-capsule-title', branch.title));
      main.appendChild(
        el(
          'span',
          'mp-learn-capsule-summary',
          `${branch.turns.length} 轮${subCount ? ` · ${subCount} 个子分支` : ''}`,
        ),
      );
      main.addEventListener('click', () => {
        highlightedBranchId = branch.id;
        hooks?.openDeckInInspector();
      });
      const actions = el('div', 'mp-learn-pill-actions');
      const locateBtn = el('button', '', '定位查看');
      locateBtn.type = 'button';
      locateBtn.addEventListener('click', () => {
        highlightedBranchId = branch.id;
        hooks?.openDeckInInspector();
      });
      const recallBtn = el('button', '', '↙ 收回原位');
      recallBtn.type = 'button';
      recallBtn.addEventListener('click', () => {
        void Data.learnPatch({
          conversationId: conversation.id,
          action: 'update-branch',
          branchId: branch.id,
          docked: false,
        });
      });
      actions.append(locateBtn, recallBtn);
      pill.append(main, actions);
      row.appendChild(pill);
      return row;
    }

    // Collapsed 1-Line Insight Capsule
    if (branch.collapsed && !inDeck) {
      const subCount = countDescendants(branch.id, allBranches);
      const capsule = el('div', 'mp-learn-capsule');
      const main = el('div', 'mp-learn-capsule-main');
      main.appendChild(
        el('span', 'mp-learn-kind-chip', `▸ ${kindBadgeText(branch.anchor.kind)}`),
      );
      main.appendChild(
        el(
          'span',
          'mp-learn-capsule-title',
          `${branch.title} (${branch.turns.length}轮${subCount ? `+${subCount}支线` : ''})`,
        ),
      );
      main.appendChild(
        el(
          'span',
          'mp-learn-capsule-summary',
          branch.insightSummary || branchSummaryForLemma(branch).slice(0, 80),
        ),
      );
      main.addEventListener('click', () => {
        void Data.learnPatch({
          conversationId: conversation.id,
          action: 'update-branch',
          branchId: branch.id,
          collapsed: false,
        });
      });
      const actions = el('div', 'mp-learn-pill-actions');
      const editSummaryBtn = el('button', '', '✎ 批注');
      editSummaryBtn.type = 'button';
      editSummaryBtn.title = '编辑你的一句话顿悟批注';
      editSummaryBtn.addEventListener('click', ev => {
        ev.stopPropagation();
        const next = window.prompt(
          '提炼一句你的顿悟批注（折叠时展示）：',
          branch.insightSummary || '',
        );
        if (next !== null) {
          void Data.learnPatch({
            conversationId: conversation.id,
            action: 'update-branch',
            branchId: branch.id,
            insightSummary: next,
          });
        }
      });
      const expandBtn = el('button', '', '展开');
      expandBtn.type = 'button';
      expandBtn.addEventListener('click', () => {
        void Data.learnPatch({
          conversationId: conversation.id,
          action: 'update-branch',
          branchId: branch.id,
          collapsed: false,
        });
      });
      actions.append(editSummaryBtn, expandBtn);
      capsule.append(main, actions);
      row.appendChild(capsule);
      return row;
    }

    // Expanded Branch Card
    const card = el(
      'article',
      'mp-learn-branch-card' +
        (highlightedBranchId === branch.id ? ' is-highlighted' : ''),
    );
    card.dataset.branchId = branch.id;

    const head = el('header', 'mp-learn-branch-head');
    head.draggable = true;
    head.title = '按住可拖入右侧对照台，或直接拖进任意输入框作为引理引用';
    head.addEventListener('dragstart', ev => {
      const lemma: MagicPointerLearnLemmaRef = {
        branchId: branch.id,
        title: branch.title,
        summary: branchSummaryForLemma(branch),
      };
      ev.dataTransfer?.setData(LEMMA_MIME, JSON.stringify(lemma));
      ev.dataTransfer?.setData(
        BRANCH_MIME,
        JSON.stringify({conversationId: conversation.id, branchId: branch.id}),
      );
      if (ev.dataTransfer) {
        ev.dataTransfer.effectAllowed = 'copyMove';
      }
      if (!inDeck) {
        dockDropzone?.classList.add('is-visible');
      }
    });
    head.addEventListener('dragend', () => {
      dockDropzone?.classList.remove('is-visible', 'is-over');
    });

    const titleRow = el('div', 'mp-learn-branch-title-row');
    titleRow.appendChild(el('span', 'mp-learn-drag-grip', '⋮⋮'));
    titleRow.appendChild(
      el('span', 'mp-learn-kind-chip', kindBadgeText(branch.anchor.kind)),
    );
    const actualDepth = depthOfBranch(branch, byId);
    titleRow.appendChild(
      el('span', 'mp-learn-branch-title', `L${actualDepth} · ${branch.title}`),
    );
    head.appendChild(titleRow);

    const tools = el('div', 'mp-learn-branch-tools');
    const citeBtn = el('button', '', '📎 引理');
    citeBtn.type = 'button';
    citeBtn.title = '将本分支结论附加到主输入框作为引理引用（不污染历史缓存）';
    citeBtn.addEventListener('click', () => {
      addLemmaToKey('__main__', {
        branchId: branch.id,
        title: branch.title,
        summary: branchSummaryForLemma(branch),
      });
    });
    tools.appendChild(citeBtn);

    if (!inDeck) {
      const focusBtn = el('button', '', '⤢ 聚焦');
      focusBtn.type = 'button';
      focusBtn.title = '聚焦此支线为当前左边界，给深层公式/代码留足阅读宽度';
      focusBtn.addEventListener('click', () => {
        const rootTurn = rootTurnOfBranch(branch, byId);
        focusShiftByRoot.set(`${conversation.id}:${rootTurn}`, branch.id);
        rerenderActive();
      });
      tools.appendChild(focusBtn);

      const dockBtn = el('button', '', '↗ 对照台');
      dockBtn.type = 'button';
      dockBtn.title = '拆到右侧并排对照台（主干保留锚点胶囊）';
      dockBtn.addEventListener('click', async () => {
        highlightedBranchId = branch.id;
        await Data.learnPatch({
          conversationId: conversation.id,
          action: 'update-branch',
          branchId: branch.id,
          docked: true,
        });
        hooks?.openDeckInInspector();
      });
      tools.appendChild(dockBtn);
    } else {
      const undockBtn = el('button', '', '↙ 收回原位');
      undockBtn.type = 'button';
      undockBtn.addEventListener('click', () => {
        void Data.learnPatch({
          conversationId: conversation.id,
          action: 'update-branch',
          branchId: branch.id,
          docked: false,
        });
      });
      tools.appendChild(undockBtn);
    }

    const promoteBtn = el('button', '', '⑂ 独立成树');
    promoteBtn.type = 'button';
    promoteBtn.title = '将此分支连同上下文升级为左侧栏独立会话';
    promoteBtn.addEventListener('click', async () => {
      const res = await Data.learnPatch({
        conversationId: conversation.id,
        action: 'promote-branch',
        branchId: branch.id,
      });
      if (res?.ok && res.conversation?.id) {
        hooks?.openConversationById(String(res.conversation.id));
      }
    });
    tools.appendChild(promoteBtn);

    if (!inDeck) {
      const foldBtn = el('button', '', '− 折叠');
      foldBtn.type = 'button';
      foldBtn.addEventListener('click', () => {
        void Data.learnPatch({
          conversationId: conversation.id,
          action: 'update-branch',
          branchId: branch.id,
          collapsed: true,
        });
      });
      tools.appendChild(foldBtn);
    }
    head.appendChild(tools);
    card.appendChild(head);

    const turnsHost = el('div', 'mp-learn-branch-turns');
    const live = liveStreams.get(branch.id);
    const branchHighlights = (conversation.userHighlights || []).filter(
      h => h.branchId === branch.id,
    );

    (branch.turns || []).forEach((turn, turnIdx) => {
      const turnWrap = el('div', 'mp-learn-branch-turn');
      turnWrap.dataset.branchId = branch.id;
      turnWrap.dataset.turnIndex = String(turnIdx);

      const qBubble = el('div', 'mp-learn-branch-q', String(turn.question || ''));
      turnWrap.appendChild(qBubble);

      const isStreamingThisTurn =
        turn.outcome === '进行中' ||
        (live !== undefined && live.turnIndex === turnIdx);
      const effectiveAnswer =
        live && live.turnIndex === turnIdx && live.answer
          ? live.answer
          : String(turn.answer || '');

      const aWrap = el('div', 'mp-learn-branch-a');
      aWrap.dataset.branchAnswerBody = `${branch.id}:${turnIdx}`;
      if (effectiveAnswer.trim()) {
        const md = renderMarkdownNode(effectiveAnswer);
        applyUserHighlightsToContainer(
          md,
          branchHighlights.filter(item => item.turnIndex === turnIdx),
        );
        aWrap.appendChild(md);
      } else if (isStreamingThisTurn) {
        aWrap.appendChild(
          el('div', 'mp-learn-streaming-status', '正在推导此支线…'),
        );
      } else if (turn.failed && turn.error) {
        aWrap.appendChild(
          el('div', 'mp-learn-streaming-status', `⚠ ${String(turn.error)}`),
        );
      }
      turnWrap.appendChild(aWrap);

      // Draft child spawn composer anchored right below this branch turn
      if (
        draftSpawn &&
        draftSpawn.conversationId === conversation.id &&
        draftSpawn.parentBranchId === branch.id &&
        draftSpawn.parentTurnIndex === turnIdx
      ) {
        turnWrap.appendChild(
          buildComposerElement({
            conversationId: conversation.id,
            parentBranchId: branch.id,
            parentTurnIndex: turnIdx,
            anchor: draftSpawn.anchor,
            isDraftSpawn: true,
            placeholder: '输入你对这一点的具体疑问（Enter 发送，Esc 取消）…',
          }),
        );
      }

      // Recursive child branches spawned from this turn!
      const childBranches = allBranches.filter(
        candidate =>
          candidate.parentBranchId === branch.id &&
          candidate.parentTurnIndex === turnIdx,
      );
      for (const child of childBranches) {
        turnWrap.appendChild(
          renderBranchCard({
            conversation,
            branch: child,
            allBranches,
            byId,
            visualIndent: Math.min(2, visualIndent + 1),
            inDeck,
          }),
        );
      }

      turnsHost.appendChild(turnWrap);
    });

    card.appendChild(turnsHost);

    const anyTurnRunning =
      live !== undefined ||
      (branch.turns || []).some(turn => turn.outcome === '进行中');
    card.appendChild(
      buildComposerElement({
        conversationId: conversation.id,
        branchId: branch.id,
        parentBranchId: branch.parentBranchId,
        parentTurnIndex: branch.parentTurnIndex,
        isDraftSpawn: false,
        placeholder: `在「${branch.title.slice(0, 28)}」支线继续追问…（可拖入其他卡片作引理）`,
        runningRequestId: anyTurnRunning ? live?.requestId || branch.id : undefined,
      }),
    );

    row.appendChild(card);
    return row;
  }

  function renderFocusShiftBar(
    conversation: MagicPointerConversation,
    rootTurnIndex: number,
    focusedBranch: MagicPointerLearnBranch,
    byId: Map<string, MagicPointerLearnBranch>,
  ): HTMLElement {
    const chain: MagicPointerLearnBranch[] = [];
    let cursor: MagicPointerLearnBranch | undefined = focusedBranch;
    const seen = new Set<string>();
    while (cursor && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      chain.unshift(cursor);
      cursor = cursor.parentBranchId ? byId.get(cursor.parentBranchId) : undefined;
    }

    const key = `${conversation.id}:${rootTurnIndex}`;
    const bar = el('nav', 'mp-learn-focus-bar');
    bar.setAttribute('aria-label', '分支聚焦层级导航');

    const crumbs = el('div', 'mp-learn-focus-crumbs');
    const rootBtn = el('button', 'mp-learn-focus-crumb', '🌱 主干');
    rootBtn.type = 'button';
    rootBtn.addEventListener('click', () => {
      focusShiftByRoot.delete(key);
      rerenderActive();
    });
    crumbs.appendChild(rootBtn);

    chain.forEach((node, idx) => {
      crumbs.appendChild(el('span', '', '›'));
      const btn = el(
        'button',
        'mp-learn-focus-crumb' + (idx === chain.length - 1 ? ' is-current' : ''),
        node.title.slice(0, 28),
      );
      btn.type = 'button';
      btn.addEventListener('click', () => {
        focusShiftByRoot.set(key, node.id);
        rerenderActive();
      });
      crumbs.appendChild(btn);
    });

    const actions = el('div', 'mp-learn-focus-actions');
    const upBtn = el('button', '', '← 返回上层');
    upBtn.type = 'button';
    upBtn.addEventListener('click', () => {
      if (focusedBranch.parentBranchId) {
        focusShiftByRoot.set(key, focusedBranch.parentBranchId);
      } else {
        focusShiftByRoot.delete(key);
      }
      rerenderActive();
    });
    const resetBtn = el('button', '', '展开全树');
    resetBtn.type = 'button';
    resetBtn.addEventListener('click', () => {
      focusShiftByRoot.delete(key);
      rerenderActive();
    });
    actions.append(upBtn, resetBtn);
    bar.append(crumbs, actions);
    return bar;
  }

  function mountConversation(
    streamEl: HTMLElement,
    conversation: MagicPointerConversation | null | undefined,
  ): void {
    if (!conversation) {
      return;
    }
    const allBranches = Array.isArray(conversation.branches)
      ? conversation.branches
      : [];
    const byId = new Map(allBranches.map(b => [b.id, b] as const));
    const userHighlights = Array.isArray(conversation.userHighlights)
      ? conversation.userHighlights
      : [];

    const turnNodes = streamEl.querySelectorAll<HTMLElement>(
      '.mp-chat-flow-item[data-turn-index]',
    );
    turnNodes.forEach(item => {
      const turnIndex = Number(item.dataset.turnIndex);
      if (!Number.isInteger(turnIndex)) {
        return;
      }
      // Apply saved root user highlights
      const rootMd = item.querySelector<HTMLElement>('.mp-chat-markdown');
      if (rootMd) {
        applyUserHighlightsToContainer(
          rootMd,
          userHighlights.filter(
            hl => !hl.branchId && hl.turnIndex === turnIndex,
          ),
        );
      }

      item.querySelector(':scope > .mp-learn-tree-host')?.remove();

      const hasRootDraft =
        draftSpawn !== null &&
        draftSpawn.conversationId === conversation.id &&
        draftSpawn.parentBranchId === null &&
        draftSpawn.parentTurnIndex === turnIndex;
      const directChildren = allBranches.filter(
        b => b.parentBranchId === null && b.parentTurnIndex === turnIndex,
      );
      if (!hasRootDraft && !directChildren.length) {
        return;
      }

      const host = el('section', 'mp-learn-tree-host');
      host.dataset.treeOverflowMode = 'focus-shift';

      if (hasRootDraft && draftSpawn) {
        host.appendChild(
          buildComposerElement({
            conversationId: conversation.id,
            parentBranchId: null,
            parentTurnIndex: turnIndex,
            anchor: draftSpawn.anchor,
            isDraftSpawn: true,
            placeholder: '输入你的具体疑问（Enter 发送，Esc 取消）…',
          }),
        );
      }

      const focusKey = `${conversation.id}:${turnIndex}`;
      const focusedId = focusShiftByRoot.get(focusKey);
      const focusedBranch = focusedId ? byId.get(focusedId) : undefined;
      if (
        focusedBranch &&
        !focusedBranch.docked &&
        rootTurnOfBranch(focusedBranch, byId) === turnIndex
      ) {
        host.appendChild(
          renderFocusShiftBar(conversation, turnIndex, focusedBranch, byId),
        );
        host.appendChild(
          renderBranchCard({
            conversation,
            branch: focusedBranch,
            allBranches,
            byId,
            visualIndent: 0,
            inDeck: false,
          }),
        );
      } else {
        for (const child of directChildren) {
          host.appendChild(
            renderBranchCard({
              conversation,
              branch: child,
              allBranches,
              byId,
              visualIndent: 1,
              inDeck: false,
            }),
          );
        }
      }

      item.appendChild(host);
    });

    if (draftSpawn) {
      const draftInput = streamEl.querySelector<HTMLTextAreaElement>(
        '.mp-learn-composer.is-draft-spawn .mp-learn-composer-input',
      );
      draftInput?.focus();
    }
  }

  function renderDeck(
    hostEl: HTMLElement | null,
    conversation: MagicPointerConversation | null | undefined,
  ): void {
    if (!hostEl) {
      return;
    }
    hostEl.replaceChildren();
    const wrap = el('div', 'mp-learn-deck');
    const head = el('header', 'mp-learn-deck-header');
    const titleBox = el('div');
    titleBox.appendChild(el('strong', '', '并排学习对照台'));
    titleBox.appendChild(
      el(
        'p',
        '',
        '将主对话中深层发散的局部卡片拖到这里，左右对照推导不翻页，且可继续分叉。',
      ),
    );
    head.appendChild(titleBox);
    wrap.appendChild(head);

    const allBranches = conversation?.branches || [];
    const docked = allBranches.filter(b => b.docked);
    if (!conversation || !docked.length) {
      wrap.appendChild(
        el(
          'div',
          'mp-learn-deck-empty',
          '暂无停靠卡片。在对话中点击任意分支右上角「↗ 对照台」或按住卡片标题往右拖即可并排固定在此处。',
        ),
      );
      hostEl.appendChild(wrap);
      return;
    }

    const byId = new Map(allBranches.map(b => [b.id, b] as const));
    for (const branch of docked) {
      wrap.appendChild(
        renderBranchCard({
          conversation,
          branch,
          allBranches,
          byId,
          visualIndent: 0,
          inDeck: true,
        }),
      );
    }
    hostEl.appendChild(wrap);

    if (highlightedBranchId) {
      const targetCard = wrap.querySelector<HTMLElement>(
        `.mp-learn-branch-card[data-branch-id="${CSS.escape(highlightedBranchId)}"]`,
      );
      targetCard?.scrollIntoView({behavior: 'smooth', block: 'nearest'});
      setTimeout(() => {
        highlightedBranchId = '';
        targetCard?.classList.remove('is-highlighted');
      }, 1800);
    }
  }

  function rerenderActive(): void {
    const conv = hooks?.getConversation() || null;
    const stream = document.getElementById('stream');
    if (stream && conv) {
      mountConversation(stream, conv);
    }
    const deckHost = document.getElementById('learn-deck-host');
    if (deckHost) {
      renderDeck(deckHost, conv);
    }
  }

  function hideGlossPopover(): void {
    if (glossTimer !== null) {
      clearTimeout(glossTimer);
      glossTimer = null;
    }
    if (glossPopover) {
      glossPopover.hidden = true;
    }
  }

  function showGlossPopover(anchorEl: HTMLElement): void {
    const gloss = anchorEl.dataset.mpLearnGloss;
    const term = anchorEl.dataset.mpLearnTerm || anchorEl.textContent || '';
    if (!gloss) {
      return;
    }
    if (!glossPopover) {
      glossPopover = el('div', 'mp-learn-gloss-popover');
      document.body.appendChild(glossPopover);
    }
    glossPopover.replaceChildren(
      el('strong', '', term),
      el('div', '', gloss),
      el('small', '', '点击展开右下支线深入追问 ↘'),
    );
    glossPopover.hidden = false;
    const rect = anchorEl.getBoundingClientRect();
    const top = Math.max(8, rect.top - glossPopover.offsetHeight - 8);
    const left = Math.min(
      window.innerWidth - glossPopover.offsetWidth - 12,
      Math.max(12, rect.left),
    );
    glossPopover.style.top = `${top}px`;
    glossPopover.style.left = `${left}px`;
  }

  function resolveTurnContext(target: Node | null): {
    parentBranchId: string | null;
    parentTurnIndex: number;
  } | null {
    const elem =
      target instanceof HTMLElement ? target : target?.parentElement || null;
    if (!elem) {
      return null;
    }
    const branchTurn = elem.closest<HTMLElement>('.mp-learn-branch-turn');
    if (branchTurn?.dataset.branchId) {
      return {
        parentBranchId: branchTurn.dataset.branchId,
        parentTurnIndex: Number(branchTurn.dataset.turnIndex) || 0,
      };
    }
    const rootTurn = elem.closest<HTMLElement>(
      '.mp-chat-flow-item[data-turn-index]',
    );
    if (rootTurn) {
      return {
        parentBranchId: null,
        parentTurnIndex: Number(rootTurn.dataset.turnIndex) || 0,
      };
    }
    return null;
  }

  function hideSelectionBar(): void {
    if (selectionBar) {
      selectionBar.hidden = true;
    }
    pendingSelectionContext = null;
  }

  function ensureSelectionBar(): HTMLElement {
    if (selectionBar) {
      return selectionBar;
    }
    selectionBar = el('div', 'mp-learn-selection-bar');
    selectionBar.hidden = true;
    const askBtn = el('button', '', '↘ 在此追问');
    askBtn.type = 'button';
    askBtn.addEventListener('mousedown', ev => {
      ev.preventDefault();
      ev.stopPropagation();
    });
    askBtn.addEventListener('click', () => {
      const conv = hooks?.getConversation();
      const ctx = pendingSelectionContext;
      hideSelectionBar();
      window.getSelection()?.removeAllRanges();
      if (!conv || !ctx) {
        return;
      }
      draftSpawn = {
        conversationId: conv.id,
        parentBranchId: ctx.parentBranchId,
        parentTurnIndex: ctx.parentTurnIndex,
        anchor: {
          kind: 'selection',
          label: ctx.quote.slice(0, 48),
          snippet: ctx.quote,
        },
      };
      rerenderActive();
    });

    const markBtn = el('button', '', '🖍 荧光笔');
    markBtn.type = 'button';
    markBtn.addEventListener('mousedown', ev => {
      ev.preventDefault();
      ev.stopPropagation();
    });
    markBtn.addEventListener('click', () => {
      const conv = hooks?.getConversation();
      const ctx = pendingSelectionContext;
      hideSelectionBar();
      window.getSelection()?.removeAllRanges();
      if (!conv || !ctx) {
        return;
      }
      void Data.learnPatch({
        conversationId: conv.id,
        action: 'toggle-highlight',
        branchId: ctx.parentBranchId,
        turnIndex: ctx.parentTurnIndex,
        quote: ctx.quote,
      });
    });

    selectionBar.append(askBtn, markBtn);
    document.body.appendChild(selectionBar);
    return selectionBar;
  }

  function init(initHooks: LearnHooks): void {
    hooks = initHooks;
    if (initialized) {
      return;
    }
    initialized = true;

    // 1. Dock Dropzone on right edge when tearing off a branch card
    dockDropzone = el('div', 'mp-learn-dock-dropzone');
    dockDropzone.append(
      el('div', '', '↗ 松手停靠到右侧对照台'),
      el('small', '', '主干保留锚点胶囊，右侧满宽并排推导'),
    );
    document.body.appendChild(dockDropzone);

    const handleDockDrop = (ev: DragEvent) => {
      const raw = ev.dataTransfer?.getData(BRANCH_MIME);
      if (!raw) {
        return;
      }
      ev.preventDefault();
      dockDropzone?.classList.remove('is-visible', 'is-over');
      try {
        const parsed = JSON.parse(raw) as {
          conversationId?: string;
          branchId?: string;
        };
        if (parsed.conversationId && parsed.branchId) {
          highlightedBranchId = parsed.branchId;
          void Data.learnPatch({
            conversationId: parsed.conversationId,
            action: 'update-branch',
            branchId: parsed.branchId,
            docked: true,
          }).then(() => {
            hooks?.openDeckInInspector();
          });
        }
      } catch {
        /* ignore */
      }
    };

    for (const target of [
      dockDropzone,
      document.getElementById('project-inspector'),
    ]) {
      if (!target) {
        continue;
      }
      target.addEventListener('dragover', ev => {
        if (ev.dataTransfer?.types.includes(BRANCH_MIME)) {
          ev.preventDefault();
          ev.dataTransfer.dropEffect = 'move';
          dockDropzone?.classList.add('is-over');
        }
      });
      target.addEventListener('dragleave', () => {
        dockDropzone?.classList.remove('is-over');
      });
      target.addEventListener('drop', handleDockDrop);
    }

    // 2. Main Studio Composer drop target for Lemma References
    const mainComposer =
      document.getElementById('composer-form') ||
      document.getElementById('composer');
    if (mainComposer) {
      bindLemmaDropTarget(
        mainComposer,
        '__main__',
        document.getElementById('composer-lemma-strip') || undefined,
      );
    }

    // 3. Hover Micro-Gloss Popover delegation
    document.addEventListener('mouseover', ev => {
      const target =
        ev.target instanceof HTMLElement
          ? ev.target.closest<HTMLElement>('.mp-learn-term[data-mp-learn-gloss]')
          : null;
      if (!target) {
        return;
      }
      if (glossTimer !== null) {
        clearTimeout(glossTimer);
      }
      glossTimer = setTimeout(() => showGlossPopover(target), 260);
    });
    document.addEventListener('mouseout', ev => {
      const related = ev.relatedTarget instanceof HTMLElement ? ev.relatedTarget : null;
      if (related?.closest('.mp-learn-term[data-mp-learn-gloss]')) {
        return;
      }
      hideGlossPopover();
    });

    // 4. Click delegation on dotted-terms, cards, formulas & user highlights
    document.addEventListener('click', ev => {
      const target = ev.target instanceof HTMLElement ? ev.target : null;
      if (!target) {
        return;
      }
      const userMark = target.closest<HTMLElement>('.mp-learn-user-mark');
      if (userMark?.dataset.highlightId) {
        const conv = hooks?.getConversation();
        if (conv) {
          void Data.learnPatch({
            conversationId: conv.id,
            action: 'toggle-highlight',
            highlightId: userMark.dataset.highlightId,
            turnIndex: 0,
            quote: '',
          });
        }
        return;
      }

      const anchorEl = target.closest<HTMLElement>('[data-mp-learn-anchor]');
      if (!anchorEl) {
        if (!target.closest('.mp-learn-selection-bar')) {
          hideSelectionBar();
        }
        return;
      }
      // Do not hijack when user dragged to select text
      const activeSel = window.getSelection();
      if (activeSel && !activeSel.isCollapsed && activeSel.toString().trim()) {
        return;
      }
      const conv = hooks?.getConversation();
      const ctx = resolveTurnContext(anchorEl);
      if (!conv || !ctx) {
        return;
      }
      ev.preventDefault();
      ev.stopPropagation();
      hideGlossPopover();

      const kindRaw = anchorEl.dataset.mpLearnAnchor;
      let anchor: MagicPointerLearnAnchor;
      if (kindRaw === 'term') {
        const term =
          anchorEl.dataset.mpLearnTerm || anchorEl.textContent?.trim() || '概念';
        anchor = {
          kind: 'term',
          label: term,
          snippet: term,
          gloss: anchorEl.dataset.mpLearnGloss || undefined,
        };
      } else if (kindRaw === 'math') {
        const tex = anchorEl.dataset.mpLearnTex || anchorEl.textContent?.trim() || '';
        anchor = {
          kind: 'math',
          label: tex.length > 42 ? `${tex.slice(0, 42)}…` : tex,
          snippet: tex,
        };
      } else {
        const label = anchorEl.dataset.mpLearnLabel || '要点卡片';
        anchor = {
          kind: 'card',
          label,
          snippet: anchorEl.dataset.mpLearnSnippet || label,
          priority: anchorEl.dataset.mpLearnPriority || undefined,
        };
      }

      draftSpawn = {
        conversationId: conv.id,
        parentBranchId: ctx.parentBranchId,
        parentTurnIndex: ctx.parentTurnIndex,
        anchor,
      };
      rerenderActive();
      const deckHost = document.getElementById('learn-deck-host');
      if (deckHost?.contains(anchorEl)) {
        deckHost
          .querySelector<HTMLTextAreaElement>(
            '.mp-learn-composer.is-draft-spawn .mp-learn-composer-input',
          )
          ?.focus();
      }
    });

    // 5. Text Selection Floating Toolbar (Ask Here / Highlighter)
    document.addEventListener('mouseup', () => {
      setTimeout(() => {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
          return;
        }
        const quote = sel.toString().trim();
        if (quote.length < 2 || quote.length > 600) {
          hideSelectionBar();
          return;
        }
        const range = sel.getRangeAt(0);
        const common =
          range.commonAncestorContainer instanceof HTMLElement
            ? range.commonAncestorContainer
            : range.commonAncestorContainer.parentElement;
        if (!common?.closest('.mp-chat-markdown')) {
          hideSelectionBar();
          return;
        }
        const ctx = resolveTurnContext(common);
        if (!ctx) {
          hideSelectionBar();
          return;
        }
        pendingSelectionContext = {
          parentBranchId: ctx.parentBranchId,
          parentTurnIndex: ctx.parentTurnIndex,
          quote,
        };
        const bar = ensureSelectionBar();
        bar.hidden = false;
        const rect = range.getBoundingClientRect();
        const top = Math.max(8, rect.top - bar.offsetHeight - 8);
        const left = Math.min(
          window.innerWidth - bar.offsetWidth - 12,
          Math.max(12, rect.left + rect.width / 2 - bar.offsetWidth / 2),
        );
        bar.style.top = `${top}px`;
        bar.style.left = `${left}px`;
      }, 15);
    });

    // 6. Live Token Streaming inside Branch Cards
    Data.onLearnProgress(payload => {
      const branchId = String(payload?.branchId || '');
      const turnIndex = Number(payload?.turnIndex ?? 0);
      if (!branchId) {
        return;
      }
      liveStreams.set(branchId, {
        requestId: String(payload.requestId || ''),
        branchId,
        turnIndex,
        answer: String(payload.answer || ''),
        thinking: String(payload.thinking || ''),
      });
      const selector = `[data-branch-answer-body="${CSS.escape(`${branchId}:${turnIndex}`)}"]`;
      document.querySelectorAll<HTMLElement>(selector).forEach(bodyEl => {
        if (payload.answer && String(payload.answer).trim()) {
          bodyEl.replaceChildren(renderMarkdownNode(String(payload.answer)));
        }
      });
    });
  }

  function consumeMainComposerLemmas(): MagicPointerLearnLemmaRef[] {
    const items = [...lemmasForKey('__main__')];
    composerLemmas.delete('__main__');
    hooks?.onMainLemmasChanged?.();
    return items;
  }

  function formatQuestionWithMainLemmas(question: string): string {
    const items = consumeMainComposerLemmas();
    if (!items.length) {
      return question;
    }
    const tail = items
      .map(ref => `[引用并行支线「${ref.title}」的结论]\n${ref.summary}`)
      .join('\n\n');
    return `${question}\n\n---\n${tail}`;
  }

  function renderMainComposerLemmas(hostEl: HTMLElement | null): void {
    if (!hostEl) {
      return;
    }
    renderLemmaStrip(hostEl, '__main__');
  }

  const LearnTreeApi = {
    init,
    mountConversation,
    renderDeck,
    renderMainComposerLemmas,
    formatQuestionWithMainLemmas,
    hasDockedBranches(
      conversation: MagicPointerConversation | null | undefined,
    ): boolean {
      return Boolean(conversation?.branches?.some(b => b.docked));
    },
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = LearnTreeApi;
  }
  (
    globalThis as unknown as {LearnTree?: typeof LearnTreeApi}
  ).LearnTree = LearnTreeApi;
})();
