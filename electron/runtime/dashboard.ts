/**
 * Dashboards: query-backed data panels (Claude Dashboards parity, local).
 *
 * A dashboard is a JSON spec: named sources (local CSV/XLSX files or inline
 * static rows) plus charts that each carry their query text and a small
 * declarative select. Opening a dashboard re-runs every select, so the
 * snapshot carries `generatedAt` and every number traces back to its source
 * rows plus a human-readable formula. Sharing is an exported standalone
 * HTML file; there is no cloud publish.
 */
import {mkdir, readFile, readdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import ExcelJS from 'exceljs';

export type DashboardSourceKind = 'csv' | 'xlsx' | 'static';
export type DashboardAgg = 'sum' | 'avg' | 'count';
export type DashboardChartType = 'kpi' | 'line' | 'table';

export interface DashboardFilter {
  col: string;
  op: 'eq' | 'gte' | 'lte';
  value: string | number;
}

export interface DashboardSelect {
  source: string;
  value: string;
  agg: DashboardAgg;
  groupBy?: {column: string; truncateDay?: boolean};
  dateColumn?: string;
  filter?: DashboardFilter[];
  priorDays?: number;
}

export interface DashboardSource {
  sourceId: string;
  kind: DashboardSourceKind;
  path?: string;
  sheet?: string;
  rows?: Array<Record<string, string | number>>;
}

export interface DashboardChart {
  chartId: string;
  title: string;
  type: DashboardChartType;
  queryText: string;
  select: DashboardSelect;
}

export interface DashboardSpec {
  schemaVersion: 1;
  dashboardId: string;
  title: string;
  updatedAt: string;
  sources: DashboardSource[];
  charts: DashboardChart[];
}

export interface DashboardCellTrace {
  sourceId: string;
  rowIndexes: number[];
  formula: string;
}

export interface DashboardNumber {
  value: number;
  trace: DashboardCellTrace;
}

export interface DashboardChartSnapshot {
  chartId: string;
  queryText: string;
  formula: string;
  generatedAt: string;
  groups: Array<{key: string; total: DashboardNumber}>;
  current?: DashboardNumber;
  prior?: DashboardNumber;
}

export interface DashboardSnapshot {
  dashboardId: string;
  title: string;
  generatedAt: string;
  charts: DashboardChartSnapshot[];
}

export type TableRow = Record<string, string | number>;

/** Parse CSV text (quoted fields, CRLF) into header-keyed rows. */
export function parseCsv(text: string): TableRow[] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let quoted = false;
  const pushField = (): void => {
    row.push(field);
    field = '';
  };
  const pushRow = (): void => {
    pushField();
    rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      pushField();
    } else if (ch === '\n') {
      pushRow();
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) {
    pushRow();
  }
  const kept = rows.filter(cells => cells.some(cell => cell.trim() !== ''));
  if (kept.length < 2) {
    return [];
  }
  const header = kept[0].map(cell => cell.trim());
  return kept.slice(1).map(cells => {
    const out: TableRow = {};
    header.forEach((name, index) => {
      const raw = (cells[index] ?? '').trim();
      const num = raw !== '' && /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : NaN;
      out[name] = Number.isNaN(num) ? raw : num;
    });
    return out;
  });
}

/** Read the first (or named) worksheet into header-keyed rows. */
export async function readXlsxRows(
  path: string,
  sheet?: string,
): Promise<TableRow[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path);
  const picked = sheet
    ? workbook.worksheets.find(w => w.name === sheet)
    : workbook.worksheets[0];
  if (!picked) {
    throw new Error('dashboard_sheet_missing');
  }
  const rows: TableRow[] = [];
  let header: string[] = [];
  picked.eachRow((row, rowNumber) => {
    const cells = (Array.isArray(row.values) ? row.values : []).slice(1);
    const texts = cells.map(cell => {
      if (cell !== null && typeof cell === 'object') {
        const rich = cell as {result?: unknown; text?: unknown};
        return String(rich.result ?? rich.text ?? '');
      }
      return String(cell ?? '');
    });
    if (rowNumber === 1) {
      header = texts.map(text => text.trim());
      return;
    }
    if (texts.every(text => text.trim() === '')) {
      return;
    }
    const out: TableRow = {};
    header.forEach((name, index) => {
      const raw = (texts[index] ?? '').trim();
      const num = raw !== '' && /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : NaN;
      out[name] = Number.isNaN(num) ? raw : num;
    });
    rows.push(out);
  });
  return rows;
}

