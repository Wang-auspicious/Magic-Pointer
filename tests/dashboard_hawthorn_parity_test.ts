import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const requireFromRoot = createRequire(path.resolve(process.cwd(), 'package.json'));
import {
  evaluateDashboard,
  exportDashboardHtml,
  loadDashboardSource,
  validateDashboard,
  type DashboardSourceData,
  type DashboardSpec,
} from '../electron/runtime/dashboard';
import {
  DashboardSqlError,
  executeDashboardSql,
  validateReadOnlySql,
} from '../electron/runtime/dashboard_sql';
import {createDashboardTools} from '../electron/runtime/dashboard_tools';

function makeSources(): Map<string, DashboardSourceData> {
  const orders: DashboardSourceData = {
    source: {sourceId: 'orders', kind: 'static'},
    columns: ['order_id', 'customer_id', 'region', 'amount', 'order_date', 'status'],
    rows: [
      {order_id: 'o1', customer_id: 'c1', region: 'North', amount: 100, order_date: '2026-01-05', status: 'paid'},
      {order_id: 'o2', customer_id: 'c1', region: 'North', amount: 200, order_date: '2026-01-12', status: 'paid'},
      {order_id: 'o3', customer_id: 'c2', region: 'South', amount: 50, order_date: '2026-02-03', status: 'refunded'},
      {order_id: 'o4', customer_id: 'c3', region: 'East', amount: 300, order_date: '2026-02-14', status: 'paid'},
      {order_id: 'o5', customer_id: 'c2', region: 'South', amount: null, order_date: '2026-02-20', status: 'paid'},
    ],
    rowNumbers: [2, 3, 4, 5, 6],
    warnings: [],
  };
  const customers: DashboardSourceData = {
    source: {sourceId: 'customers', kind: 'static'},
    columns: ['customer_id', 'segment'],
    rows: [
      {customer_id: 'c1', segment: 'Enterprise'},
      {customer_id: 'c2', segment: 'SMB'},
      {customer_id: 'c3', segment: 'Enterprise'},
    ],
    rowNumbers: [1, 2, 3],
    warnings: [],
  };
  return new Map([
    ['orders', orders],
    ['customers', customers],
  ]);
}

test('dashboard_sql rejects DDL/DML and multi-statement queries', () => {
  for (const unsafe of [
    'DROP TABLE orders',
    'DELETE FROM orders WHERE amount > 0',
    'INSERT INTO orders VALUES (1)',
    'UPDATE orders SET amount = 0',
    'SELECT * FROM orders; DROP TABLE orders',
    'CREATE TABLE evil (id INT)',
  ]) {
    assert.throws(() => validateReadOnlySql(unsafe), DashboardSqlError);
  }
});

test('dashboard_sql executes CTEs, JOINs, WHERE, GROUP BY, HAVING, ORDER BY, LIMIT, aggregates, CASE WHEN, DATE_TRUNC, and $filters', () => {
  const sources = makeSources();
  const res = executeDashboardSql(
    `
    WITH paid_orders AS (
      SELECT o.order_id, o.customer_id, o.region, o.amount, o.order_date, c.segment
      FROM orders o
      INNER JOIN customers c ON o.customer_id = c.customer_id
      WHERE o.status = 'paid' AND o.amount IS NOT NULL AND $filters
    )
    SELECT
      DATE_TRUNC('month', order_date) AS month,
      segment,
      COUNT(DISTINCT customer_id) AS customers,
      SUM(amount) AS revenue,
      MEDIAN(amount) AS median_amount,
      CASE WHEN SUM(amount) >= 300 THEN 'high' ELSE 'normal' END AS tier
    FROM paid_orders
    GROUP BY DATE_TRUNC('month', order_date), segment
    HAVING SUM(amount) > 0
    ORDER BY revenue DESC
    LIMIT 10
    `,
    sources,
    {
      filters: [{field: 'segment', op: 'eq', values: ['Enterprise']}],
    },
  );

  assert.equal(res.rows.length, 2);
  assert.equal(res.rows[0].month, '2026-01-01');
  assert.equal(res.rows[0].segment, 'Enterprise');
  assert.equal(res.rows[0].revenue, 300);
  assert.equal(res.rows[0].customers, 1);
  assert.equal(res.rows[0].median_amount, 150);
  assert.equal(res.rows[0].tier, 'high');
  assert.deepEqual(res.rows[0].__trace.rowNumbers, [2, 3]);
  assert.equal(res.rows[0].__trace.sourceId, 'orders');
});

