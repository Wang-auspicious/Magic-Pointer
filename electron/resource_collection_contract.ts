export type ResourceIntent =
  'save' | 'reference' | 'recreate' | 'read' | 'todo';
export type ResourceState =
  'inbox' | 'ready' | 'ignored' | 'queued' | 'processing' | 'waiting' | 'error';
export type HandoffState = 'unread' | 'handled' | 'snoozed';

export interface ResourceHandoff {
  id: string;
  version: number;
  projectId: string;
  title: string;
  summary: string;
  coverage: string;
  path: string;
  intent: ResourceIntent;
  sourceUrl: string;
  createdAt: number;
}

export interface ProjectInboxEntry extends ResourceHandoff {
  revision: number;
  state: HandoffState;
  snoozedUntil: number;
  available: boolean;
}

export interface HandoffReceipt {
  resourceId: string;
  version: number;
  conversationId: string;
  turnId: string;
  acceptedAt: number;
}

export interface ResourceCollection {
  sourceAccount: string;
  postPath: string;
  postTextPath: string;
  thumbnailPath: string;
  captureStatus:
    | 'link'
    | 'queued'
    | 'loading'
    | 'saved'
    | 'partial'
    | 'auth_required'
    | 'error';
  captureError: string;
  authorName: string;
  platform: string;
  tags: string[];
  lastViewedAt: number;
  suggestedIntent: ResourceIntent | '';
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
  analysisRequestId: string;
  analysisRevision: number;
  analysisCoverage: string;
  analysisAutomatic: boolean;
  handoffVersion: number;
  handoffUpdatedAt: number;
  handoffState: HandoffState;
  handoffSnoozedUntil: number;
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
    'queued',
    'waiting',
    'error',
  ];
  return {
    sourceAccount: String(value.sourceAccount || 'web'),
    postPath: String(value.postPath || ''),
    postTextPath: String(value.postTextPath || ''),
    thumbnailPath: String(value.thumbnailPath || ''),
    captureStatus: [
      'link',
      'queued',
      'loading',
      'saved',
      'partial',
      'auth_required',
      'error',
    ].includes(value.captureStatus || '')
      ? value.captureStatus!
      : 'link',
    captureError: String(value.captureError || ''),
    authorName: String(value.authorName || ''),
    platform: String(value.platform || ''),
    tags: Array.isArray(value.tags)
      ? value.tags.filter(tag => typeof tag === 'string')
      : [],
    lastViewedAt: Number(value.lastViewedAt) || 0,
    suggestedIntent: intents.includes(value.suggestedIntent as ResourceIntent)
      ? value.suggestedIntent!
      : '',
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
    analysisRequestId: String(value.analysisRequestId || ''),
    analysisRevision: Math.max(0, Number(value.analysisRevision) || 0),
    analysisCoverage: String(value.analysisCoverage || ''),
    analysisAutomatic: value.analysisAutomatic === true,
    handoffVersion: Math.max(
      0,
      Number(value.handoffVersion) || (value.exportedPath ? 1 : 0),
    ),
    handoffUpdatedAt: Math.max(0, Number(value.handoffUpdatedAt) || 0),
    handoffState:
      value.handoffState === 'handled' || value.handoffState === 'snoozed'
        ? value.handoffState
        : 'unread',
    handoffSnoozedUntil: Math.max(0, Number(value.handoffSnoozedUntil) || 0),
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
