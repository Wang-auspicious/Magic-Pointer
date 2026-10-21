export type ResourceIntent =
  'save' | 'reference' | 'recreate' | 'read' | 'todo';
export type ResourceState =
  'inbox' | 'ready' | 'ignored' | 'processing' | 'error';

export interface ResourceCollection {
  url: string;
  title: string;
  projectId: string;
  intent: ResourceIntent;
  state: ResourceState;
  note: string;
  summary: string;
  nextStep: string;
  decisionReason: string;
  coverage: string;
  error: string;
  revision: number;
  taskId: string;
  exportedPath: string;
  paperPath: string;
  usedBackend: string;
  timingMs: number;
}

export function resourceCollection(
  value: Partial<ResourceCollection> = {},
): ResourceCollection {
  const intents: ResourceIntent[] = [
    'save',
    'reference',
    'recreate',
    'read',
    'todo',
  ];
  const states: ResourceState[] = [
    'inbox',
    'ready',
    'ignored',
    'processing',
    'error',
  ];
  return {
    url: String(value.url || ''),
    title: String(value.title || '').slice(0, 300),
    projectId: String(value.projectId || ''),
    intent: intents.includes(value.intent!) ? value.intent! : 'save',
    state: states.includes(value.state!) ? value.state! : 'inbox',
    note: String(value.note || '').slice(0, 12000),
    summary: String(value.summary || '').slice(0, 24000),
    nextStep: String(value.nextStep || '').slice(0, 6000),
    decisionReason: String(value.decisionReason || '').slice(0, 3000),
    coverage: String(value.coverage || '').slice(0, 2000),
    error: String(value.error || '').slice(0, 2000),
    revision: Math.max(1, Number(value.revision) || 1),
    taskId: String(value.taskId || ''),
    exportedPath: String(value.exportedPath || ''),
    paperPath: String(value.paperPath || ''),
    usedBackend: String(value.usedBackend || ''),
    timingMs: Math.max(0, Number(value.timingMs) || 0),
  };
}

export interface CollectedResource {
  id: string;
  media: string;
  capturedAt: number;
  relPath: string;
  absPath?: string;
  desc?: string;
  text?: string;
  summary?: string;
  app?: string;
  collection?: ResourceCollection;
}
