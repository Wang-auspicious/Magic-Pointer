import {mkdir, readFile, readdir, rename, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import type ExcelJS from 'exceljs';
import {
  DashboardSqlError,
  executeDashboardSql,
  validateReadOnlySql,
  type DashboardActiveFilter,
  type DashboardLoadErrorCode,
} from './dashboard_sql';

export type DashboardSourceKind = 'csv' | 'xlsx' | 'static' | 'json' | 'sqlite';
export type DashboardAgg = 'sum' | 'avg' | 'count';
export type DashboardChartType =
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
export type DashboardFormat = 'money' | 'number' | 'percent';
export type DashboardSourceTrust =
  | 'verified_file'
  | 'workspace_sql'
  | 'inline_static';
export type TableCell = string | number | boolean | null;
export type TableRow = Record<string, TableCell>;

export interface DashboardDiagnostic {
  code: 'not_a_number' | 'empty_chart' | 'labels_overlap' | 'labels_cut';
  message: string;
  severity: 'warning' | 'error';
}

export interface DashboardFilter {
  col: string;
  op: 'eq' | 'gte' | 'lte';
  value: string | number;
}
export interface DashboardSelect {
  source: string;
  value: string;
  agg: DashboardAgg;
  groupBy?: {column: string; truncateDay?: boolean; and?: string};
  dateColumn?: string;
  filter?: DashboardFilter[];
  priorDays?: number;
  scale?: number;
}
export interface DashboardSource {
  sourceId: string;
  kind: DashboardSourceKind;
  path?: string;
  sheet?: string;
  table?: string;
  headerRow?: number;
  rows?: TableRow[];
}
export interface DashboardColumn {
  label: string;
  select: DashboardSelect;
  format?: DashboardFormat;
  currency?: string;
}
export interface DashboardChart {
  chartId: string;
  title: string;
  type: DashboardChartType;
  queryText: string;
  select?: DashboardSelect;
  querySql?: string;
  xField?: string;
  yField?: string;
  seriesField?: string;
  sizeField?: string;
  valueField?: string;
  ghostSeries?: string;
  orientation?: 'vertical' | 'horizontal';
  watch?: {target?: number; min?: number; max?: number; label?: string};
  format?: DashboardFormat;
  currency?: string;
  primaryLabel?: string;
  columns?: DashboardColumn[];
}
export interface DashboardSpec {
  schemaVersion: 1;
  dashboardId: string;
  title: string;
  updatedAt: string;
  revision?: number;
  sources: DashboardSource[];
  charts: DashboardChart[];
}
export interface DashboardCellTrace {
  traceId?: string;
  sourceId: string;
  rowIndexes: number[];
  rowNumbers: number[];
  formula: string;
  excludedCount: number;
}
export interface DashboardNumber {
  value: number | null;
  trace: DashboardCellTrace;
}
export interface DashboardChartSnapshot {
  chartId: string;
  queryText: string;
  formula: string;
  generatedAt: string;
  error?: string;
  errorCode?: DashboardLoadErrorCode;
  warnings?: string[];
  diagnostics?: DashboardDiagnostic[];
  trustBadge?: DashboardSourceTrust;
  groups: Array<{key: string; dimensions: string[]; total: DashboardNumber}>;
  current?: DashboardNumber;
  prior?: DashboardNumber;
  table?: {
    columns: string[];
    rows: Array<{key: string; cells: Array<DashboardNumber | null>}>;
  };
}
export interface DashboardSnapshot {
  snapshotId: string;
  dashboardId: string;
  title: string;
  generatedAt: string;
  trustBadge?: DashboardSourceTrust;
  diagnostics?: DashboardDiagnostic[];
  charts: DashboardChartSnapshot[];
}
export interface DashboardSourceData {
  source: DashboardSource;
  columns: string[];
  rows: TableRow[];
  rowNumbers: number[];
  warnings: string[];
  error?: string;
}
export interface DashboardRun {
  spec: DashboardSpec;
  snapshot: DashboardSnapshot;
  sources: Map<string, DashboardSourceData>;
}

function headers(cells: string[]): string[] {
  const result = cells.map(
    (cell, index) => cell.trim() || `Column ${index + 1}`,
  );
  if (new Set(result).size !== result.length) {
    throw new Error(
      'The header contains duplicate column names. Choose a header row with unique names.',
    );
  }
  return result;
}

function csvRecords(text: string): Array<{cells: string[]; rowNumber: number}> {
  const records: Array<{cells: string[]; rowNumber: number}> = [];
  let cells: string[] = [];
  let field = '';
  let quoted = false;
  let line = 1;
  let startLine = 1;
  const finish = () => {
    cells.push(field);
    if (cells.some(cell => cell.trim() !== '')) {
      records.push({cells, rowNumber: startLine});
    }
    cells = [];
    field = '';
  };
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === ',' && !quoted) {
      cells.push(field);
      field = '';
    } else if (char === '\n') {
      if (quoted) {
        field += char;
      } else {
        finish();
      }
      line += 1;
      if (!quoted) {
        startLine = line;
      }
    } else if (char !== '\r' || quoted) {
      field += char;
    }
  }
  if (quoted) {
    throw new Error('CSV contains an unclosed quoted field.');
  }
  if (field || cells.length) {
    finish();
  }
  return records;
}

