import type {Data} from './agent';
import {record as asObject} from './context';
import {listDashboards} from './dashboard';
import {
  createDashboardTools,
  type DashboardToolOptions,
} from './dashboard_tools';
import type {RuntimePlugin} from './agent_plugins';
import {
  RuntimeModules,
  type RuntimeModule,
  type RuntimeModulePanel,
} from './runtime_modules';
import type {EventSession} from './session';
import type {ModsPanel, ModsPanelRow} from './module_contract';

const rows = (value: unknown): Data[] =>
  Array.isArray(value) ? value.map(asObject) : [];
function savedCommand(
  session: EventSession,
  commandId: string,
): {value: Data; arguments: Data; recordedAt: string} | undefined {
  const commands =
    commandId === 'open' ? ['open', 'create', 'update'] : [commandId];
  for (const event of [...session.events].reverse()) {
    let value: Data;
    let args: Data;
    if (
      event.type === 'module/command_finished' &&
      event.data.moduleId === 'dashboards' &&
      commands.includes(String(event.data.commandId))
    ) {
      const result = asObject(event.data.result);
      if (result.is_error === true) {
        continue;
      }
      value = asObject(result.value);
      args = asObject(result.arguments);
    } else if (
      event.type === 'operation/settled' &&
      event.data.outcome === 'succeeded'
    ) {
      const message = asObject(event.data.message);
      if (
        message.is_error === true ||
        !commands.some(
          command => message.name === `Dashboard.${command.replaceAll('-', '_')}`,
        )
      ) {
        continue;
      }
      try {
        // Runtime serializes the value on one line, then appends hook context.
        value = asObject(JSON.parse(String(message.content).split('\n', 1)[0]));
      } catch {
        continue;
      }
      const prepared = session.events.find(
        row =>
          row.type === 'operation/prepared' &&
          row.data.operationId === event.data.operationId,
      );
      args = asObject(prepared?.data.arguments);
    } else {
      continue;
    }
    return {
      value,
      arguments: args,
      recordedAt: event.time
        ? new Date(event.time).toISOString()
        : 'Time unavailable',
    };
  }
  return undefined;
}

