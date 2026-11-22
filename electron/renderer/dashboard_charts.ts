'use strict';

interface DashboardChartRenderOptions {
  hoveredX?: string | null;
  hiddenSeries?: Set<string>;
  activeFilters?: Array<{field: string; values: Array<string | number>}>;
  tableState?: {
    search?: string;
    sortCol?: number;
    sortDir?: 1 | -1;
    page?: number;
    pageSize?: number;
  };
}

interface DashboardChartViewNumber {
  value: number | null;
  trace: {traceId?: string; excludedCount?: number};
}

interface DashboardChartViewGroup {
  key: string;
  dimensions: string[];
  total: DashboardChartViewNumber;
}

interface DashboardChartViewData {
  chartId: string;
  queryText: string;
  error?: string;
  groups: DashboardChartViewGroup[];
  current?: DashboardChartViewNumber;
  prior?: DashboardChartViewNumber;
  table?: {
    columns: string[];
    rows: Array<{key: string; cells: Array<DashboardChartViewNumber | null>}>;
  };
}

interface DashboardChartViewMeta {
  chartId: string;
  title: string;
  type: string;
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

declare global {
  var DashboardCharts: {
    CATEGORICAL_TOKENS: readonly string[];
    SEQUENTIAL_TOKENS: readonly string[];
    escapeHtml(value: unknown): string;
    formatNumber(
      value: number | null | undefined,
      format?: 'money' | 'number' | 'percent',
      currency?: string,
    ): string;
    renderChart(
      chart: DashboardChartViewData,
      meta: DashboardChartViewMeta,
      options?: DashboardChartRenderOptions,
    ): string;
  };
}

(() => {
  const CATEGORICAL_TOKENS = [
    'var(--cds-chart-categorical-1, #2563eb)',
    'var(--cds-chart-categorical-2, #ea580c)',
    'var(--cds-chart-categorical-3, #0891b2)',
    'var(--cds-chart-categorical-4, #ca8a04)',
    'var(--cds-chart-categorical-5, #db2777)',
    'var(--cds-chart-categorical-6, #16a34a)',
    'var(--cds-chart-categorical-7, #7c3aed)',
    'var(--cds-chart-categorical-8, #dc2626)',
  ] as const;

  const SEQUENTIAL_TOKENS = [
    'var(--cds-chart-sequential-1, #eff6ff)',
    'var(--cds-chart-sequential-2, #dbeafe)',
    'var(--cds-chart-sequential-3, #93c5fd)',
    'var(--cds-chart-sequential-4, #60a5fa)',
    'var(--cds-chart-sequential-5, #3b82f6)',
    'var(--cds-chart-sequential-6, #2563eb)',
    'var(--cds-chart-sequential-7, #1d4ed8)',
  ] as const;

  function lang(): string {
    return typeof getStudioLanguage === 'function' ? getStudioLanguage() : 'en';
  }

  function escapeHtml(value: unknown): string {
    return String(value ?? '').replace(
      /[&<>"']/g,
      char =>
        ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[
          char
        ]!,
    );
  }

  function formatNumber(
    value: number | null | undefined,
    format?: 'money' | 'number' | 'percent',
    currency = 'USD',
  ): string {
    if (value === null || value === undefined || !Number.isFinite(value)) {
      return '—';
    }
    if (format === 'percent') {
      return `${value.toLocaleString(lang(), {maximumFractionDigits: 2})}%`;
    }
    return new Intl.NumberFormat(
      lang(),
      format === 'money'
        ? {
            style: 'currency',
            currency,
            maximumFractionDigits: 2,
            notation: Math.abs(value) >= 1_000_000 ? 'compact' : 'standard',
          }
        : {maximumFractionDigits: 2},
    ).format(value);
  }

  function numberButton(
    num: DashboardChartViewNumber | null | undefined,
    meta: {format?: 'money' | 'number' | 'percent'; currency?: string},
  ): string {
    const label = escapeHtml(
      formatNumber(num?.value ?? null, meta.format, meta.currency),
    );
    return num?.trace?.traceId
      ? `<button type="button" class="mp-dash-value-button" data-dash-trace="${escapeHtml(num.trace.traceId)}" title="Inspect source rows">${label}</button>`
      : label;
  }

  interface SeriesItem {
    label: string;
    points: Array<{x: string; y: number | null; traceId?: string}>;
  }

  function splitSeries(groups: DashboardChartViewGroup[]): SeriesItem[] {
    const map = new Map<string, SeriesItem['points']>();
    for (const g of groups) {
      const [x = '', label = ''] = g.dimensions;
      const list = map.get(label) ?? [];
      list.push({x, y: g.total.value, traceId: g.total.trace?.traceId});
      map.set(label, list);
    }
    return [...map].map(([label, points]) => ({
      label,
      points: points.sort((a, b) => a.x.localeCompare(b.x)),
    }));
  }

  function renderKpi(
    chart: DashboardChartViewData,
    meta: DashboardChartViewMeta,
  ): string {
    const current = chart.current?.value ?? null;
    const prior = chart.prior?.value ?? null;
    let html = `<div class="mp-dash-kpi-value">${numberButton(chart.current, meta)}</div>`;
    if (current !== null && prior !== null && prior !== 0) {
      const pct = ((current - prior) / Math.abs(prior)) * 100;
      const dir = current >= prior ? 'up' : 'down';
      html += `<div class="mp-dash-delta ${dir}">${pct > 0 ? '+' : ''}${pct.toFixed(1)}% vs prior</div>`;
    }
    if (chart.prior) {
      html += `<small class="mp-dash-note">Prior: ${numberButton(chart.prior, meta)}</small>`;
    }
    if (meta.watch && current !== null) {
      let status: 'good' | 'warning' | 'critical' = 'good';
      let label = meta.watch.label || 'Watch';
      if (meta.watch.target !== undefined) {
        status = current >= meta.watch.target ? 'good' : 'warning';
        label = `${label}: ${formatNumber(meta.watch.target, meta.format, meta.currency)}`;
      }
      if (meta.watch.min !== undefined && current < meta.watch.min) {
        status = 'critical';
      }
      if (meta.watch.max !== undefined && current > meta.watch.max) {
        status = 'critical';
      }
      html += `<div class="mp-dash-watch mp-dash-watch-${status}">${escapeHtml(label)}</div>`;
    }
    if (chart.groups.length >= 2) {
      const vals = chart.groups
        .map(g => g.total.value)
        .filter((v): v is number => v !== null);
      if (vals.length >= 2) {
        const min = Math.min(...vals);
        const max = Math.max(...vals);
        const span = max - min || 1;
        const w = 140;
        const h = 32;
        const d = vals
          .map((v, i) => {
            const px = (i / (vals.length - 1)) * w;
            const py = h - 4 - ((v - min) / span) * (h - 8);
            return `${i === 0 ? 'M' : 'L'}${px.toFixed(1)},${py.toFixed(1)}`;
          })
          .join(' ');
        html += `<svg viewBox="0 0 ${w} ${h}" class="mp-dash-sparkline" aria-hidden="true"><path d="${d}" fill="none" stroke="${CATEGORICAL_TOKENS[0]}" stroke-width="1.75"/></svg>`;
      }
    }
    if (current === null) {
      html += '<p class="mp-dash-note">No numeric values</p>';
    }
    return html;
  }

  function renderLineOrArea(
    chart: DashboardChartViewData,
    meta: DashboardChartViewMeta,
    options: DashboardChartRenderOptions,
  ): string {
    const allSeries = splitSeries(chart.groups);
    const hidden = options.hiddenSeries ?? new Set<string>();
    const visibleSeries = allSeries.filter(s => !hidden.has(s.label || meta.title));
    const isArea = meta.type === 'area' || meta.type === 'stacked_area';
    const isStacked = meta.type === 'stacked_area';
    const points = visibleSeries.flatMap(s => s.points).filter(p => p.y !== null);
    if (!points.length) {
      return '<p class="mp-dash-note">No visible series data.</p>';
    }

    const width = 720;
    const height = 280;
    const showEndLabels =
      !isStacked && visibleSeries.length >= 2 && visibleSeries.length <= 4;
    const left = 72;
    const right = showEndLabels ? 110 : 20;
    const top = 16;
    const bottom = 36;
    const domain = [
      ...new Set(visibleSeries.flatMap(s => s.points.map(p => p.x))),
    ].sort();
    const dateAxis = domain.every(
      v => /^\d{4}-\d{2}-\d{2}/.test(v) && Number.isFinite(Date.parse(v)),
    );
    const coords = domain.map((v, i) => (dateAxis ? Date.parse(v) : i));
    const first = coords[0];
    const last = coords[coords.length - 1];
    const posX = new Map(
      domain.map((v, i) => [
        v,
        first === last
          ? left + (width - left - right) / 2
          : left + ((coords[i] - first) / (last - first)) * (width - left - right),
      ]),
    );

    const stackedTotals = new Map<string, number>();
    if (isStacked) {
      for (const s of visibleSeries) {
        for (const p of s.points) {
          if (p.y !== null) {
            stackedTotals.set(p.x, (stackedTotals.get(p.x) ?? 0) + Math.max(0, p.y));
          }
        }
      }
    }
    const vals = isStacked
      ? [...stackedTotals.values()]
      : points.map(p => p.y!);
    const low = Math.min(0, ...vals);
    const high = Math.max(0, ...vals);
    const span = high - low || 1;
    const maxY = high + span * 0.08;
    const minY = low < 0 ? low - span * 0.08 : 0;
    const yFn = (val: number) =>
      top + ((maxY - val) / (maxY - minY)) * (height - top - bottom);

    let svg = `<svg viewBox="0 0 ${width} ${height}" class="mp-dash-line" role="img" aria-label="${escapeHtml(meta.title)}">`;
    for (let i = 0; i <= 4; i += 1) {
      const val = minY + ((maxY - minY) * i) / 4;
      const py = yFn(val);
      svg += `<line x1="${left}" y1="${py}" x2="${width - right}" y2="${py}" class="mp-dash-grid"/>`;
      svg += `<text x="${left - 8}" y="${py + 4}" class="mp-dash-axis" text-anchor="end">${escapeHtml(formatNumber(val, meta.format, meta.currency))}</text>`;
    }
    const step = Math.max(1, Math.ceil(domain.length / 7));
    domain.forEach((v, i) => {
      if (i % step && i !== domain.length - 1) {
        return;
      }
      const label = dateAxis ? v.slice(5, 10) : v.slice(0, 14);
      svg += `<text x="${posX.get(v)}" y="${height - 10}" class="mp-dash-axis" text-anchor="${i === 0 ? 'start' : i === domain.length - 1 ? 'end' : 'middle'}">${escapeHtml(label)}</text>`;
    });

    if (options.hoveredX && posX.has(options.hoveredX)) {
      const hx = posX.get(options.hoveredX)!;
      svg += `<line x1="${hx}" y1="${top}" x2="${hx}" y2="${height - bottom}" class="mp-dash-crosshair"/>`;
    }

    const baseAccum = new Map<string, number>();
    visibleSeries.forEach((series, idx) => {
      const color = CATEGORICAL_TOKENS[idx % CATEGORICAL_TOKENS.length];
      const isGhost = meta.ghostSeries && series.label === meta.ghostSeries;
      let pathD = '';
      let areaD = '';
      let segStartX = 0;
      let prevX = 0;
      let connected = false;
      const ptsByX = new Map(series.points.map(p => [p.x, p]));

      for (const xVal of domain) {
        const p = ptsByX.get(xVal);
        if (!p || p.y === null) {
          if (isArea && connected) {
            areaD += ` L${prevX},${yFn(0)} L${segStartX},${yFn(0)} Z`;
          }
          connected = false;
          continue;
        }
        const px = posX.get(xVal)!;
        const base = isStacked ? (baseAccum.get(xVal) ?? 0) : 0;
        const topVal = base + p.y;
        if (isStacked) {
          baseAccum.set(xVal, topVal);
        }
        const py = yFn(topVal);
        if (!connected) {
          segStartX = px;
          pathD += ` M${px},${py}`;
          if (isArea) {
            areaD += ` M${px},${yFn(base)} L${px},${py}`;
          }
          connected = true;
        } else {
          pathD += ` L${px},${py}`;
          if (isArea) {
            areaD += ` L${px},${py}`;
          }
        }
        prevX = px;
      }
      if (isArea && connected) {
        areaD += ` L${prevX},${yFn(0)} L${segStartX},${yFn(0)} Z`;
        svg += `<path d="${areaD}" fill="${color}" fill-opacity="0.18"/>`;
      }
      svg += `<path d="${pathD}" fill="none" stroke="${color}" stroke-width="2" ${isGhost ? 'stroke-dasharray="5 4"' : ''}/>`;

      let lastPlotted: {px: number; py: number} | null = null;
      const accumReadout = new Map<string, number>();
      for (const p of series.points) {
        if (p.y === null) {
          continue;
        }
        const px = posX.get(p.x)!;
        const py = yFn(isStacked ? (accumReadout.get(p.x) ?? 0) + p.y : p.y);
        accumReadout.set(p.x, (accumReadout.get(p.x) ?? 0) + p.y);
        lastPlotted = {px, py};
        const tip = `${series.label || meta.title} · ${p.x}: ${formatNumber(p.y, meta.format, meta.currency)}`;
        svg += `<circle cx="${px}" cy="${py}" r="${options.hoveredX === p.x ? 6 : 4}" fill="${color}" data-dash-x="${escapeHtml(p.x)}" data-dash-series="${escapeHtml(series.label)}" data-dash-tip="${escapeHtml(tip)}" ${p.traceId ? `data-dash-trace="${escapeHtml(p.traceId)}" tabindex="0" role="button"` : ''}><title>${escapeHtml(tip)}</title></circle>`;
      }
      if (showEndLabels && lastPlotted && series.label) {
        svg += `<text x="${lastPlotted.px + 6}" y="${lastPlotted.py + 4}" class="mp-dash-end-label" fill="${color}">${escapeHtml(series.label.slice(0, 14))}</text>`;
      }
    });
    svg += '</svg>';
    svg += renderLegend(allSeries, meta, hidden, chart.chartId);
    return svg;
  }

  function renderLegend(
    allSeries: SeriesItem[],
    meta: DashboardChartViewMeta,
    hidden: Set<string>,
    chartId: string,
  ): string {
    return (
      '<div class="mp-dash-legend">' +
      allSeries
        .map((s, idx) => {
          const label = s.label || meta.title;
          const isHidden = hidden.has(label);
          const color = CATEGORICAL_TOKENS[idx % CATEGORICAL_TOKENS.length];
          const lastPt = s.points.filter(p => p.y !== null).at(-1);
          return `<button type="button" class="mp-dash-legend-item ${isHidden ? 'is-hidden' : ''}" data-dash-legend="${escapeHtml(chartId)}" data-dash-series="${escapeHtml(label)}"><i style="background:${color}"></i>${escapeHtml(label)}${lastPt ? ` · ${escapeHtml(formatNumber(lastPt.y, meta.format, meta.currency))}` : ''}</button>`;
        })
        .join('') +
      '</div>'
    );
  }

  function renderBar(
    chart: DashboardChartViewData,
    meta: DashboardChartViewMeta,
    options: DashboardChartRenderOptions,
  ): string {
    const seriesList = splitSeries(chart.groups);
    const hidden = options.hiddenSeries ?? new Set<string>();
    const visible = seriesList.filter(s => !hidden.has(s.label || meta.title));
    const cats = [...new Set(chart.groups.map(g => g.dimensions[0] ?? ''))];
    if (!cats.length) {
      return '<p class="mp-dash-note">No bar data.</p>';
    }
    const isStacked = meta.type === 'stacked_bar';
    const isHoriz = meta.orientation === 'horizontal';
    const width = 720;
    const height = isHoriz ? Math.max(200, cats.length * 36 + 44) : 280;
    const left = isHoriz ? 120 : 68;
    const right = 24;
    const top = 16;
    const bottom = 38;

    const totalsByCat = cats.map(cat => {
      const vals = visible.map(
        s => s.points.find(p => p.x === cat)?.y ?? 0,
      );
      return isStacked
        ? vals.reduce((a, b) => a + Math.max(0, b), 0)
        : Math.max(0, ...vals);
    });
    const maxVal = Math.max(1, ...totalsByCat) * 1.1;
    const plotW = width - left - right;
    const plotH = height - top - bottom;

    let svg = `<svg viewBox="0 0 ${width} ${height}" class="mp-dash-bar" role="img" aria-label="${escapeHtml(meta.title)}">`;
    if (!isHoriz) {
      for (let i = 0; i <= 4; i += 1) {
        const v = (maxVal * i) / 4;
        const py = top + plotH - (v / maxVal) * plotH;
        svg += `<line x1="${left}" y1="${py}" x2="${width - right}" y2="${py}" class="mp-dash-grid"/>`;
        svg += `<text x="${left - 8}" y="${py + 4}" class="mp-dash-axis" text-anchor="end">${escapeHtml(formatNumber(v, meta.format, meta.currency))}</text>`;
      }
      const bandW = plotW / cats.length;
      cats.forEach((cat, ci) => {
        const cx = left + ci * bandW;
        let stackY = top + plotH;
        const subW = isStacked
          ? Math.min(48, bandW * 0.65)
          : Math.min(36, (bandW * 0.72) / Math.max(1, visible.length));
        visible.forEach((s, si) => {
          const pt = s.points.find(p => p.x === cat);
          const val = pt?.y ?? 0;
          const barH = Math.max(2, (Math.abs(val) / maxVal) * plotH);
          const bx = isStacked
            ? cx + (bandW - subW) / 2
            : cx + (bandW - subW * visible.length) / 2 + si * subW;
          const by = isStacked ? stackY - barH : top + plotH - barH;
          if (isStacked) {
            stackY -= barH;
          }
          const color = CATEGORICAL_TOKENS[si % CATEGORICAL_TOKENS.length];
          const tip = `${cat}${s.label ? ` · ${s.label}` : ''}: ${formatNumber(val, meta.format, meta.currency)}`;
          svg += `<rect x="${bx}" y="${by}" width="${Math.max(4, subW - 2)}" height="${barH}" rx="3" fill="${color}" data-dash-filter-field="${escapeHtml(meta.xField || 'dimension')}" data-dash-filter-val="${escapeHtml(cat)}" data-dash-tip="${escapeHtml(tip)}" ${pt?.traceId ? `data-dash-trace="${escapeHtml(pt.traceId)}"` : ''}><title>${escapeHtml(tip)}</title></rect>`;
        });
        svg += `<text x="${cx + bandW / 2}" y="${height - 12}" class="mp-dash-axis" text-anchor="middle">${escapeHtml(cat.slice(0, 14))}</text>`;
      });
    } else {
      const bandH = plotH / cats.length;
      cats.forEach((cat, ci) => {
        const cy = top + ci * bandH;
        let stackX = left;
        const barH = Math.min(24, bandH * 0.65);
        visible.forEach((s, si) => {
          const pt = s.points.find(p => p.x === cat);
          const val = pt?.y ?? 0;
          const barW = Math.max(2, (Math.abs(val) / maxVal) * plotW);
          const bx = isStacked ? stackX : left;
          if (isStacked) {
            stackX += barW;
          }
          const color = CATEGORICAL_TOKENS[si % CATEGORICAL_TOKENS.length];
          const tip = `${cat}: ${formatNumber(val, meta.format, meta.currency)}`;
          svg += `<rect x="${bx}" y="${cy + (bandH - barH) / 2}" width="${barW}" height="${barH}" rx="3" fill="${color}" data-dash-filter-field="${escapeHtml(meta.xField || 'dimension')}" data-dash-filter-val="${escapeHtml(cat)}" data-dash-tip="${escapeHtml(tip)}" ${pt?.traceId ? `data-dash-trace="${escapeHtml(pt.traceId)}"` : ''}><title>${escapeHtml(tip)}</title></rect>`;
        });
        svg += `<text x="${left - 8}" y="${cy + bandH / 2 + 4}" class="mp-dash-axis" text-anchor="end">${escapeHtml(cat.slice(0, 16))}</text>`;
      });
    }
    svg += '</svg>';
    if (seriesList.length > 1 || seriesList[0]?.label) {
      svg += renderLegend(seriesList, meta, hidden, chart.chartId);
    }
    return svg;
  }

  function renderScatter(
    chart: DashboardChartViewData,
    meta: DashboardChartViewMeta,
  ): string {
    const rawPts = chart.groups.filter(
      g => g.total.value !== null && Number.isFinite(g.total.value),
    );
    if (!rawPts.length) {
      return '<p class="mp-dash-note">No numeric scatter points.</p>';
    }
    const allNumericX = rawPts.every(g => {
      const n = Number(g.dimensions[0]);
      return g.dimensions[0] !== '' && Number.isFinite(n);
    });
    const xCategories = allNumericX
      ? []
      : [...new Set(rawPts.map(g => g.dimensions[0] ?? ''))];
    const pts = rawPts.map(g => ({
      x: allNumericX
        ? Number(g.dimensions[0])
        : xCategories.indexOf(g.dimensions[0] ?? ''),
      xLabel: g.dimensions[0] ?? '',
      y: g.total.value!,
      series: g.dimensions[1] ?? '',
      traceId: g.total.trace?.traceId,
    }));
    const width = 720;
    const height = 280;
    const left = 68;
    const right = 24;
    const top = 16;
    const bottom = 38;
    const minX = Math.min(...pts.map(p => p.x));
    const maxX = Math.max(...pts.map(p => p.x));
    const minY = Math.min(0, ...pts.map(p => p.y));
    const maxY = Math.max(...pts.map(p => p.y));
    const spanX = maxX - minX || 1;
    const spanY = maxY - minY || 1;
    const pxFn = (x: number) => left + ((x - minX) / spanX) * (width - left - right);
    const pyFn = (y: number) => top + ((maxY - y) / spanY) * (height - top - bottom);
    const seriesNames = [...new Set(pts.map(p => p.series))];

    let svg = `<svg viewBox="0 0 ${width} ${height}" class="mp-dash-scatter" role="img" aria-label="${escapeHtml(meta.title)}">`;
    for (let i = 0; i <= 4; i += 1) {
      const yv = minY + (spanY * i) / 4;
      const py = pyFn(yv);
      svg += `<line x1="${left}" y1="${py}" x2="${width - right}" y2="${py}" class="mp-dash-grid"/>`;
      svg += `<text x="${left - 8}" y="${py + 4}" class="mp-dash-axis" text-anchor="end">${escapeHtml(formatNumber(yv, meta.format, meta.currency))}</text>`;
    }
    for (const pt of pts) {
      const si = Math.max(0, seriesNames.indexOf(pt.series));
      const color = CATEGORICAL_TOKENS[si % CATEGORICAL_TOKENS.length];
      const tip = `${pt.series ? `${pt.series} · ` : ''}(${pt.x}, ${formatNumber(pt.y, meta.format, meta.currency)})`;
      svg += `<circle cx="${pxFn(pt.x)}" cy="${pyFn(pt.y)}" r="5" fill="${color}" fill-opacity="0.82" data-dash-tip="${escapeHtml(tip)}" ${pt.traceId ? `data-dash-trace="${escapeHtml(pt.traceId)}" tabindex="0" role="button"` : ''}><title>${escapeHtml(tip)}</title></circle>`;
    }
    svg += '</svg>';
    return svg;
  }

  function renderHeatmap(
    chart: DashboardChartViewData,
    meta: DashboardChartViewMeta,
  ): string {
    const xs = [...new Set(chart.groups.map(g => g.dimensions[0] ?? ''))];
    const ys = [...new Set(chart.groups.map(g => g.dimensions[1] ?? 'All'))];
    if (!xs.length || !ys.length) {
      return '<p class="mp-dash-note">No heatmap cells.</p>';
    }
    const vals = chart.groups
      .map(g => g.total.value)
      .filter((v): v is number => v !== null);
    const min = Math.min(...vals, 0);
    const max = Math.max(...vals, 1);
    const span = max - min || 1;
    const cellW = 72;
    const cellH = 34;
    const left = 100;
    const top = 28;
    const width = left + xs.length * cellW + 16;
    const height = top + ys.length * cellH + 16;

    let svg = `<svg viewBox="0 0 ${width} ${height}" class="mp-dash-heatmap" role="grid" aria-label="${escapeHtml(meta.title)}">`;
    xs.forEach((x, xi) => {
      svg += `<text x="${left + xi * cellW + cellW / 2}" y="18" class="mp-dash-axis" text-anchor="middle">${escapeHtml(x.slice(0, 10))}</text>`;
    });
    ys.forEach((y, yi) => {
      svg += `<text x="${left - 8}" y="${top + yi * cellH + cellH / 2 + 4}" class="mp-dash-axis" text-anchor="end">${escapeHtml(y.slice(0, 12))}</text>`;
      xs.forEach((x, xi) => {
        const found = chart.groups.find(
          g => g.dimensions[0] === x && (g.dimensions[1] ?? 'All') === y,
        );
        const val = found?.total.value ?? null;
        const step =
          val === null
            ? 0
            : Math.min(6, Math.max(0, Math.floor(((val - min) / span) * 6.99)));
        const fill = val === null ? 'var(--mp-panel-subtle, #f4f4f5)' : SEQUENTIAL_TOKENS[step];
        const tip = `${x} × ${y}: ${formatNumber(val, meta.format, meta.currency)}`;
        svg += `<rect x="${left + xi * cellW + 2}" y="${top + yi * cellH + 2}" width="${cellW - 4}" height="${cellH - 4}" rx="4" fill="${fill}" tabindex="0" data-dash-heat-cell="${xi}:${yi}" data-dash-tip="${escapeHtml(tip)}" ${found?.total.trace?.traceId ? `data-dash-trace="${escapeHtml(found.total.trace.traceId)}"` : ''}><title>${escapeHtml(tip)}</title></rect>`;
      });
    });
    svg += '</svg>';
    return svg;
  }

  function renderPieOrDonut(
    chart: DashboardChartViewData,
    meta: DashboardChartViewMeta,
  ): string {
    const items = chart.groups
      .filter(g => (g.total.value ?? 0) > 0)
      .map(g => ({
        label: g.dimensions.join(' · ') || g.key,
        value: g.total.value!,
        traceId: g.total.trace?.traceId,
      }));
    const total = items.reduce((a, b) => a + b.value, 0);
    if (!items.length || total <= 0) {
      return '<p class="mp-dash-note">No positive slice values.</p>';
    }
    const cx = 120;
    const cy = 120;
    const r = 92;
    const innerR = meta.type === 'donut' ? 54 : 0;
    let angle = -Math.PI / 2;

    let svg = `<div class="mp-dash-pie-wrap"><svg viewBox="0 0 240 240" class="mp-dash-pie" role="img" aria-label="${escapeHtml(meta.title)}">`;
    items.forEach((item, idx) => {
      const slice = (item.value / total) * Math.PI * 2;
      const a1 = angle;
      const a2 = angle + slice;
      angle = a2;
      const large = slice > Math.PI ? 1 : 0;
      const x1 = cx + r * Math.cos(a1);
      const y1 = cy + r * Math.sin(a1);
      const x2 = cx + r * Math.cos(a2);
      const y2 = cy + r * Math.sin(a2);
      let d: string;
      if (innerR > 0) {
        const ix1 = cx + innerR * Math.cos(a2);
        const iy1 = cy + innerR * Math.sin(a2);
        const ix2 = cx + innerR * Math.cos(a1);
        const iy2 = cy + innerR * Math.sin(a1);
        d = `M${x1},${y1} A${r},${r} 0 ${large} 1 ${x2},${y2} L${ix1},${iy1} A${innerR},${innerR} 0 ${large} 0 ${ix2},${iy2} Z`;
      } else {
        d = `M${cx},${cy} L${x1},${y1} A${r},${r} 0 ${large} 1 ${x2},${y2} Z`;
      }
      const color = CATEGORICAL_TOKENS[idx % CATEGORICAL_TOKENS.length];
      const pct = ((item.value / total) * 100).toFixed(1);
      const tip = `${item.label}: ${formatNumber(item.value, meta.format, meta.currency)} (${pct}%)`;
      svg += `<path d="${d}" fill="${color}" stroke="var(--mp-panel, #fff)" stroke-width="1.5" data-dash-filter-field="${escapeHtml(meta.xField || 'dimension')}" data-dash-filter-val="${escapeHtml(item.label)}" data-dash-tip="${escapeHtml(tip)}" ${item.traceId ? `data-dash-trace="${escapeHtml(item.traceId)}"` : ''}><title>${escapeHtml(tip)}</title></path>`;
    });
    if (meta.type === 'donut') {
      svg += `<text x="${cx}" y="${cy + 5}" class="mp-dash-donut-total" text-anchor="middle">${escapeHtml(formatNumber(total, meta.format, meta.currency))}</text>`;
    }
    svg += '</svg><div class="mp-dash-pie-legend">';
    items.forEach((item, idx) => {
      const color = CATEGORICAL_TOKENS[idx % CATEGORICAL_TOKENS.length];
      const pct = ((item.value / total) * 100).toFixed(1);
      svg += `<button type="button" class="mp-dash-legend-item" data-dash-filter-field="${escapeHtml(meta.xField || 'dimension')}" data-dash-filter-val="${escapeHtml(item.label)}"><i style="background:${color}"></i><span>${escapeHtml(item.label)}</span><strong>${pct}%</strong></button>`;
    });
    svg += '</div></div>';
    return svg;
  }

  function renderTable(
    chart: DashboardChartViewData,
    meta: DashboardChartViewMeta,
    options: DashboardChartRenderOptions,
  ): string {
    if (!chart.table || !chart.table.rows.length) {
      return '<p class="mp-dash-note">No rows.</p>';
    }
    const ts = options.tableState ?? {};
    const search = (ts.search ?? '').trim().toLowerCase();
    const pageSize = ts.pageSize ?? 10;
    let rows = [...chart.table.rows];
    if (search) {
      rows = rows.filter(r => r.key.toLowerCase().includes(search));
    }
    if (ts.sortCol !== undefined) {
      const col = ts.sortCol;
      const dir = ts.sortDir ?? -1;
      rows.sort((a, b) => {
        if (col === 0) {
          return dir * a.key.localeCompare(b.key);
        }
        const av = a.cells[col - 1]?.value ?? -Infinity;
        const bv = b.cells[col - 1]?.value ?? -Infinity;
        return dir * (av - bv);
      });
    }
    const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
    const page = Math.min(totalPages - 1, Math.max(0, ts.page ?? 0));
    const paged = rows.slice(page * pageSize, (page + 1) * pageSize);

    const colMax = chart.table.columns.slice(1).map((_, idx) =>
      Math.max(1, ...rows.map(r => Math.abs(r.cells[idx]?.value ?? 0))),
    );

    let html = `<div class="mp-dash-table-toolbar"><input type="search" class="mp-dash-table-search" placeholder="Search rows..." value="${escapeHtml(ts.search ?? '')}" data-dash-table-search="${escapeHtml(chart.chartId)}" />`;
    if (totalPages > 1) {
      html += `<div class="mp-dash-table-pager"><button type="button" data-dash-page="${escapeHtml(chart.chartId)}:${page - 1}" ${page === 0 ? 'disabled' : ''}>Prev</button><span>${page + 1}/${totalPages}</span><button type="button" data-dash-page="${escapeHtml(chart.chartId)}:${page + 1}" ${page >= totalPages - 1 ? 'disabled' : ''}>Next</button></div>`;
    }
    html += '</div>';

    html += `<div class="mp-dash-table-scroll"><table class="mp-dash-table"><thead><tr>${chart.table.columns
      .map((col, idx) => {
        const active = ts.sortCol === idx;
        const arrow = active ? (ts.sortDir === 1 ? ' ↑' : ' ↓') : '';
        return `<th data-dash-sort="${escapeHtml(chart.chartId)}:${idx}" tabindex="0">${escapeHtml(col)}${arrow}</th>`;
      })
      .join('')}</tr></thead><tbody>`;
    for (const row of paged) {
      html += `<tr><th scope="row">${escapeHtml(row.key)}</th>${row.cells
        .map((cell, idx) => {
          const cellMeta =
            idx === 0
              ? meta
              : {currency: meta.currency, ...(meta.columns?.[idx - 1] ?? {})};
          const ratio =
            cell?.value !== null && cell?.value !== undefined
              ? Math.min(0.22, (Math.abs(cell.value) / colMax[idx]) * 0.22)
              : 0;
          const style = ratio > 0 ? ` style="background:rgba(37,99,235,${ratio.toFixed(3)})"` : '';
          return `<td class="mp-dash-cell-tone"${style}>${numberButton(cell, cellMeta)}</td>`;
        })
        .join('')}</tr>`;
    }
    html += '</tbody></table></div>';
    return html;
  }

  function renderChart(
    chart: DashboardChartViewData,
    meta: DashboardChartViewMeta,
    options: DashboardChartRenderOptions = {},
  ): string {
    if (chart.error) {
      return `<p class="mp-dash-error">${escapeHtml(chart.error)}</p>`;
    }
    switch (meta.type) {
      case 'kpi':
        return renderKpi(chart, meta);
      case 'line':
      case 'area':
      case 'stacked_area':
        return renderLineOrArea(chart, meta, options);
      case 'bar':
      case 'stacked_bar':
        return renderBar(chart, meta, options);
      case 'scatter':
        return renderScatter(chart, meta);
      case 'heatmap':
        return renderHeatmap(chart, meta);
      case 'pie':
      case 'donut':
        return renderPieOrDonut(chart, meta);
      case 'table':
        return renderTable(chart, meta, options);
      default:
        return renderBar(chart, meta, options);
    }
  }

  globalThis.DashboardCharts = {
    CATEGORICAL_TOKENS,
    SEQUENTIAL_TOKENS,
    escapeHtml,
    formatNumber,
    renderChart,
  };
})();
