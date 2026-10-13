import {mkdir, readFile, readdir, rename, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import ExcelJS from 'exceljs';

export type DashboardSourceKind = 'csv' | 'xlsx' | 'static';
export type DashboardAgg = 'sum' | 'avg' | 'count';
export type DashboardChartType = 'kpi' | 'line' | 'table';
export type DashboardFormat = 'money' | 'number' | 'percent';
export type TableCell = string | number | boolean | null;
export type TableRow = Record<string, TableCell>;

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
  select: DashboardSelect;
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
  warnings?: string[];
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
  return source.kind === 'csv'
    ? csvData(await readFile(source.path, 'utf8'), source)
    : xlsxData(source);
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

export function snapshotCharts(
  spec: DashboardSpec,
  loaded: Map<string, TableRow[] | DashboardSourceData>,
  generatedAt: string,
): DashboardChartSnapshot[] {
  const dataFor = (select: DashboardSelect): DashboardSourceData => {
    const loadedSource = loaded.get(select.source);
    if (!loadedSource) {
      throw new Error(`Source not found: ${select.source}`);
    }
    const data = Array.isArray(loadedSource)
      ? {
          source: {sourceId: select.source, kind: 'static' as const},
          columns: [...new Set(loadedSource.flatMap(row => Object.keys(row)))],
          rows: loadedSource,
          rowNumbers: loadedSource.map((_, index) => index + 1),
          warnings: [],
        }
      : loadedSource;
    checkColumns(data, select);
    return data;
  };
  return spec.charts.map(chart => {
    try {
      const source = dataFor(chart.select);
      const snapshot = runSelect(
        chart.select.source,
        source.rows,
        chart.select,
        generatedAt,
        source.rowNumbers,
      );
      snapshot.chartId = chart.chartId;
      snapshot.warnings = [...source.warnings, ...(snapshot.warnings ?? [])];
      if (chart.type === 'table') {
        const selects = [
          chart.select,
          ...(chart.columns ?? []).map(column => column.select),
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
      snapshot.warnings = [...new Set(snapshot.warnings)];
      return snapshot;
    } catch (error) {
      return {
        chartId: chart.chartId,
        queryText: describeDashboardSelect(chart.select),
        formula: '',
        generatedAt,
        groups: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
}

export async function evaluateDashboard(
  spec: DashboardSpec,
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
  return {
    spec,
    sources,
    snapshot: {
      snapshotId: randomUUID(),
      dashboardId: spec.dashboardId,
      title: spec.title,
      generatedAt,
      charts: snapshotCharts(spec, sources, generatedAt),
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
      !['csv', 'xlsx', 'static'].includes(source.kind)
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
      !['kpi', 'line', 'table'].includes(chart.type)
    ) {
      throw new Error('Dashboard charts need unique IDs and a supported type.');
    }
    ids.add(chart.chartId);
    for (const select of [
      chart.select,
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
    if (chart.type === 'line' && !chart.select.groupBy) {
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
      queryText: describeDashboardSelect(chart.select),
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
