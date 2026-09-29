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

  function sourceButtons(evidence: Json[] = []): string {
    return evidence
      .filter(
        ref =>
          (ref.kind === 'screen' || ref.kind === 'file') &&
          Number.isInteger(ref.index),
      )
      .slice(0, 4)
      .map(
        ref =>
          `<button type="button" class="personal-source-link" data-personal-${ref.kind}="${ref.index}">${ref.kind === 'screen' ? '查看画面' : '打开文件'} <span aria-hidden="true">↗</span></button>`,
      )
      .join('');
  }

  function workItemLabel(item: Json): string {
    return (
      String(item.path || '')
        .split(/[\\/]/)
        .pop() || String(item.path || '未命名文件')
    );
  }

  function markup(snapshot: Json, date: string, query: string): string {
    const status = snapshot.status || {};
    const day = snapshot.day;
    const brief = snapshot.report?.brief;
    const screenpipe = snapshot.sources?.screenpipe;
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
    const segments = (day?.segments || []).filter((row: Json) =>
      matches(`${row.label} ${row.appId} ${row.windowTitle || ''}`),
    );
    const workItems = (
      day?.workItems ||
      files.map((row: Json) => ({
        ...row,
        evidence: [{kind: 'file', index: row.index, at: row.at}],
      }))
    ).filter((row: Json) => matches(`${row.path} ${row.previousPath || ''}`));
    const observations = (brief?.observations || []).filter((row: Json) =>
      matches(row.text),
    );
    const openThreads = (brief?.openThreads || []).filter((row: Json) =>
      matches(`${row.text || ''} ${row.lastInstruction || ''}`),
    );
    const totalKeys = Object.values(day?.keyboard || {}).reduce<number>(
      (total, value) => total + Number(value),
      0,
    );
    const recording = status.enabled && !status.paused;
    const screenpipeStates: Record<string, string> = {
      'not-recording': '本机记录未启动',
      'details-cleared': '当日明细已清理',
      'no-anchor': '没有可关联的本机画面',
      unavailable: '未连接',
      error: '读取失败',
    };
    const screenpipeLabel = !status.screenpipeEnabled
      ? '未启用'
      : screenpipe?.state === 'connected'
        ? `已连接${screenpipe.acceptedRows ? ` · 读取 ${number(screenpipe.acceptedRows)} 条文字记录` : ''}`
        : screenpipeStates[screenpipe?.state] || '未连接';
    const statusLabel = !status.enabled
      ? '尚未开启'
      : status.paused
        ? '已暂停'
        : snapshot.nativeError
          ? '部分记录不可用'
          : '正在本机记录';
    const roots = status.roots || status.watchedRoots || [];
    const dateLabel = new Date(`${date}T12:00:00`).toLocaleDateString('zh-CN', {
      month: 'long',
      day: 'numeric',
      weekday: 'long',
    });
    const segmentRows = segments
      .slice(-80)
      .reverse()
      .map((row: Json) => {
        const partial = row.coverage === 'partial';
        const interval = partial
          ? time(row.from)
          : `${time(row.from)} – ${time(row.to)}`;
        const context =
          row.windowTitle && row.windowTitle !== row.label
            ? `<p class="personal-entry-context">${escape(row.windowTitle)}</p>`
            : '';
        const duration =
          !partial && Number(row.activeMs) > 0
            ? `<span>${minutes(row.activeMs)}</span>`
            : '';
        return `<article class="personal-entry"><div class="personal-entry-time"><time>${interval}</time><span class="personal-entry-line" aria-hidden="true"></span></div><div class="personal-entry-body"><div class="personal-entry-heading"><h3>${escape(row.label || row.appId || '应用活动')}</h3>${partial ? '<span class="personal-partial">仅采样</span>' : duration}</div>${context}<div class="personal-source-links">${sourceButtons(row.evidence)}</div></div></article>`;
      })
      .join('');
    const sampledRows = screens
      .slice(-80)
      .reverse()
      .map(
        (row: Json) =>
          `<article class="personal-entry"><div class="personal-entry-time"><time>${time(row.at)}</time><span class="personal-entry-line" aria-hidden="true"></span></div><div class="personal-entry-body"><div class="personal-entry-heading"><h3>${escape(row.title || row.appId || '屏幕采样')}</h3><span class="personal-partial">仅采样</span></div><p class="personal-entry-context">${escape(row.text || (row.error ? `文字识别未完成：${row.error}` : '已保留当时的窗口画面'))}</p><div class="personal-source-links"><button type="button" class="personal-source-link" data-personal-screen="${row.index}">查看画面 <span aria-hidden="true">↗</span></button></div></div></article>`,
      )
      .join('');
    const workRows = workItems
      .slice(0, 12)
      .map(
        (item: Json) =>
          `<div class="personal-work-item"><div class="personal-work-item-top"><span>${escape(kinds[item.kind] || '文件变化')}</span><time>${time(item.at)}</time></div><strong title="${escape(item.path)}">${escape(workItemLabel(item))}</strong><small title="${escape(item.path)}">${escape(item.path)}</small><div class="personal-source-links">${sourceButtons(item.evidence)}</div></div>`,
      )
      .join('');
    return `<div class="personal-page">
      <header class="personal-header"><div><p class="personal-eyebrow">ACTIVITY JOURNAL</p><h1>工作回顾</h1><p class="personal-subtitle">从本机记录中找回做过的事、留下的文件和接下来要处理的线索。</p></div>
        <div class="personal-header-actions"><span class="personal-status" data-recording="${recording}">${statusLabel}</span><button type="button" class="personal-analyze" data-personal-action="analyze" title="使用当前模型梳理这一天的记录" ${day ? '' : 'disabled'}>分析这一天</button>
          <button type="button" data-personal-action="${status.enabled ? 'pause' : 'enable'}">${status.enabled ? (status.paused ? '继续记录' : '暂停') : '开启记录'}</button></div></header>
      <div class="personal-toolbar"><label>日期 <input type="date" data-personal-date value="${escape(date)}" max="${dateKey()}" /></label><input type="search" data-personal-search value="${escape(query)}" placeholder="搜索应用、画面或文件" aria-label="搜索当天记录" /><button type="button" data-personal-action="refresh">刷新</button></div>
      <p class="personal-feedback" role="status" aria-live="polite"></p>
      ${snapshot.nativeError || snapshot.screenError ? `<p class="personal-error" role="status">${escape(snapshot.nativeError || snapshot.screenError)}</p>` : ''}
      <div class="personal-date-line"><span>${escape(dateLabel)}</span>${day?.firstObservedAt ? `<span>记录始于 ${time(day.firstObservedAt)}</span>` : ''}${day?.detailsCleared ? '<span>早期明细已按保留设置清理</span>' : ''}</div>
      <div class="personal-columns"><main>
        <section class="personal-section personal-brief"><div class="personal-section-title"><div><p class="personal-section-kicker">TODAY'S NOTES</p><h2>值得记住的线索</h2></div><button type="button" data-personal-action="report">${brief ? '更新回顾' : '生成回顾'}</button></div>
          ${observations.length ? `<div class="personal-observations">${observations.map((row: Json) => `<div class="personal-observation"><p>${escape(row.text)}</p><div class="personal-source-links">${sourceButtons(row.evidence)}</div></div>`).join('')}</div>` : `<p class="personal-empty">${day ? '这一天还没有可核对的小结。可查看下方的原始记录，或生成一次回顾。' : '这一天没有记录。开启后会从当前时刻开始积累。'}</p>`}
          ${snapshot.report?.markdown ? `<details class="personal-report-details" data-personal-details="report"><summary>查看完整日报</summary><pre class="personal-report">${escape(snapshot.report.markdown)}</pre></details>` : ''}</section>
        <section class="personal-section personal-timeline"><div class="personal-section-title"><div><p class="personal-section-kicker">RECORDED ACTIVITY</p><h2>${segments.length ? '工作片段' : '记录线索'}</h2></div><span>${segments.length ? `${number(segments.length)} 段` : `${number(screens.length)} 个画面样本`}</span></div>
          <p class="personal-section-description">${segments.length ? '按实际应用活跃区间排列；仅有屏幕采样的旧记录会单独标明。' : '按采样时刻排列。屏幕样本无法说明两次记录之间的活动。'}</p>
          <div class="personal-entry-list">${segmentRows || sampledRows || `<p class="personal-empty">${needle ? '没有匹配的工作记录。' : '目前没有可展示的活动片段。'}</p>`}</div>${segments.length > 80 || (!segments.length && screens.length > 80) ? '<p class="personal-hint">显示最近 80 条，可搜索当天全部记录。</p>' : ''}</section>
        <details class="personal-section personal-record-details" data-personal-details="records"><summary>原始记录与统计 <span>${number(files.length)} 次文件变化 · ${number(screens.length)} 个画面样本</span></summary><div class="personal-record-content"><div class="personal-section-title"><h3>文件变化</h3></div>
          <div class="personal-file-list">${
            files
              .slice(-100)
              .reverse()
              .map(
                (row: Json) =>
                  `<button type="button" class="personal-file-row" data-personal-file="${row.index}"><time>${time(row.at)}</time><span class="personal-file-kind">${kinds[row.kind] || '变化'}</span><span title="${escape(row.path)}">${escape(row.path)}${row.previousPath ? `<small>从 ${escape(row.previousPath)}</small>` : ''}</span></button>`,
              )
              .join('') || '<p class="personal-empty">没有匹配的文件变化。</p>'
          }</div>${files.length > 100 ? '<p class="personal-hint">显示最近 100 条，可搜索当天全部记录。</p>' : ''}<div class="personal-section-title"><h3>屏幕样本</h3></div><div class="personal-screen-list">${
            screens
              .slice(-60)
              .reverse()
              .map(
                (row: Json) =>
                  `<button type="button" class="personal-screen-row" data-personal-screen="${row.index}"><time>${time(row.at)}</time><span><strong>${escape(row.title || row.appId)}</strong><span>${escape(row.text || (row.error ? `文字识别未完成：${row.error}` : '已保留当时的窗口画面'))}</span></span><span aria-hidden="true">↗</span></button>`,
              )
              .join('') || '<p class="personal-empty">没有匹配的屏幕片段。</p>'
          }</div>${screens.length > 60 ? '<p class="personal-hint">显示最近 60 个片段，可搜索当天全部文字。</p>' : ''}
          <div class="personal-measures"><div><span>电脑活跃</span><strong>${minutes(day?.coverage?.activeMs)}</strong></div><div><span>按键次数</span><strong>${number(totalKeys)}</strong></div><div><span>屏幕样本</span><strong>${number(day?.screenCount ?? day?.screens?.length)}</strong></div></div>
          <h3>使用过的应用</h3><dl class="personal-app-list">${
            (day?.applications || [])
              .slice(0, 12)
              .map(
                (row: Json) =>
                  `<div><dt>${escape(row.label || row.appId)}</dt><dd>${minutes(row.activeMs)}</dd></div>`,
              )
              .join('') || '<p class="personal-empty">还没有应用活动。</p>'
          }</dl>
          <h3>按键明细</h3><dl class="personal-key-list">${
            Object.entries(day?.keyboard || {})
              .sort((a, b) => Number(b[1]) - Number(a[1]))
              .map(
                ([key, value]) =>
                  `<div><dt><kbd>${escape(key)}</kbd></dt><dd>${number(value)}</dd></div>`,
              )
              .join('') || '<p class="personal-empty">还没有按键记录。</p>'
          }</dl></div></details>
      </main><aside>
        <section class="personal-section personal-next"><p class="personal-section-kicker">PICK UP</p><h2>接着处理</h2>${
          openThreads.length
            ? `<div class="personal-thread-list">${openThreads
                .slice(0, 6)
                .map(
                  (row: Json) =>
                    `<div class="personal-thread"><p>${escape(row.text || row.lastInstruction || row.outcome || '未完成的任务')}</p>${row.outcome && row.text ? `<small>${escape(row.outcome)}</small>` : ''}<div class="personal-source-links">${row.conversationId ? `<button type="button" class="personal-source-link" data-personal-conversation="${escape(row.conversationId)}">继续对话 <span aria-hidden="true">↗</span></button>` : sourceButtons(row.evidence)}</div></div>`,
                )
                .join('')}</div>`
            : '<p class="personal-empty">这一天没有可继续的任务线索。</p>'
        }</section>
        <section class="personal-section personal-work"><p class="personal-section-kicker">FILES</p><h2>碰过的文件</h2>${workRows || '<p class="personal-empty">没有匹配的文件记录。</p>'}${workItems.length > 12 ? '<p class="personal-hint">显示最近 12 个文件，可在原始记录中查看全部。</p>' : ''}</section>
        <section class="personal-section personal-coverage"><p class="personal-section-kicker">COVERAGE</p><h2>记录范围</h2><p>${day?.firstObservedAt && day?.lastObservedAt ? `${time(day.firstObservedAt)} – ${time(day.lastObservedAt)} 有本机记录。` : '当天没有可确认的记录时段。'}${escape(brief?.coverageNote || '')}</p><p class="personal-external-source">Screenpipe 补充：${screenpipeLabel}</p>${(
          status.gaps || []
        )
          .slice(-3)
          .map(
            (gap: Json) =>
              `<p class="personal-gap">间断 ${time(gap.from)} – ${gap.to ? time(gap.to) : '现在'}</p>`,
          )
          .join('')}</section>
      </aside></div>
      <details class="personal-settings" data-personal-details="settings"><summary>记录设置与覆盖范围</summary><div class="personal-settings-content">
        <label class="personal-setting-row"><span>记录屏幕与可搜索文字</span><input type="checkbox" data-personal-setting="screenEnabled" ${status.screenEnabled ? 'checked' : ''} /></label>
        <label class="personal-setting-row"><span>补充 Screenpipe 记录 <small>只读取已有本机服务，不会启动它</small></span><input type="checkbox" data-personal-setting="screenpipeEnabled" ${status.screenpipeEnabled ? 'checked' : ''} /></label>
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
      const opened = Array.from(
        host.querySelectorAll<HTMLDetailsElement>(
          'details[open][data-personal-details]',
        ),
        details => details.dataset.personalDetails,
      );
      host.innerHTML = markup(snapshot, date, query);
      host
        .querySelectorAll<HTMLDetailsElement>('details[data-personal-details]')
        .forEach(details => {
          details.open = opened.includes(details.dataset.personalDetails);
        });
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
              setting === 'screenEnabled' || setting === 'screenpipeEnabled'
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
        if (button.dataset.personalConversation) {
          host.dispatchEvent(
            new CustomEvent('personal-activity-open-conversation', {
              bubbles: true,
              detail: {conversationId: button.dataset.personalConversation},
            }),
          );
          button.disabled = false;
          return;
        } else if (button.dataset.personalAction === 'analyze') {
          host.dispatchEvent(
            new CustomEvent('personal-activity-analyze', {
              bubbles: true,
              detail: {date},
            }),
          );
          button.disabled = false;
          return;
        } else if (
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
