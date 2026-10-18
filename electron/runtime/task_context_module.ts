import {asObject} from './agent';
import {taskSources, taskReferences} from './context';
import {taskOutcomes} from './agent_outcomes';
import type {EventSession} from './session';
import type {RuntimeModule} from './runtime_modules';
import type {ModsPanel} from './module_contract';

export function taskContextModule(session: EventSession): RuntimeModule {
  const panel = (): Omit<ModsPanel, 'moduleId'> => {
    const sources = taskSources(session.events);
    const references = taskReferences(session.events).filter(row => row.active);
    const plan = [...session.events]
      .reverse()
      .find(event => event.type === 'plan/updated')?.data.plan;
    const outcome = taskOutcomes(session.events);
    const receipt = [...session.events]
      .reverse()
      .find(event => event.type === 'receipt/issued')?.data;
    return {
      id: 'task-context',
      title: 'Task context',
      description:
        'Current task materials, references, plan and verified results from the saved session.',
      status: {
        state: session.openTurn === null ? 'ready' : 'running',
        label: receipt ? String(receipt.status) : 'No result receipt yet',
      },
      sections: [
        {
          id: 'sources',
          title: 'Sources',
          rows: sources.map(source => ({
            id: source.sourceId,
            label: source.title,
            value: `${source.kind} · ${source.origin}`,
          })),
        },
        {
          id: 'references',
          title: 'Active references',
          rows: references.map(reference => ({
            id: reference.referenceId,
            label: reference.label,
            value: `${reference.role} · ${sources.find(source => source.sourceId === reference.sourceId)?.title ?? reference.sourceId}`,
          })),
        },
        {
          id: 'plan',
          title: 'Plan',
          rows: (Array.isArray(plan) ? plan : []).map((value, index) => {
            const item = asObject(value);
            return {
              id: String(index),
              label: String(item.content ?? ''),
              value: String(item.status ?? ''),
              tone:
                item.status === 'completed'
                  ? ('success' as const)
                  : ('neutral' as const),
            };
          }),
        },
        {
          id: 'outcomes',
          title: 'Outstanding results',
          rows: outcome.targets
            .filter(row => row.status !== 'verified')
            .map(row => ({
              id: row.operationId,
              label: row.target,
              value: `${row.status} · ${row.tool}`,
              tone: 'warning' as const,
            })),
        },
        {
          id: 'actions',
          rows: [{id: 'identity', label: 'Task', value: session.id}],
          actions: [
            {id: 'refresh', label: 'Refresh task context'},
            {id: 'summary', label: 'Read current summary', primary: true},
          ],
        },
      ],
    };
  };
  return {
    id: 'task-context',
    title: 'Task context',
    description: 'Inspect the evidence and unfinished work in this task.',
    commands: [
      {
        id: 'inspect',
        label: 'Inspect task context',
        tool: {
          description:
            'Read the current task source catalogue, active references, plan and outstanding result receipts. Does not read other sessions or open source files.',
          input_schema: {type: 'object', properties: {}, required: []},
          effect: 'read',
          is_concurrency_safe: true,
          used_backend: 'runtime.task_context',
          execute: async () => {
            await session.refresh();
            const view = panel();
            return {
              text: view.sections
                .filter(section => section.id !== 'actions')
                .map(
                  section =>
                    `${section.title}:\n${section.rows.length ? section.rows.map(row => `${row.label}: ${row.value}`).join('\n') : 'None recorded'}`,
                )
                .join('\n\n'),
              panelId: view.id,
            };
          },
        },
      },
    ],
    panels: [
      {
        id: 'task-context',
        render: panel,
        actions: {
          refresh: {commandId: 'inspect'},
          summary: {commandId: 'inspect'},
        },
      },
    ],
  };
}