function csvData(text: string, source: DashboardSource): DashboardSourceData {
  const records = csvRecords(text.replace(/^\uFEFF/, ''));
  const headerIndex =
    source.headerRow === undefined
      ? 0
      : records.findIndex(record => record.rowNumber === source.headerRow);
  if (headerIndex < 0 || !records[headerIndex]) {
    return {source, columns: [], rows: [], rowNumbers: [], warnings: []};
  }
  const columns = headers(records[headerIndex].cells);
  const data = records.slice(headerIndex + 1);
  return {
    source,
    columns,
    rowNumbers: data.map(row => row.rowNumber),
    warnings: [],
    rows: data.map(record =>
      Object.fromEntries(
        columns.map((column, index) => [
          column,
          (record.cells[index] ?? '').trim(),
        ]),
      ),
    ),
  };
}

export function parseCsv(text: string): TableRow[] {
  return csvData(text, {sourceId: 'csv', kind: 'csv'}).rows;
}

function excelValue(
  value: ExcelJS.CellValue,
  address: string,
  warnings: string[],
): TableCell {
  if (value === null || value === undefined) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value !== 'object') {
    return value;
  }
  if ('formula' in value || 'sharedFormula' in value) {
    if (value.result === undefined) {
      warnings.push(
        `${address}: the formula has no cached result; it was not treated as zero.`,
      );
      return null;
    }
    return excelValue(value.result, address, warnings);
  }
  if ('richText' in value) {
    return value.richText.map(run => run.text).join('');
  }
  if ('text' in value) {
    return value.text;
  }
  if ('error' in value) {
    warnings.push(`${address}: ${value.error}`);
  }
  return null;
}

async function xlsxData(source: DashboardSource): Promise<DashboardSourceData> {
  const ExcelJS = require('exceljs') as typeof import('exceljs');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(source.path!);
  const sheet = source.sheet
    ? workbook.getWorksheet(source.sheet)
    : workbook.worksheets[0];
  if (!sheet) {
    throw new Error(`Worksheet not found: ${source.sheet || '(first sheet)'}`);
  }
  const headerRow = source.headerRow ?? 1;
  const header = sheet.getRow(headerRow);
  const columns = headers(
    Array.from(
      {length: header.cellCount},
      (_, index) => header.getCell(index + 1).text,
    ),
  );
  const data: DashboardSourceData = {
    source: {...source, sheet: sheet.name},
    columns,
    rows: [],
    rowNumbers: [],
    warnings: [],
  };
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber <= headerRow) {
      return;
    }
    const values = columns.map((_, index) => {
      const cell = row.getCell(index + 1);
      return excelValue(
        cell.value,
        `${sheet.name}!${cell.address}`,
        data.warnings,
      );
    });
    if (values.every(value => value === null || value === '')) {
      return;
    }
    data.rows.push(
      Object.fromEntries(
        columns.map((column, index) => [column, values[index]]),
      ),
    );
    data.rowNumbers.push(rowNumber);
  });
  return data;
}

export async function readXlsxRows(
  file: string,
  sheet?: string,
): Promise<TableRow[]> {
  return (await xlsxData({sourceId: 'xlsx', kind: 'xlsx', path: file, sheet}))
    .rows;
}

async function jsonData(source: DashboardSource): Promise<DashboardSourceData> {
  const raw = JSON.parse(await readFile(source.path!, 'utf8')) as unknown;
  const array = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as {rows?: unknown}).rows)
      ? (raw as {rows: unknown[]}).rows
      : raw && typeof raw === 'object' && Array.isArray((raw as {data?: unknown}).data)
        ? (raw as {data: unknown[]}).data
        : null;
  if (!array) {
    throw new Error(
      `JSON source "${source.sourceId}" must be an array of objects or { rows: [...] }.`,
    );
  }
  const rows: TableRow[] = array.map(item =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? (item as TableRow)
      : {value: (item as TableCell) ?? null},
  );
  return {
    source,
    columns: [...new Set(rows.flatMap(row => Object.keys(row)))],
    rows,
    rowNumbers: rows.map((_, index) => index + 1),
    warnings: [],
  };
}

