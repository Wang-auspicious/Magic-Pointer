import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import {
  dashboardTrace,
  dashboardTraceCsv,
  evaluateDashboard,
  parseCsv,
  readXlsxRows,
  runSelect,
  snapshotCharts,
} from '../electron/runtime/dashboard';
import {createDashboardTools} from '../electron/runtime/dashboard_tools';
import {ToolRegistry} from '../electron/runtime/tools';
import {EventSession} from '../electron/runtime/session';
import {prepareTaskContext} from '../electron/runtime/context_prepare';
import {taskSources} from '../electron/runtime/context';

test('dashboard counts text identifiers and excludes empty values from averages', () => {
  const rows = parseCsv('id,value\n001,10\n002,\n003,20\n');
  assert.equal(
    rows[0].id,
    '001',
    'CSV identifiers must retain their leading zeroes',
  );
  assert.equal(
    runSelect('source', rows, {source: 'source', value: 'id', agg: 'count'}, '')
      .current?.value,
    3,
  );
  assert.equal(
    runSelect(
      'source',
      rows,
      {source: 'source', value: 'value', agg: 'avg'},
      '',
    ).current?.value,
    15,
    'blank cells are not measured zeroes',
  );
});

test('dashboard Excel date cells remain usable by period queries', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'mp-dashboard-'));
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Sales');
  sheet.addRow(['date', 'revenue']);
  sheet.addRow([new Date('2026-01-01T00:00:00Z'), 10]);
  sheet.addRow([]);
  sheet.addRow([new Date('2026-01-02T00:00:00Z'), 20]);
  const file = path.join(folder, 'sales.xlsx');
  await workbook.xlsx.writeFile(file);
  const rows = await readXlsxRows(file, 'Sales');
  assert.equal(rows[0].date, '2026-01-01T00:00:00.000Z');
  const result = runSelect(
    'sales',
    rows,
    {
      source: 'sales',
      value: 'revenue',
      agg: 'sum',
      dateColumn: 'date',
      priorDays: 1,
    },
    '',
  );
  assert.equal(result.current?.value, 20);
  assert.equal(result.prior?.value, 10);
});

test('dashboard table headers align with every computed metric', () => {
  const select = {
    source: 'sales',
    value: 'revenue',
    agg: 'sum' as const,
    groupBy: {column: 'channel'},
  };
  const spec = {
    schemaVersion: 1 as const,
    dashboardId: 'sales',
    title: 'Sales',
    updatedAt: '',
    sources: [],
    charts: [
      {
        chartId: 'channels',
        title: 'Channels',
        type: 'table' as const,
        queryText: '',
        primaryLabel: 'Revenue',
        select,
        columns: [
          {
            label: 'Orders',
            select: {...select, value: 'order', agg: 'count' as const},
          },
        ],
      },
    ],
  };
  const snapshots = snapshotCharts(
    spec,
    new Map([['sales', [{channel: 'Direct', revenue: 30, order: 'order-a'}]]]),
    '',
  );
  assert.deepEqual(snapshots[0].table?.columns, [
    'channel',
    'Revenue',
    'Orders',
  ]);
  assert.deepEqual(
    snapshots[0].table?.rows[0].cells.map(cell => cell?.value),
    [30, 1],
  );
});

test('dashboard traces retain physical rows and the values that produced the displayed snapshot', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'mp-dashboard-trace-'));
  const file = path.join(folder, 'orders.csv');
  await writeFile(file, 'id,value\n001,10\n\n003,20\n');
  const run = await evaluateDashboard({
    schemaVersion: 1,
    dashboardId: 'trace',
    title: 'Orders',
    updatedAt: '',
    sources: [{sourceId: 'orders', kind: 'csv', path: file}],
    charts: [
      {
        chartId: 'total',
        title: 'Total',
        type: 'kpi',
        queryText: '',
        select: {source: 'orders', value: 'value', agg: 'sum'},
      },
    ],
  });
  const traceId = run.snapshot.charts[0].current!.trace.traceId!;
  await writeFile(file, 'id,value\n001,999\n');
  const detail = dashboardTrace(run, traceId);
  assert.equal(detail.value, 30);
  assert.deepEqual(
    detail.rows.map(row => row.rowNumber),
    [2, 4],
  );
  assert.deepEqual(
    detail.rows.map(row => row.values.value),
    ['10', '20'],
  );
  assert.match(dashboardTraceCsv(run, traceId), /"4","003","20"/);
  assert.doesNotMatch(dashboardTraceCsv(run, traceId), /999/);
});

test('Dashboard tools create and edit real data without replacing other charts or bypassing source access', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'mp-dashboard-tools-'));
  const file = path.join(folder, 'orders.csv');
  await writeFile(file, 'id,value\nA,10\nB,20\n');
  const registry = new ToolRegistry();
  for (const tool of createDashboardTools({
    userDataDir: folder,
    sources: () => [],
    authorizeAccess: request => ({
      allowed:
        request.paths?.every(item => path.resolve(item) === file) === true,
    }),
  })) {
    registry.register(tool);
  }
  const chart = {
    chartId: 'total',
    title: 'Total',
    type: 'kpi',
    select: {source: 'orders', value: 'value', agg: 'sum'},
  };
  const call = async (name: string, args: Record<string, unknown>) =>
    registry.execute({id: name, name, arguments: args});
  const created = await call('Dashboard.create', {
    title: 'Orders',
    sources: [{sourceId: 'orders', kind: 'csv', path: file}],
    charts: [chart],
  });
  assert.equal(created.is_error, false, created.error_message);
  const saved = created.value as any;
  assert.equal(saved.charts[0].current.value, 30);
  const edited = await call('Dashboard.update', {
    dashboard_id: saved.dashboardId,
    expected_revision: saved.revision,
    operations: [
      {op: 'rename', title: 'Updated'},
      {
        op: 'set_chart',
        chart: {
          ...chart,
          chartId: 'average',
          select: {...chart.select, agg: 'avg'},
        },
      },
    ],
  });
  assert.equal(edited.is_error, false, edited.error_message);
  assert.equal((edited.value as any).charts.length, 2);
  assert.equal(
    (
      await call('Dashboard.update', {
        dashboard_id: saved.dashboardId,
        expected_revision: saved.revision,
        operations: [{op: 'rename', title: 'Stale'}],
      })
    ).is_error,
    true,
  );
  const denied = await call('Dashboard.inspect_source', {
    source: {
      sourceId: 'other',
      kind: 'csv',
      path: path.join(folder, 'unselected.csv'),
    },
  });
  assert.equal(denied.failure_type, 'permission_denied');
  await registry.close();
});

test('Dashboard tools honor the exact source grant for a projectless attachment', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'mp-dashboard-attachment-'));
  const file = path.join(folder, 'selected.csv');
  await writeFile(file, 'id,value\nA,10\n');
  const session = await EventSession.open(folder, 'dashboard-attachment');
  const registry = new ToolRegistry();
  const prepared = await prepareTaskContext(
    session,
    {attachments: [file], workspacePath: ''},
    {root: folder, userDataDir: folder, registry},
  );
  for (const tool of createDashboardTools({
    userDataDir: folder,
    authorizeAccess: prepared.authorizeAccess,
    sources: () => taskSources(session.events),
  })) {
    registry.register(tool);
  }
  const result = await registry.execute({
    id: 'read-selected',
    name: 'Dashboard.inspect_source',
    arguments: {source: {sourceId: 'selected', kind: 'csv', path: file}},
  });
  assert.equal(result.is_error, false, result.error_message);
  assert.equal((result.value as any).rows[0].values.id, 'A');
  await registry.close();
});
