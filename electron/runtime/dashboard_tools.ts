import {isAbsolute, relative, resolve} from 'node:path';
import {ActionFailure, type ToolSpec} from './tools';
import type {AccessRequest, SourceRef} from './context';
import {
  dashboardTrace,
  evaluateDashboard,
  listDashboards,
  loadDashboard,
  loadDashboardSource,
  saveDashboard,
  validateDashboard,
  type DashboardChart,
  type DashboardRun,
  type DashboardSource,
  type DashboardSpec,
} from './dashboard';

const text = {type: 'string', minLength: 1};
const object = (
  properties: Record<string, unknown>,
  required: string[] = [],
) => ({type: 'object', properties, required, additionalProperties: false});
const sourceSchema = object(
  {
    sourceId: text,
    kind: {enum: ['csv', 'xlsx', 'static']},
    path: {
      type: 'string',
      description:
        'Absolute path to an attached or workspace-authorized CSV/XLSX file.',
    },
    sheet: text,
    headerRow: {type: 'integer', minimum: 1},
    rows: {
      type: 'array',
      description:
        'Inline values supplied by the user; never invent source measurements.',
      items: {
        type: 'object',
        additionalProperties: {type: ['string', 'number', 'boolean', 'null']},
      },
    },
  },
  ['sourceId', 'kind'],
);
const selectSchema = object(
  {
    source: text,
    value: {
      ...text,
      description: 'Exact column name. Use * with count to count all rows.',
    },
    agg: {enum: ['sum', 'avg', 'count']},
    groupBy: object({column: text, truncateDay: {type: 'boolean'}, and: text}, [
      'column',
    ]),
    dateColumn: text,
    priorDays: {
      type: 'integer',
      minimum: 1,
      description:
        'Compare the latest N days in the data with the preceding N days; do not combine with groupBy.',
    },
    scale: {
      type: 'number',
      description: 'Multiply the aggregate; for ratio percentages use 100.',
    },
    filter: {
      type: 'array',
      items: object(
        {
          col: text,
          op: {enum: ['eq', 'gte', 'lte']},
          value: {type: ['string', 'number']},
        },
        ['col', 'op', 'value'],
      ),
    },
  },
  ['source', 'value', 'agg'],
);
const format = {
  enum: ['number', 'money', 'percent'],
  description:
    'Percent values are percentage points: 5 is 5%. Use select.scale=100 for ratios.',
};
const currency = {
  type: 'string',
  pattern: '^[A-Z]{3}$',
  description: 'Currency code for money, for example CNY or USD.',
};
const chartSchema = object(
  {
    chartId: text,
    title: text,
    type: {enum: ['kpi', 'line', 'table']},
    select: selectSchema,
    format,
    currency,
    primaryLabel: text,
    queryText: {
      type: 'string',
      description: 'Generated from select when saved; never executed as SQL.',
    },
    columns: {
      type: 'array',
      description:
        'Extra table metrics; the primary select is already the first metric.',
      items: object({label: text, select: selectSchema, format, currency}, [
        'label',
        'select',
      ]),
    },
  },
  ['chartId', 'title', 'type', 'select'],
);

export type DashboardEdit =
  | {op: 'rename'; title: string}
  | {op: 'set_chart'; chart: DashboardChart}
  | {op: 'remove_chart'; chartId: string}
  | {op: 'set_source'; source: DashboardSource}
  | {op: 'remove_source'; sourceId: string};

export function applyDashboardEdits(
  spec: DashboardSpec,
  edits: DashboardEdit[],
): DashboardSpec {
  const next = structuredClone(spec);
  for (const edit of edits) {
    if (edit.op === 'rename') {
      next.title = edit.title;
    } else if (edit.op === 'set_chart' && edit.chart) {
      const index = next.charts.findIndex(
        chart => chart.chartId === edit.chart.chartId,
      );
      if (index < 0) {
        next.charts.push(edit.chart);
      } else {
        next.charts[index] = edit.chart;
      }
    } else if (edit.op === 'remove_chart') {
      next.charts = next.charts.filter(chart => chart.chartId !== edit.chartId);
    } else if (edit.op === 'set_source' && edit.source) {
      const index = next.sources.findIndex(
        source => source.sourceId === edit.source.sourceId,
      );
      if (index < 0) {
        next.sources.push(edit.source);
      } else {
        next.sources[index] = edit.source;
      }
    } else if (edit.op === 'remove_source') {
      next.sources = next.sources.filter(
        source => source.sourceId !== edit.sourceId,
      );
    } else {
      throw new Error('Unsupported or incomplete dashboard edit.');
    }
  }
  validateDashboard(next);
  return next;
}