async function sqliteData(source: DashboardSource): Promise<DashboardSourceData> {
  let sqliteMod: typeof import('node:sqlite');
  try {
    sqliteMod = await import('node:sqlite');
  } catch (error) {
    throw new Error(
      `SQLite reader is unavailable in this Node runtime: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const db = new sqliteMod.DatabaseSync(source.path!, {readOnly: true});
  try {
    let tableName = source.table;
    if (!tableName) {
      const first = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name LIMIT 1",
        )
        .get() as {name?: string} | undefined;
      tableName = first?.name;
    }
    if (!tableName) {
      throw new Error(`No tables found in SQLite source: ${source.sourceId}`);
    }
    const safeIdent = `"${tableName.replaceAll('"', '""')}"`;
    const rows = db.prepare(`SELECT * FROM ${safeIdent}`).all() as TableRow[];
    return {
      source: {...source, table: tableName},
      columns: [...new Set(rows.flatMap(row => Object.keys(row)))],
      rows,
      rowNumbers: rows.map((_, index) => index + 1),
      warnings: [],
    };
  } finally {
    db.close();
  }
}

export async function loadDashboardSource(
  source: DashboardSource,
): Promise<DashboardSourceData> {
  if (source.kind === 'static') {
    const rows = source.rows ?? [];
    return {
      source,
      rows,
      columns: [...new Set(rows.flatMap(row => Object.keys(row)))],
      rowNumbers: rows.map((_, index) => index + 1),
      warnings: [],
    };
  }
  if (!source.path) {
    throw new Error(`Source path is missing: ${source.sourceId}`);
  }
  if (source.kind === 'csv') {
    return csvData(await readFile(source.path, 'utf8'), source);
  }
  if (source.kind === 'json') {
    return jsonData(source);
  }
  if (source.kind === 'sqlite') {
    return sqliteData(source);
  }
  return xlsxData(source);
}

function numeric(value: TableCell | undefined): number | null {
  if (
    value === null ||
    value === undefined ||
    typeof value === 'boolean' ||
    String(value).trim() === ''
  ) {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function matchFilter(row: TableRow, filter: DashboardFilter): boolean {
  const actual = row[filter.col];
  if (actual === undefined || actual === null) {
    return false;
  }
  if (filter.op === 'eq') {
    return String(actual) === String(filter.value);
  }
  const left = numeric(actual);
  const right = numeric(filter.value);
  if (left !== null && right !== null) {
    return filter.op === 'gte' ? left >= right : left <= right;
  }
  return filter.op === 'gte'
    ? String(actual) >= String(filter.value)
    : String(actual) <= String(filter.value);
}

export function describeDashboardSelect(select: DashboardSelect): string {
  const filters = (select.filter ?? []).map(
    filter =>
      `${filter.col} ${filter.op === 'eq' ? '=' : filter.op === 'gte' ? '>=' : '<='} ${JSON.stringify(filter.value)}`,
  );
  return (
    `SELECT ${select.agg.toUpperCase()}(${select.value}) FROM ${select.source}` +
    (filters.length ? ` WHERE ${filters.join(' AND ')}` : '') +
    (select.groupBy
      ? ` GROUP BY ${select.groupBy.truncateDay ? `DATE(${select.groupBy.column})` : select.groupBy.column}${select.groupBy.and ? `, ${select.groupBy.and}` : ''}`
      : '') +
    (select.priorDays
      ? `; compare latest ${select.priorDays} days with preceding ${select.priorDays} days using ${select.dateColumn}`
      : '') +
    (select.scale !== undefined ? `; multiply result by ${select.scale}` : '')
  );
}

export function runSelect(
  sourceId: string,
  rows: TableRow[],
  select: DashboardSelect,
  generatedAt: string,
  rowNumbers = rows.map((_, index) => index + 1),
): DashboardChartSnapshot {
  const kept = rows
    .map((row, index) => ({row, index}))
    .filter(({row}) =>
      (select.filter ?? []).every(filter => matchFilter(row, filter)),
    );
  const formula = describeDashboardSelect(select);
  const numberFor = (items: typeof kept, condition = ''): DashboardNumber => {
    const measured = items.flatMap(item => {
      const value = item.row[select.value];
      const number =
        select.agg === 'count'
          ? select.value === '*' ||
            (value !== undefined &&
              value !== null &&
              String(value).trim() !== '')
            ? 1
            : null
          : numeric(value);
      return number === null ? [] : [{index: item.index, number}];
    });
    const sum = measured.reduce((total, item) => total + item.number, 0);
    const value =
      select.agg === 'count'
        ? measured.length
        : measured.length
          ? select.agg === 'avg'
            ? sum / measured.length
            : sum
          : null;
    return {
      value: value === null ? null : value * (select.scale ?? 1),
      trace: {
        sourceId,
        rowIndexes: measured.map(item => item.index),
        rowNumbers: measured.map(item => rowNumbers[item.index]),
        formula: formula + condition,
        excludedCount: items.length - measured.length,
      },
    };
  };
  const snapshot: DashboardChartSnapshot = {
    chartId: '',
    queryText: formula,
    formula,
    generatedAt,
    groups: [],
  };
  if (select.groupBy) {
    const buckets = new Map<
      string,
      {dimensions: string[]; items: typeof kept}
    >();
    for (const item of kept) {
      const value = String(item.row[select.groupBy.column] ?? '');
      const dimensions = [
        select.groupBy.truncateDay ? value.slice(0, 10) : value,
      ];
      if (select.groupBy.and) {
        dimensions.push(String(item.row[select.groupBy.and] ?? ''));
      }
      const key =
        dimensions.length > 1 ? JSON.stringify(dimensions) : dimensions[0];
      const bucket = buckets.get(key) ?? {dimensions, items: []};
      bucket.items.push(item);
      buckets.set(key, bucket);
    }
    snapshot.groups = [...buckets]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, bucket]) => ({
        key,
        dimensions: bucket.dimensions,
        total: numberFor(
          bucket.items,
          `; group ${JSON.stringify(bucket.dimensions)}`,
        ),
      }));
  } else if (select.priorDays !== undefined) {
    const stamped = kept.map(item => ({
      ...item,
      day: String(item.row[select.dateColumn || ''] ?? '').slice(0, 10),
    }));
    const valid = stamped.filter(
      item =>
        /^\d{4}-\d{2}-\d{2}$/.test(item.day) &&
        Number.isFinite(Date.parse(`${item.day}T00:00:00Z`)),
    );
    const latest = valid
      .map(item => item.day)
      .sort()
      .at(-1);
    if (kept.length && !latest) {
      throw new Error(
        `No readable dates in ${select.dateColumn}. Use ISO dates or an Excel date column.`,
      );
    }
    const lastMs = latest ? Date.parse(`${latest}T00:00:00Z`) : 0;
    const currentCut = lastMs - select.priorDays * 86_400_000;
    const priorCut = currentCut - select.priorDays * 86_400_000;
    snapshot.current = numberFor(
      valid.filter(item => Date.parse(`${item.day}T00:00:00Z`) > currentCut),
      `; latest ${select.priorDays} days ending ${latest || 'no data'}`,
    );
    snapshot.prior = numberFor(
      valid.filter(item => {
        const time = Date.parse(`${item.day}T00:00:00Z`);
        return time > priorCut && time <= currentCut;
      }),
      `; preceding ${select.priorDays} days`,
    );
    if (valid.length !== kept.length) {
      snapshot.warnings = [
        `${kept.length - valid.length} rows have no readable date and were excluded.`,
      ];
    }
  } else {
    snapshot.current = numberFor(kept);
  }
  return snapshot;
}