test('dashboard_sql supports LIKE, IN, BETWEEN, arithmetic, and structured error codes', () => {
  const sources = makeSources();
  const res = executeDashboardSql(
    `
    SELECT region, ROUND(SUM(amount * 1.1), 2) AS taxed, MIN(amount) AS min_amt, MAX(amount) AS max_amt
    FROM orders
    WHERE region IN ('North', 'East') AND order_date BETWEEN '2026-01-01' AND '2026-02-28' AND status LIKE 'pa%'
    GROUP BY region
    ORDER BY taxed DESC, region ASC
    `,
    sources,
  );
  assert.equal(res.rows.length, 2);
  assert.ok(Math.abs(Number(res.rows[0].taxed) - 330) < 0.001);
  assert.equal(res.rows[0].min_amt, 300);
  assert.equal(res.rows[0].max_amt, 300);

  assert.throws(
    () => executeDashboardSql('SELECT * FROM missing_table', sources),
    err => err instanceof DashboardSqlError && err.code === 'load_source_failed',
  );
  assert.throws(
    () => executeDashboardSql('SELECT UNKNOWN_FUNC(amount) FROM orders', sources),
    err => err instanceof DashboardSqlError && err.code === 'load_calc_failed',
  );
});

test('dashboard loads json and sqlite sources with rowNumbers', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mp-dash-src-'));
  try {
    const jsonPath = path.join(dir, 'metrics.json');
    await writeFile(
      jsonPath,
      JSON.stringify([
        {day: '2026-03-01', visits: 42},
        {day: '2026-03-02', visits: 58},
      ]),
    );
    const jsonData = await loadDashboardSource({
      sourceId: 'web',
      kind: 'json',
      path: jsonPath,
    });
    assert.equal(jsonData.rows.length, 2);
    assert.deepEqual(jsonData.rowNumbers, [1, 2]);
    assert.deepEqual(jsonData.columns, ['day', 'visits']);

    const {DatabaseSync} = await import('node:sqlite');
    const dbPath = path.join(dir, 'warehouse.sqlite');
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE sales (region TEXT, amount REAL)');
    db.exec("INSERT INTO sales VALUES ('North', 120), ('South', 80)");
    db.close();

    const sqliteData = await loadDashboardSource({
      sourceId: 'wh',
      kind: 'sqlite',
      path: dbPath,
      table: 'sales',
    });
    assert.equal(sqliteData.rows.length, 2);
    assert.deepEqual(sqliteData.rowNumbers, [1, 2]);
    assert.equal(sqliteData.rows[0].region, 'North');
    assert.equal(sqliteData.rows[0].amount, 120);
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});