function matchFilter(row: TableRow, filter: DashboardFilter): boolean {
  const actual = row[filter.col];
  if (filter.op === 'eq') {
    return String(actual ?? '') === String(filter.value);
  }
  const left = Number(actual);
  const right = Number(filter.value);
  if (!Number.isNaN(left) && !Number.isNaN(right)) {
    return filter.op === 'gte' ? left >= right : left <= right;
  }
  const text = String(actual ?? '');
  return filter.op === 'gte'
    ? text >= String(filter.value)
    : text <= String(filter.value);
}

function aggregate(
  values: number[],
  agg: DashboardAgg,
  label: string,
): {total: number; formula: string} {
  if (agg === 'count') {
    return {total: values.length, formula: `count(${label})`};
  }
  const sum = values.reduce((acc, item) => acc + item, 0);
  if (agg === 'sum') {
    return {total: sum, formula: `sum(${label})`};
  }
  return {
    total: values.length ? sum / values.length : 0,
    formula: `avg(${label})`,
  };
}

function toDay(value: string | number): string {
  return String(value ?? '').slice(0, 10);
}

async function loadSourceRows(source: DashboardSource): Promise<TableRow[]> {
  if (source.kind === 'static') {
    return source.rows ?? [];
  }
  if (!source.path) {
    throw new Error('dashboard_source_path_missing');
  }
  if (source.kind === 'csv') {
    return parseCsv(await readFile(source.path, 'utf8'));
  }
  return readXlsxRows(source.path, source.sheet);
}

/** Run one chart select against loaded rows; numbers keep row provenance. */
export function runSelect(
  sourceId: string,
  rows: TableRow[],
  select: DashboardSelect,
  generatedAt: string,
): DashboardChartSnapshot {
  const kept = rows
    .map((row, index) => ({row, index}))
    .filter(({row}) => (select.filter ?? []).every(f => matchFilter(row, f)));
  const numbers = kept
    .map(({row, index}) => ({
      index,
      num: Number(row[select.value]),
    }))
    .filter(item => Number.isFinite(item.num));
  const formulaBase = `${select.agg}(${select.value})`;
  if (!select.groupBy && select.priorDays === undefined) {
    const {total, formula} = aggregate(
      numbers.map(item => item.num),
      select.agg,
      select.value,
    );
    return {
      chartId: '',
      queryText: '',
      formula,
      generatedAt,
      groups: [],
      current: {
        value: total,
        trace: {
          sourceId,
          rowIndexes: numbers.map(item => item.index),
          formula,
        },
      },
    };
  }
  if (select.groupBy) {
    const buckets = new Map<string, Array<{index: number; num: number}>>();
    for (const item of numbers) {
      const row = kept.find(k => k.index === item.index)?.row;
      const cell = row ? row[select.groupBy.column] : '';
      const key = select.groupBy.truncateDay ? toDay(String(cell ?? '')) : String(cell ?? '');
      const list = buckets.get(key) ?? [];
      list.push(item);
      buckets.set(key, list);
    }
    const groups = [...buckets.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([key, items]) => {
        const {total, formula} = aggregate(
          items.map(item => item.num),
          select.agg,
          select.value,
        );
        return {
          key,
          total: {
            value: total,
            trace: {
              sourceId,
              rowIndexes: items.map(item => item.index),
              formula: `${formula} where ${select.groupBy!.column}=${key}`,
            },
          },
        };
      });
    return {
      chartId: '',
      queryText: '',
      formula: formulaBase,
      generatedAt,
      groups,
    };
  }
  const days = Number(select.priorDays ?? 0);
  const dateCol = String(select.dateColumn ?? '');
  const stamps = kept.map(({row, index}) => ({
    index,
    day: toDay(String(row[dateCol] ?? '')),
  }));
  const latest = stamps.map(s => s.day).sort().pop() ?? '';
  const latestMs = Date.parse(`${latest}T00:00:00Z`);
  const currentCut = latestMs - days * 86400000;
  const priorCut = latestMs - 2 * days * 86400000;
  const inCurrent = new Set(
    stamps
      .filter(s => Date.parse(`${s.day}T00:00:00Z`) > currentCut)
      .map(s => s.index),
  );
  const inPrior = new Set(
    stamps
      .filter(s => {
        const time = Date.parse(`${s.day}T00:00:00Z`);
        return time <= currentCut && time > priorCut;
      })
      .map(s => s.index),
  );
  const part = (picked: Set<number>): DashboardNumber => {
    const items = numbers.filter(item => picked.has(item.index));
    const {total, formula} = aggregate(
      items.map(item => item.num),
      select.agg,
      select.value,
    );
    return {
      value: total,
      trace: {
        sourceId,
        rowIndexes: items.map(item => item.index),
        formula,
      },
    };
  };
  return {
    chartId: '',
    queryText: '',
    formula: formulaBase,
    generatedAt,
    groups: [],
    current: part(inCurrent),
    prior: part(inPrior),
  };
}