function checkColumns(
  data: DashboardSourceData,
  select: DashboardSelect,
): void {
  if (data.error) {
    throw new Error(data.error);
  }
  const names = [
    select.value === '*' && select.agg === 'count' ? '' : select.value,
    select.groupBy?.column,
    select.groupBy?.and,
    select.dateColumn,
    ...(select.filter ?? []).map(filter => filter.col),
  ].filter((value): value is string => Boolean(value));
  for (const name of names) {
    if (!data.columns.includes(name)) {
      throw new Error(
        `Column "${name}" is missing from source "${select.source}".`,
      );
    }
  }
}

const CHART_TYPES: readonly DashboardChartType[] = [
  'kpi',
  'line',
  'area',
  'stacked_area',
  'bar',
  'stacked_bar',
  'scatter',
  'heatmap',
  'pie',
  'donut',
  'table',
];

function computeTrustBadge(
  spec: DashboardSpec,
  chart?: DashboardChart,
): DashboardSourceTrust {
  if (chart?.querySql) {
    const allFile = spec.sources.every(s => s.kind !== 'static');
    return allFile ? 'workspace_sql' : 'inline_static';
  }
  const sourceId = chart?.select?.source;
  const source = sourceId
    ? spec.sources.find(s => s.sourceId === sourceId)
    : undefined;
  if (source) {
    return source.kind === 'static' ? 'inline_static' : 'verified_file';
  }
  return spec.sources.some(s => s.kind !== 'static')
    ? 'verified_file'
    : 'inline_static';
}

function runChartDiagnostics(
  chart: DashboardChart,
  snap: DashboardChartSnapshot,
): DashboardDiagnostic[] {
  const diags: DashboardDiagnostic[] = [];
  if (snap.error) {
    return diags;
  }
  if (chart.type === 'kpi') {
    if (!snap.current || snap.current.value === null) {
      diags.push({
        code: 'empty_chart',
        message: 'KPI returned no numeric value.',
        severity: 'warning',
      });
    } else if (!Number.isFinite(snap.current.value)) {
      diags.push({
        code: 'not_a_number',
        message: 'KPI computed a non-finite value.',
        severity: 'error',
      });
    }
    return diags;
  }
  if (chart.type === 'table') {
    if (!snap.table?.rows.length) {
      diags.push({
        code: 'empty_chart',
        message: 'Table returned 0 rows.',
        severity: 'warning',
      });
    }
    return diags;
  }
  if (!snap.groups.length) {
    diags.push({
      code: 'empty_chart',
      message: 'Chart has 0 data points.',
      severity: 'warning',
    });
    return diags;
  }
  if (snap.groups.some(g => g.total.value !== null && !Number.isFinite(g.total.value))) {
    diags.push({
      code: 'not_a_number',
      message: 'Chart contains non-finite numeric values.',
      severity: 'error',
    });
  }
  const xLabels = [...new Set(snap.groups.map(g => g.dimensions[0] ?? ''))];
  if (xLabels.length > 24 || (xLabels.length > 10 && xLabels.some(l => l.length > 18))) {
    diags.push({
      code: 'labels_overlap',
      message: `${xLabels.length} axis labels may overlap; automatic tick thinning applied.`,
      severity: 'warning',
    });
  }
  if (xLabels.some(l => l.length > 28)) {
    diags.push({
      code: 'labels_cut',
      message: 'Long axis labels may be truncated.',
      severity: 'warning',
    });
  }
  return diags;
}

function applySelectFilters(
  select: DashboardSelect,
  activeFilters: DashboardActiveFilter[],
  columns: string[],
): DashboardSelect {
  const matching = activeFilters.filter(f => columns.includes(f.field));
  if (!matching.length) {
    return select;
  }
  const extra: DashboardFilter[] = matching.flatMap<DashboardFilter>(f => {
    if (f.op === 'eq' || f.op === 'in') {
      return f.values.length === 1
        ? [{col: f.field, op: 'eq' as const, value: f.values[0]}]
        : [];
    }
    return f.values.length
      ? [{col: f.field, op: f.op, value: f.values[0]}]
      : [];
  });
  if (!extra.length) {
    return select;
  }
  return {
    ...select,
    filter: [...(select.filter ?? []), ...extra],
  };
}

