/* Dashboard panel: KPI cards, SVG line charts, data tables.
 *
 * Classic browser script: exposes renderDashboard on the global scope.
 * Numbers come from a DashboardSnapshot; chart titles/types/formats ride
 * alongside in DashboardChartMeta. No chart dependency: the line chart is
 * hand-built SVG.
 */

interface DashboardChartMeta {
  chartId: string;
  title: string;
  type: 'kpi' | 'line' | 'table';
  format?: 'money' | 'number' | 'percent';
  subtitle?: string;
  columnFormats?: Array<'money' | 'number' | 'percent'>;
}

interface DashboardViewCallbacks {
  onShare: () => void;
  onClose: () => void;
  onInspect: (chartId: string, trace: string) => void;
}

declare global {
  function renderDashboard(
    container: HTMLElement,
    title: string,
    snapshot: unknown,
    metas: DashboardChartMeta[],
    callbacks: DashboardViewCallbacks,
  ): void;
}

function dashboardRelTime(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) {
    return 'just now';
  }
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) {
    return 'just now';
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  return `${Math.floor(hours / 24)}d ago`;
}

function dashboardFormat(
  value: number,
  format: 'money' | 'number' | 'percent' | undefined,
): string {
  if (format === 'percent') {
    return `${value.toFixed(2)}%`;
  }
  if (format === 'money') {
    const abs = Math.abs(value);
    if (abs >= 1000000) {
      return `$${(value / 1000000).toFixed(1)}M`;
    }
    if (abs >= 1000) {
      return `$${(value / 1000).toFixed(1)}K`;
    }
    return `$${value.toFixed(2)}`;
  }
  return value.toLocaleString('en-US', {maximumFractionDigits: 2});
}

function dashboardDelta(current: number, prior: number): string {
  if (!Number.isFinite(prior) || prior === 0) {
    return '';
  }
  const pct = ((current - prior) / Math.abs(prior)) * 100;
  const sign = pct > 0 ? '+' : '';
  return `${sign}${pct.toFixed(1)}% vs prior period`;
}

