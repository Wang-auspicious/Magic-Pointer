'use strict';

(() => {
type UnknownRecord = Record<string, unknown>;

interface SourceRef {
  sourceId: string;
  taskId: string;
  kind: 'file' | 'document' | 'chat' | 'web' | 'figma' | 'capture';
  title: string;
  identity: UnknownRecord;
  revision: UnknownRecord;
  capabilities: string[];
  origin: 'user-attached' | 'user-pointed' | 'task-discovered';
  parentSourceId: string | null;
}

interface FragmentLocator {
  kind: 'message' | 'text' | 'table' | 'cell-range' | 'slide-shape' | 'pdf-region' | 'dom-node' | 'figma-node' | 'visual-region';
  value: UnknownRecord;
}

interface ReferenceBinding {
  referenceId: string;
  label: string;
  sourceId: string;
  locator: FragmentLocator;
  role: 'target' | 'source' | 'reference' | 'exclude' | 'unresolved';
  frameLeaseId: string | null;
  capturedAtMs: number;
  ordinal: number;
  active: boolean;
}

interface ReferenceUpdate {
  operation: 'add' | 'correct' | 'remove';
  binding: ReferenceBinding;
}

interface Coverage {
  extent: 'selection' | 'neighborhood' | 'page' | 'document' | 'query-results';
  readRanges: UnknownRecord[];
  totalUnits: number | null;
  complete: boolean;
  nextCursor: string | null;
  missingReason: string | null;
}

interface TaskContextState {
  taskId: string;
  sources: SourceRef[];
  references: Record<string, ReferenceBinding>;
  referenceRevision: number;
}

interface BindConversationTaskInputOptions {
  taskId: string;
  instruction: string;
  attachments?: string[];
  inputId?: string;
  capturedAtMs?: number;
}

const SOURCE_KINDS = new Set(['file', 'document', 'chat', 'web', 'figma', 'capture']);
const SOURCE_ORIGINS = new Set(['user-attached', 'user-pointed', 'task-discovered']);
const SOURCE_CAPABILITIES = new Set(['read', 'search', 'follow', 'patch']);
const LOCATOR_KINDS = new Set(['message', 'text', 'table', 'cell-range', 'slide-shape', 'pdf-region', 'dom-node', 'figma-node', 'visual-region']);
const REFERENCE_ROLES = new Set(['target', 'source', 'reference', 'exclude', 'unresolved']);
const COVERAGE_EXTENTS = new Set(['selection', 'neighborhood', 'page', 'document', 'query-results']);

function clone<T>(value: T): T {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function record(value: unknown, name: string): UnknownRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as UnknownRecord;
}

function strict(value: unknown, name: string, required: string[], optional: string[] = []): UnknownRecord {
  const data = record(value, name);
  const allowed = new Set([...required, ...optional]);
  const unknown = Object.keys(data).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`unknown field(s) for ${name}: ${unknown.sort().join(', ')}`);
  const missing = required.filter((key) => !Object.prototype.hasOwnProperty.call(data, key));
  if (missing.length) throw new Error(`missing field(s) for ${name}: ${missing.join(', ')}`);
  return data;
}

function text(value: unknown, name: string, allowEmpty = false): string {
  if (typeof value !== 'string') throw new Error(`${name} must be a string`);
  const result = value.trim();
  if (!result && !allowEmpty) throw new Error(`${name} must be non-empty`);
  return result;
}

function integer(value: unknown, name: string, minimum = 0): number {
  if (!Number.isInteger(value) || Number(value) < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}`);
  }
  return Number(value);
}

function stringList(value: unknown, name: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  const result = value.map((item) => text(item, `${name} item`));
  if (new Set(result).size !== result.length) throw new Error(`${name} must not contain duplicates`);
  return result;
}

function normalizeLocator(value: unknown): FragmentLocator {
  const data = strict(value, 'FragmentLocator', ['kind', 'value']);
  const kind = text(data.kind, 'FragmentLocator.kind');
  if (!LOCATOR_KINDS.has(kind)) throw new Error(`unsupported FragmentLocator.kind: ${kind}`);
  return { kind: kind as FragmentLocator['kind'], value: clone(record(data.value, 'FragmentLocator.value')) };
}

function normalizeSourceRef(value: unknown): SourceRef {
  const data = strict(value, 'SourceRef', [
    'sourceId', 'taskId', 'kind', 'title', 'identity', 'revision',
    'capabilities', 'origin', 'parentSourceId',
  ]);
  const kind = text(data.kind, 'SourceRef.kind');
  const origin = text(data.origin, 'SourceRef.origin');
  if (!SOURCE_KINDS.has(kind)) throw new Error(`unsupported SourceRef.kind: ${kind}`);
  if (!SOURCE_ORIGINS.has(origin)) throw new Error(`unsupported SourceRef.origin: ${origin}`);
  const capabilities = stringList(data.capabilities, 'SourceRef.capabilities');
  const unsupported = capabilities.filter((item) => !SOURCE_CAPABILITIES.has(item));
  if (unsupported.length) throw new Error(`unsupported SourceRef.capabilities: ${unsupported.join(', ')}`);
  return {
    sourceId: text(data.sourceId, 'SourceRef.sourceId'),
    taskId: text(data.taskId, 'SourceRef.taskId'),
    kind: kind as SourceRef['kind'],
    title: text(data.title, 'SourceRef.title'),
    identity: clone(record(data.identity, 'SourceRef.identity')),
    revision: clone(record(data.revision, 'SourceRef.revision')),
    capabilities,
    origin: origin as SourceRef['origin'],
    parentSourceId: data.parentSourceId === null ? null : text(data.parentSourceId, 'SourceRef.parentSourceId'),
  };
}

function normalizeReferenceBinding(value: unknown): ReferenceBinding {
  const data = strict(value, 'ReferenceBinding', [
    'referenceId', 'label', 'sourceId', 'locator', 'role', 'frameLeaseId',
    'capturedAtMs', 'ordinal', 'active',
  ]);
  const role = text(data.role, 'ReferenceBinding.role');
  if (!REFERENCE_ROLES.has(role)) throw new Error(`unsupported ReferenceBinding.role: ${role}`);
  if (typeof data.active !== 'boolean') throw new Error('ReferenceBinding.active must be boolean');
  return {
    referenceId: text(data.referenceId, 'ReferenceBinding.referenceId'),
    label: text(data.label, 'ReferenceBinding.label'),
    sourceId: text(data.sourceId, 'ReferenceBinding.sourceId'),
    locator: normalizeLocator(data.locator),
    role: role as ReferenceBinding['role'],
    frameLeaseId: data.frameLeaseId === null ? null : text(data.frameLeaseId, 'ReferenceBinding.frameLeaseId'),
    capturedAtMs: integer(data.capturedAtMs, 'ReferenceBinding.capturedAtMs'),
    ordinal: integer(data.ordinal, 'ReferenceBinding.ordinal', 1),
    active: data.active,
  };
}

function normalizeReferenceUpdate(value: unknown): ReferenceUpdate {
  const data = strict(value, 'ReferenceUpdate', ['operation', 'binding']);
  const operation = text(data.operation, 'ReferenceUpdate.operation');
  if (!['add', 'correct', 'remove'].includes(operation)) {
    throw new Error(`unsupported ReferenceUpdate.operation: ${operation}`);
  }
  const binding = normalizeReferenceBinding(data.binding);
  if (operation === 'remove' && binding.active) throw new Error('remove requires active=false');
  if (operation !== 'remove' && !binding.active) throw new Error(`${operation} requires active=true`);
  return { operation: operation as ReferenceUpdate['operation'], binding };
}

function normalizeCoverage(value: unknown): Coverage {
  const data = strict(value, 'Coverage', [
    'extent', 'readRanges', 'totalUnits', 'complete', 'nextCursor', 'missingReason',
  ]);
  const extent = text(data.extent, 'Coverage.extent');
  if (!COVERAGE_EXTENTS.has(extent)) throw new Error(`unsupported Coverage.extent: ${extent}`);
  if (!Array.isArray(data.readRanges)) throw new Error('Coverage.readRanges must be an array');
  if (typeof data.complete !== 'boolean') throw new Error('Coverage.complete must be boolean');
  return {
    extent: extent as Coverage['extent'],
    readRanges: data.readRanges.map((item) => clone(record(item, 'Coverage.readRanges item'))),
    totalUnits: data.totalUnits === null ? null : integer(data.totalUnits, 'Coverage.totalUnits'),
    complete: data.complete,
    nextCursor: data.nextCursor === null ? null : text(data.nextCursor, 'Coverage.nextCursor'),
    missingReason: data.missingReason === null ? null : text(data.missingReason, 'Coverage.missingReason'),
  };
}

function normalizeTimelineEvent(value: unknown): UnknownRecord {
  const data = strict(value, 'TimelineEvent', ['eventId', 'kind', 'startMs', 'endMs'], ['text', 'referenceId']);
  const kind = text(data.kind, 'TimelineEvent.kind');
  if (!['utterance', 'point'].includes(kind)) throw new Error(`unsupported TimelineEvent.kind: ${kind}`);
  const result: UnknownRecord = {
    eventId: text(data.eventId, 'TimelineEvent.eventId'),
    kind,
    startMs: integer(data.startMs, 'TimelineEvent.startMs'),
    endMs: integer(data.endMs, 'TimelineEvent.endMs'),
  };
  if (Number(result.endMs) < Number(result.startMs)) throw new Error('TimelineEvent.endMs must be >= startMs');
  if (data.text !== undefined) result.text = text(data.text, 'TimelineEvent.text');
  if (data.referenceId !== undefined) result.referenceId = text(data.referenceId, 'TimelineEvent.referenceId');
  if (kind === 'utterance' && result.text === undefined) throw new Error('utterance timeline event requires text');
  if (kind === 'point' && result.referenceId === undefined) throw new Error('point timeline event requires referenceId');
  return result;
}

function normalizeTaskInput(value: unknown): UnknownRecord {
  const data = strict(value, 'TaskInput', [
    'inputId', 'taskId', 'target', 'instruction', 'referenceUpdates',
    'sourceIds', 'timeline', 'capturedAtMs',
  ]);
  const target = text(data.target, 'TaskInput.target');
  if (!['next-step', 'next-turn'].includes(target)) throw new Error(`unsupported TaskInput.target: ${target}`);
  if (!Array.isArray(data.referenceUpdates) || !Array.isArray(data.timeline)) {
    throw new Error('TaskInput referenceUpdates and timeline must be arrays');
  }
  const instruction = text(data.instruction, 'TaskInput.instruction', true);
  const referenceUpdates = data.referenceUpdates.map(normalizeReferenceUpdate);
  const sourceIds = stringList(data.sourceIds, 'TaskInput.sourceIds');
  if (!instruction && !referenceUpdates.length && !sourceIds.length) {
    throw new Error('TaskInput requires instruction, referenceUpdates, or sourceIds');
  }
  return {
    inputId: text(data.inputId, 'TaskInput.inputId'),
    taskId: text(data.taskId, 'TaskInput.taskId'),
    target,
    instruction,
    referenceUpdates,
    sourceIds,
    timeline: data.timeline.map(normalizeTimelineEvent),
    capturedAtMs: integer(data.capturedAtMs, 'TaskInput.capturedAtMs'),
  };
}

function attachmentSourceId(value: unknown): string {
  const filePath = text(value, 'attachment path').replace(/\\/g, '/');
  return `source:attachment:${filePath}`;
}

function attachmentSourceRef(value: unknown, taskIdValue: unknown): SourceRef {
  const absolutePath = text(value, 'attachment path');
  const taskId = text(taskIdValue, 'attachment taskId');
  const title = absolutePath.replace(/\\/g, '/').split('/').filter(Boolean).pop() || absolutePath;
  const suffix = title.includes('.') ? title.slice(title.lastIndexOf('.')).toLocaleLowerCase() : '';
  const document = ['.pdf', '.docx', '.pptx', '.xlsx'].includes(suffix);
  return normalizeSourceRef({
    sourceId: attachmentSourceId(absolutePath),
    taskId,
    kind: document ? 'document' : 'file',
    title,
    identity: { absolutePath },
    revision: { authority: 'disk' },
    capabilities: document
      ? ['read', 'search', 'follow', 'patch']
      : ['read', 'search', 'follow'],
    origin: 'user-attached',
    parentSourceId: null,
  });
}

function bindConversationTaskInput(
  value: unknown,
  options: BindConversationTaskInputOptions,
): UnknownRecord {
  const data = record(value, 'Studio TaskInput');
  const taskId = text(options.taskId, 'Studio TaskInput taskId');
  const instruction = text(options.instruction, 'Studio TaskInput instruction', true);
  const capturedAtMs = integer(
    options.capturedAtMs === undefined ? data.capturedAtMs : options.capturedAtMs,
    'Studio TaskInput capturedAtMs',
  );
  const sourceIds = stringList(data.sourceIds, 'TaskInput.sourceIds');
  for (const filePath of options.attachments || []) {
    const sourceId = attachmentSourceId(filePath);
    if (!sourceIds.includes(sourceId)) sourceIds.push(sourceId);
  }
  const rawTimeline = Array.isArray(data.timeline) ? data.timeline : [];
  const timeline = rawTimeline.length || !instruction
    ? rawTimeline
    : [{
        eventId: `utterance:${String(options.inputId || data.inputId)}`,
        kind: 'utterance',
        startMs: capturedAtMs,
        endMs: capturedAtMs,
        text: instruction,
      }];
  return normalizeTaskInput({
    inputId: String(options.inputId || data.inputId || ''),
    taskId,
    target: 'next-step',
    instruction,
    referenceUpdates: Array.isArray(data.referenceUpdates) ? data.referenceUpdates : [],
    sourceIds,
    timeline,
    capturedAtMs,
  });
}

function emptyTaskContext(taskId: unknown): TaskContextState {
  return { taskId: text(taskId, 'TaskContext.taskId'), sources: [], references: {}, referenceRevision: 0 };
}

function applyReferenceUpdate(references: Record<string, ReferenceBinding>, update: ReferenceUpdate): void {
  const binding = clone(update.binding);
  const current = references[binding.referenceId];
  if (update.operation === 'add') {
    if (current) throw new Error(`reference already exists: ${binding.referenceId}`);
    if (Object.values(references).some((item) => item.label === binding.label || item.ordinal === binding.ordinal)) {
      throw new Error('reference label and ordinal must remain unique');
    }
    references[binding.referenceId] = binding;
    return;
  }
  if (!current) throw new Error(`unknown reference: ${binding.referenceId}`);
  if (binding.label !== current.label || binding.ordinal !== current.ordinal) {
    throw new Error('reference correction/removal cannot renumber a binding');
  }
  if (update.operation === 'remove') {
    if (binding.sourceId !== current.sourceId) throw new Error('reference removal cannot change sourceId');
    references[binding.referenceId] = { ...current, active: false };
    return;
  }
  references[binding.referenceId] = {
    ...binding,
    frameLeaseId: binding.frameLeaseId || current.frameLeaseId,
  };
}

function reduceTaskContext(stateValue: TaskContextState, eventValue: unknown): TaskContextState {
  const state = clone(stateValue);
  const event = record(eventValue, 'TaskContextEvent');
  if (event.type !== 'context/updated') return state;
  const data = strict(event.data, 'context/updated', ['taskId', 'sources', 'referenceUpdates', 'referenceRevision']);
  if (data.taskId !== state.taskId) throw new Error('context/updated taskId does not match projection taskId');
  if (!Array.isArray(data.sources) || !Array.isArray(data.referenceUpdates)) {
    throw new Error('context/updated sources and referenceUpdates must be arrays');
  }
  const updates = data.referenceUpdates.map(normalizeReferenceUpdate);
  const expectedRevision = state.referenceRevision + (updates.length ? 1 : 0);
  if (data.referenceRevision !== expectedRevision) throw new Error('context/updated referenceRevision is not monotonic');
  const sourceById = new Map(state.sources.map((source) => [source.sourceId, source]));
  for (const raw of data.sources) {
    const source = normalizeSourceRef(raw);
    if (source.taskId !== state.taskId) throw new Error('source taskId does not match projection taskId');
    sourceById.set(source.sourceId, source);
  }
  state.sources = Array.from(sourceById.values());
  const knownSources = new Set(state.sources.map((source) => source.sourceId));
  for (const update of updates) {
    if (!knownSources.has(update.binding.sourceId)) throw new Error('reference source is not registered for task');
    applyReferenceUpdate(state.references, update);
  }
  state.referenceRevision = Number(data.referenceRevision);
  return state;
}

function referenceLabel(ordinal: unknown): string {
  const value = integer(ordinal, 'reference ordinal', 1);
  let result = '';
  let remaining = value;
  while (remaining > 0) {
    remaining -= 1;
    result = String.fromCharCode(65 + (remaining % 26)) + result;
    remaining = Math.floor(remaining / 26);
  }
  return result;
}

function nextReferenceIdentity(state: TaskContextState): { label: string; ordinal: number } {
  const ordinal = Math.max(0, ...Object.values(state.references).map((item) => item.ordinal)) + 1;
  return { ordinal, label: referenceLabel(ordinal) };
}

const TaskSources = {
  emptyTaskContext,
  nextReferenceIdentity,
  normalizeCoverage,
  normalizeLocator,
  normalizeReferenceBinding,
  normalizeReferenceUpdate,
  normalizeSourceRef,
  normalizeTaskInput,
  attachmentSourceId,
  attachmentSourceRef,
  bindConversationTaskInput,
  reduceTaskContext,
  referenceLabel,
};

if (typeof module !== 'undefined' && module.exports) module.exports = TaskSources;
if (typeof globalThis !== 'undefined') {
  (globalThis as typeof globalThis & { TaskSources?: typeof TaskSources }).TaskSources = TaskSources;
}
})();