function runSqlChart(
  chart: DashboardChart,
  sourceMap: Map<string, DashboardSourceData>,
  generatedAt: string,
  activeFilters: DashboardActiveFilter[],
): DashboardChartSnapshot {
  const sql = chart.querySql!;
  const res = executeDashboardSql(sql, sourceMap, {
    filters: activeFilters,
    generatedAt,
  });
  const cols = res.columns;
  const baseSnap: DashboardChartSnapshot = {
    chartId: chart.chartId,
    queryText: sql,
    formula: res.formula,
    generatedAt,
    groups: [],
  };
  if (chart.type === 'kpi') {
    const firstRow = res.rows[0];
    const valCol =
      chart.yField && cols.includes(chart.yField)
        ? chart.yField
        : (cols.find(c => typeof firstRow?.[c] === 'number') ?? cols[0]);
    const raw = firstRow && valCol ? firstRow[valCol] : null;
    const val = raw === null || raw === undefined ? null : Number(raw);
    baseSnap.current = {
      value: val !== null && Number.isFinite(val) ? val : null,
      trace: firstRow?.__trace ?? {
        sourceId: [...sourceMap.keys()][0] ?? 'sql',
        rowIndexes: [],
        rowNumbers: [],
        formula: res.formula,
        excludedCount: 0,
      },
    };
    return baseSnap;
  }
  if (chart.type === 'table') {
    const labelCol = chart.xField && cols.includes(chart.xField) ? chart.xField : cols[0];
    const valueCols = cols.filter(c => c !== labelCol);
    baseSnap.table = {
      columns: [labelCol || 'Group', ...valueCols],
      rows: res.rows.map(row => ({
        key: String(row[labelCol] ?? ''),
        cells: valueCols.map(c => {
          const v = row[c];
          const num = v === null || v === undefined ? null : Number(v);
          return {
            value: num !== null && Number.isFinite(num) ? num : null,
            trace: row.__trace,
          };
        }),
      })),
    };
    return baseSnap;
  }
  const xCol = chart.xField && cols.includes(chart.xField) ? chart.xField : cols[0];
  const valCol =
    chart.valueField && cols.includes(chart.valueField)
      ? chart.valueField
      : chart.yField && cols.includes(chart.yField)
        ? chart.yField
        : cols[cols.length - 1];
  const seriesCol =
    chart.seriesField && cols.includes(chart.seriesField)
      ? chart.seriesField
      : cols.length >= 3
        ? cols.find(c => c !== xCol && c !== valCol)
        : undefined;
  baseSnap.groups = res.rows.map(row => {
    const dims = [String(row[xCol] ?? '')];
    if (seriesCol) {
      dims.push(String(row[seriesCol] ?? ''));
    }
    const raw = row[valCol];
    const num = raw === null || raw === undefined ? null : Number(raw);
    return {
      key: dims.length > 1 ? JSON.stringify(dims) : dims[0],
      dimensions: dims,
      total: {
        value: num !== null && Number.isFinite(num) ? num : null,
        trace: row.__trace,
      },
    };
  });
  return baseSnap;
}