test('dashboard evaluates extended chart types, querySql, cross-filters, QA diagnostics, trust badges, and interactive HTML export', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mp-dash-eval-'));
  try {
    const csvPath = path.join(dir, 'sales.csv');
    await writeFile(
      csvPath,
      [
        'date,region,channel,revenue,cost',
        '2026-01-01,North,Direct,100,40',
        '2026-01-01,South,Partner,80,30',
        '2026-01-02,North,Direct,150,50',
        '2026-01-02,South,Partner,90,35',
      ].join('\n'),
    );

    const spec: DashboardSpec = {
      schemaVersion: 1,
      dashboardId: 'hawthorn-test',
      title: 'Hawthorn Parity',
      updatedAt: '',
      sources: [{sourceId: 'sales', kind: 'csv', path: csvPath}],
      charts: [
        {
          chartId: 'kpi_rev',
          title: 'Total Revenue',
          type: 'kpi',
          queryText: '',
          querySql: 'SELECT SUM(revenue) AS value FROM sales WHERE $filters',
          format: 'money',
          currency: 'USD',
          watch: {target: 400, label: 'Target'},
        },
        {
          chartId: 'bar_region',
          title: 'Revenue by Region',
          type: 'stacked_bar',
          queryText: '',
          querySql: 'SELECT region, channel, SUM(revenue) AS total FROM sales WHERE $filters GROUP BY region, channel ORDER BY region',
          xField: 'region',
          seriesField: 'channel',
          yField: 'total',
        },
        {
          chartId: 'scatter_rev_cost',
          title: 'Revenue vs Cost',
          type: 'scatter',
          queryText: '',
          querySql: 'SELECT cost, revenue, region FROM sales WHERE $filters',
          xField: 'cost',
          yField: 'revenue',
          seriesField: 'region',
        },
        {
          chartId: 'heat_matrix',
          title: 'Region x Channel',
          type: 'heatmap',
          queryText: '',
          querySql: 'SELECT region, channel, SUM(revenue) AS total FROM sales GROUP BY region, channel',
          xField: 'region',
          yField: 'channel',
          valueField: 'total',
        },
        {
          chartId: 'donut_share',
          title: 'Channel Share',
          type: 'donut',
          queryText: '',
          select: {source: 'sales', value: 'revenue', agg: 'sum', groupBy: {column: 'channel'}},
        },
        {
          chartId: 'empty_bar',
          title: 'Empty Check',
          type: 'bar',
          queryText: '',
          querySql: "SELECT region, SUM(revenue) AS total FROM sales WHERE region = 'Nowhere' GROUP BY region",
          xField: 'region',
          yField: 'total',
        },
      ],
    };

    validateDashboard(spec);
    const run = await evaluateDashboard(spec);
    assert.equal(run.snapshot.charts[0].current?.value, 420);
    assert.equal(run.snapshot.charts[0].trustBadge, 'workspace_sql');
    assert.ok(run.snapshot.charts[0].current?.trace.traceId);
    assert.equal(run.snapshot.charts[1].groups.length, 2);
    assert.equal(run.snapshot.charts[2].groups.length, 4);
    assert.equal(run.snapshot.charts[3].groups.length, 2);
    assert.equal(run.snapshot.charts[4].groups.length, 2);
    assert.ok(
      run.snapshot.charts[5].diagnostics?.some(d => d.code === 'empty_chart'),
      'empty chart must emit empty_chart QA diagnostic',
    );

    // Cross-filter evaluation
    const filteredRun = await evaluateDashboard(spec, {
      activeFilters: [{field: 'region', op: 'eq', values: ['North']}],
    });
    assert.equal(filteredRun.snapshot.charts[0].current?.value, 250);

    // Interactive HTML export
    const html = exportDashboardHtml(run);
    assert.match(html, /Hawthorn Parity/);
    assert.match(html, /mp-dash-export-state/);
    assert.match(html, /toggleFilter|crossFilter/);

    // Tools schema accepts extended types & querySql
    const tools = createDashboardTools({
      userDataDir: dir,
      sources: () => [],
      authorizeAccess: () => ({allowed: true}),
    });
    const createTool = tools.find(t => t.name === 'Dashboard.create')!;
    const created = (await createTool.execute(
      {
        title: 'Tool SQL Dash',
        sources: [{sourceId: 'sales', kind: 'csv', path: csvPath}],
        charts: [
          {
            chartId: 'c1',
            title: 'Bar',
            type: 'bar',
            querySql: 'SELECT region, SUM(revenue) AS total FROM sales GROUP BY region',
            xField: 'region',
            yField: 'total',
          },
        ],
      },
      {} as never,
    )) as {dashboardId: string; charts: Array<{current?: {value: number}; groupCount: number}>};
    assert.ok(created.dashboardId);
    assert.equal(created.charts[0].groupCount, 2);
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});