/** Run every chart in a spec with preloaded rows; attaches ids/query text. */
export function snapshotCharts(
  spec: DashboardSpec,
  loaded: Map<string, TableRow[]>,
  generatedAt: string,
): DashboardChartSnapshot[] {
  return spec.charts.map(chart => {
    const rows = loaded.get(chart.select.source) ?? [];
    const snap = runSelect(chart.select.source, rows, chart.select, generatedAt);
    return {...snap, chartId: chart.chartId, queryText: chart.queryText};
  });
}

/** Load a spec, re-run every chart against current source files. */
export async function runDashboard(
  root: string,
  dashboardId: string,
): Promise<{spec: DashboardSpec; snapshot: DashboardSnapshot}> {
  const spec = await loadDashboard(root, dashboardId);
  const generatedAt = new Date().toISOString();
  const loaded = new Map<string, TableRow[]>();
  for (const source of spec.sources) {
    loaded.set(source.sourceId, await loadSourceRows(source));
  }
  return {
    spec,
    snapshot: {
      dashboardId: spec.dashboardId,
      title: spec.title,
      generatedAt,
      charts: snapshotCharts(spec, loaded, generatedAt),
    },
  };
}

function dashboardsDir(root: string): string {
  return join(root, 'dashboards');
}

export async function saveDashboard(
  root: string,
  spec: DashboardSpec,
): Promise<DashboardSpec> {
  const value: DashboardSpec = {
    ...spec,
    dashboardId: spec.dashboardId || randomUUID(),
    updatedAt: new Date().toISOString(),
  };
  await mkdir(dashboardsDir(root), {recursive: true});
  await writeFile(
    join(dashboardsDir(root), `${value.dashboardId}.json`),
    JSON.stringify(value, null, 2),
    'utf8',
  );
  return value;
}

export async function loadDashboard(
  root: string,
  dashboardId: string,
): Promise<DashboardSpec> {
  const raw = await readFile(
    join(dashboardsDir(root), `${dashboardId}.json`),
    'utf8',
  );
  return JSON.parse(raw) as DashboardSpec;
}

export async function listDashboards(root: string): Promise<DashboardSpec[]> {
  let names: string[];
  try {
    names = await readdir(dashboardsDir(root));
  } catch {
    return [];
  }
  const out: DashboardSpec[] = [];
  for (const name of names.filter(item => item.endsWith('.json'))) {
    try {
      out.push(await loadDashboard(root, name.slice(0, -5)));
    } catch {}
  }
  return out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}