export function snapshotCharts(
  spec: DashboardSpec,
  loaded: Map<string, TableRow[] | DashboardSourceData>,
  generatedAt: string,
  activeFilters: DashboardActiveFilter[] = [],
): DashboardChartSnapshot[] {
  const normalizedSources = new Map<string, DashboardSourceData>();
  for (const [id, entry] of loaded.entries()) {
    normalizedSources.set(
      id,
      Array.isArray(entry)
        ? {
            source: {sourceId: id, kind: 'static' as const},
            columns: [...new Set(entry.flatMap(row => Object.keys(row)))],
            rows: entry,
            rowNumbers: entry.map((_, index) => index + 1),
            warnings: [],
          }
        : entry,
    );
  }
  const dataFor = (select: DashboardSelect): DashboardSourceData => {
    const data = normalizedSources.get(select.source);
    if (!data) {
      throw new DashboardSqlError(
        'load_source_failed',
        `Source not found: ${select.source}`,
      );
    }
    checkColumns(data, select);
    return data;
  };
  return spec.charts.map(chart => {
    try {
      let snapshot: DashboardChartSnapshot;
      if (chart.querySql) {
        snapshot = runSqlChart(chart, normalizedSources, generatedAt, activeFilters);
      } else {
        if (!chart.select) {
          throw new DashboardSqlError(
            'load_calc_failed',
            `Chart "${chart.chartId}" has neither select nor querySql.`,
          );
        }
        const source = dataFor(chart.select);
        const effectiveSelect = applySelectFilters(
          chart.select,
          activeFilters,
          source.columns,
        );
        snapshot = runSelect(
          chart.select.source,
          source.rows,
          effectiveSelect,
          generatedAt,
          source.rowNumbers,
        );
        snapshot.chartId = chart.chartId;
        snapshot.warnings = [...source.warnings, ...(snapshot.warnings ?? [])];
        if (chart.type === 'table') {
          const selects = [
            effectiveSelect,
            ...(chart.columns ?? []).map(column =>
              applySelectFilters(column.select, activeFilters, dataFor(column.select).columns),
            ),
          ];
          const grouped = new Map<string, Array<DashboardNumber | null>>();
          selects.forEach((select, index) => {
            const data = dataFor(select);
            const result = runSelect(
              select.source,
              data.rows,
              select,
              generatedAt,
              data.rowNumbers,
            );
            const groups = result.groups.length
              ? result.groups
              : result.current
                ? [{key: 'Total', total: result.current}]
                : [];
            for (const group of groups) {
              const cells =
                grouped.get(group.key) ??
                Array.from({length: selects.length}, () => null);
              cells[index] = group.total;
              grouped.set(group.key, cells);
            }
            if (index) {
              snapshot.warnings!.push(
                ...data.warnings,
                ...(result.warnings ?? []),
              );
            }
          });
          snapshot.table = {
            columns: [
              chart.select.groupBy?.column || 'Group',
              chart.primaryLabel || chart.select.value,
              ...(chart.columns ?? []).map(column => column.label),
            ],
            rows: [...grouped]
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, cells]) => ({key, cells})),
          };
        }
      }
      const numbers = [
        snapshot.current,
        snapshot.prior,
        ...snapshot.groups.map(group => group.total),
        ...(snapshot.table?.rows.flatMap(row => row.cells) ?? []),
      ];
      numbers.forEach((number, index) => {
        if (number) {
          number.trace.traceId = `${chart.chartId}:${index}`;
        }
      });
      snapshot.warnings = [...new Set(snapshot.warnings ?? [])];
      snapshot.trustBadge = computeTrustBadge(spec, chart);
      snapshot.diagnostics = runChartDiagnostics(chart, snapshot);
      return snapshot;
    } catch (error) {
      const errorCode: DashboardLoadErrorCode =
        error instanceof DashboardSqlError
          ? error.code
          : String(error instanceof Error ? error.message : error).includes('Source')
            ? 'load_source_failed'
            : 'load_calc_failed';
      return {
        chartId: chart.chartId,
        queryText: chart.querySql || (chart.select ? describeDashboardSelect(chart.select) : ''),
        formula: '',
        generatedAt,
        groups: [],
        trustBadge: computeTrustBadge(spec, chart),
        errorCode,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
}

export async function evaluateDashboard(
  spec: DashboardSpec,
  options: {activeFilters?: DashboardActiveFilter[]} = {},
): Promise<DashboardRun> {
  const sources = new Map<string, DashboardSourceData>();
  await Promise.all(
    spec.sources.map(async source => {
      try {
        sources.set(source.sourceId, await loadDashboardSource(source));
      } catch (error) {
        sources.set(source.sourceId, {
          source,
          columns: [],
          rows: [],
          rowNumbers: [],
          warnings: [],
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }),
  );
  const generatedAt = new Date().toISOString();
  const charts = snapshotCharts(
    spec,
    sources,
    generatedAt,
    options.activeFilters ?? [],
  );
  return {
    spec,
    sources,
    snapshot: {
      snapshotId: randomUUID(),
      dashboardId: spec.dashboardId,
      title: spec.title,
      generatedAt,
      trustBadge: computeTrustBadge(spec),
      diagnostics: charts.flatMap(c => c.diagnostics ?? []),
      charts,
    },
  };
}

export async function runDashboard(
  root: string,
  dashboardId: string,
): Promise<DashboardRun> {
  return evaluateDashboard(await loadDashboard(root, dashboardId));
}

export function dashboardTrace(
  run: DashboardRun,
  traceId: string,
  offset = 0,
  limit = 100,
) {
  for (const chart of run.snapshot.charts) {
    const number = [
      chart.current,
      chart.prior,
      ...chart.groups.map(group => group.total),
      ...(chart.table?.rows.flatMap(row => row.cells) ?? []),
    ].find(number => number?.trace.traceId === traceId);
    if (!number) {
      continue;
    }
    const data = run.sources.get(number.trace.sourceId)!;
    const start = Math.max(0, Math.floor(offset));
    const size = Math.max(1, Math.min(200, Math.floor(limit)));
    const {rows: _rows, ...source} = data.source;
    return {
      snapshotId: run.snapshot.snapshotId,
      chartId: chart.chartId,
      traceId,
      generatedAt: run.snapshot.generatedAt,
      source,
      columns: data.columns,
      value: number.value,
      formula: number.trace.formula,
      excludedCount: number.trace.excludedCount,
      warnings: data.warnings,
      totalRows: number.trace.rowIndexes.length,
      offset: start,
      rows: number.trace.rowIndexes
        .slice(start, start + size)
        .map(index => ({
          rowNumber: data.rowNumbers[index],
          values: data.rows[index],
        })),
    };
  }
  throw new Error('This value is not part of the open dashboard snapshot.');
}

export function dashboardTraceCsv(run: DashboardRun, traceId: string): string {
  const detail = dashboardTrace(run, traceId);
  const source = run.sources.get(detail.source.sourceId)!;
  const chart = run.snapshot.charts.find(
    item => item.chartId === detail.chartId,
  )!;
  const number = [
    chart.current,
    chart.prior,
    ...chart.groups.map(group => group.total),
    ...(chart.table?.rows.flatMap(row => row.cells) ?? []),
  ].find(item => item?.trace.traceId === traceId)!;
  const quote = (value: TableCell | undefined) =>
    `"${String(value ?? '').replaceAll('"', '""')}"`;
  const rows = [
    ['Source row', ...source.columns],
    ...number.trace.rowIndexes.map(index => [
      source.rowNumbers[index],
      ...source.columns.map(column => source.rows[index][column]),
    ]),
  ];
  return (
    '\uFEFF' + rows.map(row => row.map(quote).join(',')).join('\r\n') + '\r\n'
  );
}

function identifier(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(value)) {
    throw new Error('Dashboard ID is invalid.');
  }
  return value;
}

export function validateDashboard(spec: DashboardSpec): void {
  if (
    !spec.title?.trim() ||
    !Array.isArray(spec.sources) ||
    !Array.isArray(spec.charts) ||
    !spec.charts.length
  ) {
    throw new Error(
      'A dashboard needs a title, sources, and at least one chart.',
    );
  }
  const sourceIds = new Set<string>();
  for (const source of spec.sources) {
    if (
      !source.sourceId ||
      sourceIds.has(source.sourceId) ||
      !['csv', 'xlsx', 'static', 'json', 'sqlite'].includes(source.kind)
    ) {
      throw new Error(
        'Dashboard sources need unique IDs and a supported kind.',
      );
    }
    if (
      source.headerRow !== undefined &&
      (!Number.isInteger(source.headerRow) || source.headerRow < 1)
    ) {
      throw new Error('Header row must be a positive integer.');
    }
    sourceIds.add(source.sourceId);
  }
  const ids = new Set<string>();
  for (const chart of spec.charts) {
    if (
      !chart.chartId ||
      ids.has(chart.chartId) ||
      !CHART_TYPES.includes(chart.type)
    ) {
      throw new Error('Dashboard charts need unique IDs and a supported type.');
    }
    ids.add(chart.chartId);
    if (chart.querySql) {
      validateReadOnlySql(chart.querySql);
    } else if (!chart.select) {
      throw new Error(`Chart ${chart.chartId} needs either select or querySql.`);
    }
    for (const select of [
      ...(chart.select ? [chart.select] : []),
      ...(chart.columns ?? []).map(column => column.select),
    ]) {
      if (
        !select ||
        !sourceIds.has(select.source) ||
        !select.value ||
        !['sum', 'avg', 'count'].includes(select.agg)
      ) {
        throw new Error(`Invalid query for chart ${chart.chartId}.`);
      }
      if (select.scale !== undefined && !Number.isFinite(select.scale)) {
        throw new Error('Query scale must be finite.');
      }
      if (
        select.priorDays !== undefined &&
        (!Number.isInteger(select.priorDays) ||
          select.priorDays < 1 ||
          !select.dateColumn ||
          select.groupBy)
      ) {
        throw new Error(
          'Period comparisons need a positive number of days and a date column, without grouping.',
        );
      }
      if (
        select.filter?.some(
          filter => !filter.col || !['eq', 'gte', 'lte'].includes(filter.op),
        )
      ) {
        throw new Error('Unsupported dashboard filter.');
      }
    }
    if (chart.type === 'line' && !chart.querySql && !chart.select?.groupBy) {
      throw new Error('Line charts need a grouping column.');
    }
  }
}

export async function saveDashboard(
  root: string,
  spec: DashboardSpec,
  expectedRevision?: number,
): Promise<DashboardSpec> {
  validateDashboard(spec);
  const dashboardId = identifier(spec.dashboardId || randomUUID());
  const existing = await loadDashboard(root, dashboardId).catch(error => {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw error;
  });
  if (
    expectedRevision !== undefined &&
    expectedRevision !== (existing?.revision || 0)
  ) {
    throw new Error(
      'Dashboard changed. Read the current revision before editing.',
    );
  }
  const value: DashboardSpec = {
    ...spec,
    schemaVersion: 1,
    dashboardId,
    revision: (existing?.revision || 0) + 1,
    updatedAt: new Date().toISOString(),
    charts: spec.charts.map(chart => ({
      ...chart,
      queryText:
        chart.querySql ||
        (chart.select ? describeDashboardSelect(chart.select) : chart.queryText),
    })),
  };
  const directory = join(root, 'dashboards');
  await mkdir(directory, {recursive: true});
  const target = join(directory, `${dashboardId}.json`);
  const temporary = join(directory, `${dashboardId}.${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify(value, null, 2), 'utf8');
  await rename(temporary, target);
  return value;
}

export async function loadDashboard(
  root: string,
  dashboardId: string,
): Promise<DashboardSpec> {
  const spec = JSON.parse(
    await readFile(
      join(root, 'dashboards', `${identifier(dashboardId)}.json`),
      'utf8',
    ),
  ) as DashboardSpec;
  validateDashboard(spec);
  return spec;
}

export async function listDashboards(root: string): Promise<DashboardSpec[]> {
  const names = await readdir(join(root, 'dashboards')).catch(error => {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  });
  const values: DashboardSpec[] = [];
  for (const name of names.filter(item => item.endsWith('.json'))) {
    values.push(await loadDashboard(root, name.slice(0, -5)));
  }
  return values.sort((a, b) =>
    String(b.updatedAt).localeCompare(String(a.updatedAt)),
  );
}

/**
 * Generates a self-contained offline interactive HTML file bundling the dashboard
 * snapshot, chart metadata, CDS styling, cross-filtering, tooltips, and table sorting.
 */
export function exportDashboardHtml(
  run: DashboardRun,
  options: {title?: string} = {},
): string {
  const esc = (s: unknown) =>
    String(s ?? '').replace(
      /[&<>"']/g,
      c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[c]!,
    );
  const title = options.title || run.snapshot.title || 'Dashboard';
  const payload = JSON.stringify({
    title,
    snapshot: run.snapshot,
    metas: run.spec.charts.map(c => ({
      chartId: c.chartId,
      title: c.title,
      type: c.type,
      format: c.format,
      currency: c.currency,
      orientation: c.orientation,
      watch: c.watch,
      xField: c.xField,
      yField: c.yField,
      seriesField: c.seriesField,
    })),
  }).replace(/<\/script/gi, '<\\/script');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)}</title>
<style>
:root{--cds-chart-categorical-1:#2563eb;--cds-chart-categorical-2:#ea580c;--cds-chart-categorical-3:#0891b2;--cds-chart-categorical-4:#ca8a04;--cds-chart-categorical-5:#db2777;--cds-chart-categorical-6:#16a34a;--cds-chart-categorical-7:#7c3aed;--cds-chart-categorical-8:#dc2626;font-family:system-ui,-apple-system,sans-serif;color:#18181b;background:#fafafa}
body{margin:0;padding:24px;max-width:1280px;margin-inline:auto}
header{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;padding-bottom:14px;border-bottom:1px solid #e4e4e7;margin-bottom:16px}
h1{font-size:20px;margin:0}
.meta{font-size:12px;color:#71717a;display:flex;gap:10px;align-items:center}
.badge{padding:2px 8px;border-radius:999px;background:#e0f2fe;color:#0369a1;font-weight:500}
.filters{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px}
.pill{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;background:#eef2ff;color:#1d4ed8;font-size:12px;border:1px solid #bfdbfe;cursor:pointer}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px}
.card{background:#fff;border:1px solid #e4e4e7;border-radius:12px;padding:16px;position:relative}
.card h2{font-size:15px;margin:0 0 10px}
.kpi{font-size:28px;font-weight:600}
.bar-row{display:flex;align-items:center;gap:8px;margin:6px 0;font-size:12px;cursor:pointer}
.bar-track{flex:1;height:18px;background:#f4f4f5;border-radius:4px;overflow:hidden}
.bar-fill{height:100%;background:var(--cds-chart-categorical-1)}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{padding:7px 8px;border-bottom:1px solid #e4e4e7;text-align:left}
th{cursor:pointer;color:#52525b;font-weight:600}
.tooltip{position:fixed;pointer-events:none;background:#18181b;color:#fff;padding:6px 10px;border-radius:6px;font-size:12px;display:none;z-index:20}
</style>
</head>
<body>
<header>
  <h1>${esc(title)}</h1>
  <div class="meta">
    <span class="badge">${esc(run.snapshot.trustBadge || 'verified_file')}</span>
    <span>Generated ${esc(new Date(run.snapshot.generatedAt).toLocaleString())}</span>
  </div>
</header>
<div id="mp-dash-filters" class="filters"></div>
<main id="mp-dash-root" class="grid"></main>
<div id="mp-dash-tooltip" class="tooltip"></div>
<script id="mp-dash-export-state" type="application/json">${payload}</script>
<script>
(function(){
  const state = JSON.parse(document.getElementById('mp-dash-export-state').textContent);
  let activeFilters = [];
  let tableSort = {};
  const colors = ['#2563eb','#ea580c','#0891b2','#ca8a04','#db2777','#16a34a','#7c3aed','#dc2626'];
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const tip = document.getElementById('mp-dash-tooltip');
  function toggleFilter(dim) {
    const idx = activeFilters.indexOf(dim);
    if (idx >= 0) activeFilters.splice(idx, 1); else activeFilters.push(dim);
    render();
  }
  function crossFilter(groups) {
    if (!activeFilters.length) return groups;
    return groups.filter(g => activeFilters.some(f => g.dimensions.includes(f)));
  }
  function fmt(v, meta) {
    if (v === null || v === undefined || !Number.isFinite(v)) return '—';
    if (meta.format === 'percent') return v.toFixed(1) + '%';
    if (meta.format === 'money') return new Intl.NumberFormat('en-US', {style:'currency',currency:meta.currency||'USD',maximumFractionDigits:2}).format(v);
    return new Intl.NumberFormat('en-US', {maximumFractionDigits:2}).format(v);
  }
  function render() {
    const fEl = document.getElementById('mp-dash-filters');
    fEl.innerHTML = activeFilters.map(f => '<button class="pill" data-clear="'+esc(f)+'">Filter: '+esc(f)+' ×</button>').join('');
    fEl.querySelectorAll('[data-clear]').forEach(b => b.onclick = () => toggleFilter(b.getAttribute('data-clear')));
    const byId = new Map(state.metas.map(m => [m.chartId, m]));
    const root = document.getElementById('mp-dash-root');
    root.innerHTML = state.snapshot.charts.map(c => {
      const m = byId.get(c.chartId) || {title: c.chartId, type: 'bar'};
      if (c.error) return '<section class="card"><h2>'+esc(m.title)+'</h2><p>'+esc(c.error)+'</p></section>';
      if (m.type === 'kpi') {
        return '<section class="card"><h2>'+esc(m.title)+'</h2><div class="kpi">'+esc(fmt(c.current && c.current.value, m))+'</div></section>';
      }
      if (m.type === 'table' && c.table) {
        const rows = [...c.table.rows];
        const s = tableSort[c.chartId];
        if (s) rows.sort((a,b) => {
          const av = s.col === 0 ? a.key : (a.cells[s.col-1] && a.cells[s.col-1].value || 0);
          const bv = s.col === 0 ? b.key : (b.cells[s.col-1] && b.cells[s.col-1].value || 0);
          return s.dir * (typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv)));
        });
        return '<section class="card"><h2>'+esc(m.title)+'</h2><table><thead><tr>' +
          c.table.columns.map((col, idx) => '<th data-sort="'+esc(c.chartId)+':'+idx+'">'+esc(col)+'</th>').join('') +
          '</tr></thead><tbody>' +
          rows.map(r => '<tr><td>'+esc(r.key)+'</td>'+r.cells.map(cell => '<td>'+esc(fmt(cell && cell.value, m))+'</td>').join('')+'</tr>').join('') +
          '</tbody></table></section>';
      }
      const groups = crossFilter(c.groups || []);
      const max = Math.max(1, ...groups.map(g => Math.abs(g.total && g.total.value || 0)));
      return '<section class="card"><h2>'+esc(m.title)+'</h2>' +
        groups.map((g, i) => {
          const val = g.total && g.total.value || 0;
          const pct = Math.min(100, Math.round((Math.abs(val) / max) * 100));
          return '<div class="bar-row" data-dim="'+esc(g.dimensions[0]||g.key)+'" data-tip="'+esc(g.dimensions.join(' · ')+': '+fmt(val, m))+'"><span style="min-width:90px">'+esc(g.dimensions.join(' / '))+'</span><div class="bar-track"><div class="bar-fill" style="width:'+pct+'%;background:'+colors[i%colors.length]+'"></div></div><span>'+esc(fmt(val, m))+'</span></div>';
        }).join('') + '</section>';
    }).join('');
    root.querySelectorAll('[data-dim]').forEach(el => {
      el.onclick = () => toggleFilter(el.getAttribute('data-dim'));
      el.onmousemove = e => { tip.style.display='block'; tip.style.left=(e.clientX+12)+'px'; tip.style.top=(e.clientY+12)+'px'; tip.textContent=el.getAttribute('data-tip'); };
      el.onmouseleave = () => { tip.style.display='none'; };
    });
    root.querySelectorAll('[data-sort]').forEach(th => {
      th.onclick = () => {
        const [cid, col] = th.getAttribute('data-sort').split(':');
        const cur = tableSort[cid];
        tableSort[cid] = { col: Number(col), dir: cur && cur.col === Number(col) ? -cur.dir : -1 };
        render();
      };
    });
  }
  render();
})();
</script>
</body>
</html>`;
}
