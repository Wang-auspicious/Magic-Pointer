import type {
  CollectedResource,
  ResourceCollection,
} from '../resource_collection_contract';
import type {
  ResourceCollectionApi,
  ResourceResponse,
  ResourceAction,
  ResourceRequest,
} from '../resource_collection_api';
import type {ResourcePost} from '../resource_post';

declare global {
  var ResourceLibrary: {
    mount(
      host: HTMLElement,
      api: ResourceCollectionApi,
      options: {
        openTask(id: string): void;
        openCanvas(): void;
        openRightBrowser?(): void;
        startLearnChat?(prompt: string): void;
        openVaultNote?(relativePath?: string): void;
        onVaultUpdated?(): void;
      },
    ): {show(): void; hide(): void; refresh(): Promise<void>};
  };
}

(() => {
  const esc = (value: unknown) =>
    String(value ?? '').replace(
      /[&<>"']/g,
      c =>
        ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[
          c
        ]!,
    );
  const stripTagSpam = (raw: string): string =>
    String(raw || '')
      .replace(/(?:\s*#[^\s#]{1,32}#?){2,}\s*$/gm, '')
      .replace(/^(?:\s*#[^\s#]{1,32}#?){2,}\s*$/gm, '')
      .replace(/\s+/g, ' ')
      .trim();

  function normalizeCleanTag(raw: string): string {
    return raw
      .replace(/\[话题\]/g, '')
      .replace(/#+$/g, '')
      .trim();
  }

  function splitPostParagraphs(raw: string): {
    paragraphs: string[];
    cleanTags: string[];
  } {
    const text = String(raw || '').replace(/\r\n?/g, '\n').trim();
    if (!text) {
      return {paragraphs: [], cleanTags: []};
    }
    const cleanTags: string[] = [];
    const seen = new Set<string>();
    for (const match of text.matchAll(/(?:^|\s)#([^\s#]{1,32}#?)/g)) {
      const tag = normalizeCleanTag(match[1]);
      if (!tag || tag.length < 2) {
        continue;
      }
      const key = tag.toLowerCase();
      if (
        !seen.has(key) &&
        !['每天学习一点点', '学习打卡', '日常', 'ai', 'study'].includes(key)
      ) {
        seen.add(key);
        cleanTags.push(tag);
        if (cleanTags.length >= 4) {
          break;
        }
      }
    }
    const blocks = text
      .split(/\n{2,}|\n/)
      .map(line =>
        line
          .replace(/(?:\s*#[^\s#]{1,32}#?){2,}\s*$/g, '')
          .replace(/^(?:\s*#[^\s#]{1,32}#?\s*)+$/g, '')
          .trim(),
      )
      .filter(Boolean);
    const paragraphs: string[] = [];
    for (const block of blocks) {
      if (/^https?:\/\/\S+$/i.test(block)) {
        paragraphs.push(block);
        continue;
      }
      const hasCjk = /[\u4e00-\u9fa5]/.test(block);
      const minSplitLen = hasCjk ? 60 : 160;
      if (block.length <= minSplitLen) {
        paragraphs.push(block);
        continue;
      }
      const sentences =
        block.match(/[^。！？.!?\n]+[。！？.!?]?/g)?.map(s => s.trim()) || [];
      if (sentences.length < 3 && block.length <= 160) {
        paragraphs.push(block);
        continue;
      }
      const bucketLimit = hasCjk ? 56 : 135;
      let bucket = '';
      for (const s of sentences) {
        if (!s) {
          continue;
        }
        if (bucket && bucket.length + s.length > bucketLimit) {
          paragraphs.push(bucket.trim());
          bucket = s;
        } else {
          bucket = bucket ? `${bucket} ${s}`.replace(/([。！？]) /, '$1') : s;
        }
      }
      if (bucket.trim()) {
        paragraphs.push(bucket.trim());
      }
    }
    return {paragraphs, cleanTags};
  }

  function mount(
    host: HTMLElement,
    api: ResourceCollectionApi,
    options: {
      openTask(id: string): void;
      openCanvas(): void;
      openRightBrowser?(): void;
      startLearnChat?(prompt: string): void;
      openVaultNote?(relativePath?: string): void;
      onVaultUpdated?(): void;
    },
  ) {
    const t = (en: string, zh: string) =>
      document.documentElement.lang.startsWith('zh') ? zh : en;
    const listSep = () => (document.documentElement.lang.startsWith('zh') ? '：' : ': ');
    let snapshot: ResourceResponse = {ok: true, items: [], projects: []};
    let selected = '';
    let filter = 'all';
    let lens: 'all' | 'goal' | 'practice' | 'recent' = 'all';
    let activeGoalId = '';
    let mediaScope = 'bookmarks';
    let sort = (localStorage.getItem('mp:collection-sort') || 'time') as
      | 'time'
      | 'importance';
    let focus = '';
    let cardLimit = 120;
    let captureOpen = false;
    const savedToVaultIds = new Set<string>();
    const savedTodoIds = new Set<string>();
    let query = '';
    let searchMatches: Set<string> | undefined;
    let searchTimer: ReturnType<typeof setTimeout> | undefined;
    let searchEpoch = 0;
    let tab: 'library' | 'sources' | 'browser' = 'library';
    let visible = false;
    let dirty = false;
    let editorRevision = 0;
    let editVersion = 0;
    let saving: Promise<void> | null = null;
    let captureDraft = '';
    let capturing = false;
    let rulesDraft: string | null = null;
    let sourcePending = false;
    let sourceFeedback = '';
    let sourceError = false;
    let sourceTimer: ReturnType<typeof setTimeout> | undefined;
    let savedBrowserUrl = 'https://x.com';
    let browserSlot =
      localStorage.getItem('mp:collection-account') || 'xiaohongshu-1';
    const browserAccounts = [
      {
        id: 'xiaohongshu-1',
        name: '小红书 1',
        url: 'https://www.xiaohongshu.com/',
      },
      {
        id: 'xiaohongshu-2',
        name: '小红书 2',
        url: 'https://www.xiaohongshu.com/',
      },
      {id: 'x-1', name: 'X', url: 'https://x.com/'},
      {id: 'web', name: t('Web', '网页'), url: 'https://www.minttr.com/'},
    ];
    let browserResizeFrame = 0;
    let explicitBrowserNavigation = false;
    let relatedGeneration = 0;
    let relatedUrl = '';
    let postGeneration = 0;
    let detailView: 'post' | 'notes' = 'post';
    let displayedPost: ResourcePost | undefined;
    let generation = 0;
    let focusedId = '';
    const pending = new Set<string>();
    const preview = globalThis.ResourcePreviewView.create();
    const browserObserver = new ResizeObserver(() => {
      cancelAnimationFrame(browserResizeFrame);
      browserResizeFrame = requestAnimationFrame(() => {
        const bounds = browserBounds();
        if (visible && tab === 'browser' && bounds) {
          void api.request('browser-command', {
            command: 'resize',
            sourceAccount: browserSlot,
            bounds,
          });
        }
      });
    });
    window.magicPointerDashboard?.browserView?.onState?.(state => {
      if (
        !visible ||
        tab !== 'browser' ||
        state.activeKey !== `collection:${browserSlot}`
      ) {
        return;
      }
      const input = host.querySelector<HTMLInputElement>(
        '[data-rl-browser] input',
      );
      if (state.url && input && document.activeElement !== input) {
        input.value = state.url;
        savedBrowserUrl = state.url;
        localStorage.setItem('mp:collection-url:' + browserSlot, state.url);
      }
      const back = host.querySelector<HTMLButtonElement>(
        '[data-rl-browser-command=back]',
      );
      const forward = host.querySelector<HTMLButtonElement>(
        '[data-rl-browser-command=forward]',
      );
      if (back) {
        back.disabled = !state.canGoBack;
      }
      if (forward) {
        forward.disabled = !state.canGoForward;
      }
      if (state.url && !state.loading) {
        void updateRelated(state.url);
      }
    });
    const labels = () => ({
      save: t('Save', '仅保存'),
      reference: t('Reference', '参考'),
      recreate: t('Recreate later', '复刻候选'),
      read: t('Read', '阅读'),
      todo: t('To do', '待办候选'),
    });
    const details = (item: CollectedResource) =>
      ({
        revision: 1,
        state: 'inbox',
        title: item.desc || '',
        summary: item.summary || '',
        projectId: '',
        intent: 'save',
        note: '',
        nextStep: '',
        coverage: '',
        ...item.collection,
      }) as ResourceCollection;
    const current = () => snapshot.items?.find(item => item.id === selected);

    function viewFilterValue(): string {
      return `${mediaScope}:${filter}:${lens}`;
    }

    function applyViewFilterValue(value: string): void {
      const [nextScope = 'bookmarks', nextFilter = 'all', nextLens = 'all'] =
        String(value || 'bookmarks:all:all').split(':');
      mediaScope = nextScope;
      filter = nextFilter;
      lens = nextLens as typeof lens;
      cardLimit = 120;
    }

    function syncReadingChrome(): void {
      const shell = host.querySelector<HTMLElement>('.rl-shell');
      if (!shell) {
        return;
      }
      const isReading = tab === 'library' && Boolean(current());
      shell.classList.toggle('is-reading', isReading);
    }

    function pausePostMedia(release = false) {
      host
        .querySelectorAll<HTMLMediaElement>('.rl-post video,.rl-post audio')
        .forEach(media => {
          media.pause();
          if (release) {
            media.removeAttribute('src');
            media.load();
          }
        });
    }
    function status(message: string, error = false) {
      const output = host.querySelector<HTMLElement>('[data-resource-status]');
      if (output) {
        output.textContent = message;
        output.dataset.error = String(error);
        output.hidden = !message;
      }
    }
    async function call(action: ResourceAction, input: ResourceRequest = {}) {
      const result = await api.request(action, input);
      if (!result.ok) {
        throw new Error(
          result.error === 'resource_revision_conflict'
            ? t(
                'This resource changed elsewhere. Your draft is kept. Reload the saved version to review the changes.',
                '资料已在别处更新，当前草稿已保留。可重新加载已保存的版本查看变化。',
              )
            : result.error || t('The operation failed.', '操作失败。'),
        );
      }
      return result;
    }
    async function refresh() {
      const thisGeneration = ++generation;
      try {
        const next = await call('list', {sort, focus});
        if (thisGeneration !== generation) {
          return;
        }
        snapshot = next;
        if (visible && !dirty && tab === 'library') {
          renderList();
          renderDetail();
          syncSummary();
        }
        if (visible && tab === 'sources') {
          syncSourceView();
        }
        if (visible && tab === 'browser') {
          await updateRelated(savedBrowserUrl, true);
        }
      } catch (error) {
        status(String(error), true);
      }
    }
    function projectOptions(value = '') {
      return `<option value="">${t('Choose a project', '选择项目')}</option>${(snapshot.projects || []).map(project => `<option value="${esc(project.id)}" ${value === project.id ? 'selected' : ''}>${esc(project.name)}</option>`).join('')}`;
    }
    function render() {
      pausePostMedia(true);
      clearTimeout(sourceTimer);
      if (tab !== 'browser') {
        void api.request('browser-command', {command: 'hide'});
      }
      const isReading = tab === 'library' && Boolean(current());
      const activeTopTab = tab === 'sources' ? 'sources' : 'library';
      host.innerHTML = `<div class="rl-shell${isReading ? ' is-reading' : ''}">
        <header class="rl-heading">
          <h1>${t('Resources', '收集')}</h1>
          <button type="button" class="rl-browser-shortcut" data-rl-open-browser title="${t('Open Browser side panel', '在右侧打开浏览器')}">
            <span class="cds-icon" data-size="small" aria-hidden="true">&#xE082;</span>
            <span>${t('Browser', '浏览器')}</span>
          </button>
        </header>
        <div class="mp-library-tabs mp-library-top-tabs rl-top-tabs" role="tablist" aria-label="${t('Resource views', '资源视图')}">${[
          ['library', t('Library', '资料')],
          ['sources', t('Sources', '来源')],
        ]
          .map(
            ([id, name]) =>
              `<button type="button" role="tab" data-rl-tab="${id}" class="${activeTopTab === id ? 'is-on' : ''}" aria-selected="${activeTopTab === id}">${name}</button>`,
          )
          .join('')}</div>
        <div class="rl-status" data-resource-status role="status" aria-live="polite" hidden></div>
        <div class="rl-content"></div>
      </div>`;
      if (tab === 'library') {
        renderLibrary();
      }
      if (tab === 'browser') {
        renderBrowser();
      }
      if (tab === 'sources') {
        renderSources();
      }
      scheduleSourceRefresh();
    }
    function scheduleSourceRefresh() {
      clearTimeout(sourceTimer);
      if (visible) {
        sourceTimer = setTimeout(() => {
          void refresh().finally(scheduleSourceRefresh);
        }, 5000);
      }
    }
    function renderGoalStrip(): void {
      const strip = host.querySelector<HTMLElement>('[data-rl-goal-strip]');
      if (!strip) {
        return;
      }
      const goals = snapshot.learningGoals || [];
      if (!goals.length) {
        strip.hidden = true;
        strip.replaceChildren();
        return;
      }
      const bridgeMap = snapshot.learningBridge || {};
      const matchCount = (goalId: string) =>
        (snapshot.items || []).filter(
          item =>
            (item.learningBridge || bridgeMap[item.id])?.goalMatch?.goalId ===
            goalId,
        ).length;
      strip.hidden = false;
      strip.innerHTML = `<span class="rl-goal-strip-title">${t('Study topics', '学习脉络')}</span><div class="rl-goal-pills">${goals
        .map(goal => {
          const count = matchCount(goal.id);
          return `<button type="button" class="rl-goal-pill" data-rl-goal="${esc(goal.id)}" aria-pressed="${activeGoalId === goal.id}">${esc(goal.label)}${count ? ` <em>${count}</em>` : ''}</button>`;
        })
        .join('')}${activeGoalId ? `<button type="button" class="rl-goal-clear" data-rl-goal="">${t('Clear', '清除')}</button>` : ''}</div><button type="button" class="rl-goal-vault-btn" data-rl-action="open-vault">${t('Vault', '知识库')} ↗</button>`;
    }
    function renderLibrary() {
      pausePostMedia(true);
      const filterChoices: Array<[string, string]> = [
        ['bookmarks:all:all', t('Bookmarks and links', '收藏与链接')],
        ['bookmarks:all:goal', t('Best fit for study', '最贴合学习目标')],
        ['bookmarks:all:practice', t('Ready to practice', '可直接动手练')],
        ['bookmarks:all:recent', t('Recently saved', '最近收藏')],
        ['files:all:all', t('Files and screenshots', '文件与截图')],
        ['all:all:all', t('All materials', '全部资料')],
        ['all:inbox:all', t('Inbox', '待整理')],
        ['all:ready:all', t('Collected', '已整理')],
        ['all:reference:all', t('References', '参考')],
        ['all:todo:all', t('To do', '待办')],
        ['all:revisit:all', t('Revisit', '回看')],
        ['all:ignored:all', t('Ignored', '已忽略')],
      ];
      const currentFilterVal = viewFilterValue();
      const searchSvg = `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="7" cy="7" r="4.8"/><path d="M10.7 10.7L14 14" stroke-linecap="round"/></svg>`;
      host.querySelector('.rl-content')!.innerHTML =
        `<div class="mp-library-toolbar rl-toolbar">
          <label class="mp-library-search rl-search-box">${searchSvg}<input type="search" class="rl-search" placeholder="${t('Search', '搜索资料')}" aria-label="${t('Find a resource', '搜索资料')}" value="${esc(query)}"></label>
          <select data-rl-view-filter aria-label="${t('Filter resources', '筛选资料')}">${filterChoices
            .map(
              ([val, label]) =>
                `<option value="${esc(val)}" ${currentFilterVal === val ? 'selected' : ''}>${esc(label)}</option>`,
            )
            .join('')}</select>
          <select data-rl-sort aria-label="${t('Sort', '排序')}"><option value="time" ${sort === 'time' ? 'selected' : ''}>${t('Saved order', '按收藏时间')}</option><option value="importance" ${sort === 'importance' ? 'selected' : ''}>${t('Important now', '对当下的重要性')}</option></select>
          <button type="button" class="rl-tool-btn" data-rl-action="canvas">${t('Canvas', '画布')}</button>
          <button type="button" class="mp-library-primary rl-add-btn" data-rl-toggle-capture aria-expanded="${captureOpen}">${captureOpen ? t('Close', '收起') : `+ ${t('Add', '添加')}`}</button>
        </div>
        <div class="rl-capture-drawer" data-rl-capture-drawer ${captureOpen ? '' : 'hidden'}>
          <form class="rl-capture" data-rl-capture><textarea name="text" rows="1" placeholder="${t('Drop a thought or paste a link…', '记下想法或粘贴链接…')}" aria-label="${t('Text or link to collect', '要收集的文字或链接')}" required>${esc(captureDraft)}</textarea><button type="button" class="rl-capture-secondary" data-rl-action="files">${t('Add files', '添加文件')}</button><button type="submit" class="mp-library-primary" ${capturing ? 'disabled' : ''}>${t('Keep', '收下')}</button></form>
        </div>
        <div class="rl-goal-strip" data-rl-goal-strip hidden></div>
        <div class="rl-focus" ${sort === 'importance' ? '' : 'hidden'}><label>${t('Current focus', '当前关注')} <input data-rl-focus value="${esc(focus)}" placeholder="${esc(snapshot.focus || t('Recent MP tasks', '最近的 MP 任务'))}"></label></div>
        <div class="rl-sync-bar" data-rl-sync-summary role="status" hidden></div>
        <div class="rl-workspace"><div class="rl-grid" role="list" aria-label="${t('Collected resources', '收集的资料')}"></div><aside class="rl-detail" hidden aria-label="${t('Resource details', '资料详情')}"></aside></div>`;
      renderGoalStrip();
      const contentEl = host.querySelector<HTMLElement>('.rl-content');
      if (contentEl) {
        contentEl.onscroll = () => {
          if (
            tab === 'library' &&
            !selected &&
            contentEl.scrollTop + contentEl.clientHeight >=
              contentEl.scrollHeight - 350 &&
            contentEl.querySelector('[data-rl-more]')
          ) {
            cardLimit += 120;
            renderList();
          }
        };
      }
      renderList();
      renderDetail();
      syncSummary();
    }
    function syncSummary() {
      const output = host.querySelector<HTMLElement>('[data-rl-sync-summary]');
      if (!output) {
        return;
      }
      const jobs = (snapshot.histories || []).filter(
        job => job.list === 'saved',
      );
      const running = jobs.find(job => job.status === 'running');
      if (!running) {
        output.textContent = '';
        output.hidden = true;
        return;
      }
      output.hidden = false;
      output.textContent = t(
        `Importing ${running.mode === 'check' ? 'new bookmarks' : 'history'} · ${running.retained} retained`,
        `正在${running.mode === 'check' ? '检查新增收藏' : '初始化历史收藏'} · 已收录 ${running.retained} 条`,
      );
    }
    function renderList() {
      renderGoalStrip();
      syncReadingChrome();
      const grid = host.querySelector('.rl-grid');
      if (!grid) {
        return;
      }
      const focused =
        document.activeElement?.closest<HTMLElement>('[data-rl-id]');
      const restore = focused && grid.contains(focused);
      if (restore) {
        focusedId = focused.dataset.rlId || '';
      }
      const bridgeMap = snapshot.learningBridge || {};
      const items = (snapshot.items || []).filter(item => {
        const detail = details(item);
        const bridge = item.learningBridge || bridgeMap[item.id];
        const accountHome =
          /^https?:\/\/(?:www\.)?xiaohongshu\.com\/(?:explore)?(?:[?#]|$)/i.test(
            detail.url,
          );
        const lensMatch =
          lens === 'all' ||
          (lens === 'goal' &&
            (Boolean(bridge?.goalMatch) || (bridge?.score ?? 0) >= 6)) ||
          (lens === 'practice' && bridge?.intent === 'practice') ||
          lens === 'recent';
        const goalMatch =
          !activeGoalId || bridge?.goalMatch?.goalId === activeGoalId;
        return (
          lensMatch &&
          goalMatch &&
          (mediaScope === 'all' ||
            (mediaScope === 'bookmarks'
              ? Boolean(item.collection) && !accountHome
              : !item.collection || item.media !== 'text')) &&
          (filter === 'all' ||
            (['reference', 'todo'].includes(filter) &&
              detail.state !== 'ignored' &&
              (detail.intent === filter ||
                (detail.intent === 'save' &&
                  detail.suggestedIntent === filter))) ||
            (filter === 'revisit' &&
              detail.state !== 'ignored' &&
              item.capturedAt < new Date().setHours(0, 0, 0, 0)) ||
            (filter === 'inbox'
              ? ['inbox', 'error', 'queued', 'processing', 'waiting'].includes(
                  detail.state,
                )
              : detail.state === filter)) &&
          (!query ||
            searchMatches?.has(item.id) ||
            `${detail.title} ${detail.summary} ${item.text || ''} ${detail.note} ${detail.authorName} ${detail.tags?.join(' ') || ''}`
              .toLowerCase()
              .includes(query.toLowerCase()))
        );
      });
      if (lens === 'goal' || activeGoalId) {
        items.sort((left, right) => {
          const scoreLeft =
            (left.learningBridge || bridgeMap[left.id])?.score ?? 0;
          const scoreRight =
            (right.learningBridge || bridgeMap[right.id])?.score ?? 0;
          return scoreRight - scoreLeft || right.capturedAt - left.capturedAt;
        });
      } else if (lens === 'recent') {
        items.sort((left, right) => right.capturedAt - left.capturedAt);
      } else if (filter === 'revisit') {
        items.sort(
          (left, right) =>
            details(left).lastViewedAt - details(right).lastViewedAt ||
            left.capturedAt - right.capturedAt,
        );
      }
      if (!items.some(item => item.id === focusedId)) {
        focusedId = items.some(item => item.id === selected)
          ? selected
          : items[0]?.id || '';
      }
      grid.innerHTML = items.length
        ? '<div class="rl-masonry">' +
          items
            .slice(0, cardLimit)
            .map(item => {
              const detail = details(item);
              const bridge = item.learningBridge || bridgeMap[item.id];
              const project = snapshot.projects?.find(
                row => row.id === detail.projectId,
              );
              const date = new Date(item.capturedAt).toLocaleDateString(
                document.documentElement.lang || 'en',
                {month: 'short', day: 'numeric'},
              );
              const previewUrl = item.previewUrl;
              const cardTitle = detail.title || t('Untitled resource', '未命名资料');
              const rawBody = stripTagSpam(
                bridge?.lead ||
                  detail.sourceExcerpt ||
                  detail.summary ||
                  item.text ||
                  detail.url ||
                  '',
              ).slice(0, 180);
              const snippet =
                rawBody &&
                rawBody !== cardTitle &&
                !/^https?:\/\/\S+$/i.test(rawBody)
                  ? rawBody
                  : '';
              const sourceMeta = detail.authorName || item.app || item.media;
              const statusNote =
                detail.captureStatus === 'loading'
                  ? t('Saving…', '保存中…')
                  : detail.captureStatus === 'partial'
                    ? t('Media incomplete', '媒体未齐')
                    : project?.name
                      ? project.name
                      : detail.exportedPath
                        ? t('In project', '已放入项目')
                        : '';
              return `<button type="button" class="mp-library-card rl-item ${selected === item.id ? 'is-selected' : ''}" data-rl-id="${esc(item.id)}" tabindex="${focusedId === item.id ? 0 : -1}" aria-pressed="${selected === item.id}">
          ${previewUrl ? `<div class="rl-thumbnail"><img src="${esc(previewUrl)}" alt="${esc(cardTitle)}" loading="lazy"></div>` : ''}
          <div class="rl-item-copy">
            <strong>${esc(cardTitle)}</strong>
            ${snippet ? `<p class="rl-card-excerpt">${esc(snippet)}</p>` : ''}
            <small class="rl-item-foot"><span>${esc(sourceMeta)} · ${esc(date)}</span>${statusNote ? `<span>${esc(statusNote)}</span>` : ''}</small>
          </div>
        </button>`;
            })
            .join('') +
          '</div>' +
          (items.length > cardLimit
            ? `<button type="button" class="rl-load-more" data-rl-action="more" data-rl-more>${t('Load more', '加载更多')} · ${Math.min(cardLimit, items.length)} / ${items.length}</button>`
            : '')
        : snapshot.items?.length
          ? `<div class="mp-library-empty rl-empty"><h2>${t('No matching resources', '没有符合条件的资料')}</h2><p>${t('Try a different search or filter.', '试试其他关键词或筛选条件。')}</p><button type="button" data-rl-action="clear-search">${t(query ? 'Clear search' : 'View all', query ? '清除搜索' : '查看全部')}</button></div>`
          : `<div class="mp-library-empty rl-empty"><h2>${t('No saved resources yet', '还没有收集资料')}</h2><p>${t('Add a thought, paste a link, or connect Xiaohongshu or X in Sources.', '点击右上角“添加”记下想法或链接，或在“来源”中绑定账号。')}</p><button type="button" class="mp-library-primary" data-rl-tab="sources">${t('Connect sources', '连接来源')}</button></div>`;
      if (restore) {
        focusCard(focusedId);
      }
    }

    function focusCard(id: string): void {
      if (!visible || tab !== 'library' || !host.isConnected) {
        return;
      }
      const cards = [
        ...host.querySelectorAll<HTMLButtonElement>('[data-rl-id]'),
      ];
      const card = cards.find(item => item.dataset.rlId === id);
      if (!card) {
        host.querySelector<HTMLElement>('.rl-search')?.focus();
        return;
      }
      focusedId = id;
      cards.forEach(item => {
        item.tabIndex = item === card ? 0 : -1;
      });
      card.focus({preventScroll: true});
      card.scrollIntoView({block: 'nearest', inline: 'nearest'});
    }

    async function closeDetail(): Promise<void> {
      const id = selected;
      if (
        !(await savePending()) ||
        selected !== id ||
        !visible ||
        tab !== 'library'
      ) {
        return;
      }
      selected = '';
      renderList();
      renderDetail();
      focusCard(id);
    }
    function renderDetail() {
      syncReadingChrome();
      const panel = host.querySelector<HTMLElement>('.rl-detail');
      const item = current();
      if (!panel || dirty) {
        return;
      }
      const active = document.activeElement as HTMLElement | null;
      const field =
        active &&
        panel.contains(active) &&
        (active instanceof HTMLInputElement ||
          active instanceof HTMLTextAreaElement ||
          active instanceof HTMLSelectElement)
          ? active
          : null;
      const selection =
        field instanceof HTMLInputElement ||
        field instanceof HTMLTextAreaElement
          ? {
              start: field.selectionStart,
              end: field.selectionEnd,
              direction: field.selectionDirection,
            }
          : null;
      const action =
        active && panel.contains(active) ? active.dataset.rlAction : undefined;
      const saveFocused = active?.matches('.rl-save') && panel.contains(active);
      panel.hidden = !item;
      host
        .querySelector('.rl-workspace')
        ?.classList.toggle('has-detail', Boolean(item));
      if (!item) {
        pausePostMedia(true);
        host.querySelector('.rl-workspace')?.classList.remove('is-reading');
        delete panel.dataset.contentKey;
        postGeneration++;
        displayedPost = undefined;
        panel.replaceChildren();
        return;
      }
      const bridge = item.learningBridge || snapshot.learningBridge?.[item.id];
      const detail = details(item);
      host
        .querySelector('.rl-workspace')
        ?.classList.toggle('is-reading', true);
      const vaultFlag = savedToVaultIds.has(item.id) ? 'v1' : 'v0';
      const todoFlag = savedTodoIds.has(item.id) ? 't1' : 't0';
      const contentKey =
        detail.postPath && detailView === 'post'
          ? `${item.id}:post:${detail.postPath}:${detail.captureStatus}:${detail.thumbnailPath}:${vaultFlag}:${todoFlag}`
          : `${item.id}:${detail.revision}:${detailView}:${vaultFlag}:${todoFlag}`;
      if (panel.dataset.contentKey === contentKey) {
        return;
      }
      pausePostMedia(true);
      panel.dataset.contentKey = contentKey;
      editorRevision = detail.revision;
      const busy = pending.has(item.id) || detail.state === 'processing';
      const primary =
        detail.state === 'waiting' && detail.taskId
          ? `<button type="button" data-rl-action="task">${t('Continue task', '继续整理任务')} ↗</button>`
          : `<button type="button" data-rl-action="process" ${busy || detail.state === 'waiting' ? 'disabled' : ''}>${busy ? t('Working…', '正在处理…') : detail.state === 'queued' ? t('Organize now', '立即整理') : t('Let MP organize', '交给 MP 整理')}</button>`;
      const savedInVault = savedToVaultIds.has(item.id);
      const addedTodo = savedTodoIds.has(item.id);
      const editFormMarkup = `<form data-rl-edit><label>${t('Title', '标题')}<input name="title" value="${esc(detail.title)}" required></label><div class="rl-pair"><label>${t('Project', '项目')}<select name="projectId">${projectOptions(detail.projectId)}</select></label><label>${t('Use it for', '用途')}<select name="intent">${Object.entries(
          labels(),
        )
          .map(
            ([id, name]) =>
              `<option value="${id}" ${detail.intent === id ? 'selected' : ''}>${name}</option>`,
          )
          .join('')}</select></label></div>
        <label>${t('Your note', '你的想法')}<textarea name="note" rows="2" placeholder="${t('Why did this catch your eye?', '当时为什么想收下它？')}">${esc(detail.note)}</textarea></label>
        <label>${t('Processed content', '整理后的内容')}<textarea name="summary" rows="6" placeholder="${t('Let the agent read your saved material, or write your own.', '让 Agent 整理已保存的材料，也可以自己写。')}">${esc(detail.summary)}</textarea></label>
        <label>${t('Next time', '下次可以做什么')}<textarea name="nextStep" rows="2">${esc(detail.nextStep)}</textarea></label><button type="submit" class="rl-save">${t('Save changes', '保存修改')}</button></form>`;
      const fallbackParagraphs = splitPostParagraphs(
        detail.summary || detail.sourceExcerpt || item.text || '',
      );
      const linkedNotesHtml = bridge?.relatedNoteTitles?.length
        ? bridge.relatedNoteTitles
            .map(
              noteTitle =>
                `<button type="button" class="rl-inline-link" data-rl-action="open-vault">[[${esc(noteTitle)}]]</button>`,
            )
            .join(' · ')
        : '';
      const readerContextLine =
        bridge?.goalMatch || linkedNotesHtml
          ? `<p class="rl-reader-context">${bridge?.goalMatch ? esc(bridge.goalMatch.reason) : ''}${bridge?.goalMatch && linkedNotesHtml ? ' · ' : ''}${linkedNotesHtml ? `${t('Linked notes', '关联笔记')}${listSep()}${linkedNotesHtml}` : ''}</p>`
          : '';
      const readerBar = `<div class="rl-reader-bar">
        <button type="button" class="rl-back-btn" data-rl-action="close" aria-label="${t('Back to list', '返回列表')}">← ${t('Resources', '返回列表')}</button>
        <div class="rl-bridge-actions">
          <button type="button" class="mp-library-primary rl-bridge-primary" data-rl-action="learn-distill">${t('Bring into Learn', '带入 Learn 深聊')}</button>
          <button type="button" class="rl-bridge-btn" data-rl-action="${savedInVault ? 'open-vault' : 'save-to-vault'}">${savedInVault ? t('Saved in Vault', '已存知识库') : t('Save to Vault', '存入知识库')}</button>
          <button type="button" class="rl-bridge-btn" data-rl-action="add-vault-todo" ${addedTodo ? 'disabled' : ''}>${addedTodo ? t('Added to Todo', '已加入待办') : t('+ Study Todo', '+ 学习待办')}</button>
          <details class="rl-reader-more"><summary aria-label="${t('More actions', '更多操作')}">···</summary><div class="rl-reader-more-menu">${primary}<button type="button" data-rl-action="deliver" ${busy ? 'disabled' : ''}>${t('Send to project', '放入项目')} ↗</button>${detail.url ? `<button type="button" data-rl-action="source">${t('Original page', '原始页面')} ↗</button>` : ''}${detail.postPath ? `<button type="button" data-rl-action="copy-post">${t('Copy post', '复制正文')}</button>` : ''}<button type="button" data-rl-action="ignore">${detail.state === 'ignored' ? t('Restore', '恢复') : t('Ignore', '忽略')}</button></div></details>
        </div>
      </div>`;
      const readerTabs = `<div class="mp-library-tabs rl-reading-tabs" role="tablist">
        <button type="button" role="tab" data-rl-detail-view="post" class="${detailView === 'post' ? 'is-on' : ''}" aria-pressed="${detailView === 'post'}">${t('Article', '正文精读')}</button>
        <button type="button" role="tab" data-rl-detail-view="notes" class="${detailView === 'notes' ? 'is-on' : ''}" aria-pressed="${detailView === 'notes'}">${t('Notes & metadata', '备注与整理')}</button>
      </div>`;
      panel.innerHTML = `<div class="rl-reader-shell">
        ${readerBar}
        ${readerTabs}
        ${readerContextLine}
        ${detail.postPath ? `<article class="rl-post" data-rl-post ${detailView === 'post' ? '' : 'hidden'} aria-busy="true"><p>${t('Loading saved post…', '正在读取已保存原帖…')}</p></article>` : `<article class="rl-post" ${detailView === 'post' ? '' : 'hidden'}><header><span class="rl-post-platform">${esc(item.app || item.media)}</span><h2>${esc(detail.title || t('Untitled resource', '未命名资料'))}</h2>${detail.authorName ? `<p class="rl-post-byline">${esc(detail.authorName)}</p>` : ''}</header><div class="rl-post-text rl-post-paragraphs">${(fallbackParagraphs.paragraphs.length ? fallbackParagraphs.paragraphs : [detail.url || t('Saved link.', '已保存链接。')]).map(p => `<p class="rl-post-paragraph">${esc(p)}</p>`).join('')}</div>${bridge?.cleanTags?.length ? `<div class="rl-post-clean-tags">${bridge.cleanTags.map(tag => `<span>#${esc(tag)}</span>`).join('')}</div>` : ''}</article>`}
        ${detail.url && detail.captureStatus !== 'saved' ? `<div class="rl-capture-state" role="status"><p>${esc(detail.captureError || t('The link is saved. Capture the page to keep its text and media here.', '链接已保留。提取正文和媒体后，即可在这里阅读。'))}</p><button type="button" data-rl-action="capture-source" ${detail.captureStatus === 'loading' ? 'disabled' : ''}>${detail.captureStatus === 'loading' ? t('Saving…', '正在保存…') : t('Capture / retry media', '提取正文 / 重试媒体')}</button></div>` : ''}
        <div class="rl-notes" ${detailView === 'notes' ? '' : 'hidden'}>
        ${detail.suggestedIntent && detail.suggestedIntent !== detail.intent ? `<div class="rl-use-suggestion"><span>${t('Suggested use', '建议用途')}${listSep()}${esc(labels()[detail.suggestedIntent])}</span><button type="button" data-rl-action="adopt-intent">${t('Use this', '采用建议')}</button></div>` : ''}
        <button type="button" class="rl-read-original" data-rl-action="preview">${t('Read saved original', '阅读保存的原件')} <span aria-hidden="true">↗</span></button>
        ${detail.paperPath ? `<button type="button" class="rl-read-original" data-rl-action="paper">${t('Read downloaded paper', '阅读已下载的论文')} <span aria-hidden="true">PDF ↗</span></button>` : ''}
        <button type="button" data-rl-action="reload" hidden>${t('Discard draft and reload', '舍弃草稿并重新加载')}</button>
        ${detailView === 'notes' ? editFormMarkup : ''}
        <div class="rl-evidence">${detail.decisionReason ? `<span>${t('Collection decision', '收录判断')}</span><p>${esc(detail.decisionReason)}</p>` : ''}<span>${t('Reading coverage', '实际阅读范围')}</span><p>${esc(detail.coverage || t('Saved material; not yet reviewed.', '已保存材料，尚未阅读整理。'))}</p>${detail.error ? `<p class="rl-error">${esc(detail.error)}</p>` : ''}${detail.exportedPath ? `<p>${esc(detail.exportedPath)}</p>` : ''}</div>
        <div class="rl-actions" aria-busy="${busy}">${primary}<button type="button" data-rl-action="deliver" ${busy ? 'disabled' : ''}>${t('Send to project', '放入项目')} ↗</button></div>
        </div>
        ${detailView === 'post' ? `<details class="rl-edit-drawer"><summary>${t('Edit notes, project & intent', '补充想法 / 归属项目 / 修改信息')}</summary>${editFormMarkup}</details>` : ''}
        <div class="rl-links">${detail.url ? `<button type="button" data-rl-action="source">${t('Original page', '原始页面')} ↗</button>` : ''}${detail.postPath ? `<button type="button" data-rl-action="copy-post">${t('Copy post', '复制正文')}</button>` : `<button type="button" data-rl-action="original">${t('Saved original', '保存的原件')} ↗</button>`}${detail.taskId ? `<button type="button" data-rl-action="task">${t('Agent task', '整理任务')} ↗</button>` : ''}<button type="button" data-rl-action="ignore">${detail.state === 'ignored' ? t('Restore', '恢复') : t('Ignore', '忽略')}</button></div></div>`;
      if (detail.postPath && detailView === 'post') {
        void loadPost(item.id);
      }
      const restored = field
        ? panel.querySelector<HTMLElement>(`[name="${field.name}"]`)
        : action
          ? panel.querySelector<HTMLElement>(`[data-rl-action="${action}"]`)
          : saveFocused
            ? panel.querySelector<HTMLElement>('.rl-save')
            : null;
      restored?.focus({preventScroll: true});
      if (
        selection?.start !== null &&
        selection?.end !== null &&
        selection &&
        (restored instanceof HTMLInputElement ||
          restored instanceof HTMLTextAreaElement)
      ) {
        restored.setSelectionRange(
          selection.start,
          selection.end,
          selection.direction || undefined,
        );
      }
    }
    async function loadPost(id: string) {
      const epoch = ++postGeneration;
      const article = host.querySelector<HTMLElement>('[data-rl-post]');
      if (!article) {
        return;
      }
      try {
        const result = await call('read-post', {id});
        if (
          epoch !== postGeneration ||
          selected !== id ||
          !article.isConnected
        ) {
          return;
        }
        const post = result.post!;
        displayedPost = post;
        const formatted = splitPostParagraphs(post.text);
        const bodyHtml = formatted.paragraphs.length
          ? `<div class="rl-post-text rl-post-paragraphs">${formatted.paragraphs
              .map(p => `<p class="rl-post-paragraph">${esc(p)}</p>`)
              .join('')}</div>`
          : formatted.cleanTags.length || !post.text.trim()
            ? ''
            : `<div class="rl-post-text rl-post-paragraphs"><p class="rl-post-paragraph">${esc(post.text)}</p></div>`;
        const mediaCount = post.media.length;
        article.innerHTML = `<header><span class="rl-post-platform">${esc(post.platform === 'xiaohongshu' ? '小红书' : post.platform === 'x' ? 'X' : new URL(post.url).hostname)}</span><h2>${esc(post.title)}</h2><p class="rl-post-byline">${esc(post.author.name)}${post.publishedAt ? ` · ${esc(new Date(post.publishedAt).toLocaleDateString(document.documentElement.lang))}` : ''}</p></header>${bodyHtml}${formatted.cleanTags.length ? `<div class="rl-post-clean-tags">${formatted.cleanTags.map(tag => `<span>#${esc(tag)}</span>`).join('')}</div>` : ''}<div class="rl-post-media" data-media-count="${mediaCount}">${post.media.map((media, index) => (media.localUrl ? (media.kind === 'image' ? `<button type="button" class="rl-post-image" data-rl-media="${index}" aria-label="${t('Enlarge image', '放大图片')} ${index + 1}"><img src="${esc(media.localUrl)}" loading="lazy" alt="${t('Saved post image', '已保存图片')} ${index + 1}"></button>` : `<video controls preload="metadata" src="${esc(media.localUrl)}"></video>`) : `<div class="rl-media-missing">${t('Media not saved', '媒体尚未保存')} ${index + 1}<p>${esc(media.error || '')}</p></div>`)).join('')}</div>${post.links.length ? `<details class="rl-post-links"><summary>${t('Links in this post', '帖子中的链接')} (${post.links.length})</summary>${post.links.map(url => `<button type="button" data-rl-url="${esc(url)}">${esc(url)}</button>`).join('')}</details>` : ''}<p class="rl-post-coverage">${esc(post.coverage)}</p>`;
        article.setAttribute('aria-busy', 'false');
      } catch (error) {
        if (epoch === postGeneration && article.isConnected) {
          article.textContent = String(error);
          article.setAttribute('aria-busy', 'false');
        }
      }
    }
    function renderBrowser() {
      relatedGeneration++;
      relatedUrl = '';
      savedBrowserUrl =
        localStorage.getItem('mp:collection-url:' + browserSlot) ||
        browserAccounts.find(account => account.id === browserSlot)!.url;
      host.querySelector('.rl-content')!.innerHTML =
        `<div class="rl-browser rl-embedded">
          <div class="rl-browser-accounts" role="group" aria-label="${t('Separate sign-in sessions', '独立登录会话')}">
            <button type="button" class="rl-back-btn" data-rl-tab="sources">← ${t('Back to Sources', '返回来源')}</button>
            ${browserAccounts.map(account => `<button type="button" data-rl-account="${account.id}" aria-pressed="${account.id === browserSlot}">${account.name}</button>`).join('')}
            <span>${t('Each session stays isolated on this device.', '各账号登录状态保存在本机，互不串用。')}</span>
          </div>
          <form class="rl-browser-bar" data-rl-browser><button type="button" data-rl-browser-command="back" aria-label="${t('Back', '后退')}">←</button><button type="button" data-rl-browser-command="forward" aria-label="${t('Forward', '前进')}">→</button><button type="button" data-rl-browser-command="reload" aria-label="${t('Reload', '刷新')}">↻</button><input name="url" aria-label="URL" value="${esc(savedBrowserUrl)}" required><button type="submit">${t('Go', '前往')}</button><button type="button" data-rl-action="${browserSlot.startsWith('xiaohongshu-') ? 'sync-bookmarks' : 'capture'}">${browserSlot.startsWith('xiaohongshu-') ? t('View synced bookmarks', '查看同步收藏') : t('Save this page', '保存当前网页')}</button></form>
          <div class="rl-browser-canvas"><div class="rl-browser-surface" data-rl-browser-host><p>${t('Loading session…', '正在打开页面…')}</p></div><aside class="rl-browser-recall" data-rl-related hidden aria-label="${t('Previously saved references', '以前留下的资料')}"></aside></div>
        </div>`;
      browserObserver.disconnect();
      browserObserver.observe(host);
      browserObserver.observe(host.querySelector('[data-rl-browser-host]')!);
      if (!explicitBrowserNavigation) {
        requestAnimationFrame(() => {
          if (visible && tab === 'browser') {
            run(() => browse(savedBrowserUrl, true));
          }
        });
      }
    }
    async function updateRelated(url: string, force = false) {
      if (!/^https?:/.test(url)) {
        return;
      }
      const key = browserSlot + ':' + url;
      if (!force && relatedUrl === key) {
        return;
      }
      relatedUrl = key;
      const epoch = ++relatedGeneration;
      try {
        const result = await call('related', {url});
        if (epoch !== relatedGeneration || !visible || tab !== 'browser') {
          return;
        }
        const aside = host.querySelector<HTMLElement>('[data-rl-related]');
        if (!aside) {
          return;
        }
        const rows = result.related || [];
        aside.hidden = !rows.length;
        aside.parentElement?.classList.toggle(
          'has-related',
          Boolean(rows.length),
        );
        aside.innerHTML = rows.length
          ? `<h3>${t('Saved from here earlier', '以前在这里留过资料')}</h3><p class="rl-recall-intro">${t('Pick up where you left off.', '当时留下的想法、参考或下一步。')}</p>${rows
              .map(row => {
                const detail = details(row.entry);
                return `<button type="button" data-rl-revisit="${esc(row.entry.id)}"><small>${row.relation === 'page' ? t('This page', '同一页面') : row.relation === 'link' ? t('Links here', '提到此页') : t('Same site', '同一网站')} · ${esc(labels()[detail.intent === 'save' && detail.suggestedIntent ? detail.suggestedIntent : detail.intent])}</small><strong>${esc(detail.title)}</strong><p>${esc((detail.note || detail.summary || detail.nextStep || '').slice(0, 220))}</p></button>`;
              })
              .join('')}`
          : '';
      } catch (error) {
        if (epoch === relatedGeneration && visible && tab === 'browser') {
          status(String(error), true);
        }
      }
    }
    function renderSources() {
      const source = snapshot.source;
      const xhsRows = browserAccounts
        .filter(account => account.id.startsWith('xiaohongshu-'))
        .map(account => ({
          id: account.id,
          name: account.name,
          subtitle: t('Isolated sign-in session', '本机独立登录会话'),
          sync: t('Hourly', '每小时'),
        }));
      host.querySelector('.rl-content')!.innerHTML =
        `<div class="rl-sources">
          <h2 class="mp-library-section-title">${t('Your bookmark sources', '收藏来源')}</h2>
          <p class="mp-library-note">${t('Sign in once on this device to import and sync saved posts locally.', '在本机登录一次后即可自动收录并保留本地正文与媒体。')}</p>
          <div class="mp-connector-table">
            <div class="mp-connector-head"><span>${t('Source', '来源')}</span><span>${t('Sync', '同步')}</span><span>${t('Status', '状态')}</span><span>${t('Action', '操作')}</span></div>
            ${xhsRows
              .map(
                row => `<div class="mp-connector-row" data-rl-source-row="${row.id}">
                  <span><strong>${esc(row.name)}</strong></span>
                  <span>${esc(row.sync)}</span>
                  <span data-rl-source-status="${row.id}">${t('Not connected', '未连接')}</span>
                  <button type="button" data-rl-connect-account="${row.id}">${t('Open', '打开')}</button>
                </div>`,
              )
              .join('')}
            <div class="mp-connector-row" data-rl-source-row="x-1">
              <span><strong>X</strong></span>
              <span>${t('Session + API', '会话 + API')}</span>
              <span data-rl-source-account>${t('Not connected', '未连接')}</span>
              <button type="button" data-rl-connect-account="x-1">${t('Open', '打开')}</button>
            </div>
            <div class="mp-connector-row">
              <span><strong>${t('Clipboard', '剪贴板')}</strong></span>
              <span>${t('Local', '本机')}</span>
              <span>${t('On this device', '本机设置')}</span>
              <button type="button" data-rl-action="settings">${t('Settings', '设置')}</button>
            </div>
          </div>

          <details class="rl-source-disclosure">
            <summary>${t('Xiaohongshu sync & import history', '小红书收藏同步与导入明细')}</summary>
            ${xhsRows
              .map(
                row =>
                  `<div class="rl-source-history-block"><h4>${esc(row.name)}</h4><div data-rl-history-account="${row.id}" class="rl-history"></div></div>`,
              )
              .join('')}
          </details>

          <details class="rl-source-disclosure">
            <summary>${t('X API connection & collection rules', 'X 开发者 API 与自动整理规则')}</summary>
            <div class="rl-api-panel">
              <p data-rl-source-feedback role="status" aria-live="polite"></p>
              <form data-rl-x>
                <label>${t('User OAuth access token', '用户 OAuth access token')}<input name="token" type="password" autocomplete="off" required placeholder="${t('Stored encrypted on this device', '仅加密保存在本机')}"></label>
                <p class="mp-library-note">${t('Requires an authorized X developer app token (up to 500 recent items per check).', '需要你自己的 X 开发者应用读取 token（每次检查近期最多 500 条）。')}</p>
                <button type="submit">${t('Connect official API', '连接官方 API')}</button>
              </form>
              <div class="rl-source-options">
                <label><input type="checkbox" data-rl-x-option="bookmarks" ${source?.bookmarks ? 'checked' : ''}> ${t('Bookmarks', '收藏')}</label>
                <label><input type="checkbox" data-rl-x-option="likes" ${source?.likes ? 'checked' : ''}> ${t('Likes', '点赞')}</label>
                <label><input type="checkbox" data-rl-x-option="enabled" ${source?.enabled ? 'checked' : ''}> ${t('Automatic checks', '定时检查')}</label>
                <label><input type="checkbox" data-rl-x-option="organize" ${source?.organize ? 'checked' : ''}> ${t('Auto-organize with MP', '自动整理新导入内容')}</label>
                <button type="button" data-rl-action="sync" ${source?.accountId ? '' : 'disabled'}>${t('Check now', '现在检查')}</button>
              </div>
              <p class="rl-source-result"></p>
              <form data-rl-rules><label>${t('What is worth keeping?', '哪些内容值得留下？')}<textarea name="rules" rows="3" placeholder="${t('Keep UI references and research ideas; ignore giveaways.', '保留 UI 参考与论文思路，忽略抽奖。')}">${esc(source?.rules || '')}</textarea></label><button type="submit">${t('Save collection rule', '保存收集规则')}</button></form>
            </div>
          </details>

          <p class="mp-library-note">${t('Douyin / Bilibili: browse and clip manually in the Browser side panel. Mobile inbox sync is not connected in this build.', '抖音 / B 站可在右侧浏览器中手动收录；手机配对同步暂未接通。')}</p>
        </div>`;
      syncSourceView();
    }
    function syncSourceView() {
      if (tab !== 'sources') {
        return;
      }
      const source = snapshot.source;
      host
        .querySelectorAll<HTMLElement>('[data-rl-source-status]')
        .forEach(cell => {
          const accountId = cell.dataset.rlSourceStatus!;
          const connected = snapshot.accounts?.find(
            account => account.account === accountId,
          );
          const jobs = (snapshot.histories || []).filter(
            job => job.account === accountId,
          );
          const savedJob = jobs.find(job => job.list === 'saved');
          if (connected && connected.error !== 'auth_required') {
            const countText = savedJob ? ` · ${savedJob.retained}` : '';
            const runningText =
              savedJob?.status === 'running' ? ` (${t('syncing', '同步中')})` : '';
            cell.textContent = `${connected.name || t('Connected', '已连接')}${countText}${runningText}`;
          } else {
            cell.textContent = t('Not connected', '未连接');
          }
        });
      host
        .querySelectorAll<HTMLElement>('[data-rl-history-account]')
        .forEach(container => {
          const accountId = container.dataset.rlHistoryAccount!;
          const connected = snapshot.accounts?.find(
            account => account.account === accountId,
          );
          const jobs = (snapshot.histories || []).filter(
            job => job.account === accountId,
          );
          const busy = jobs.some(job => job.status === 'running');
          const statusLabels = {
            running: t('Importing bookmarks…', '正在收录收藏…'),
            paused: t('Paused · end not confirmed', '已暂停 · 未确认历史到底'),
            complete: t('Up to date', '本次同步完成'),
            auth_required: t(
              'Sign in inside MP, then continue',
              '请在 MP 内登录此账号后继续',
            ),
            verification_required: t(
              'Complete verification inside MP, then continue',
              '请在 MP 内完成验证后继续',
            ),
            error: t('Stopped with an error', '遇到错误，已停止'),
          };
          container.innerHTML =
            (connected && connected.error !== 'auth_required'
              ? `<p>${esc(connected.name || t('Signed in', '已登录'))} · <label><input type="checkbox" data-rl-bookmark-enabled="${accountId}" ${connected.enabled ? 'checked' : ''}> ${t('Sync bookmarks every hour', '每小时自动同步收藏')}</label></p><p>${connected.enabled && connected.nextCheckAt ? t('Next check: ', '下次检查：') + new Date(connected.nextCheckAt).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'}) : ''}</p>`
              : `<p>${t('Sign in via Open above to start importing saved posts.', '点击上方“打开”登录后开始导入历史收藏。')}</p>`) +
            (['saved', 'liked'] as const)
              .map(list => {
                const job = jobs.find(row => row.list === list);
                return `<div class="rl-history-list"><div><strong>${list === 'saved' ? t('Saved notes', '收藏笔记') : t('Liked notes', '点赞笔记')}</strong><p>${job ? `${esc(statusLabels[job.status])} · ${job.retained} ${t('links retained', '条链接已留存')}` : t('Not imported yet', '尚未导入')}</p>${job?.error ? `<p class="rl-error">${esc(job.error)}</p>` : ''}</div><div class="rl-history-actions"><button type="button" data-rl-history="${job?.status === 'running' ? 'pause' : 'start'}" data-account="${accountId}" data-list="${list}" ${busy && job?.status !== 'running' ? 'disabled' : ''}>${job?.status === 'running' ? t('Pause', '暂停') : job ? t('Continue / check again', '继续 / 再次检查') : t('Import history', '导入历史')}</button>${job?.url ? `<button type="button" data-rl-history-view="${esc(job.url)}" data-account="${accountId}">${t('Check account page', '查看账号页面')} ↗</button>` : ''}</div></div>`;
              })
              .join('');
        });
      const account = host.querySelector<HTMLElement>(
        '[data-rl-source-account]',
      );
      if (account) {
        account.textContent = source?.username
          ? '@' + source.username
          : t('Not connected', '未连接');
      }
      host
        .querySelectorAll<HTMLInputElement>('[data-rl-x-option]')
        .forEach(input => {
          const key = input.dataset.rlXOption as
            | 'enabled'
            | 'likes'
            | 'bookmarks'
            | 'organize';
          input.checked = Boolean(source?.[key]);
          input.disabled = sourcePending;
        });
      host
        .querySelectorAll<HTMLButtonElement>(
          '[data-rl-x] button,[data-rl-rules] button,[data-rl-action=sync]',
        )
        .forEach(button => {
          button.disabled =
            sourcePending ||
            (button.dataset.rlAction === 'sync' && !source?.accountId);
        });
      const check = host.querySelector<HTMLElement>('[data-rl-action=sync]');
      if (check) {
        check.textContent = sourcePending
          ? t('Working…', '正在处理…')
          : t('Check now', '现在检查');
      }
      const rules = host.querySelector<HTMLTextAreaElement>('[name=rules]');
      const value = rulesDraft ?? source?.rules ?? '';
      if (rules && rules.value !== value) {
        rules.value = value;
      }
      const feedback = host.querySelector<HTMLElement>(
        '[data-rl-source-feedback]',
      );
      if (feedback) {
        feedback.textContent = sourceFeedback;
        feedback.classList.toggle('rl-error', sourceError);
      }
      const result = host.querySelector<HTMLElement>('.rl-source-result');
      if (result) {
        const states = {
          disconnected: t('Not connected', '未连接'),
          ready: t('Ready', '已就绪'),
          syncing: t('Checking…', '正在检查…'),
          partial: t('Partially checked', '部分检查完成'),
          auth_required: t('Reconnect your account', '需要重新连接账号'),
          rate_limited: t(
            'Paused by the platform rate limit',
            '平台限流，已暂停检查',
          ),
          error: t('Check failed', '检查失败'),
        };
        result.textContent = [
          source ? states[source.status] : states.disconnected,
          source?.error,
          source?.lastSuccess
            ? t('Last checked: ', '上次检查：') +
              new Date(source.lastSuccess).toLocaleString()
            : '',
        ]
          .filter(Boolean)
          .join(' · ');
      }
    }
    function sourceNotice(message: string, error = false) {
      sourceFeedback = message;
      sourceError = error;
      syncSourceView();
    }
    async function sourceRequest(
      action: ResourceAction,
      input: ResourceRequest = {},
    ) {
      if (sourcePending) {
        return null;
      }
      sourcePending = true;
      generation++;
      sourceNotice(t('Updating the X source…', '正在处理 X 来源…'));
      try {
        const result = await call(action, input);
        generation++;
        snapshot.source = result.source;
        return result;
      } catch (error) {
        sourceNotice(String(error), true);
        return null;
      } finally {
        sourcePending = false;
        syncSourceView();
      }
    }
    async function saveDetail() {
      if (saving) {
        await saving;
        return;
      }
      const item = current();
      const form = host.querySelector<HTMLFormElement>('[data-rl-edit]');
      if (!item || !form) {
        return;
      }
      if (!form.reportValidity()) {
        throw new Error(
          t(
            'Complete the resource details before saving.',
            '请补全资料详情再保存。',
          ),
        );
      }
      const data = new FormData(form);
      const patch = Object.fromEntries(
        ['title', 'projectId', 'intent', 'note', 'summary', 'nextStep'].map(
          key => [key, String(data.get(key) || '')],
        ),
      ) as Partial<ResourceCollection>;
      const version = editVersion;
      saving = (async () => {
        try {
          const result = await call('edit', {
            id: item.id,
            revision: editorRevision,
            patch,
          });
          if (result.entry) {
            snapshot.items = snapshot.items?.map(row =>
              row.id === item.id ? {...row, ...result.entry} : row,
            );
          }
          if (form.isConnected && selected === item.id) {
            editorRevision =
              result.entry?.collection?.revision ?? editorRevision;
            dirty = version !== editVersion;
            renderList();
            if (!dirty) {
              renderDetail();
            }
            status(
              dirty
                ? t(
                    'Saved. Your newer edits are still unsaved.',
                    '已保存，之后输入的修改仍待保存。',
                  )
                : t('Changes saved.', '修改已保存。'),
            );
          }
        } catch (error) {
          if (form.isConnected) {
            const reload = host.querySelector<HTMLButtonElement>(
              '[data-rl-action=reload]',
            );
            if (reload) {
              reload.hidden = false;
            }
          }
          throw error;
        }
      })();
      try {
        await saving;
      } finally {
        saving = null;
      }
    }
    async function savePending() {
      if (dirty) {
        await saveDetail();
      }
      return !dirty;
    }
    function browserBounds() {
      const bounds = host
        .querySelector('[data-rl-browser-host]')
        ?.getBoundingClientRect();
      return bounds && bounds.width > 0 && bounds.height > 0
        ? {
            x: Math.round(bounds.x),
            y: Math.round(bounds.y),
            width: Math.round(bounds.width),
            height: Math.round(bounds.height),
          }
        : undefined;
    }
    async function browse(url: string, restore = false) {
      if (tab !== 'browser') {
        tab = 'browser';
        explicitBrowserNavigation = true;
        render();
        explicitBrowserNavigation = false;
      }
      const bounds = browserBounds();
      if (!bounds) {
        throw new Error(
          t('The browser area is not visible.', '浏览器区域尚未显示。'),
        );
      }
      const slot = browserSlot;
      status(t('Loading page…', '正在加载网页…'));
      const result = await call('browser-open', {
        url,
        bounds,
        sourceAccount: slot,
        restore,
      });
      if (slot !== browserSlot) {
        return;
      }
      if (!visible || tab !== 'browser') {
        await api.request('browser-command', {command: 'hide'});
        return;
      }
      savedBrowserUrl = result.url || url;
      localStorage.setItem('mp:collection-url:' + slot, savedBrowserUrl);
      const input = host.querySelector<HTMLInputElement>(
        '[data-rl-browser] input',
      );
      if (input) {
        input.value = savedBrowserUrl;
      }
      status('');
      await updateRelated(savedBrowserUrl);
    }
    const run = (operation: () => Promise<void>) => {
      void operation().catch(error => status(String(error), true));
    };
    host.addEventListener('input', event => {
      const target = event.target as HTMLElement;
      if (target.closest('[data-rl-edit]')) {
        dirty = true;
        editVersion++;
      }
      if (target.matches('[data-rl-capture] textarea')) {
        captureDraft = (target as HTMLTextAreaElement).value;
      }
      if (target.matches('[name=rules]')) {
        rulesDraft = (target as HTMLTextAreaElement).value;
      }
      if (target.classList.contains('rl-search')) {
        query = (target as HTMLInputElement).value;
        searchMatches = undefined;
        clearTimeout(searchTimer);
        const epoch = ++searchEpoch;
        if (query.trim()) {
          searchTimer = setTimeout(() => {
            void call('search', {text: query})
              .then(result => {
                if (epoch === searchEpoch) {
                  searchMatches = new Set(
                    (result.items || []).map(item => item.id),
                  );
                  renderList();
                }
              })
              .catch(error => status(String(error), true));
          }, 180);
        }
        renderList();
      }
    });
    host.addEventListener('change', event => {
      const input = event.target as HTMLInputElement;
      if (input.dataset.rlBookmarkEnabled) {
        run(async () => {
          await call('bookmark-configure', {
            sourceAccount: input.dataset.rlBookmarkEnabled,
            enabled: input.checked,
          });
          await refresh();
        });
        return;
      }
      if (input.matches('[data-rl-view-filter]')) {
        applyViewFilterValue(input.value);
        renderList();
        return;
      }
      if (input.matches('[data-rl-sort]')) {
        sort = input.value as 'time' | 'importance';
        localStorage.setItem('mp:collection-sort', sort);
        run(async () => {
          await refresh();
          renderLibrary();
        });
        return;
      }
      if (input.matches('[data-rl-focus]')) {
        focus = input.value;
        run(refresh);
        return;
      }
      if (input.dataset.rlXOption) {
        run(async () => {
          const result = await sourceRequest('x-configure', {
            [input.dataset.rlXOption!]: input.checked,
          });
          if (result) {
            sourceNotice(t('Source settings saved.', '来源设置已保存。'));
          }
        });
      }
    });
    host.addEventListener('submit', event => {
      event.preventDefault();
      const form = event.target as HTMLFormElement;
      run(async () => {
        if (form.matches('[data-rl-edit]')) {
          await saveDetail();
          return;
        }
        if (form.matches('[data-rl-browser]')) {
          await browse(String(new FormData(form).get('url')));
          return;
        }
        if (form.matches('[data-rl-rules]')) {
          const value = String(new FormData(form).get('rules') || '');
          const result = await sourceRequest('x-configure', {
            rules: value,
          });
          if (result) {
            if (rulesDraft === value) {
              rulesDraft = null;
            }
            sourceNotice(
              rulesDraft === null
                ? t('Collection rule saved.', '收集规则已保存。')
                : t(
                    'Saved. Your newer rule edits are still unsaved.',
                    '已保存，之后输入的规则修改仍待保存。',
                  ),
            );
          }
          return;
        }
        if (form.matches('[data-rl-x]')) {
          const token = form.querySelector<HTMLInputElement>('input')!;
          const value = token.value;
          const result = await sourceRequest('x-connect', {token: value});
          if (!result) {
            return;
          }
          if (token.value === value) {
            token.value = '';
          }
          sourceNotice(
            t(
              'Connected. Choose what to collect before enabling automatic checks.',
              '已连接。选择采集内容后，再启用定时检查。',
            ),
          );
          return;
        }
        if (capturing || !(await savePending())) {
          return;
        }
        const field = form.querySelector<HTMLTextAreaElement>('textarea')!;
        const draft = field.value;
        const text = draft.trim();
        const previousSelection = selected;
        capturing = true;
        const submit = form.querySelector<HTMLButtonElement>('[type=submit]')!;
        submit.disabled = true;
        try {
          const result = await call('add-batch', {
            text,
            sourceAccount: browserSlot,
          });
          if (captureDraft === draft) {
            captureDraft = '';
            captureOpen = false;
            const currentField = host.querySelector<HTMLTextAreaElement>(
              '[data-rl-capture] textarea',
            );
            if (currentField) {
              currentField.value = '';
            }
          }
          if (selected === previousSelection && tab === 'library' && !dirty) {
            selected = result.entry?.id || '';
            filter = 'inbox';
            mediaScope = 'all';
            renderLibrary();
          }
          await refresh();
          status(
            result.items && result.items.length > 1
              ? t(
                  `${result.items.length} links saved.`,
                  `已保留 ${result.items.length} 条链接。`,
                )
              : t('Saved.', '已收下。'),
          );
        } finally {
          capturing = false;
          const button = host.querySelector<HTMLButtonElement>(
            '[data-rl-capture] [type=submit]',
          );
          if (button) {
            button.disabled = false;
          }
        }
      });
    });
    host.addEventListener('click', event => {
      const button = (event.target as HTMLElement).closest<HTMLElement>(
        'button',
      );
      if (!button) {
        return;
      }
      run(async () => {
        if ('rlOpenBrowser' in button.dataset) {
          if (options.openRightBrowser) {
            options.openRightBrowser();
          } else {
            document.getElementById('header-browser-toggle')?.click();
          }
          return;
        }
        if ('rlToggleCapture' in button.dataset) {
          captureOpen = !captureOpen;
          const drawer = host.querySelector<HTMLElement>(
            '[data-rl-capture-drawer]',
          );
          if (drawer) {
            drawer.hidden = !captureOpen;
          }
          button.setAttribute('aria-expanded', String(captureOpen));
          button.textContent = captureOpen
            ? t('Close', '收起')
            : `+ ${t('Add', '添加')}`;
          if (captureOpen) {
            host
              .querySelector<HTMLTextAreaElement>('[data-rl-capture] textarea')
              ?.focus();
          }
          return;
        }
        if (button.dataset.rlTab) {
          if (!(await savePending())) {
            return;
          }
          const nextTab = button.dataset.rlTab;
          if (
            nextTab === 'library' ||
            nextTab === 'sources' ||
            nextTab === 'browser'
          ) {
            tab = nextTab;
          }
          render();
          return;
        }
        if (button.dataset.rlAccount) {
          await call('browser-command', {command: 'hide'});
          browserSlot = button.dataset.rlAccount;
          localStorage.setItem('mp:collection-account', browserSlot);
          renderBrowser();
          return;
        }
        if (button.dataset.rlConnectAccount) {
          browserSlot = button.dataset.rlConnectAccount;
          localStorage.setItem('mp:collection-account', browserSlot);
          await browse(
            browserAccounts.find(account => account.id === browserSlot)!.url,
            true,
          );
          return;
        }
        if (button.dataset.rlHistory) {
          button.setAttribute('disabled', '');
          const result = await call(
            button.dataset.rlHistory === 'pause'
              ? 'history-pause'
              : 'history-start',
            {
              sourceAccount: button.dataset.account,
              historyList: button.dataset.list as 'saved' | 'liked',
            },
          );
          snapshot.histories = result.histories;
          syncSourceView();
          return;
        }
        if (button.dataset.rlHistoryView) {
          browserSlot = button.dataset.account!;
          await browse(button.dataset.rlHistoryView);
          return;
        }
        if (button.dataset.rlRevisit) {
          if (!(await savePending())) {
            return;
          }
          await refresh();
          selected = button.dataset.rlRevisit;
          detailView = 'post';
          filter = 'all';
          tab = 'library';
          const item = current();
          if (item) {
            const result = await call('edit', {
              id: item.id,
              revision: details(item).revision,
              patch: {lastViewedAt: Date.now()},
            });
            snapshot.items = snapshot.items?.map(row =>
              row.id === selected && result.entry
                ? {...row, ...result.entry}
                : row,
            );
          }
          render();
          return;
        }
        if (button.dataset.rlBrowserCommand) {
          await call('browser-command', {
            sourceAccount: browserSlot,
            command: button.dataset.rlBrowserCommand as
              | 'back'
              | 'forward'
              | 'reload',
          });
          return;
        }
        if (button.dataset.rlUrl) {
          await browse(button.dataset.rlUrl);
          return;
        }
        if (button.dataset.rlDetailView) {
          if (!(await savePending())) {
            return;
          }
          detailView = button.dataset.rlDetailView as 'post' | 'notes';
          renderDetail();
          return;
        }
        if (button.dataset.rlMedia !== undefined) {
          const media = displayedPost?.media[Number(button.dataset.rlMedia)];
          if (media?.localUrl && media.kind === 'image') {
            preview.show({
              title: displayedPost!.title,
              restoreFocus: () => button.focus(),
              load: async () => ({
                kind: 'image',
                url: media.localUrl!,
                name: displayedPost!.title,
                truncated: false,
              }),
            });
          }
          return;
        }
        if (button.dataset.rlGoal !== undefined) {
          const nextGoal = button.dataset.rlGoal;
          activeGoalId = activeGoalId === nextGoal ? '' : nextGoal;
          renderGoalStrip();
          renderList();
          return;
        }
        if (button.dataset.rlId) {
          if (!(await savePending())) {
            return;
          }
          selected = button.dataset.rlId;
          const viewed = current();
          if (viewed) {
            const result = await call('edit', {
              id: selected,
              revision: details(viewed).revision,
              patch: {lastViewedAt: Date.now()},
            });
            if (result.entry) {
              snapshot.items = snapshot.items?.map(item =>
                item.id === selected ? {...item, ...result.entry} : item,
              );
            }
          }
          detailView = 'post';
          focusedId = selected;
          renderList();
          renderDetail();
          if (event.detail === 0 && visible && tab === 'library') {
            host
              .querySelector<HTMLElement>('.rl-detail [data-rl-action=close]')
              ?.focus({preventScroll: true});
          }
          return;
        }
        const action = button.dataset.rlAction;
        if (action === 'more') {
          cardLimit += 120;
          renderList();
          return;
        }
        if (action === 'sync-bookmarks') {
          tab = 'library';
          selected = '';
          mediaScope = 'bookmarks';
          filter = 'all';
          lens = 'all';
          render();
          await refresh();
          return;
        }
        if (action === 'adopt-intent') {
          if (!(await savePending())) {
            return;
          }
          const item = current();
          if (item && details(item).suggestedIntent) {
            await call('edit', {
              id: item.id,
              revision: details(item).revision,
              patch: {
                intent: details(item)
                  .suggestedIntent as ResourceCollection['intent'],
              },
            });
            await refresh();
          }
          return;
        }
        if (action === 'capture-source') {
          const item = current();
          if (!item) {
            return;
          }
          button.setAttribute('disabled', '');
          status(t('Saving source text and media…', '正在保存原文和媒体…'));
          await call('capture-source', {id: item.id});
          await refresh();
          status(t('Capture updated.', '正文与媒体已更新。'));
          return;
        }
        if (action === 'copy-post' && displayedPost) {
          await navigator.clipboard.writeText(
            `${displayedPost.title}\n\n${displayedPost.text}\n\n${displayedPost.url}`,
          );
          status(t('Post copied.', '正文已复制。'));
          return;
        }
        if (action === 'clear-search') {
          if (!query) {
            filter = 'all';
            lens = 'all';
          }
          query = '';
          searchEpoch++;
          searchMatches = undefined;
          clearTimeout(searchTimer);
          const search = host.querySelector<HTMLInputElement>('.rl-search');
          if (search) {
            search.value = '';
            search.focus();
          }
          const filterSelect = host.querySelector<HTMLSelectElement>(
            '[data-rl-view-filter]',
          );
          if (filterSelect) {
            filterSelect.value = viewFilterValue();
          }
          renderList();
          return;
        }
        if (action === 'reload') {
          dirty = false;
          await refresh();
          return;
        }
        if (action === 'close') {
          await closeDetail();
          return;
        }
        if (action === 'files') {
          if (!window.magicPointerDashboard.stash.addFiles) {
            throw new Error('File collection is unavailable.');
          }
          await window.magicPointerDashboard.stash.addFiles();
          await refresh();
          return;
        }
        if (action === 'canvas') {
          options.openCanvas();
          return;
        }
        if (action === 'settings') {
          document
            .querySelector<HTMLElement>('[data-account-command="settings"]')
            ?.click();
          requestAnimationFrame(() =>
            document
              .querySelector<HTMLElement>('[data-settings-page="privacy"]')
              ?.click(),
          );
          return;
        }
        if (action === 'capture') {
          button.setAttribute('disabled', '');
          status(t('Saving page text and media…', '正在保存正文和媒体…'));
          let result: ResourceResponse;
          try {
            result = await call('capture', {sourceAccount: browserSlot});
          } finally {
            button.removeAttribute('disabled');
          }
          selected = result.entry?.id || '';
          status(
            result.entry?.collection?.captureError ||
              t('Saved to inbox.', '已收进待整理。'),
            Boolean(result.entry?.collection?.captureError),
          );
          await refresh();
          return;
        }
        if (action === 'sync') {
          const result = await sourceRequest('x-sync');
          if (result) {
            if (visible && tab === 'library') {
              await refresh();
            }
            sourceNotice(
              t('Source check finished.', '来源检查已返回。'),
            );
          }
          return;
        }
        if (action === 'open-vault') {
          options.openVaultNote?.();
          return;
        }
        const item = current();
        if (!item) {
          return;
        }
        if (action === 'learn-distill') {
          button.setAttribute('disabled', '');
          try {
            const res = await call('distill', {id: item.id});
            if (res.distilledPrompt && options.startLearnChat) {
              options.startLearnChat(res.distilledPrompt);
            }
          } finally {
            button.removeAttribute('disabled');
          }
          return;
        }
        if (action === 'save-to-vault') {
          button.setAttribute('disabled', '');
          try {
            const res = await call('save-to-vault', {id: item.id});
            if (res.ok) {
              savedToVaultIds.add(item.id);
              options.onVaultUpdated?.();
              status(t('Saved to Knowledge Vault.', '已存入知识库。'));
              renderDetail();
            }
          } finally {
            button.removeAttribute('disabled');
          }
          return;
        }
        if (action === 'add-vault-todo') {
          button.setAttribute('disabled', '');
          try {
            const res = await call('add-vault-todo', {id: item.id});
            if (res.ok) {
              savedTodoIds.add(item.id);
              options.onVaultUpdated?.();
              status(
                res.vaultResult?.appended === false
                  ? t(
                      'This study todo already exists in Vault.',
                      '该学习待办已在知识库清单中。',
                    )
                  : t(
                      'Added study todo to Knowledge Vault.',
                      '已加入知识库学习待办。',
                    ),
              );
              renderDetail();
            }
          } finally {
            button.removeAttribute('disabled');
          }
          return;
        }
        if (action === 'preview' || action === 'paper') {
          const material = action === 'paper' ? 'paper' : 'original';
          preview.show({
            title:
              details(item).title ||
              item.desc ||
              t('Saved original', '保存的原件'),
            restoreFocus: () => {
              if (visible && tab === 'library' && current()?.id === item.id) {
                host
                  .querySelector<HTMLElement>(`[data-rl-action=${action}]`)
                  ?.focus({preventScroll: true});
              }
            },
            load: async () => {
              const result = await call('preview', {id: item.id, material});
              if (!result.preview) {
                throw new Error(t('Preview unavailable.', '暂时无法预览。'));
              }
              return result.preview;
            },
            openExternal: async () => {
              await call('open-original', {id: item.id, material});
            },
          });
          return;
        }
        if (action === 'original') {
          await call('open-original', {id: item.id});
          return;
        }
        if (action === 'source') {
          if (!(await savePending())) {
            return;
          }
          browserSlot = details(item).sourceAccount || 'web';
          await browse(details(item).url);
          return;
        }
        if (action === 'task') {
          options.openTask(details(item).taskId);
          return;
        }
        if (action === 'ignore') {
          if (pending.has(item.id)) {
            return;
          }
          pending.add(item.id);
          try {
            if (!(await savePending()) || selected !== item.id) {
              return;
            }
            const detail = details(current()!);
            const result = await call('edit', {
              id: item.id,
              revision: detail.revision,
              patch: {
                state: detail.state === 'ignored' ? 'inbox' : 'ignored',
              },
            });
            if (selected === item.id) {
              editorRevision =
                result.entry?.collection?.revision ?? editorRevision;
              if (!dirty) {
                selected = '';
              }
            }
            await refresh();
          } finally {
            pending.delete(item.id);
          }
          return;
        }
        if (action === 'process' || action === 'deliver') {
          if (pending.has(item.id)) {
            return;
          }
          pending.add(item.id);
          try {
            if (!(await savePending())) {
              return;
            }
            renderDetail();
            status(
              action === 'process'
                ? t(
                    'MP is reading the saved material…',
                    'MP 正在阅读已保存的材料…',
                  )
                : t('Saving into the project…', '正在放入项目…'),
            );
            await call(action, {id: item.id});
            await refresh();
            status(
              action === 'process'
                ? t('Organized.', '已整理。')
                : t('Saved to project.', '已加入项目资料。'),
            );
          } catch (error) {
            await refresh();
            throw error;
          } finally {
            pending.delete(item.id);
            if (!dirty) {
              renderDetail();
            }
          }
        }
      });
    });
    host.addEventListener('keydown', event => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey
      ) {
        return;
      }
      const target = event.target as HTMLElement;
      const card = target.closest<HTMLButtonElement>('[data-rl-id]');
      if (
        card &&
        [
          'ArrowDown',
          'ArrowUp',
          'ArrowLeft',
          'ArrowRight',
          'Home',
          'End',
        ].includes(event.key)
      ) {
        const cards = [
          ...host.querySelectorAll<HTMLButtonElement>('[data-rl-id]'),
        ];
        const index = cards.indexOf(card);
        const next =
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? cards.length - 1
              : (index +
                  (['ArrowDown', 'ArrowRight'].includes(event.key) ? 1 : -1) +
                  cards.length) %
                cards.length;
        event.preventDefault();
        event.stopPropagation();
        focusCard(cards[next].dataset.rlId!);
        return;
      }
      if (
        event.key === 'Escape' &&
        selected &&
        (target.closest('.rl-detail') || card)
      ) {
        event.preventDefault();
        run(closeDetail);
        event.stopPropagation();
      }
    });
    window.magicPointerDashboard.stash.onEntry?.(() => {
      if (visible && tab === 'library' && !dirty) {
        void refresh();
      }
    });
    host.addEventListener(
      'error',
      event => {
        const image = event.target;
        if (
          image instanceof HTMLImageElement &&
          image.closest('.rl-thumbnail')
        ) {
          const thumbnail = image.parentElement!;
          thumbnail.classList.add('is-unavailable');
          thumbnail.textContent = t('Preview unavailable', '缩略图暂不可用');
        }
      },
      true,
    );
    return {
      show() {
        visible = true;
        const navigationLabel = document.querySelector(
          '#nav-resources .mp-nav-label',
        );
        if (navigationLabel) {
          navigationLabel.textContent = t('Resources', '收集');
        }
        if (!host.childElementCount) {
          render();
        } else if (tab === 'browser') {
          renderBrowser();
        }
        scheduleSourceRefresh();
        void refresh();
      },
      hide() {
        relatedGeneration++;
        pausePostMedia();
        visible = false;
        clearTimeout(sourceTimer);
        postGeneration++;
        const readingPanel = host.querySelector<HTMLElement>('.rl-detail');
        if (readingPanel?.querySelector('[data-rl-post][aria-busy="true"]')) {
          delete readingPanel.dataset.contentKey;
        }
        cancelAnimationFrame(browserResizeFrame);
        browserObserver.disconnect();
        void api.request('browser-command', {command: 'hide'});
        preview.close();
      },
      refresh,
    };
  }
  globalThis.ResourceLibrary = {mount};
})();
