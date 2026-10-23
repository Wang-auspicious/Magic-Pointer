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
      options: {openTask(id: string): void; openCanvas(): void},
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
  function mount(
    host: HTMLElement,
    api: ResourceCollectionApi,
    options: {openTask(id: string): void; openCanvas(): void},
  ) {
    const t = (en: string, zh: string) =>
      document.documentElement.lang.startsWith('zh') ? zh : en;
    let snapshot: ResourceResponse = {ok: true, items: [], projects: []};
    let selected = '';
    let filter = 'all';
    let mediaScope = 'bookmarks';
    let sort = (localStorage.getItem('mp:collection-sort') || 'time') as
      'time' | 'importance';
    let focus = '';
    let cardLimit = 120;
    let masonryFrame = 0;
    const masonryObserver = new ResizeObserver(() => scheduleMasonry());
    let query = '';
    let searchMatches: Set<string> | undefined;
    let searchTimer: ReturnType<typeof setTimeout> | undefined;
    let searchEpoch = 0;
    let tab = 'library';
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
      host.innerHTML = `<div class="rl-shell">
        <header class="rl-heading"><div><p class="rl-kicker">${t('A little less scattered', '让零散，慢慢有了去处')}</p><h1>${t('Resources', '收集')}</h1></div><nav aria-label="${t('Resource views', '资源视图')}">${[
          ['library', t('Library', '资料')],
          ['browser', t('Browser', '浏览器')],
          ['sources', t('Sources', '来源')],
        ]
          .map(
            ([id, name]) =>
              `<button type="button" data-rl-tab="${id}" aria-pressed="${tab === id}">${name}</button>`,
          )
          .join('')}</nav></header>
        <div class="rl-status" data-resource-status role="status" aria-live="polite"></div>
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
    function renderLibrary() {
      pausePostMedia(true);
      host.querySelector('.rl-content')!.innerHTML =
        `<form class="rl-capture" data-rl-capture><span class="rl-add-mark" aria-hidden="true">＋</span><textarea name="text" rows="1" placeholder="${t('Drop a thought. Paste a link. Keep something good.', '记下一点想法，粘贴一个链接，留住值得回看的东西。')}" aria-label="${t('Text or link to collect', '要收集的文字或链接')}" required>${esc(captureDraft)}</textarea><button type="submit" ${capturing ? 'disabled' : ''}>${t('Keep', '收下')} ↗</button></form>
        <div class="rl-tools"><div class="rl-filters">${[
          ['all', t('All saved', '全部收藏')],
          ['inbox', t('Inbox', '待整理')],
          ['ready', t('Collected', '已整理')],
          ['reference', t('References', '参考')],
          ['todo', t('To do', '待办')],
          ['revisit', t('Revisit', '回看')],
          ['ignored', t('Ignored', '已忽略')],
        ]
          .map(
            ([id, label]) =>
              `<button type="button" data-rl-filter="${id}" aria-pressed="${filter === id}">${label}</button>`,
          )
          .join(
            '',
          )}</div><input type="search" class="rl-search" placeholder="${t('Find a resource', '搜索资料')}" aria-label="${t('Find a resource', '搜索资料')}" value="${esc(query)}"><button type="button" data-rl-action="files">${t('Add files', '添加文件')}</button><button type="button" data-rl-action="canvas">${t('Canvas', '画布')} ↗</button></div>
        <div class="rl-library-options"><select data-rl-scope aria-label="${t('Material type', '资料类型')}"><option value="bookmarks" ${mediaScope === 'bookmarks' ? 'selected' : ''}>${t('Bookmarks and links', '收藏与链接')}</option><option value="files" ${mediaScope === 'files' ? 'selected' : ''}>${t('Files and screenshots', '文件与截图')}</option><option value="all" ${mediaScope === 'all' ? 'selected' : ''}>${t('All materials', '全部资料')}</option></select><div data-rl-sync-summary role="status"></div><label>${t('Sort', '排序')} <select data-rl-sort><option value="time" ${sort === 'time' ? 'selected' : ''}>${t('Saved order', '按收藏时间')}</option><option value="importance" ${sort === 'importance' ? 'selected' : ''}>${t('Important now', '对当下的重要性')}</option></select></label></div><div class="rl-focus" ${sort === 'importance' ? '' : 'hidden'}><label>${t('Current focus', '当前关注')} <input data-rl-focus value="${esc(focus)}" placeholder="${esc(snapshot.focus || t('Recent MP tasks', '最近的 MP 任务'))}"></label><small>${t('Uses recent tasks, project links, next steps and unread older material. You can change the focus.', '结合最近任务、关联项目、下一步和未回看的旧资料排序，也可填写当前关注的事。')}</small></div>
        <div class="rl-workspace"><div class="rl-grid" role="list" aria-label="${t('Collected resources', '收集的资料')}"></div><aside class="rl-detail" aria-label="${t('Resource details', '资料详情')}" hidden></aside></div>`;
      masonryObserver.disconnect();
      masonryObserver.observe(host.querySelector('.rl-grid')!);
      host.querySelector('.rl-grid')!.addEventListener('scroll', event => {
        const grid = event.target as HTMLElement;
        if (
          grid.scrollTop + grid.clientHeight >= grid.scrollHeight - 350 &&
          grid.querySelector('[data-rl-more]')
        ) {
          cardLimit += 120;
          renderList();
        }
      });
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
      const accounts = snapshot.accounts || [];
      output.textContent = running
        ? t(
            `Importing ${running.mode === 'check' ? 'new bookmarks' : 'history'} · ${running.retained} retained`,
            `正在${running.mode === 'check' ? '检查新增收藏' : '初始化历史收藏'} · 已收录 ${running.retained} 条`,
          )
        : accounts.some(account => account.enabled)
          ? t('Bookmarks sync automatically every hour', '收藏每小时自动同步')
          : t(
              'Sign in to an account to import its saved posts automatically',
              '登录账号后，自动收录历史收藏',
            );
    }
    function scheduleMasonry() {
      cancelAnimationFrame(masonryFrame);
      masonryFrame = requestAnimationFrame(() => {
        const grid = host.querySelector<HTMLElement>('.rl-grid');
        const canvas = grid?.querySelector<HTMLElement>('.rl-masonry');
        if (!grid || !canvas || !visible || tab !== 'library') {
          return;
        }
        const width = grid.clientWidth - 6;
        const columns = Math.max(
          1,
          Math.min(5, Math.floor((width + 16) / 170)),
        );
        const cardWidth = (width - (columns - 1) * 16) / columns;
        const heights = Array<number>(columns).fill(0);
        canvas.dataset.columns = String(columns);
        canvas.querySelectorAll<HTMLElement>('[data-rl-id]').forEach(card => {
          const column = heights.indexOf(Math.min(...heights));
          card.style.width = `${cardWidth}px`;
          card.style.left = `${column * (cardWidth + 16)}px`;
          card.style.top = `${heights[column]}px`;
          heights[column] += card.getBoundingClientRect().height + 16;
        });
        canvas.style.height = `${Math.max(...heights)}px`;
      });
    }
    function renderList() {
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
      const items = (snapshot.items || []).filter(item => {
        const detail = details(item);
        return (
          (mediaScope === 'all' ||
            (mediaScope === 'bookmarks'
              ? Boolean(item.collection)
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
      if (filter === 'revisit') {
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
              const project = snapshot.projects?.find(
                row => row.id === detail.projectId,
              );
              const date = new Date(item.capturedAt).toLocaleDateString(
                document.documentElement.lang || 'en',
                {month: 'short', day: 'numeric'},
              );
              const preview = (
                item as CollectedResource & {previewUrl?: string}
              ).previewUrl;
              return `<button type="button" class="rl-item ${selected === item.id ? 'is-selected' : ''}" data-rl-id="${esc(item.id)}" tabindex="${focusedId === item.id ? 0 : -1}" aria-pressed="${selected === item.id}">
          ${preview ? `<div class="rl-thumbnail"><img src="${esc(preview)}" alt="${esc(detail.title)}" loading="lazy"></div>` : `<div class="rl-excerpt">${esc((detail.sourceExcerpt || detail.summary || item.text || detail.url || '').slice(0, 350))}</div>`}
          <div class="rl-item-copy"><span class="rl-item-meta">${esc(detail.authorName || item.app || item.media)} <span>${date}</span></span><strong>${esc(detail.title || t('Untitled resource', '未命名资料'))}</strong>${detail.tags?.length ? `<span class="rl-card-tags">${esc(detail.tags.join(' · '))}</span>` : ''}${sort === 'importance' && item.relevanceReason ? `<span class="rl-relevance">${esc(item.relevanceReason)}</span>` : ''}<div class="rl-item-foot"><span>${esc(project?.name || labels()[detail.intent === 'save' && detail.suggestedIntent ? detail.suggestedIntent : detail.intent])}</span><span>${detail.captureStatus === 'loading' ? t('Saving original…', '保存原帖中…') : detail.captureStatus === 'partial' ? t('Media incomplete', '媒体未齐') : detail.state === 'queued' ? t('Queued', '等待整理') : detail.state === 'waiting' ? t('Needs your input', '等待你的处理') : detail.state === 'processing' ? t('Processing…', '正在整理…') : detail.state === 'error' ? t('Needs attention', '需要处理') : detail.exportedPath ? t('In project', '已放入项目') : '↗'}</span></div></div></button>`;
            })
            .join('') +
          '</div>' +
          (items.length > cardLimit
            ? `<button type="button" data-rl-action="more" data-rl-more>${t('Load more', '加载更多')} · ${Math.min(cardLimit, items.length)} / ${items.length}</button>`
            : '')
        : snapshot.items?.length
          ? `<div class="rl-empty"><h2>${t('No resources match.', '没有符合条件的资料。')}</h2><p>${t('Try another search or view your other resources.', '试试其他关键词，或查看其他分类。')}</p><button type="button" data-rl-action="clear-search">${t(query ? 'Clear search' : 'View all resources', query ? '清除搜索' : '查看全部资料')}</button></div>`
          : `<div class="rl-empty"><span class="rl-empty-mark" aria-hidden="true">↙</span><h2>${t('Room for the next good idea.', '留一点空间，给下一个好想法。')}</h2><p>${t('A screenshot, a paper, a small detail you want to borrow. Keep it here; decide what it becomes next.', '截图、论文、想借鉴的小细节。先收在这里，再决定它会成为什么。')}</p><button type="button" data-rl-tab="browser">${t('Open your browser', '打开内置浏览器')} ↗</button></div>`;
      if (restore) {
        focusCard(focusedId);
      }
      scheduleMasonry();
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
      const detail = details(item);
      host
        .querySelector('.rl-workspace')
        ?.classList.toggle(
          'is-reading',
          Boolean(detail.postPath && detailView === 'post'),
        );
      const contentKey =
        detail.postPath && detailView === 'post'
          ? `${item.id}:post:${detail.postPath}:${detail.captureStatus}:${detail.thumbnailPath}`
          : `${item.id}:${detail.revision}:${detailView}`;
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
      panel.innerHTML = `<div class="rl-detail-top"><span>${t('Make it useful', '让它派上用场')}</span><button type="button" data-rl-action="close" aria-label="${t('Close details', '关闭详情')}">×</button></div>
        ${detail.postPath ? `<div class="rl-reading-tabs"><button type="button" data-rl-detail-view="post" aria-pressed="${detailView === 'post'}">${t('Original post', '原帖')}</button><button type="button" data-rl-detail-view="notes" aria-pressed="${detailView === 'notes'}">${t('Use & notes', '用途与整理')}</button></div><article class="rl-post" data-rl-post ${detailView === 'post' ? '' : 'hidden'} aria-busy="true"><p>${t('Loading saved post…', '正在读取已保存原帖…')}</p></article>` : ''}
        ${detail.url && detail.captureStatus !== 'saved' ? `<div class="rl-capture-state" role="status"><p>${esc(detail.captureError || t('The link is saved. Capture the page to keep its text and media here.', '链接已保留。提取正文和媒体后，即可在这里阅读。'))}</p><button type="button" data-rl-action="capture-source" ${detail.captureStatus === 'loading' ? 'disabled' : ''}>${detail.captureStatus === 'loading' ? t('Saving…', '正在保存…') : t('Capture / retry media', '提取正文 / 重试媒体')}</button></div>` : ''}
        <div class="rl-notes" ${detail.postPath && detailView === 'post' ? 'hidden' : ''}>
        ${detail.suggestedIntent && detail.suggestedIntent !== detail.intent ? `<div class="rl-use-suggestion"><span>${t('Suggested use', '建议用途')}：${esc(labels()[detail.suggestedIntent])}</span><button type="button" data-rl-action="adopt-intent">${t('Use this', '采用建议')}</button></div>` : ''}
        <button type="button" class="rl-read-original" data-rl-action="preview">${t('Read saved original', '阅读保存的原件')} <span aria-hidden="true">↗</span></button>
        ${detail.paperPath ? `<button type="button" class="rl-read-original" data-rl-action="paper">${t('Read downloaded paper', '阅读已下载的论文')} <span aria-hidden="true">PDF ↗</span></button>` : ''}
        <button type="button" data-rl-action="reload" hidden>${t('Discard draft and reload', '舍弃草稿并重新加载')}</button>
        <form data-rl-edit><label>${t('Title', '标题')}<input name="title" value="${esc(detail.title)}" required></label><div class="rl-pair"><label>${t('Project', '项目')}<select name="projectId">${projectOptions(detail.projectId)}</select></label><label>${t('Use it for', '用途')}<select name="intent">${Object.entries(
          labels(),
        )
          .map(
            ([id, name]) =>
              `<option value="${id}" ${detail.intent === id ? 'selected' : ''}>${name}</option>`,
          )
          .join('')}</select></label></div>
        <label>${t('Your note', '你的想法')}<textarea name="note" rows="2" placeholder="${t('Why did this catch your eye?', '当时为什么想收下它？')}">${esc(detail.note)}</textarea></label>
        <label>${t('Processed content', '整理后的内容')}<textarea name="summary" rows="6" placeholder="${t('Let the agent read your saved material, or write your own.', '让 Agent 整理已保存的材料，也可以自己写。')}">${esc(detail.summary)}</textarea></label>
        <label>${t('Next time', '下次可以做什么')}<textarea name="nextStep" rows="2">${esc(detail.nextStep)}</textarea></label><button type="submit" class="rl-save">${t('Save changes', '保存修改')}</button></form>
        <div class="rl-evidence">${detail.decisionReason ? `<span>${t('Collection decision', '收录判断')}</span><p>${esc(detail.decisionReason)}</p>` : ''}<span>${t('Reading coverage', '实际阅读范围')}</span><p>${esc(detail.coverage || t('Saved material; not yet reviewed.', '已保存材料，尚未阅读整理。'))}</p>${detail.error ? `<p class="rl-error">${esc(detail.error)}</p>` : ''}${detail.exportedPath ? `<p>${esc(detail.exportedPath)}</p>` : ''}</div>
        <div class="rl-actions" aria-busy="${busy}">${primary}<button type="button" data-rl-action="deliver" ${busy ? 'disabled' : ''}>${t('Send to project', '放入项目')} ↗</button></div>
        </div><div class="rl-links">${detail.url ? `<button type="button" data-rl-action="source">${t('Original page', '原始页面')} ↗</button>` : ''}${detail.postPath ? `<button type="button" data-rl-action="copy-post">${t('Copy post', '复制正文')}</button>` : `<button type="button" data-rl-action="original">${t('Saved original', '保存的原件')} ↗</button>`}${detail.taskId ? `<button type="button" data-rl-action="task">${t('Agent task', '整理任务')} ↗</button>` : ''}<button type="button" data-rl-action="ignore">${detail.state === 'ignored' ? t('Restore', '恢复') : t('Ignore', '忽略')}</button></div>`;
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
        article.innerHTML = `<header><span class="rl-post-platform">${esc(post.platform === 'xiaohongshu' ? '小红书' : post.platform === 'x' ? 'X' : new URL(post.url).hostname)}</span><h2>${esc(post.title)}</h2><p class="rl-post-byline">${esc(post.author.name)}${post.publishedAt ? ` · ${esc(new Date(post.publishedAt).toLocaleDateString(document.documentElement.lang))}` : ''}</p></header><div class="rl-post-text">${esc(post.text)}</div><div class="rl-post-media">${post.media.map((media, index) => (media.localUrl ? (media.kind === 'image' ? `<button type="button" class="rl-post-image" data-rl-media="${index}" aria-label="${t('Enlarge image', '放大图片')} ${index + 1}"><img src="${esc(media.localUrl)}" loading="lazy" alt="${t('Saved post image', '已保存图片')} ${index + 1}"></button>` : `<video controls preload="metadata" src="${esc(media.localUrl)}"></video>`) : `<div class="rl-media-missing">${t('Media not saved', '媒体尚未保存')} ${index + 1}<p>${esc(media.error || '')}</p></div>`)).join('')}</div>${post.links.length ? `<details class="rl-post-links"><summary>${t('Links in this post', '帖子中的链接')} (${post.links.length})</summary>${post.links.map(url => `<button type="button" data-rl-url="${esc(url)}">${esc(url)}</button>`).join('')}</details>` : ''}<p class="rl-post-coverage">${esc(post.coverage)}</p>`;
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
        `<div class="rl-browser rl-embedded"><div class="rl-browser-accounts" role="group" aria-label="${t('Separate sign-in sessions', '独立登录会话')}">${browserAccounts.map(account => `<button type="button" data-rl-account="${account.id}" aria-pressed="${account.id === browserSlot}">${account.name}</button>`).join('')}<span>${t('Sign in once. Each account stays separate on this device.', '登录状态保存在本机，各账号互不串用。')}</span></div>
        <form class="rl-browser-bar" data-rl-browser><button type="button" data-rl-browser-command="back" aria-label="${t('Back', '后退')}">←</button><button type="button" data-rl-browser-command="forward" aria-label="${t('Forward', '前进')}">→</button><button type="button" data-rl-browser-command="reload" aria-label="${t('Reload', '刷新')}">↻</button><input name="url" aria-label="URL" value="${esc(savedBrowserUrl)}" required><button type="submit">${t('Go', '前往')}</button><button type="button" data-rl-action="${browserSlot.startsWith('xiaohongshu-') ? 'sync-bookmarks' : 'capture'}">${browserSlot.startsWith('xiaohongshu-') ? t('View synced bookmarks', '查看同步收藏') : t('Save this page', '保存当前网页')}</button></form><p class="rl-browser-sync-help">${browserSlot.startsWith('xiaohongshu-') ? t('After sign-in, MP imports your saved history automatically, then checks for new bookmarks every hour.', '登录后自动初始化全部历史收藏，之后每小时检查新增收藏。可返回资料页查看导入进度。') : ''}</p><div class="rl-browser-canvas"><div class="rl-browser-surface" data-rl-browser-host><p>${t('Your page opens here, inside MP.', '网页在这里打开，始终留在 MP 内。')}</p></div><aside class="rl-browser-recall" data-rl-related hidden aria-label="${t('Previously saved references', '以前留下的资料')}"></aside></div></div>`;
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
          ? `<h3>${t('You kept something here.', '你以前在这里留过东西。')}</h3><p class="rl-recall-intro">${t('A note, a reference, a next step. Pick it up where you left it.', '当时的一点想法、一个参考，或留给下次的事。')}</p>${rows
              .map(row => {
                const detail = details(row.entry);
                return `<button type="button" data-rl-revisit="${esc(row.entry.id)}"><small>${row.relation === 'page' ? t('This page', '同一页面') : row.relation === 'link' ? t('Links to this page', '提到了这个页面') : t('From this website', '同一网站的资料')} · ${esc(labels()[detail.intent === 'save' && detail.suggestedIntent ? detail.suggestedIntent : detail.intent])}</small><strong>${esc(detail.title)}</strong><p>${esc((detail.note || detail.summary || detail.nextStep || '').slice(0, 220))}</p></button>`;
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
      host.querySelector('.rl-content')!.innerHTML =
        `<div class="rl-sources"><h2>${t('Sign in. Your bookmarks follow.', '登录一次，收藏自动收进来。')}</h2><p>${t('MP imports all available saved history after sign-in, then checks for new bookmarks every hour. Text and media remain readable here.', '登录后先初始化历史收藏，之后每小时检查新增收藏。正文和媒体保留在本机，回到资料页就能查看。')}</p>
        ${browserAccounts
          .filter(account => account.id !== 'web')
          .map(
            account =>
              `<section class="rl-source-account"><div class="rl-source-row"><div><h3>${esc(account.name)}</h3><p>${t('A separate sign-in session saved on this device.', '独立登录会话，保存在这台电脑。')}</p></div><button type="button" data-rl-connect-account="${account.id}">${t('Open in MP', '在 MP 内打开')} ↗</button></div>${account.id.startsWith('xiaohongshu-') ? `<div data-rl-history-account="${account.id}" class="rl-history"></div>` : ''}</section>`,
          )
          .join('')}
        <details class="rl-api-options"><summary>${t('Optional X developer API connection', '可选：X 开发者 API 接入')}</summary>
        <section class="rl-source-row"><div><h3>X</h3><p>${t('Official, read-only API · every 30 minutes when enabled', '官方只读 API · 启用后每 30 分钟检查')}</p></div><span data-rl-source-account></span></section>
        <p data-rl-source-feedback role="status" aria-live="polite"></p>
        <form data-rl-x><label>${t('User OAuth access token', '用户 OAuth access token')}<input name="token" type="password" autocomplete="off" required placeholder="${t('Stored encrypted on this device', '仅加密保存在本机')}"></label><p>${t('Requires your X developer application and user-authorized read scopes. API usage may be billed by X. Your browser login is not this token.', '需要你自己的 X 开发者应用和用户授权的读取权限，X API 可能计费。浏览器的登录状态不能代替这个 token。')}</p><button type="submit">${t('Connect official API', '连接官方 API')}</button></form>
        <div class="rl-source-options"><label><input type="checkbox" data-rl-x-option="bookmarks" ${source?.bookmarks ? 'checked' : ''}> ${t('Bookmarks', '收藏')}</label><label><input type="checkbox" data-rl-x-option="likes" ${source?.likes ? 'checked' : ''}> ${t('Likes', '点赞')}</label><label><input type="checkbox" data-rl-x-option="enabled" ${source?.enabled ? 'checked' : ''}> ${t('Automatic checks', '定时检查')}</label><button type="button" data-rl-action="sync" ${source?.accountId ? '' : 'disabled'}>${t('Check now', '现在检查')}</button></div>
        <p>${t('Recent window only, up to 500 entries per list per check. Imported materials are retained even when the source is unavailable.', 'API 每次检查近期窗口，每类最多 500 条。来源不可用时，已经保存的材料仍然保留。')}</p>
        <p class="rl-source-result"></p></details>
        <form data-rl-rules><label>${t('What is worth keeping?', '哪些内容值得留下？')}<textarea name="rules" rows="3" placeholder="${t('Keep UI references and research ideas; ignore giveaways.', '保留 UI 参考与论文思路，忽略抽奖。')}">${esc(source?.rules || '')}</textarea></label><button type="submit">${t('Save collection rule', '保存收集规则')}</button></form>
        <div class="rl-source-options"><label><input type="checkbox" data-rl-x-option="organize" ${source?.organize ? 'checked' : ''}> ${t('Organize new imports with MP (uses model credits)', '自动整理新导入内容（消耗模型额度）')}</label></div>
        ${[
          [
            '抖音 / B站',
            t(
              'Browse and clip manually. Automatic account collection is not enabled without a verified permitted interface.',
              '可在内置浏览器中正常浏览、主动收录。未核实允许的接口前，不启用账号自动采集。',
            ),
          ],
          [
            'iPhone / Android',
            t(
              'Share or transfer files to this PC, then add them here. A paired mobile inbox and automatic album sync are not connected in this build.',
              '可以先将文件分享到电脑，再添加到这里。本版尚未接通手机配对收件箱与自动相册同步。',
            ),
          ],
        ]
          .map(
            ([name, body]) =>
              `<section class="rl-source-row"><div><h3>${name}</h3><p>${body}</p></div></section>`,
          )
          .join('')}
        <button type="button" data-rl-action="settings">${t('Clipboard collection settings', '剪贴板收集设置')} ↗</button></div>`;
      syncSourceView();
    }
    function syncSourceView() {
      if (tab !== 'sources') {
        return;
      }
      const source = snapshot.source;
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
          const labels = {
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
              : `<p>${t('After sign-in, history import starts automatically.', '登录后自动开始初始化历史收藏。')}</p>`) +
            (['saved', 'liked'] as const)
              .map(list => {
                const job = jobs.find(row => row.list === list);
                return `<div class="rl-history-list"><div><strong>${list === 'saved' ? t('Saved notes', '收藏笔记') : t('Liked notes', '点赞笔记')}</strong><p>${job ? `${esc(labels[job.status])} · ${job.retained} ${t('links retained', '条链接已留存')}` : t('Not imported yet', '尚未导入')}</p>${job?.error ? `<p class="rl-error">${esc(job.error)}</p>` : ''}</div><div class="rl-history-actions"><button type="button" data-rl-history="${job?.status === 'running' ? 'pause' : 'start'}" data-account="${accountId}" data-list="${list}" ${busy && job?.status !== 'running' ? 'disabled' : ''}>${job?.status === 'running' ? t('Pause', '暂停') : job ? t('Continue / check again', '继续 / 再次检查') : t('Import history', '导入历史')}</button>${job?.url ? `<button type="button" data-rl-history-view="${esc(job.url)}" data-account="${accountId}">${t('Check account page', '查看账号页面')} ↗</button>` : ''}</div></div>`;
              })
              .join('') +
            `<details class="rl-history-coverage"><summary>${t('Import details', '导入明细')}</summary><p>${t('Saved posts are retained locally. If the platform hides older posts or requests verification, synchronization stops and keeps its progress.', '已取得的原帖保留在本机。平台隐藏旧帖、要求验证或列表加载中断时，会保留进度并明确显示暂停原因。')}</p></details>`;
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
            'enabled' | 'likes' | 'bookmarks' | 'organize';
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
      status(
        t(
          'Ready. Signed-in Xiaohongshu accounts synchronize bookmarks automatically.',
          '已就绪。小红书账号登录后会自动同步收藏。',
        ),
      );
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
      if (input.matches('[data-rl-sort]')) {
        sort = input.value as 'time' | 'importance';
        localStorage.setItem('mp:collection-sort', sort);
        run(async () => {
          await refresh();
          renderLibrary();
        });
        return;
      }
      if (input.matches('[data-rl-scope]')) {
        mediaScope = input.value;
        cardLimit = 120;
        renderList();
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
            renderLibrary();
          }
          await refresh();
          status(
            result.items && result.items.length > 1
              ? t(
                  `${result.items.length} links saved. Originals are being captured in the background.`,
                  `已保留 ${result.items.length} 条链接，正在后台保存原帖。`,
                )
              : t('Kept. Ready when you are.', '收下了，随时可以继续。'),
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
        if (button.dataset.rlTab) {
          if (!(await savePending())) {
            return;
          }
          tab = button.dataset.rlTab;
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
              'back' | 'forward' | 'reload',
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
        if (button.dataset.rlFilter) {
          filter = button.dataset.rlFilter;
          host
            .querySelectorAll<HTMLElement>('[data-rl-filter]')
            .forEach(item =>
              item.setAttribute(
                'aria-pressed',
                String(item.dataset.rlFilter === filter),
              ),
            );
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
          status(
            t(
              'Capture returned. The saved content and any gaps are shown here.',
              '提取已返回，已保存的内容与缺口显示在这里。',
            ),
          );
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
          host
            .querySelectorAll<HTMLElement>('[data-rl-filter]')
            .forEach(item =>
              item.setAttribute(
                'aria-pressed',
                String(item.dataset.rlFilter === filter),
              ),
            );
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
              t('Saved to your inbox.', '已收进待整理。'),
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
              t(
                'Source check finished. See its status below.',
                '来源检查已返回，实际状态见下方。',
              ),
            );
          }
          return;
        }
        const item = current();
        if (!item) {
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
                ? t(
                    'Organized. Review the reading coverage and next step.',
                    '已整理。可以查看阅读范围和下一步建议。',
                  )
                : t(
                    'Saved and attached to the project for the next task.',
                    '已保存并加入项目资料，下次任务可读取。',
                  ),
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
      'load',
      event => {
        if ((event.target as HTMLElement).closest?.('.rl-thumbnail')) {
          scheduleMasonry();
        }
      },
      true,
    );
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
        const grid = host.querySelector('.rl-grid');
        if (grid) {
          masonryObserver.observe(grid);
        }
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
        masonryObserver.disconnect();
        cancelAnimationFrame(masonryFrame);
        void api.request('browser-command', {command: 'hide'});
        preview.close();
      },
      refresh,
    };
  }
  globalThis.ResourceLibrary = {mount};
})();