export function createDashboardModule(
  options: DashboardToolOptions & {session: EventSession},
): RuntimeModule {
  const labels: Record<string, string> = {
    list: 'List dashboards',
    inspect_source: 'Inspect source rows',
    create: 'Create dashboard',
    open: 'Query dashboard',
    update: 'Edit dashboard',
    trace: 'Trace a value',
  };
  const panel: RuntimeModulePanel = {
    id: 'dashboards',
    actions: {},
    render: async () => {
      const saved = await listDashboards(options.userDataDir);
      const actions: NonNullable<RuntimeModulePanel['actions']> = {
        'refresh-list': {commandId: 'list'},
      };
      const sections: ModsPanel['sections'] = [
        {
          id: 'catalog',
          title: 'Saved dashboards',
          rows: saved.map(item => ({
            id: item.dashboardId,
            label: item.title,
            value: `Revision ${item.revision ?? 0} · ${item.charts.length} chart${item.charts.length === 1 ? '' : 's'} · ${item.sources.length} source${item.sources.length === 1 ? '' : 's'}`,
          })),
          actions: [
            {id: 'refresh-list', label: 'Refresh list'},
            ...saved.map(item => ({
              id: `open-${item.dashboardId}`,
              label: `Query ${item.title}`,
            })),
          ],
        },
      ];
      for (const item of saved) {
        actions[`open-${item.dashboardId}`] = {
          commandId: 'open',
          arguments: {dashboard_id: item.dashboardId},
        };
      }
      const opened = savedCommand(options.session, 'open');
      if (opened) {
        const value = opened.value;
        const definition = asObject(value.definition);
        const charts = rows(value.charts);
        const chartDefinitions = rows(definition.charts);
        const sources = rows(value.sources);
        const queriedRows: ModsPanelRow[] = [
          {
            id: 'queried-at',
            label: 'Last queried',
            value: String(value.generatedAt ?? ''),
          },
        ];
        for (const chart of charts) {
          const id = String(chart.chartId);
          const title = String(
            chartDefinitions.find(item => item.chartId === chart.chartId)
              ?.title ?? id,
          );
          const current = asObject(chart.current);
          queriedRows.push({
            id,
            label: title,
            value: chart.error
              ? String(chart.error)
              : current.value !== undefined
                ? String(current.value)
                : `${chart.groupCount ?? chart.tableRows ?? 0} rows`,
            tone: chart.error ? 'error' : 'neutral',
          });
          queriedRows.push({
            id: `query-${id}`,
            label: `${title} query`,
            value: String(chart.query ?? ''),
          });
          if (current.sourceRows !== undefined) {
            queriedRows.push({
              id: `rows-${id}`,
              label: `${title} source rows`,
              value: `${current.sourceRows} included · ${current.excludedRows ?? 0} excluded`,
            });
          }
        }
        actions['refresh-values'] = {
          commandId: 'open',
          arguments: {dashboard_id: value.dashboardId},
        };
        const sourceActions = sources.map((source, index) => {
          actions[`inspect-${index}`] = {
            commandId: 'inspect-source',
            arguments: {
              dashboard_id: value.dashboardId,
              source_id: source.sourceId,
              limit: 20,
            },
          };
          return {id: `inspect-${index}`, label: `Inspect ${source.sourceId}`};
        });
        sections.push({
          id: 'values',
          title: String(value.title ?? 'Last dashboard query'),
          rows: queriedRows,
          actions: [
            {id: 'refresh-values', label: 'Refresh values', primary: true},
            ...sourceActions,
          ],
        });
        const inspected = savedCommand(options.session, 'inspect-source');
        if (
          inspected &&
          inspected.arguments.dashboard_id === value.dashboardId
        ) {
          const source = inspected.value;
          sections.push({
            id: 'source-rows',
            title: `${source.sourceId} · ${source.totalRows} source rows`,
            rows: [
              {
                id: 'source-read-at',
                label: 'Source preview read at',
                value: inspected.recordedAt,
              },
              ...rows(source.rows).map(row => ({
                id: `row-${row.rowNumber}`,
                label: `Row ${row.rowNumber}`,
                value: Object.entries(asObject(row.values))
                  .map(([key, value]) => `${key}: ${String(value ?? '')}`)
                  .join(' · '),
              })),
            ],
          });
        }
      }
      panel.actions = actions;
      return {
        id: 'dashboards',
        title: 'Dashboards',
        description:
          'Query authorized data and inspect the physical source rows. Values below retain the last query until you refresh them.',
        status: {state: 'ready'},
        sections,
      };
    },
  };
  return {
    id: 'dashboards',
    title: 'Dashboards',
    description: 'Saved dashboards, live queries and source inspection.',
    commands: createDashboardTools(options).map(tool => {
      const short = tool.name.slice('Dashboard.'.length);
      const id = short.replaceAll('_', '-');
      return {
        id,
        label: labels[short] ?? tool.name,
        tool,
        present: (value: unknown) => {
          const data = asObject(value);
          if (short === 'list') {
            return {
              text: `${Array.isArray(value) ? value.length : 0} saved dashboards.`,
              panelId: 'dashboards',
            };
          }
          if (short === 'inspect_source') {
            return {
              text: `Read ${rows(data.rows).length} of ${data.totalRows ?? 0} rows from ${data.sourceId ?? 'source'}.`,
              panelId: 'dashboards',
            };
          }
          return {
            text: `${data.title ?? 'Dashboard'} · ${rows(data.charts).length} charts queried.`,
            panelId: 'dashboards',
          };
        },
      };
    }),
    panels: [panel],
  };
}

export function dashboardModulePlugin(
  options: DashboardToolOptions & {session: EventSession},
): RuntimePlugin {
  return {
    name: 'dashboard-tools',
    inject: ['modules', 'tools'],
    apply: ctx => {
      ctx
        .get<RuntimeModules>('modules')
        .register(createDashboardModule(options));
    },
  };
}
