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
    let filter = 'inbox';
    let query = '';
    let tab = 'library';
    let visible = false;
    let dirty = false;
    let editorRevision = 0;
    let editVersion = 0;
    let saving: Promise<void> | null = null;
    let captureDraft = '';
    let capturing = false;
    let savedBrowserUrl = 'https://x.com';
    let generation = 0;
    const pending = new Set<string>();
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
        const next = await call('list');
        if (thisGeneration !== generation) {
          return;
        }
        snapshot = next;
        if (visible && !dirty && tab === 'library') {
          renderList();
          renderDetail();
        }
        if (
          visible &&
          tab === 'sources' &&
          !host.querySelector<HTMLInputElement>('[name="token"]')?.value &&
          document.activeElement?.tagName !== 'TEXTAREA'
        ) {
          renderSources();
        }
      } catch (error) {
        status(String(error), true);
      }
    }
    function projectOptions(value = '') {
      return `<option value="">${t('Choose a project', '选择项目')}</option>${(snapshot.projects || []).map(project => `<option value="${esc(project.id)}" ${value === project.id ? 'selected' : ''}>${esc(project.name)}</option>`).join('')}`;
    }
    function render() {
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
    }
    function renderLibrary() {
      host.querySelector('.rl-content')!.innerHTML =
        `<form class="rl-capture" data-rl-capture><span class="rl-add-mark" aria-hidden="true">＋</span><textarea name="text" rows="1" placeholder="${t('Drop a thought. Paste a link. Keep something good.', '记下一点想法，粘贴一个链接，留住值得回看的东西。')}" aria-label="${t('Text or link to collect', '要收集的文字或链接')}" required>${esc(captureDraft)}</textarea><button type="submit" ${capturing ? 'disabled' : ''}>${t('Keep', '收下')} ↗</button></form>
        <div class="rl-tools"><div class="rl-filters">${[
          ['inbox', t('Inbox', '待整理')],
          ['ready', t('Collected', '已整理')],
          ['all', t('All', '全部')],
          ['ignored', t('Ignored', '已忽略')],
        ]
          .map(
            ([id, label]) =>
              `<button type="button" data-rl-filter="${id}" aria-pressed="${filter === id}">${label}</button>`,
          )
          .join(
            '',
          )}</div><input type="search" class="rl-search" placeholder="${t('Find a resource', '搜索资料')}" aria-label="${t('Find a resource', '搜索资料')}" value="${esc(query)}"><button type="button" data-rl-action="files">${t('Add files', '添加文件')}</button><button type="button" data-rl-action="canvas">${t('Canvas', '画布')} ↗</button></div>
        <div class="rl-workspace"><div class="rl-grid" role="list" aria-label="${t('Collected resources', '收集的资料')}"></div><aside class="rl-detail" aria-label="${t('Resource details', '资料详情')}" hidden></aside></div>`;
      renderList();
      renderDetail();
    }
    function renderList() {
      const grid = host.querySelector('.rl-grid');
      if (!grid) {
        return;
      }
      const items = (snapshot.items || []).filter(item => {
        const detail = details(item);
        return (
          (filter === 'all' ||
            (filter === 'inbox'
              ? ['inbox', 'error', 'processing'].includes(detail.state)
              : detail.state === filter)) &&
          (!query ||
            `${detail.title} ${detail.summary} ${item.text || ''} ${detail.note}`
              .toLowerCase()
              .includes(query.toLowerCase()))
        );
      });
      grid.innerHTML = items.length
        ? items
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
              return `<button type="button" class="rl-item ${selected === item.id ? 'is-selected' : ''}" data-rl-id="${esc(item.id)}" aria-pressed="${selected === item.id}">
          ${preview ? `<div class="rl-thumbnail"><img src="${esc(preview)}" alt="${esc(detail.title)}" loading="lazy"></div>` : `<div class="rl-excerpt">${esc((detail.summary || item.text || detail.url || '').slice(0, 210))}</div>`}
          <div class="rl-item-copy"><span class="rl-item-meta">${esc(item.app || item.media)} <span>${date}</span></span><strong>${esc(detail.title || t('Untitled resource', '未命名资料'))}</strong><div class="rl-item-foot"><span>${esc(project?.name || labels()[detail.intent])}</span><span>${detail.state === 'processing' ? t('Processing…', '正在整理…') : detail.state === 'error' ? t('Needs attention', '需要处理') : detail.exportedPath ? t('In project', '已放入项目') : '↗'}</span></div></div></button>`;
            })
            .join('')
        : snapshot.items?.length
          ? `<div class="rl-empty"><h2>${t('No resources match.', '没有符合条件的资料。')}</h2><p>${t('Try another search or view your other resources.', '试试其他关键词，或查看其他分类。')}</p><button type="button" data-rl-action="clear-search">${t(query ? 'Clear search' : 'View all resources', query ? '清除搜索' : '查看全部资料')}</button></div>`
          : `<div class="rl-empty"><span class="rl-empty-mark" aria-hidden="true">↙</span><h2>${t('Room for the next good idea.', '留一点空间，给下一个好想法。')}</h2><p>${t('A screenshot, a paper, a small detail you want to borrow. Keep it here; decide what it becomes next.', '截图、论文、想借鉴的小细节。先收在这里，再决定它会成为什么。')}</p><button type="button" data-rl-tab="browser">${t('Open your browser', '打开内置浏览器')} ↗</button></div>`;
    }
    function renderDetail() {
      const panel = host.querySelector<HTMLElement>('.rl-detail');
      const item = current();
      if (!panel || dirty) {
        return;
      }
      panel.hidden = !item;
      host
        .querySelector('.rl-workspace')
        ?.classList.toggle('has-detail', Boolean(item));
      if (!item) {
        panel.replaceChildren();
        return;
      }
      const detail = details(item);
      editorRevision = detail.revision;
      panel.innerHTML = `<div class="rl-detail-top"><span>${t('Make it useful', '让它派上用场')}</span><button type="button" data-rl-action="close" aria-label="${t('Close details', '关闭详情')}">×</button></div>
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
        <div class="rl-actions" aria-busy="${pending.has(item.id)}"><button type="button" data-rl-action="process" ${pending.has(item.id) ? 'disabled' : ''}>${pending.has(item.id) ? t('Working…', '正在处理…') : t('Let MP organize', '交给 MP 整理')}</button><button type="button" data-rl-action="deliver" ${pending.has(item.id) ? 'disabled' : ''}>${t('Send to project', '放入项目')} ↗</button></div>
        <div class="rl-links">${detail.url ? `<button type="button" data-rl-action="source">${t('Original page', '原始页面')} ↗</button>` : ''}<button type="button" data-rl-action="original">${t('Saved original', '保存的原件')} ↗</button>${detail.taskId ? `<button type="button" data-rl-action="task">${t('Agent task', '整理任务')} ↗</button>` : ''}<button type="button" data-rl-action="ignore">${detail.state === 'ignored' ? t('Restore', '恢复') : t('Ignore', '忽略')}</button></div>`;
    }
    function renderBrowser() {
      host.querySelector('.rl-content')!.innerHTML =
        `<div class="rl-browser"><div class="rl-browser-start"><p>${t('Browse in ego, with the same local sign-in profile used by MP. Websites open in its native browser window. Sessions remain until the site expires them or you sign out.', '使用 MP 已接入的 ego 浏览器和同一份本机登录状态。网页在原生浏览器窗口打开，直到网站要求重新验证或你主动退出。')}</p><div class="rl-sites">${[
          ['X', 'https://x.com'],
          ['小红书', 'https://www.xiaohongshu.com'],
          ['抖音', 'https://www.douyin.com'],
          ['B站', 'https://www.bilibili.com'],
        ]
          .map(
            ([name, url]) =>
              `<button type="button" data-rl-url="${url}">${name} ↗</button>`,
          )
          .join('')}</div></div>
        <form class="rl-browser-bar" data-rl-browser><input name="url" aria-label="URL" value="${esc(savedBrowserUrl)}" required><button type="submit">${t('Open in ego', '在 ego 中打开')} ↗</button></form><div class="rl-browser-handoff"><span class="rl-empty-mark" aria-hidden="true">↙</span><h2>${t('Bring back what matters.', '把值得留下的，带回来。')}</h2><p>${t('Select text in your collection browser, then collect it here. MP briefly reads that page’s selection and hands control back. No selection saves the link only.', '在收集浏览器中选中文字，再回到这里收录。MP 会短暂读取当前页选文后交回控制；未选文字时，只保存链接。')}</p><button type="button" data-rl-action="capture">${t('Keep selection / link', '收录选中文字 / 链接')} ↙</button></div></div>`;
    }
    function renderSources() {
      const source = snapshot.source;
      host.querySelector('.rl-content')!.innerHTML =
        `<div class="rl-sources"><h2>${t('Connected on your terms.', '按你的方式，连接来源。')}</h2><p>${t('Browser sign-in and automatic collection are separate. MP does not script social timelines or reuse private account APIs.', '浏览器登录与定时采集分别管理。MP 不脚本刷社交时间线，也不借用私有账号接口。')}</p>
        <section class="rl-source-row"><div><h3>X</h3><p>${t('Official, read-only API · every 30 minutes when enabled', '官方只读 API · 启用后每 30 分钟检查')}</p></div><span>${esc(source?.username ? '@' + source.username : t('Not connected', '未连接'))}</span></section>
        <form data-rl-x><label>${t('User OAuth access token', '用户 OAuth access token')}<input name="token" type="password" autocomplete="off" required placeholder="${t('Stored encrypted on this device', '仅加密保存在本机')}"></label><p>${t('Requires your X developer application and user-authorized read scopes. API usage may be billed by X. Your browser login is not this token.', '需要你自己的 X 开发者应用和用户授权的读取权限，X API 可能计费。浏览器的登录状态不能代替这个 token。')}</p><button type="submit">${t('Connect official API', '连接官方 API')}</button></form>
        <div class="rl-source-options"><label><input type="checkbox" data-rl-x-option="bookmarks" ${source?.bookmarks ? 'checked' : ''}> ${t('Bookmarks', '收藏')}</label><label><input type="checkbox" data-rl-x-option="likes" ${source?.likes ? 'checked' : ''}> ${t('Likes', '点赞')}</label><label><input type="checkbox" data-rl-x-option="enabled" ${source?.enabled ? 'checked' : ''}> ${t('Automatic checks', '定时检查')}</label><button type="button" data-rl-action="sync" ${source?.accountId ? '' : 'disabled'}>${t('Check now', '现在检查')}</button></div>
        <form data-rl-rules><label>${t('What is worth keeping?', '哪些内容值得留下？')}<textarea name="rules" rows="3" placeholder="${t('Keep UI references and research ideas; ignore giveaways.', '保留 UI 参考与论文思路，忽略抽奖。')}">${esc(source?.rules || '')}</textarea></label><button type="submit">${t('Save collection rule', '保存收集规则')}</button></form><div class="rl-source-options"><label><input type="checkbox" data-rl-x-option="organize" ${source?.organize ? 'checked' : ''}> ${t('Organize newly imported posts with MP (uses model credits)', '自动整理新导入内容（消耗模型额度）')}</label></div><p>${t('Recent window only, up to 500 entries per list per check. Imported materials are retained even when the source is unavailable.', '每次检查近期窗口，每类最多 500 条。来源不可用时，已经保存的材料仍然保留。')}</p>
        <p class="rl-source-result">${esc(source?.error || source?.status || '')}${source?.lastSuccess ? ' · ' + new Date(source.lastSuccess).toLocaleString() : ''}</p>
        ${[
          [
            '小红书 / 抖音 / B站',
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
    async function browse(url: string) {
      const result = await call('browser-open', {url});
      savedBrowserUrl = result.url || url;
      const input = host.querySelector<HTMLInputElement>(
        '[data-rl-browser] input',
      );
      if (input) {
        input.value = savedBrowserUrl;
      }
      status(
        t(
          'Opened in ego · select text there, then collect it here.',
          '已在 ego 中打开 · 在网页选中文字后，回这里收录。',
        ),
      );
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
      if (target.classList.contains('rl-search')) {
        query = (target as HTMLInputElement).value;
        renderList();
      }
    });
    host.addEventListener('change', event => {
      const input = event.target as HTMLInputElement;
      if (input.dataset.rlXOption) {
        run(async () => {
          const result = await call('x-configure', {
            [input.dataset.rlXOption!]: input.checked,
          });
          snapshot.source = result.source;
          status(t('Source settings saved.', '来源设置已保存。'));
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
          const result = await call('x-configure', {
            rules: String(new FormData(form).get('rules') || ''),
          });
          snapshot.source = result.source;
          status(t('Collection rule saved.', '收集规则已保存。'));
          return;
        }
        if (form.matches('[data-rl-x]')) {
          const token = form.querySelector<HTMLInputElement>('input')!;
          const value = token.value;
          token.value = '';
          const result = await call('x-connect', {token: value});
          snapshot.source = result.source;
          renderSources();
          status(
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
          const result = await call(
            'add',
            /^https?:\/\/\S+$/.test(text) ? {url: text} : {text},
          );
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
          status(t('Kept. Ready when you are.', '收下了，随时可以继续。'));
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
        if (button.dataset.rlUrl) {
          await browse(button.dataset.rlUrl);
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
          renderList();
          renderDetail();
          return;
        }
        const action = button.dataset.rlAction;
        if (action === 'clear-search') {
          if (!query) {
            filter = 'all';
          }
          query = '';
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
          if (!(await savePending())) {
            return;
          }
          selected = '';
          renderList();
          renderDetail();
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
          const result = await call('capture');
          selected = result.entry?.id || '';
          status(t('Saved to your inbox.', '已收进待整理。'));
          await refresh();
          return;
        }
        if (action === 'sync') {
          status(t('Checking the official API…', '正在检查官方 API…'));
          const result = await call('x-sync');
          snapshot.source = result.source;
          renderSources();
          return;
        }
        const item = current();
        if (!item) {
          return;
        }
        if (action === 'original') {
          if (!window.magicPointerDashboard.stash.open) {
            throw new Error('Original material is unavailable.');
          }
          await window.magicPointerDashboard.stash.open(item.id);
          return;
        }
        if (action === 'source') {
          if (!(await savePending())) {
            return;
          }
          savedBrowserUrl = details(item).url;
          tab = 'browser';
          render();
          await browse(savedBrowserUrl);
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
        event.key === 'Escape' &&
        selected &&
        !(event.target as HTMLElement).matches('input,textarea,select')
      ) {
        run(async () => {
          if (await savePending()) {
            selected = '';
            renderList();
            renderDetail();
          }
        });
        event.stopPropagation();
      }
    });
    window.magicPointerDashboard.stash.onEntry?.(() => {
      if (visible && tab === 'library' && !dirty) {
        void refresh();
      }
    });
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
        }
        void refresh();
      },
      hide() {
        visible = false;
      },
      refresh,
    };
  }
  globalThis.ResourceLibrary = {mount};
})();
