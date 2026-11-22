interface DashboardChartMeta {
  chartId: string;
  title: string;
  type:
    | 'kpi'
    | 'line'
    | 'area'
    | 'stacked_area'
    | 'bar'
    | 'stacked_bar'
    | 'scatter'
    | 'heatmap'
    | 'pie'
    | 'donut'
    | 'table';
  format?: 'money' | 'number' | 'percent';
  currency?: string;
  xField?: string;
  yField?: string;
  seriesField?: string;
  ghostSeries?: string;
  orientation?: 'vertical' | 'horizontal';
  watch?: {target?: number; min?: number; max?: number; label?: string};
  columns?: Array<{format?: 'money' | 'number' | 'percent'; currency?: string}>;
}
interface DashboardViewCallbacks {
  onShare(): void;
  onClose(): void;
  onInspect(chartId: string, traceId: string): void;
  onRefresh?(): void;
  onEdit?(): void;
  onQueryRun?(chartId: string, querySql: string): Promise<void> | void;
  onAskAgent?(prompt: string, chartId?: string): void;
  onUndo?(): void;
  onRemix?(format: 'design_canvas' | 'markdown_memo' | 'slides'): void;
  onExportChartCsv?(chartId: string): void;
  onExportPng?(chartId?: string): void;
  embed?: boolean;
}
interface DashboardViewNumber {
  value: number | null;
  trace: {traceId?: string; excludedCount?: number};
}
interface DashboardViewGroup {
  key: string;
  dimensions: string[];
  total: DashboardViewNumber;
}
interface DashboardViewSnapshot {
  generatedAt: string;
  trustBadge?: 'verified_file' | 'workspace_sql' | 'inline_static';
  diagnostics?: Array<{
    code: string;
    message: string;
    severity: 'warning' | 'error';
  }>;
  charts: Array<{
    chartId: string;
    queryText: string;
    error?: string;
    errorCode?: string;
    warnings?: string[];
    diagnostics?: Array<{
      code: string;
      message: string;
      severity: 'warning' | 'error';
    }>;
    trustBadge?: string;
    groups: DashboardViewGroup[];
    current?: DashboardViewNumber;
    prior?: DashboardViewNumber;
    table?: {
      columns: string[];
      rows: Array<{key: string; cells: Array<DashboardViewNumber | null>}>;
    };
  }>;
}

declare global {
  function renderDashboard(
    container: HTMLElement,
    title: string,
    snapshot: DashboardViewSnapshot,
    metas: DashboardChartMeta[],
    callbacks: DashboardViewCallbacks,
  ): void;
}

