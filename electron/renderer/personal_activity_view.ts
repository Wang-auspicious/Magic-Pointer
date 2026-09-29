(() => {
  type Json = Record<string, any>;
  interface Api {
    read(date?: string): Promise<Json>;
    configure(patch: Json): Promise<Json>;
    generate(date: string): Promise<Json>;
    pickRoot(): Promise<Json>;
    openSource(payload: Json): Promise<Json>;
    clear(): Promise<Json>;
  }
  const escape = (value: unknown) =>
    String(value ?? '').replace(
      /[&<>"']/g,
      character =>
        ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[
          character
        ]!,
    );
  const dateKey = () => {
    const date = new Date();
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  };
  const number = (value: unknown) => Number(value || 0).toLocaleString('zh-CN');
  const minutes = (value: unknown) =>
    `${Math.round(Number(value || 0) / 60000)} 分钟`;
  const time = (value: string) =>
    new Date(value).toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
    });
  const kinds: Json = {
    created: '新增',
    modified: '修改',
    deleted: '删除',
    renamed: '移动 / 更名',
  };

  function markup(snapshot: Json, date: string, query: string): string {
    const status = snapshot.status || {};
    const day = snapshot.day;
    const facts = snapshot.facts || {};
    const needle = query.trim().toLowerCase();
    const matches = (value: unknown) =>
      !needle ||
      String(value || '')
        .toLowerCase()
        .includes(needle);
    const files = (day?.files || [])
      .map((row: Json, index: number) => ({...row, index}))
      .filter((row: Json) => matches(`${row.path} ${row.previousPath || ''}`));
    const screens = (day?.screens || [])
      .map((row: Json, index: number) => ({...row, index}))
      .filter((row: Json) => matches(`${row.title} ${row.text} ${row.appId}`));
    const totalKeys = Object.values(day?.keyboard || {}).reduce<number>(
      (total, value) => total + Number(value),
      0,
    );
    const fileCounts = day?.fileCounts || {};
    const newFiles =
      fileCounts.created ??
      files.filter((row: Json) => row.kind === 'created').length;
    const recording = status.enabled && !status.paused;
    const statusLabel = !status.enabled
      ? '尚未开启'
      : status.paused
        ? '已暂停'
        : snapshot.nativeError
          ? '部分记录不可用'
          : '正在本机记录';
    const appRows = (day?.applications || []).slice(0, 8);
    const roots = status.roots || status.watchedRoots || [];
    return `<div class="personal-page">
      <header class="personal-header"><div><p class="personal-eyebrow">PERSONAL MEMORY</p><h1>我的一天</h1><p class="personal-subtitle">记住做过的事，接着往下做。</p></div>
        <div class="personal-header-actions"><span class="personal-status" data-recording="${recording}">${statusLabel}</span>
          <button type="button" data-personal-action="${status.enabled ? 'pause' : 'enable'}">${status.enabled ? (status.paused ? '继续记录' : '暂停') : '开启记录'}</button></div></header>
      <div class="personal-toolbar"><label>日期 <input type="date" data-personal-date value="${escape(date)}" max="${dateKey()}" /></label><input type="search" data-personal-search value="${escape(query)}" placeholder="查找看过的内容或文件…" aria-label="搜索当天记录" /><button type="button" data-personal-action="refresh">刷新</button></div>
      <p class="personal-feedback" role="status" aria-live="polite"></p>
      ${snapshot.nativeError || snapshot.screenError ? `<p class="personal-error" role="status">${escape(snapshot.nativeError || snapshot.screenError)}</p>` : ''}
      ${day ? `<div class="personal-totals"><div><strong>${number(totalKeys)}</strong><span>次按键</span></div><div><strong>${minutes(day.coverage?.activeMs)}</strong><span>电脑活跃时间</span></div><div><strong>${number(newFiles)}</strong><span>次文件新增</span></div><div><strong>${number(day.screenCount ?? day.screens?.length)}</strong><span>个屏幕片段</span></div></div>` : `<p class="personal-empty">这一天没有记录。开启后会从当前时刻开始积累。</p>`}
      <div class="personal-columns"><main>
        <section class="personal-section"><div class="personal-section-title"><h2>当天小结</h2><button type="button" data-personal-action="report">生成最新小结</button></div><pre class="personal-report">${escape(snapshot.report?.markdown || '还没有活动记录。')}</pre></section>
        <section class="personal-section"><div class="personal-section-title"><h2>文件足迹</h2><span>${number(files.length)} 条${day?.detailsCleared ? ' · 详细记录已按保留设置清理' : ''}</span></div>
          <div class="personal-file-list">${
            files
              .slice(-100)
              .reverse()
              .map(
                (row: Json) =>
                  `<button type="button" class="personal-file-row" data-personal-file="${row.index}"><time>${time(row.at)}</time><span class="personal-file-kind">${kinds[row.kind] || '变化'}</span><span title="${escape(row.path)}">${escape(row.path)}${row.previousPath ? `<small>从 ${escape(row.previousPath)}</small>` : ''}</span></button>`,
              )
              .join('') || '<p class="personal-empty">没有匹配的文件变化。</p>'
          }</div>${files.length > 100 ? '<p class="personal-hint">显示最近 100 条，可搜索当天全部记录。</p>' : ''}</section>
        <section class="personal-section"><div class="personal-section-title"><h2>看过的内容</h2><span>${number(screens.length)} 个片段</span></div><div class="personal-screen-list">${
          screens
            .slice(-60)
            .reverse()
            .map(
              (row: Json) =>
                `<button type="button" class="personal-screen-row" data-personal-screen="${row.index}"><time>${time(row.at)}</time><span><strong>${escape(row.title || row.appId)}</strong><span>${escape(row.text || (row.error ? `文字识别未完成：${row.error}` : '已保留当时的窗口画面'))}</span></span><span aria-hidden="true">↗</span></button>`,
            )
            .join('') || '<p class="personal-empty">没有匹配的屏幕片段。</p>'
        }</div>${screens.length > 60 ? '<p class="personal-hint">显示最近 60 个片段，可搜索当天全部文字。</p>' : ''}</section>
      </main><aside>
        <section class="personal-section"><h2>按键次数</h2><dl class="personal-key-list">${
          Object.entries(day?.keyboard || {})
            .sort((a, b) => Number(b[1]) - Number(a[1]))
            .map(
              ([key, value]) =>
                `<div><dt><kbd>${escape(key)}</kbd></dt><dd>${number(value)}</dd></div>`,
            )
            .join('') || '<p class="personal-empty">还没有按键记录。</p>'
        }</dl></section>
        <section class="personal-section"><h2>使用过的应用</h2><dl class="personal-app-list">${appRows.map((row: Json) => `<div><dt>${escape(row.label || row.appId)}</dt><dd>${minutes(row.activeMs)}</dd></div>`).join('') || '<p class="personal-empty">还没有应用活动。</p>'}</dl></section>
        <section class="personal-section"><h2>积累下来的习惯</h2><p>已有 ${number(facts.observedDays)} 天的实际记录。</p>${(
          facts.applications || []
        )
          .slice(0, 3)
          .map(
            (row: Json) =>
              `<p class="personal-fact">${escape(row.label)} <span>累计活跃 ${minutes(row.activeMs)}</span></p>`,
          )
          .join(
            '',
          )}<p class="personal-hint">MP 可在需要时读取这些活动事实与原始出处。</p></section>
      </aside></div>
      <details class="personal-settings"><summary>记录设置与覆盖范围</summary><div class="personal-settings-content">
        <label class="personal-setting-row"><span>记录屏幕与可搜索文字</span><input type="checkbox" data-personal-setting="screenEnabled" ${status.screenEnabled ? 'checked' : ''} /></label>
        <label class="personal-setting-row"><span>每天生成小结</span><input type="time" data-personal-setting="reportTime" value="${escape(status.reportTime || '21:00')}" /></label>
        <label class="personal-setting-row"><span>原图和详细记录保留天数 <small>每日统计继续保留</small></span><input type="number" min="1" max="365" data-personal-setting="retentionDays" value="${status.retentionDays || 30}" /></label>
        <div class="personal-setting-roots"><strong>观察这些文件夹的变化</strong>${roots.map((root: string, index: number) => `<div><span>${escape(root)}</span><button type="button" data-personal-remove-root="${index}" aria-label="停止观察 ${escape(root)}">移除</button></div>`).join('')}<button type="button" data-personal-action="add-root">加入文件夹或磁盘</button></div>
        <p class="personal-hint">键盘统计按键按下次数，不保存输入文字；文件记录包含路径与变化。屏幕采样只在电脑活跃时运行。退出 MP 后停止记录，重新打开继续积累。</p>
        ${(status.errors || []).map((error: Json) => `<p class="personal-error">${escape(error.path)}：${escape(error.message)}</p>`).join('')}
        ${(status.gaps || [])
          .slice(-5)
          .map(
            (gap: Json) =>
              `<p class="personal-hint">记录间断：${escape(new Date(gap.from).toLocaleString('zh-CN'))} — ${gap.to ? escape(new Date(gap.to).toLocaleString('zh-CN')) : '现在'}</p>`,
          )
          .join('')}
        <div class="personal-settings-footer"><button type="button" data-personal-action="disable">关闭记录</button><button type="button" data-personal-action="clear">删除全部个人活动记录…</button></div>
      </div></details>
    </div>`;
  }

  function mount(host: HTMLElement | null, api: Api | undefined) {
    let snapshot: Json | undefined;
    let date = dateKey();
    let query = '';
    let visible = false;
    let request = 0;
    let timer: ReturnType<typeof setInterval> | undefined;
    const feedback = (message: string) => {
      const node = host?.querySelector('.personal-feedback');
      if (node) {
        node.textContent = message;
      }
    };
    const render = () => {
      if (!host || !snapshot) {
        return;
      }
      const opened =
        host.querySelector<HTMLDetailsElement>('.personal-settings')?.open;
      host.innerHTML = markup(snapshot, date, query);
      if (opened) {
        host.querySelector<HTMLDetailsElement>('.personal-settings')!.open =
          true;
      }
    };
    const refresh = async () => {
      if (!host || !api) {
        return;
      }
      const generation = ++request;
      try {
        const result = await api.read(date);
        if (generation !== request || !visible) {
          return;
        }
        if (result.ok === false) {
          throw new Error(result.error);
        }
        snapshot = result;
        render();
      } catch (error) {
        if (generation === request) {
          if (!snapshot) {
            host.innerHTML = '<p class="personal-feedback" role="status"></p>';
          }
          feedback(String(error));
        }
      }
    };
    host?.addEventListener('input', event => {
      const target = event.target as HTMLInputElement;
      if (!target.matches('[data-personal-search]')) {
        return;
      }
      query = target.value;
      if ((event as InputEvent).isComposing) {
        return;
      }
      const cursor = target.selectionStart;
      render();
      const next = host.querySelector<HTMLInputElement>(
        '[data-personal-search]',
      );
      next?.focus();
      if (next && cursor !== null) {
        next.setSelectionRange(cursor, cursor);
      }
    });
    host?.addEventListener('change', event => {
      const target = event.target as HTMLInputElement;
      if (target.matches('[data-personal-date]')) {
        date = target.value || dateKey();
        void refresh();
        return;
      }
      const setting = target.dataset.personalSetting;
      if (setting && api) {
        target.disabled = true;
        void api
          .configure({
            [setting]:
              setting === 'screenEnabled'
                ? target.checked
                : setting === 'retentionDays'
                  ? Number(target.value)
                  : target.value,
          })
          .then(result => {
            if (result.ok === false) {
              throw new Error(result.error);
            }
            return refresh();
          })
          .catch(error => {
            render();
            feedback(String(error));
          });
      }
    });
    host?.addEventListener('click', event => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>(
        'button',
      );
      if (!button || !api || !snapshot) {
        return;
      }
      const run = async () => {
        button.disabled = true;
        let result: Json = {ok: true};
        if (
          button.dataset.personalScreen !== undefined ||
          button.dataset.personalFile !== undefined
        ) {
          result = await api.openSource({
            date,
            kind:
              button.dataset.personalScreen !== undefined ? 'screen' : 'file',
            index: Number(
              button.dataset.personalScreen ?? button.dataset.personalFile,
            ),
          });
        } else if (button.dataset.personalRemoveRoot !== undefined) {
          result = await api.configure({
            roots: (snapshot!.status.roots || []).filter(
              (_root: string, index: number) =>
                index !== Number(button.dataset.personalRemoveRoot),
            ),
          });
        } else {
          switch (button.dataset.personalAction) {
            case 'enable':
              result = await api.configure({enabled: true, paused: false});
              break;
            case 'pause':
              result = await api.configure({paused: !snapshot!.status.paused});
              break;
            case 'disable':
              result = await api.configure({enabled: false});
              break;
            case 'report':
              result = await api.generate(date);
              break;
            case 'add-root':
              result = await api.pickRoot();
              break;
            case 'clear':
              result = await api.clear();
              break;
          }
        }
        if (result.ok === false) {
          throw new Error(result.error);
        }
        await refresh();
      };
      void run().catch(error => {
        button.disabled = false;
        feedback(String(error));
      });
    });
    return {
      show() {
        visible = true;
        void refresh();
        if (!timer) {
          timer = setInterval(() => {
            if (!host?.contains(document.activeElement)) {
              void refresh();
            }
          }, 10000);
        }
      },
      hide() {
        visible = false;
        request++;
        if (timer) {
          clearInterval(timer);
        }
        timer = undefined;
      },
      refresh,
    };
  }
  const api = {markup, mount};
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  (
    globalThis as typeof globalThis & {PersonalActivityView?: typeof api}
  ).PersonalActivityView = api;
})();