function summary(run: DashboardRun) {
  const number = (
    item: DashboardRun['snapshot']['charts'][number]['current'],
  ) =>
    item
      ? {
          value: item.value,
          traceId: item.trace.traceId,
          sourceRows: item.trace.rowNumbers.length,
          excludedRows: item.trace.excludedCount,
        }
      : null;
  return {
    dashboardId: run.spec.dashboardId,
    revision: run.spec.revision || 0,
    title: run.spec.title,
    snapshotId: run.snapshot.snapshotId,
    generatedAt: run.snapshot.generatedAt,
    definition: {
      ...run.spec,
      sources: run.spec.sources.map(source => ({...source, rows: undefined})),
    },
    sources: [...run.sources.values()].map(data => ({
      sourceId: data.source.sourceId,
      columns: data.columns,
      rowCount: data.rows.length,
      warnings: data.warnings,
      error: data.error,
    })),
    charts: run.snapshot.charts.map(chart => ({
      chartId: chart.chartId,
      error: chart.error,
      query: chart.queryText,
      current: number(chart.current),
      prior: number(chart.prior),
      groupCount: chart.groups.length,
      groups: chart.groups
        .slice(0, 30)
        .map(group => ({key: group.key, ...number(group.total)})),
      tableRows: chart.table?.rows.length,
    })),
    nextStep:
      'Open Dashboards in the sidebar to view, inspect source rows, or export the dashboard.',
  };
}