function dashboardEscape(value: unknown): string {
  return String(value ?? '').replace(
    /[&<>"']/g,
    char =>
      ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[
        char
      ]!,
  );
}

function dashboardLang(): string {
  return typeof getStudioLanguage === 'function' ? getStudioLanguage() : 'en';
}

function dashboardT(
  key: string,
  fallback: string,
  params?: Record<string, string | number>,
): string {
  if (typeof studioT === 'function') {
    return studioT(key, params);
  }
  return fallback;
}

function dashboardFormat(
  value: number | null,
  format?: DashboardChartMeta['format'],
  currency = 'USD',
): string {
  if (value === null || !Number.isFinite(value)) {
    return '—';
  }
  if (format === 'percent') {
    return `${value.toLocaleString(dashboardLang(), {maximumFractionDigits: 2})}%`;
  }
  return new Intl.NumberFormat(
    dashboardLang(),
    format === 'money'
      ? {
          style: 'currency',
          currency,
          maximumFractionDigits: 2,
          notation: Math.abs(value) >= 1000000 ? 'compact' : 'standard',
        }
      : {maximumFractionDigits: 2},
  ).format(value);
}

function dashboardLineSvg(
  series: Array<{
    label: string;
    points: Array<{x: string; y: number | null; traceId?: string}>;
  }>,
  meta: DashboardChartMeta,
): string {
  const groups: DashboardViewGroup[] = [];
  for (const s of series) {
    for (const p of s.points) {
      groups.push({
        key: s.label ? JSON.stringify([p.x, s.label]) : p.x,
        dimensions: s.label ? [p.x, s.label] : [p.x],
        total: {value: p.y, trace: {traceId: p.traceId}},
      });
    }
  }
  if (globalThis.DashboardCharts) {
    return globalThis.DashboardCharts.renderChart(
      {chartId: meta.chartId, queryText: '', groups},
      meta,
    );
  }
  return `<p class="mp-dash-note">${dashboardEscape(meta.title)}</p>`;
}

function trustBadgeLabel(badge?: string): string {
  if (badge === 'workspace_sql') {
    return 'Workspace SQL';
  }
  if (badge === 'inline_static') {
    return 'Inline Sample';
  }
  return 'Verified File';
}

function exportChartAsCsv(
  chart: DashboardViewSnapshot['charts'][number],
  meta: {title: string},
): string {
  const quote = (v: unknown) => `"${String(v ?? '').replaceAll('"', '""')}"`;
  if (chart.table) {
    const lines = [
      chart.table.columns.map(quote).join(','),
      ...chart.table.rows.map(r =>
        [r.key, ...r.cells.map(c => c?.value ?? '')].map(quote).join(','),
      ),
    ];
    return `\uFEFF${lines.join('\r\n')}\r\n`;
  }
  if (chart.groups.length) {
    const lines = [
      ['Dimension', 'Series', meta.title].map(quote).join(','),
      ...chart.groups.map(g =>
        [g.dimensions[0] ?? '', g.dimensions[1] ?? '', g.total.value ?? '']
          .map(quote)
          .join(','),
      ),
    ];
    return `\uFEFF${lines.join('\r\n')}\r\n`;
  }
  return `\uFEFF${quote(meta.title)},${quote(chart.current?.value ?? '')}\r\n`;
}

function renderDashboard(
  container: HTMLElement,
  title: string,
  snapshot: DashboardViewSnapshot,
  metas: DashboardChartMeta[],
  callbacks: DashboardViewCallbacks,
): void {
  const store = globalThis.DashboardStore
    ? globalThis.DashboardStore.createDashboardStore(snapshot, metas)
    : null;
  const tableStates = new Map<
    string,
    {search?: string; sortCol?: number; sortDir?: 1 | -1; page?: number}
  >();
  const openInspectors = new Set<string>();

  const renderNow = () => {
    const state = store
      ? store.getState()
      : {
          snapshot,
          metas,
          activeFilters: [] as Array<{
            field: string;
            op: 'eq' | 'in' | 'gte' | 'lte';
            values: Array<string | number>;
          }>,
          hoveredX: null as string | null,
          hiddenSeries: new Map<string, Set<string>>(),
          canUndo: false,
          canRedo: false,
        };
    const filteredSnapshot =
      store && state.activeFilters.length
        ? globalThis.DashboardStore.filterSnapshot(
            state.snapshot,
            state.activeFilters,
          )
        : state.snapshot;
    const byId = new Map(state.metas.map(meta => [meta.chartId, meta]));
    const updated = new Date(filteredSnapshot.generatedAt).toLocaleString(
      dashboardLang(),
    );
    const embedClass = callbacks.embed ? ' mp-dash-embed' : '';
    const trust = filteredSnapshot.trustBadge || 'verified_file';

    let html = `<div class="mp-dash-shell${embedClass}">`;
    html += `<header class="mp-dash-head"><div class="mp-dash-head-left"><strong class="mp-dash-title">${dashboardEscape(title)}</strong><span class="mp-dash-trust mp-dash-trust-${dashboardEscape(trust)}">${dashboardEscape(trustBadgeLabel(trust))}</span></div><div class="mp-dash-head-right"><span class="mp-dash-updated">${dashboardEscape(dashboardT('dashboard.updated', `Updated ${updated}`, {time: updated}))}</span>`;
    if (callbacks.onRefresh) {
      html += `<button type="button" data-dash-act="refresh">${dashboardT('dashboard.refresh', 'Refresh')}</button>`;
    }
    if (state.canUndo || callbacks.onUndo) {
      html += `<button type="button" data-dash-act="undo" ${!state.canUndo && !callbacks.onUndo ? 'disabled' : ''}>Undo</button>`;
    }
    if (callbacks.onRemix) {
      html += `<select class="mp-dash-remix-select" data-dash-remix aria-label="Remix dashboard"><option value="">Remix…</option><option value="design_canvas">Design Canvas</option><option value="markdown_memo">Markdown Memo</option><option value="slides">Slides</option></select>`;
    }
    if (callbacks.onEdit) {
      html += `<button type="button" data-dash-act="edit">${dashboardT('dashboard.edit', 'Edit')}</button>`;
    }
    html += `<button type="button" data-dash-act="share">${dashboardT('dashboard.export_html', 'Export HTML')}</button>`;
    if (!callbacks.embed) {
      html += `<button type="button" data-dash-act="close" aria-label="${dashboardT('common.close', 'Close')}">×</button>`;
    }
    html += '</div></header>';

    if (!callbacks.embed && callbacks.onAskAgent) {
      html += `<form class="mp-dash-nl-bar" data-dash-nl-form><input type="text" class="mp-dash-nl-input" data-dash-nl-input placeholder="Ask Agent to Edit… (e.g. Switch to stacked bar by region, add target watchpoint)" /><button type="submit">Apply</button></form>`;
    }

    if (state.activeFilters.length) {
      html += '<div class="mp-dash-filter-bar" data-dash-filter-bar>';
      state.activeFilters.forEach((f, idx) => {
        html += `<button type="button" class="mp-dash-filter-pill" data-dash-clear-filter="${idx}">${dashboardEscape(f.field)}: ${dashboardEscape(f.values.join(', '))} ×</button>`;
      });
      html += '<button type="button" class="mp-dash-filter-clear" data-dash-clear-all>Clear all</button></div>';
    }

    html += '<div class="mp-dash-body">';
    const card = (chart: DashboardViewSnapshot['charts'][number]): string => {
      const meta = byId.get(chart.chartId);
      if (!meta) {
        return '';
      }
      const isKpi = meta.type === 'kpi';
      const inspectorOpen = openInspectors.has(chart.chartId);
      let body = `<article class="${isKpi ? 'mp-dash-kpi' : 'mp-dash-card'}" data-dash-chart="${dashboardEscape(chart.chartId)}">`;
      body += `<div class="mp-dash-card-head"><h2 class="mp-dash-card-title">${dashboardEscape(meta.title)}</h2><div class="mp-dash-card-actions">`;
      if (chart.diagnostics?.length) {
        for (const diag of chart.diagnostics) {
          body += `<span class="mp-dash-qa-chip mp-dash-qa-${dashboardEscape(diag.severity)}" title="${dashboardEscape(diag.message)}">${dashboardEscape(diag.code)}</span>`;
        }
      }
      body += `<button type="button" class="mp-dash-mini-btn" data-dash-toggle-inspector="${dashboardEscape(chart.chartId)}" title="Query & Lineage Inspector">SQL</button>`;
      body += `<button type="button" class="mp-dash-mini-btn" data-dash-csv="${dashboardEscape(chart.chartId)}" title="Export CSV">CSV</button>`;
      body += '</div></div>';

      if (globalThis.DashboardCharts) {
        body += globalThis.DashboardCharts.renderChart(chart, meta, {
          hoveredX: state.hoveredX,
          hiddenSeries: state.hiddenSeries.get(chart.chartId),
          tableState: tableStates.get(chart.chartId),
        });
      } else if (chart.error) {
        body += `<p class="mp-dash-error">${dashboardEscape(chart.error)}</p>`;
      }

      if (chart.warnings?.length) {
        body += `<details class="mp-dash-note"><summary>Data notes (${chart.warnings.length})</summary><ul>${chart.warnings.map(w => `<li>${dashboardEscape(w)}</li>`).join('')}</ul></details>`;
      }

      if (inspectorOpen) {
        body += `<div class="mp-dash-inspector" data-dash-inspector="${dashboardEscape(chart.chartId)}"><div class="mp-dash-inspector-meta"><span>Query &amp; Lineage Inspector</span><span>${dashboardEscape(chart.trustBadge || trust)}</span></div><textarea class="mp-dash-sql-input" data-dash-sql-input="${dashboardEscape(chart.chartId)}" rows="3">${dashboardEscape(chart.queryText)}</textarea><div class="mp-dash-inspector-actions">${callbacks.onQueryRun ? `<button type="button" data-dash-run-sql="${dashboardEscape(chart.chartId)}">Run SQL</button>` : ''}<span class="mp-dash-note">Generated ${dashboardEscape(updated)}</span></div></div>`;
      } else {
        body += `<details class="mp-dash-query"><summary>${dashboardT('dashboard.query', 'Query')}</summary><code>${dashboardEscape(chart.queryText)}</code></details>`;
      }
      return `${body}</article>`;
    };

    const kpis = filteredSnapshot.charts.filter(
      chart => byId.get(chart.chartId)?.type === 'kpi',
    );
    if (kpis.length) {
      html += `<div class="mp-dash-kpis">${kpis.map(card).join('')}</div>`;
    }
    const rest = filteredSnapshot.charts.filter(
      chart => byId.get(chart.chartId)?.type !== 'kpi',
    );
    html += `<div class="mp-dash-grid">${rest.map(card).join('')}</div>`;
    html += '</div><div class="mp-dash-tooltip" data-dash-tooltip hidden></div></div>';
    container.innerHTML = html;

    // Bind header actions
    for (const [action, callback] of Object.entries({
      share: callbacks.onShare,
      close: callbacks.onClose,
      refresh: callbacks.onRefresh,
      edit: callbacks.onEdit,
    })) {
      if (callback) {
        container
          .querySelector(`[data-dash-act="${action}"]`)
          ?.addEventListener('click', callback);
      }
    }

    container
      .querySelector('[data-dash-act="undo"]')
      ?.addEventListener('click', () => {
        if (store && store.getState().canUndo) {
          store.undo();
        } else {
          callbacks.onUndo?.();
        }
      });

    container
      .querySelector<HTMLSelectElement>('[data-dash-remix]')
      ?.addEventListener('change', event => {
        const select = event.currentTarget as HTMLSelectElement;
        const val = select.value as
          | 'design_canvas'
          | 'markdown_memo'
          | 'slides'
          | '';
        if (val) {
          callbacks.onRemix?.(val);
          select.value = '';
        }
      });

    container
      .querySelector('[data-dash-nl-form]')
      ?.addEventListener('submit', event => {
        event.preventDefault();
        const input = container.querySelector<HTMLInputElement>(
          '[data-dash-nl-input]',
        );
        const prompt = input?.value.trim() || '';
        if (prompt) {
          callbacks.onAskAgent?.(prompt);
          if (input) {
            input.value = '';
          }
        }
      });

    container
      .querySelectorAll<HTMLElement>('[data-dash-clear-filter]')
      .forEach(btn => {
        btn.addEventListener('click', () => {
          store?.removeFilter(Number(btn.dataset.dashClearFilter));
        });
      });

    container
      .querySelector('[data-dash-clear-all]')
      ?.addEventListener('click', () => {
        store?.clearFilters();
      });

    container
      .querySelectorAll<HTMLElement>('[data-dash-toggle-inspector]')
      .forEach(btn => {
        btn.addEventListener('click', () => {
          const cid = btn.dataset.dashToggleInspector || '';
          if (openInspectors.has(cid)) {
            openInspectors.delete(cid);
          } else {
            openInspectors.add(cid);
          }
          renderNow();
        });
      });

    container
      .querySelectorAll<HTMLElement>('[data-dash-run-sql]')
      .forEach(btn => {
        btn.addEventListener('click', () => {
          const cid = btn.dataset.dashRunSql || '';
          const textarea = container.querySelector<HTMLTextAreaElement>(
            `[data-dash-sql-input="${cid}"]`,
          );
          if (textarea) {
            void callbacks.onQueryRun?.(cid, textarea.value);
          }
        });
      });

    container
      .querySelectorAll<HTMLElement>('[data-dash-csv]')
      .forEach(btn => {
        btn.addEventListener('click', () => {
          const cid = btn.dataset.dashCsv || '';
          if (callbacks.onExportChartCsv) {
            callbacks.onExportChartCsv(cid);
            return;
          }
          const chart = filteredSnapshot.charts.find(c => c.chartId === cid);
          const meta = byId.get(cid);
          if (chart && meta && typeof Blob !== 'undefined') {
            const csv = exportChartAsCsv(chart, meta);
            const blob = new Blob([csv], {type: 'text/csv;charset=utf-8'});
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${cid}.csv`;
            a.click();
            URL.revokeObjectURL(url);
          }
        });
      });

    container
      .querySelectorAll<HTMLElement>('[data-dash-legend]')
      .forEach(btn => {
        btn.addEventListener('click', () => {
          store?.toggleSeries(
            btn.dataset.dashLegend || '',
            btn.dataset.dashSeries || '',
          );
        });
      });

    container
      .querySelectorAll<HTMLElement>('[data-dash-filter-val]')
      .forEach(el => {
        el.addEventListener('click', event => {
          if ((event as MouseEvent).shiftKey && el.dataset.dashTrace) {
            return;
          }
          const field = el.dataset.dashFilterField || 'dimension';
          const val = el.dataset.dashFilterVal || '';
          if (store && val) {
            store.toggleFilter({field, op: 'eq', values: [val]});
          }
        });
      });

    container
      .querySelectorAll<HTMLElement>('[data-dash-sort]')
      .forEach(th => {
        th.addEventListener('click', () => {
          const [cid, colStr] = (th.dataset.dashSort || '').split(':');
          const col = Number(colStr);
          const cur = tableStates.get(cid) ?? {};
          const dir: 1 | -1 =
            cur.sortCol === col ? (cur.sortDir === -1 ? 1 : -1) : -1;
          tableStates.set(cid, {...cur, sortCol: col, sortDir: dir, page: 0});
          renderNow();
        });
      });

    container
      .querySelectorAll<HTMLInputElement>('[data-dash-table-search]')
      .forEach(input => {
        input.addEventListener('input', () => {
          const cid = input.dataset.dashTableSearch || '';
          const cur = tableStates.get(cid) ?? {};
          tableStates.set(cid, {...cur, search: input.value, page: 0});
          renderNow();
        });
      });

    container
      .querySelectorAll<HTMLElement>('[data-dash-page]')
      .forEach(btn => {
        btn.addEventListener('click', () => {
          const [cid, pageStr] = (btn.dataset.dashPage || '').split(':');
          const cur = tableStates.get(cid) ?? {};
          tableStates.set(cid, {...cur, page: Number(pageStr)});
          renderNow();
        });
      });

    const tipEl = container.querySelector<HTMLElement>('[data-dash-tooltip]');
    container
      .querySelectorAll<HTMLElement | SVGElement>('[data-dash-tip]')
      .forEach(el => {
        el.addEventListener('mouseenter', event => {
          if (tipEl) {
            tipEl.hidden = false;
            tipEl.textContent = el.getAttribute('data-dash-tip') || '';
            const me = event as MouseEvent;
            tipEl.style.left = `${me.clientX + 12}px`;
            tipEl.style.top = `${me.clientY + 12}px`;
          }
        });
        el.addEventListener('mouseleave', () => {
          if (tipEl) {
            tipEl.hidden = true;
          }
        });
      });

    container
      .querySelectorAll<HTMLElement | SVGElement>('[data-dash-trace]')
      .forEach(element => {
        const inspect = () =>
          callbacks.onInspect(
            element.closest<HTMLElement>('[data-dash-chart]')?.dataset
              .dashChart || '',
            element.dataset.dashTrace || '',
          );
        element.addEventListener('click', event => {
          if (
            element.hasAttribute('data-dash-filter-val') &&
            !(event as MouseEvent).shiftKey &&
            store
          ) {
            return;
          }
          inspect();
        });
        if (element.tagName.toLowerCase() === 'circle') {
          element.addEventListener('keydown', event => {
            if (
              (event as KeyboardEvent).key === 'Enter' ||
              (event as KeyboardEvent).key === ' '
            ) {
              event.preventDefault();
              inspect();
            }
          });
        }
      });
  };

  if (store) {
    store.subscribe(renderNow);
  }
  renderNow();
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {renderDashboard, dashboardLineSvg, dashboardFormat};
}