function dashboardLineSvg(
  series: Array<{label: string; points: Array<{x: string; y: number}>}>,
  colors: string[],
): string {
  const width = 720;
  const height = 260;
  const padLeft = 44;
  const padBottom = 24;
  const padTop = 8;
  const padRight = 8;
  const all = series.flatMap(s => s.points.map(p => p.y));
  const max = Math.max(...all, 0);
  const top = max === 0 ? 1 : max * 1.1;
  const innerW = width - padLeft - padRight;
  const innerH = height - padTop - padBottom;
  const n = Math.max(...series.map(s => s.points.length), 1);
  const pos = (i: number): number =>
    n === 1 ? padLeft : padLeft + (i / (n - 1)) * innerW;
  const val = (y: number): number =>
    padTop + innerH - (y / top) * innerH;
  let out = `<svg viewBox="0 0 ${width} ${height}" class="mp-dash-line" role="img">`;
  for (let g = 0; g <= 4; g++) {
    const y = padTop + (innerH / 4) * g;
    const label = top * (1 - g / 4);
    const text =
      label >= 1000 ? `$${(label / 1000).toFixed(1)}k` : `$${label.toFixed(1)}`;
    out += `<line x1="${padLeft}" y1="${y}" x2="${width - padRight}" y2="${y}" class="mp-dash-grid"/>`;
    out += `<text x="${padLeft - 6}" y="${y + 4}" class="mp-dash-axis" text-anchor="end">${text}</text>`;
  }
  const step = Math.max(1, Math.floor(n / 7));
  const endLabels: Array<{y: number; color: string; text: string}> = [];
  series.forEach((s, si) => {
    const color = colors[si % colors.length];
    const d = s.points
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${pos(i).toFixed(1)},${val(p.y).toFixed(1)}`)
      .join(' ');
    out += `<path d="${d}" fill="none" stroke="${color}" stroke-width="2"/>`;
    s.points.forEach((p, i) => {
      out += `<circle cx="${pos(i).toFixed(1)}" cy="${val(p.y).toFixed(1)}" r="2.5" fill="${color}"><title>${s.label} ${p.x}: ${p.y.toLocaleString('en-US')}</title></circle>`;
    });
    const last = s.points[s.points.length - 1];
    if (last) {
      endLabels.push({
        y: val(last.y),
        color,
        text: `${s.label} ${last.y.toLocaleString('en-US', {maximumFractionDigits: 2})}`,
      });
    }
    s.points.forEach((p, i) => {
      const isLast = i === n - 1;
      if (i % step === 0 || isLast) {
        const short = p.x.length > 6 ? p.x.slice(5).replace('-', ' ') : p.x;
        const anchor = isLast ? 'end' : 'middle';
        const tx = isLast ? width - padRight : pos(i).toFixed(1);
        out += `<text x="${tx}" y="${height - 6}" class="mp-dash-axis" text-anchor="${anchor}">${short}</text>`;
      }
    });
  });
  endLabels.sort((a, b) => a.y - b.y);
  for (let i = 1; i < endLabels.length; i++) {
    if (endLabels[i].y - endLabels[i - 1].y < 14) {
      endLabels[i].y = endLabels[i - 1].y + 14;
    }
  }
  for (const label of endLabels) {
    out += `<text x="${width - padRight}" y="${label.y.toFixed(1)}" class="mp-dash-series" fill="${label.color}" text-anchor="end">${label.text}</text>`;
  }
  return out + '</svg>';
}

function renderDashboard(
  container: HTMLElement,
  title: string,
  snapshot: {
    generatedAt: string;
    charts: Array<{
      chartId: string;
      queryText: string;
      formula: string;
      groups: Array<{
        key: string;
        total: {value: number; trace: {sourceId: string; rowIndexes: number[]; formula: string}};
      }>;
      current?: {value: number; trace: {sourceId: string; rowIndexes: number[]; formula: string}};
      prior?: {value: number; trace: {sourceId: string; rowIndexes: number[]; formula: string}};
      table?: {columns: string[]; rows: Array<{key: string; cells: Array<{value: number; trace: {sourceId: string; rowIndexes: number[]; formula: string}}>}>};
    }>;
  },
  metas: DashboardChartMeta[],
  callbacks: DashboardViewCallbacks,
): void {
  const metaById = new Map(metas.map(m => [m.chartId, m]));
  const colors = ['#2563eb', '#16a34a', '#ea580c', '#7c3aed', '#0891b2'];
  let html = `<div class="mp-dash-head"><div class="mp-dash-title">${title}</div>`;
  html += `<div class="mp-dash-head-right"><span class="mp-dash-updated">Updated ${dashboardRelTime(snapshot.generatedAt)}</span>`;
  html += `<button class="mp-dash-share" data-dash-act="share">Share</button>`;
  html += `<button class="mp-dash-close" data-dash-act="close" aria-label="Close">×</button></div></div>`;
  html += '<div class="mp-dash-body">';
  const kpis = snapshot.charts.filter(c => metaById.get(c.chartId)?.type === 'kpi');
  if (kpis.length) {
    html += '<div class="mp-dash-kpis">';
    for (const chart of kpis) {
      const meta = metaById.get(chart.chartId);
      const cur = chart.current?.value ?? 0;
      const pri = chart.prior?.value ?? 0;
      const delta = dashboardDelta(cur, pri);
      const up = cur >= pri;
      const trace = chart.current?.trace;
      html += `<div class="mp-dash-kpi" data-dash-chart="${chart.chartId}">`;
      html += `<div class="mp-dash-kpi-title">${meta?.title ?? ''}</div>`;
      html += `<div class="mp-dash-kpi-value" data-dash-trace="${trace ? `${trace.sourceId}:${trace.rowIndexes.length}` : ''}">${dashboardFormat(cur, meta?.format)}</div>`;
      if (delta) {
        html += `<div class="mp-dash-delta ${up ? 'up' : 'down'}">${delta}</div>`;
      }
      html += `<details class="mp-dash-query"><summary>Query</summary><code>${chart.queryText}</code><div>${chart.formula}</div></details></div>`;
    }
    html += '</div>';
  }
  for (const chart of snapshot.charts) {
    const meta = metaById.get(chart.chartId);
    if (!meta || meta.type === 'kpi') {
      continue;
    }
    html += `<div class="mp-dash-card" data-dash-chart="${chart.chartId}">`;
    html += `<div class="mp-dash-card-title">${meta.title}</div>`;
    if (meta.subtitle) {
      html += `<div class="mp-dash-card-sub">${meta.subtitle}</div>`;
    }
    if (meta.type === 'line') {
      const seriesColors = colors.slice();
      const series = splitLineSeries(chart.groups);
      html += dashboardLineSvg(series, seriesColors);
    } else if (meta.type === 'table' && chart.table) {
      html += '<table class="mp-dash-table"><thead><tr>';
      for (const col of chart.table.columns) {
        html += `<th>${col}</th>`;
      }
      html += '</tr></thead><tbody>';
      for (const row of chart.table.rows) {
        html += `<tr><td>${row.key}</td>`;
        row.cells.forEach((cell, ci) => {
          const fmt = meta.columnFormats?.[ci + 1] ?? (ci === 0 ? meta.format : undefined) ?? 'number';
          html += `<td data-dash-trace="${cell.trace.sourceId}:${cell.trace.rowIndexes.length}">${dashboardFormat(cell.value, fmt)}</td>`;
        });
        html += '</tr>';
      }
      html += '</tbody></table>';
    }
    html += `<details class="mp-dash-query"><summary>Query</summary><code>${chart.queryText}</code><div>${chart.formula}</div></details></div>`;
  }
  html += '</div>';
  container.innerHTML = html;
  container.querySelector('[data-dash-act="share"]')?.addEventListener('click', () => callbacks.onShare());
  container.querySelector('[data-dash-act="close"]')?.addEventListener('click', () => callbacks.onClose());
  container.querySelectorAll('[data-dash-trace]').forEach(el => {
    el.addEventListener('click', () => {
      const card = (el.closest('[data-dash-chart]') as HTMLElement | null)?.dataset.dashChart ?? '';
      callbacks.onInspect(card, String((el as HTMLElement).dataset.dashTrace ?? ''));
    });
  });
}

/** Split flat day-channel groups ("2026-10-01|Search") into chart series. */
function splitLineSeries(
  groups: Array<{key: string; total: {value: number}}>,
): Array<{label: string; points: Array<{x: string; y: number}>}> {
  const byLabel = new Map<string, Array<{x: string; y: number}>>();
  for (const group of groups) {
    const pipe = group.key.indexOf('|');
    const x = pipe >= 0 ? group.key.slice(0, pipe) : group.key;
    const label = pipe >= 0 ? group.key.slice(pipe + 1) : '';
    const list = byLabel.get(label) ?? [];
    list.push({x, y: group.total.value});
    byLabel.set(label, list);
  }
  return [...byLabel.entries()].map(([label, points]) => ({label, points}));
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {renderDashboard};
}