test('DashboardStore manages cross-filters, hoveredX sync, hiddenSeries, and personVsAgentHistory undo/redo', () => {
  requireFromRoot('./electron/renderer/dashboard_store');
  const dashboardStoreApi = (
    globalThis as unknown as {
      DashboardStore: {
        createDashboardStore: (
          snapshot: unknown,
          metas: unknown[],
        ) => {
          toggleFilter: (filter: {
            field: string;
            op: 'eq';
            values: string[];
          }) => void;
          setHoveredX: (x: string | null) => void;
          toggleSeries: (chartId: string, series: string) => void;
          applyEdit: (label: string, actor: string, snapshot: unknown) => void;
          undo: () => void;
          redo: () => void;
          getState: () => {
            activeFilters: unknown[];
            hoveredX: string | null;
            hiddenSeries: Map<string, Set<string>>;
            snapshot: {charts: unknown[]};
            canUndo: boolean;
            canRedo: boolean;
            historyStats: {
              agentEdits: number;
              personUndidAgent: number;
              personRedidAgent: number;
            };
          };
        };
      };
    }
  ).DashboardStore;
  const store = dashboardStoreApi.createDashboardStore(
    {
      generatedAt: '2026-01-01T00:00:00Z',
      charts: [
        {
          chartId: 'c1',
          queryText: 'SELECT ...',
          groups: [
            {key: 'North', dimensions: ['North'], total: {value: 100, trace: {traceId: 'c1:0'}}},
            {key: 'South', dimensions: ['South'], total: {value: 50, trace: {traceId: 'c1:1'}}},
          ],
        },
      ],
    },
    [{chartId: 'c1', title: 'By Region', type: 'bar'}],
  );

  store.toggleFilter({field: 'region', op: 'eq', values: ['North']});
  assert.equal(store.getState().activeFilters.length, 1);
  store.setHoveredX('North');
  assert.equal(store.getState().hoveredX, 'North');
  store.toggleSeries('c1', 'Direct');
  assert.equal(store.getState().hiddenSeries.get('c1')?.has('Direct'), true);

  store.applyEdit('Agent switched to pie', 'agent', {
    generatedAt: '2026-01-01T00:01:00Z',
    charts: store.getState().snapshot.charts,
  });
  assert.equal(store.getState().canUndo, true);
  assert.equal(store.getState().historyStats.agentEdits, 1);

  store.undo();
  assert.equal(store.getState().historyStats.personUndidAgent, 1);
  assert.equal(store.getState().canRedo, true);
  store.redo();
  assert.equal(store.getState().historyStats.personRedidAgent, 1);
});

test('DashboardCharts renders all 9 chart primitives with CDS tokens and DataTable controls', () => {
  requireFromRoot('./electron/renderer/dashboard_charts');
  const dashboardChartsApi = (
    globalThis as unknown as {
      DashboardCharts: {
        renderChart: (chart: unknown, meta: unknown) => string;
      };
    }
  ).DashboardCharts;
  const types = [
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
  ] as const;

  for (const type of types) {
    const html = dashboardChartsApi.renderChart(
      {
        chartId: `chart_${type}`,
        queryText: 'SELECT ...',
        current: {value: 420, trace: {traceId: 't0'}},
        prior: {value: 350, trace: {traceId: 't1'}},
        groups: [
          {key: '["2026-01-01","Direct"]', dimensions: ['2026-01-01', 'Direct'], total: {value: 120, trace: {traceId: 'g0'}}},
          {key: '["2026-01-02","Direct"]', dimensions: ['2026-01-02', 'Direct'], total: {value: 180, trace: {traceId: 'g1'}}},
          {key: '["2026-01-01","Partner"]', dimensions: ['2026-01-01', 'Partner'], total: {value: 60, trace: {traceId: 'g2'}}},
          {key: '["2026-01-02","Partner"]', dimensions: ['2026-01-02', 'Partner'], total: {value: 60, trace: {traceId: 'g3'}}},
        ],
      },
      {chartId: `chart_${type}`, title: `Chart ${type}`, type, format: 'number'},
    );
    assert.ok(html.length > 20, `${type} must render non-empty HTML`);
    if (type !== 'kpi') {
      assert.match(html, /<svg/, `${type} must render SVG`);
    }
  }

  const tableHtml = dashboardChartsApi.renderChart(
    {
      chartId: 'tbl',
      queryText: 'SELECT ...',
      groups: [],
      table: {
        columns: ['Region', 'Revenue', 'Orders'],
        rows: [
          {key: 'North', cells: [{value: 300, trace: {traceId: 't:0'}}, {value: 12, trace: {traceId: 't:1'}}]},
          {key: 'South', cells: [{value: 120, trace: {traceId: 't:2'}}, {value: 5, trace: {traceId: 't:3'}}]},
        ],
      },
    },
    {chartId: 'tbl', title: 'Table', type: 'table'},
  );
  assert.match(tableHtml, /mp-dash-table-toolbar/);
  assert.match(tableHtml, /data-dash-sort/);
});