export interface DashboardToolOptions {
  userDataDir: string;
  sources(): readonly SourceRef[];
  authorizeAccess(request: AccessRequest): {
    allowed: boolean;
    reason?: string;
  };
}
export function createDashboardTools(
  options: DashboardToolOptions,
): ToolSpec[] {
  const tools: ToolSpec[] = [];
  const snapshots = new Map<string, DashboardRun>();
  const authorize = (sources: DashboardSource[]) => {
    for (const source of sources) {
      if (source.kind === 'static') {
        continue;
      }
      if (!source.path || !isAbsolute(source.path)) {
        throw new Error('Dashboard file sources need an absolute path.');
      }
      const bound = options
        .sources()
        .find(
          item =>
            typeof item.identity.absolutePath === 'string' &&
            relative(
              resolve(item.identity.absolutePath),
              resolve(source.path!),
            ) === '',
        );
      const sourceGrant = bound
        ? options.authorizeAccess({action: 'read', sourceIds: [bound.sourceId]})
        : undefined;
      const decision = sourceGrant?.allowed
        ? sourceGrant
        : options.authorizeAccess({action: 'read', paths: [source.path]});
      if (!decision.allowed) {
        throw new ActionFailure(
          'permission_denied',
          decision.reason ||
            'Attach this source file or authorize its workspace before reading it.',
        );
      }
    }
  };
  const open = async (dashboardId: string): Promise<DashboardRun> => {
    const spec = await loadDashboard(options.userDataDir, dashboardId);
    authorize(spec.sources);
    const run = await evaluateDashboard(spec);
    snapshots.set(dashboardId, run);
    return run;
  };
  const save = async (spec: DashboardSpec, expectedRevision?: number) => {
    validateDashboard(spec);
    authorize(spec.sources);
    const checked = await evaluateDashboard(spec);
    const failures = checked.snapshot.charts.filter(chart => chart.error);
    if (failures.length) {
      throw new Error(
        failures.map(chart => `${chart.chartId}: ${chart.error}`).join('\n'),
      );
    }
    const saved = await saveDashboard(
      options.userDataDir,
      spec,
      expectedRevision,
    );
    checked.spec = saved;
    checked.snapshot.dashboardId = saved.dashboardId;
    checked.snapshot.title = saved.title;
    snapshots.set(saved.dashboardId, checked);
    return summary(checked);
  };
  const common = {
    deferred: true,
    used_backend: 'local.dashboard',
    resource_keys: ['dashboards'],
  };
  tools.push({
    ...common,
    name: 'Dashboard.list',
    description:
      'List saved local dashboards and their current revisions. Does not read source files.',
    input_schema: object({}),
    execute: async () =>
      (await listDashboards(options.userDataDir)).map(
        ({dashboardId, title, revision, updatedAt}) => ({
          dashboardId,
          title,
          revision: revision || 0,
          updatedAt,
        }),
      ),
  });
  tools.push({
    ...common,
    name: 'Dashboard.inspect_source',
    description:
      'Inspect real CSV/XLSX columns and sample rows before designing a dashboard. Can also page through a saved dashboard source. Retains original CSV/worksheet row numbers and reports missing formula results.',
    input_schema: object({
      source: sourceSchema,
      dashboard_id: text,
      source_id: text,
      offset: {type: 'integer', minimum: 0},
      limit: {type: 'integer', minimum: 1, maximum: 100},
    }),
    execute: async args => {
      let source = args.source as DashboardSource | undefined;
      if (args.dashboard_id) {
        source = (
          await loadDashboard(options.userDataDir, String(args.dashboard_id))
        ).sources.find(item => item.sourceId === args.source_id);
      }
      if (!source) {
        throw new Error(
          'Provide a source descriptor, or dashboard_id and source_id.',
        );
      }
      authorize([source]);
      const data = await loadDashboardSource(source);
      const offset = Number(args.offset) || 0;
      const limit = Number(args.limit) || 20;
      return {
        sourceId: source.sourceId,
        columns: data.columns,
        totalRows: data.rows.length,
        offset,
        warnings: data.warnings,
        rows: data.rows.slice(offset, offset + limit).map((values, index) => ({
          rowNumber: data.rowNumbers[offset + index],
          values,
        })),
      };
    },
  });
  tools.push({
    ...common,
    name: 'Dashboard.create',
    description:
      'Create a saved local dashboard from real, authorized CSV/XLSX sources or user-supplied inline rows. Inspect columns first. Supports KPIs, grouped time-series lines, and tables; every computed value retains its source rows. Source files are never modified.',
    input_schema: object(
      {
        title: text,
        sources: {type: 'array', items: sourceSchema, minItems: 1},
        charts: {type: 'array', items: chartSchema, minItems: 1},
      },
      ['title', 'sources', 'charts'],
    ),
    execute: args =>
      save({
        schemaVersion: 1,
        dashboardId: '',
        title: String(args.title),
        updatedAt: '',
        sources: args.sources as DashboardSource[],
        charts: args.charts as DashboardChart[],
      }),
  });
  tools.push({
    ...common,
    name: 'Dashboard.open',
    description:
      'Read the current dashboard definition and recompute it from its authorized sources. Returns current revision, bounded value preview, and trace IDs. Use this revision for edits.',
    input_schema: object({dashboard_id: text}, ['dashboard_id']),
    execute: async args => summary(await open(String(args.dashboard_id))),
  });
  tools.push({
    ...common,
    name: 'Dashboard.update',
    description:
      'Edit a saved dashboard after reading its current revision. Operations replace only named charts/sources, or rename the dashboard, preserving everything else. Validates queries against real data before saving.',
    input_schema: object(
      {
        dashboard_id: text,
        expected_revision: {type: 'integer', minimum: 0},
        operations: {
          type: 'array',
          minItems: 1,
          items: object(
            {
              op: {
                enum: [
                  'rename',
                  'set_chart',
                  'remove_chart',
                  'set_source',
                  'remove_source',
                ],
              },
              title: text,
              chart: chartSchema,
              chartId: text,
              source: sourceSchema,
              sourceId: text,
            },
            ['op'],
          ),
        },
      },
      ['dashboard_id', 'expected_revision', 'operations'],
    ),
    execute: async args =>
      save(
        applyDashboardEdits(
          await loadDashboard(options.userDataDir, String(args.dashboard_id)),
          args.operations as DashboardEdit[],
        ),
        Number(args.expected_revision),
      ),
  });
  tools.push({
    ...common,
    name: 'Dashboard.trace',
    description:
      'Read the original source rows behind a computed value from the dashboard snapshot opened in this turn. Does not reread a changed file and silently substitute different evidence.',
    input_schema: object(
      {
        dashboard_id: text,
        snapshot_id: text,
        trace_id: text,
        offset: {type: 'integer', minimum: 0},
      },
      ['dashboard_id', 'snapshot_id', 'trace_id'],
    ),
    execute: args => {
      const run = snapshots.get(String(args.dashboard_id));
      if (!run || run.snapshot.snapshotId !== args.snapshot_id) {
        throw new Error(
          'Open the dashboard and use a trace ID from that snapshot.',
        );
      }
      authorize(run.spec.sources);
      return dashboardTrace(
        run,
        String(args.trace_id),
        Number(args.offset) || 0,
      );
    },
  });
  return tools;
}
