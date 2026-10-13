interface DashboardChartMeta {
  chartId: string;
  title: string;
  type: 'kpi' | 'line' | 'table';
  format?: 'money' | 'number' | 'percent';
  currency?: string;
  columns?: Array<{format?: 'money' | 'number' | 'percent'; currency?: string}>;
}
interface DashboardViewCallbacks {
  onShare(): void;
  onClose(): void;
  onInspect(chartId: string, traceId: string): void;
  onRefresh?(): void;
  onEdit?(): void;
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
  charts: Array<{
    chartId: string;
    queryText: string;
    error?: string;
    warnings?: string[];
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

function dashboardFormat(
  value: number | null,
  format?: DashboardChartMeta['format'],
  currency = 'USD',
): string {
  if (value === null || !Number.isFinite(value)) {
    return '—';
  }
  if (format === 'percent') {
    return `${value.toLocaleString(getStudioLanguage(), {maximumFractionDigits: 2})}%`;
  }
  return new Intl.NumberFormat(
    getStudioLanguage(),
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

function dashboardDelta(current: number | null, prior: number | null): string {
  if (current === null || prior === null || prior === 0) {
    return '';
  }
  const percent = ((current - prior) / Math.abs(prior)) * 100;
  return studioT('dashboard.delta', {
    percent: `${percent > 0 ? '+' : ''}${percent.toFixed(1)}`,
  });
}

interface DashboardSeries {
  label: string;
  points: Array<{x: string; y: number | null; traceId?: string}>;
}

function splitLineSeries(groups: DashboardViewGroup[]): DashboardSeries[] {
  const series = new Map<string, DashboardSeries['points']>();
  for (const group of groups) {
    const [x, label = ''] = group.dimensions;
    const points = series.get(label) ?? [];
    points.push({x, y: group.total.value, traceId: group.total.trace.traceId});
    series.set(label, points);
  }
  return [...series].map(([label, points]) => ({
    label,
    points: points.sort((a, b) => a.x.localeCompare(b.x)),
  }));
}

function dashboardLineSvg(
  series: DashboardSeries[],
  meta: DashboardChartMeta,
): string {
  const colors = ['#2563eb', '#16a34a', '#ea580c', '#7c3aed', '#0891b2'];
  const points = series
    .flatMap(item => item.points)
    .filter(point => point.y !== null);
  if (!points.length) {
    return `<p class="mp-dash-note">${studioT('dashboard.no_query_values')}</p>`;
  }
  const width = 720;
  const height = 280;
  const left = 76;
  const right = 18;
  const top = 16;
  const bottom = 38;
  const domain = [
    ...new Set(series.flatMap(item => item.points.map(point => point.x))),
  ].sort();
  const dateAxis = domain.every(
    value =>
      /^\d{4}-\d{2}-\d{2}/.test(value) && Number.isFinite(Date.parse(value)),
  );
  const coordinates = domain.map((value, index) =>
    dateAxis ? Date.parse(value) : index,
  );
  const first = coordinates[0];
  const last = coordinates.at(-1)!;
  const positions = new Map(
    domain.map((value, index) => [
      value,
      first === last
        ? left + (width - left - right) / 2
        : left +
          ((coordinates[index] - first) / (last - first)) *
            (width - left - right),
    ]),
  );
  const values = points.map(point => point.y!);
  const low = Math.min(0, ...values);
  const high = Math.max(0, ...values);
  const span = high - low || 1;
  const maximum = high + span * 0.08;
  const minimum = low < 0 ? low - span * 0.08 : 0;
  const y = (value: number) =>
    top + ((maximum - value) / (maximum - minimum)) * (height - top - bottom);
  let svg = `<svg viewBox="0 0 ${width} ${height}" class="mp-dash-line" role="img" aria-label="${dashboardEscape(meta.title)}">`;
  for (let index = 0; index <= 4; index += 1) {
    const value = minimum + ((maximum - minimum) * index) / 4;
    svg += `<line x1="${left}" y1="${y(value)}" x2="${width - right}" y2="${y(value)}" class="mp-dash-grid"/><text x="${left - 8}" y="${y(value) + 4}" class="mp-dash-axis" text-anchor="end">${dashboardEscape(dashboardFormat(value, meta.format, meta.currency))}</text>`;
  }
  const step = Math.max(1, Math.ceil(domain.length / 7));
  domain.forEach((value, index) => {
    if (index % step && index !== domain.length - 1) {
      return;
    }
    const label = dateAxis ? value.slice(5, 10) : value;
    svg += `<text x="${positions.get(value)}" y="${height - 10}" class="mp-dash-axis" text-anchor="${index === 0 ? 'start' : index === domain.length - 1 ? 'end' : 'middle'}">${dashboardEscape(label)}</text>`;
  });
  series.forEach((item, index) => {
    const color = colors[index % colors.length];
    let connected = false;
    const segments = item.points
      .map(point => {
        if (point.y === null) {
          connected = false;
          return '';
        }
        const command = `${connected ? 'L' : 'M'}${positions.get(point.x)},${y(point.y)}`;
        connected = true;
        return command;
      })
      .join(' ');
    svg += `<path d="${segments}" fill="none" stroke="${color}" stroke-width="2"/>`;
    for (const point of item.points) {
      if (point.y === null) {
        continue;
      }
      svg += `<circle cx="${positions.get(point.x)}" cy="${y(point.y)}" r="4" fill="${color}" data-dash-x="${dashboardEscape(point.x)}" data-dash-series="${dashboardEscape(item.label)}" ${point.traceId ? `data-dash-trace="${dashboardEscape(point.traceId)}" tabindex="0" role="button" aria-label="${dashboardEscape(`${item.label} ${point.x}: ${dashboardFormat(point.y, meta.format, meta.currency)}. ${studioT('dashboard.view_rows')}.`)}"` : ''}><title>${dashboardEscape(`${item.label} ${point.x}: ${dashboardFormat(point.y, meta.format, meta.currency)}`)}</title></circle>`;
    }
  });
  svg += '</svg><div class="mp-dash-legend">';
  series.forEach((item, index) => {
    const lastPoint = item.points.filter(point => point.y !== null).at(-1);
    svg += `<span><i style="background:${colors[index % colors.length]}"></i>${dashboardEscape(item.label || meta.title)}${lastPoint ? ` · ${dashboardEscape(dashboardFormat(lastPoint.y, meta.format, meta.currency))}` : ''}</span>`;
  });
  return svg + '</div>';
}

function dashboardNumber(
  value: DashboardViewNumber | null | undefined,
  meta: {format?: DashboardChartMeta['format']; currency?: string},
): string {
  const label = dashboardEscape(
    dashboardFormat(value?.value ?? null, meta.format, meta.currency),
  );
  return value?.trace.traceId
    ? `<button type="button" class="mp-dash-value-button" data-dash-trace="${dashboardEscape(value.trace.traceId)}" title="${studioT('dashboard.view_rows')}">${label}</button>`
    : label;
}

function renderDashboard(
  container: HTMLElement,
  title: string,
  snapshot: DashboardViewSnapshot,
  metas: DashboardChartMeta[],
  callbacks: DashboardViewCallbacks,
): void {
  const byId = new Map(metas.map(meta => [meta.chartId, meta]));
  const updated = new Date(snapshot.generatedAt).toLocaleString(
    getStudioLanguage(),
  );
  let html = `<header class="mp-dash-head"><strong class="mp-dash-title">${dashboardEscape(title)}</strong><div class="mp-dash-head-right"><span class="mp-dash-updated">${dashboardEscape(studioT('dashboard.updated', {time: updated}))}</span>${callbacks.onRefresh ? `<button type="button" data-dash-act="refresh">${studioT('dashboard.refresh')}</button>` : ''}${callbacks.onEdit ? `<button type="button" data-dash-act="edit">${studioT('dashboard.edit')}</button>` : ''}<button type="button" data-dash-act="share">${studioT('dashboard.export_html')}</button><button type="button" data-dash-act="close" aria-label="${studioT('common.close')}">×</button></div></header><div class="mp-dash-body">`;
  const card = (chart: DashboardViewSnapshot['charts'][number]): string => {
    const meta = byId.get(chart.chartId);
    if (!meta) {
      return '';
    }
    let body = `<article class="${meta.type === 'kpi' ? 'mp-dash-kpi' : 'mp-dash-card'}" data-dash-chart="${dashboardEscape(chart.chartId)}"><h2 class="mp-dash-card-title">${dashboardEscape(meta.title)}</h2>`;
    if (chart.error) {
      body += `<p class="mp-dash-error">${dashboardEscape(chart.error)}</p>`;
    } else if (meta.type === 'kpi') {
      const current = chart.current?.value ?? null;
      const prior = chart.prior?.value ?? null;
      const delta = dashboardDelta(current, prior);
      body += `<div class="mp-dash-kpi-value">${dashboardNumber(chart.current, meta)}</div>`;
      if (delta) {
        body += `<div class="mp-dash-delta ${current! >= prior! ? 'up' : 'down'}">${dashboardEscape(delta)}</div>`;
      }
      if (chart.prior) {
        body += `<small>${studioT('dashboard.prior')}: ${dashboardNumber(chart.prior, meta)}</small>`;
      }
      if (current === null) {
        body += `<p class="mp-dash-note">${studioT('dashboard.no_values')}</p>`;
      }
    } else if (meta.type === 'line') {
      body += dashboardLineSvg(splitLineSeries(chart.groups), meta);
    } else if (chart.table) {
      body += `<div class="mp-dash-table-scroll"><table class="mp-dash-table"><thead><tr>${chart.table.columns.map(column => `<th>${dashboardEscape(column)}</th>`).join('')}</tr></thead><tbody>`;
      for (const row of chart.table.rows) {
        body += `<tr><th scope="row">${dashboardEscape(row.key)}</th>${row.cells.map((value, index) => `<td>${dashboardNumber(value, index === 0 ? meta : (meta.columns?.[index - 1] ?? {}))}</td>`).join('')}</tr>`;
      }
      body += '</tbody></table></div>';
    }
    if (chart.warnings?.length) {
      body += `<details class="mp-dash-note"><summary>Data notes (${chart.warnings.length})</summary><ul>${chart.warnings.map(warning => `<li>${dashboardEscape(warning)}</li>`).join('')}</ul></details>`;
    }
    return (
      body +
      `<details class="mp-dash-query"><summary>${studioT('dashboard.query')}</summary><code>${dashboardEscape(chart.queryText)}</code></details></article>`
    );
  };
  const kpis = snapshot.charts.filter(
    chart => byId.get(chart.chartId)?.type === 'kpi',
  );
  if (kpis.length) {
    html += `<div class="mp-dash-kpis">${kpis.map(card).join('')}</div>`;
  }
  html +=
    snapshot.charts
      .filter(chart => byId.get(chart.chartId)?.type !== 'kpi')
      .map(card)
      .join('') + '</div>';
  container.innerHTML = html;
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
    .querySelectorAll<HTMLElement | SVGElement>('[data-dash-trace]')
    .forEach(element => {
      const inspect = () =>
        callbacks.onInspect(
          element.closest<HTMLElement>('[data-dash-chart]')?.dataset
            .dashChart || '',
          element.dataset.dashTrace || '',
        );
      element.addEventListener('click', inspect);
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
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {renderDashboard, dashboardLineSvg, dashboardFormat};
}
