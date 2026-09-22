import { randomUUID } from 'node:crypto';
import { resolve, relative, isAbsolute } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { ToolRegistry, ActionFailure } from './tools';

export type Json = Record<string, unknown>;
export interface ContextEvent {
  type: string;
  data: Json;
  seq?: number;
}
export interface ContextSessionLike {
  id: string;
  events: readonly ContextEvent[];
  append(type: string, data: Json): unknown;
}
export interface FragmentLocator {
  kind: string;
  value: Json;
}
export interface SourceRef {
  sourceId: string;
  taskId: string;
  kind: string;
  title: string;
  identity: Json;
  revision: Json;
  capabilities: string[];
  origin: string;
  parentSourceId: string | null;
}
export interface ReferenceBinding {
  referenceId: string;
  label: string;
  sourceId: string;
  locator: FragmentLocator;
  role: string;
  frameLeaseId: string | null;
  capturedAtMs: number;
  ordinal: number;
  active: boolean;
}
export interface ReferenceUpdate {
  operation: 'add' | 'correct' | 'remove';
  binding: ReferenceBinding;
}
export interface Coverage {
  extent: string;
  readRanges: FragmentLocator[];
  totalUnits: number | null;
  complete: boolean;
  nextCursor: string | null;
  missingReason: string | null;
}
export interface ReadFragment {
  fragmentId: string;
  locator: FragmentLocator;
  text: string;
  metadata: Json;
  citations: Json[];
}
export interface ReadResult {
  sourceId: string;
  fragments: ReadFragment[];
  coverage: Coverage;
  evidenceStatus: string;
  usedBackend: string;
  latencyMs: number;
  structure?: Json;
}
export interface ReadOptions {
  locator?: FragmentLocator | null;
  cursor?: string | null;
  limit?: number;
  query?: string;
  signal?: AbortSignal;
}
export interface SourceReader {
  read(source: SourceRef, options?: ReadOptions): Promise<ReadResult>;
  follow?(source: SourceRef, fragmentId: string): Promise<SourceRef[]>;
}
export interface ScopeGrant {
  grantId: string;
  taskId: string;
  sourceIds: string[];
  folderRoots: string[];
  windowIds: string[];
  recipients: string[];
  actions: string[];
  expiresAtMs: number | null;
}
export interface TaskSourceScope {
  taskId: string;
  sources: SourceRef[];
  grants: ScopeGrant[];
}
export interface AccessRequest {
  action: string;
  sourceIds?: string[];
  paths?: string[];
  windowIds?: string[];
  recipients?: string[];
}

export function record(value: unknown): Json {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {};
}
export function array<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}
export function requiredText(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}
export function insidePath(path: string, root: string): boolean {
  const diff = relative(resolve(root), resolve(path));
  return !diff || (!diff.startsWith('..') && !isAbsolute(diff));
}
export function sourceRef(value: unknown): SourceRef {
  const data = record(value);
  for (const name of ['sourceId', 'taskId', 'title']) requiredText(data[name], name);
  if (!['file', 'document', 'chat', 'web', 'figma', 'capture'].includes(String(data.kind)))
    throw new Error('Unsupported source kind');
  if (!['user-attached', 'user-pointed', 'task-discovered'].includes(String(data.origin)))
    throw new Error('Unsupported source origin');
  if (
    !Array.isArray(data.capabilities) ||
    data.capabilities.some((x) => !['read', 'search', 'follow', 'patch'].includes(String(x)))
  )
    throw new Error('Invalid source capabilities');
  return structuredClone(data) as unknown as SourceRef;
}
export function contextUpdates(events: readonly ContextEvent[]): Json[] {
  return events.flatMap((e) =>
    e.type === 'context/updated'
      ? [e.data]
      : e.type === 'inbox/consumed' && e.data.contextUpdate
        ? [record(e.data.contextUpdate)]
        : [],
  );
}
export function taskSources(events: readonly ContextEvent[]): SourceRef[] {
  const sources = new Map<string, SourceRef>();
  for (const update of contextUpdates(events))
    for (const raw of array(update.sources)) {
      const source = sourceRef(raw);
      if (source.taskId !== update.taskId) throw new Error('Source task identity mismatch');
      sources.set(source.sourceId, source);
    }
  return [...sources.values()];
}
function applyReference(map: Map<string, ReferenceBinding>, update: ReferenceUpdate): void {
  const value = structuredClone(update.binding),
    previous = map.get(value.referenceId);
  if (!['target', 'source', 'reference', 'exclude', 'unresolved'].includes(value.role))
    throw new Error('Invalid reference role');
  if (update.operation === 'add') {
    if (
      previous ||
      [...map.values()].some((item) => item.label === value.label || item.ordinal === value.ordinal)
    )
      throw new Error('Reference identity or ordinal already exists');
    if (!value.active) throw new Error('Added reference must be active');
  } else {
    if (!previous || previous.label !== value.label || previous.ordinal !== value.ordinal)
      throw new Error('Reference correction cannot renumber');
    if (update.operation === 'remove') {
      if (previous.sourceId !== value.sourceId || value.active)
        throw new Error('Invalid reference removal');
      map.set(value.referenceId, { ...previous, active: false });
      return;
    }
    if (update.operation !== 'correct' || !value.active)
      throw new Error('Invalid reference correction');
    value.frameLeaseId ||= previous.frameLeaseId;
  }
  map.set(value.referenceId, value);
}
export function taskReferences(events: readonly ContextEvent[]): ReferenceBinding[] {
  const references = new Map<string, ReferenceBinding>();
  for (const update of contextUpdates(events))
    for (const raw of array<ReferenceUpdate>(update.referenceUpdates))
      applyReference(references, raw);
  return [...references.values()];
}
export function referenceRevision(events: readonly ContextEvent[]): number {
  let revision = 0;
  for (const update of contextUpdates(events)) {
    const next = Number(update.referenceRevision);
    if (!Number.isInteger(next) || next < revision)
      throw new Error('Reference revision must be monotonic');
    revision = next;
  }
  return revision;
}
export function resolveSource(events: readonly ContextEvent[], id: string): SourceRef {
  const references = taskReferences(events).filter(
    (item) => item.active && (item.referenceId === id || item.label === id),
  );
  if (new Set(references.map((item) => item.sourceId)).size > 1)
    throw new Error(`Ambiguous source reference: ${id}`);
  const source = taskSources(events).find(
    (item) => item.sourceId === id || item.sourceId === references[0]?.sourceId,
  );
  if (!source) throw new Error(`Unknown task source: ${id}`);
  return source;
}
export function validateContextUpdate(
  data: Json,
  sessionId: string,
  events: readonly ContextEvent[],
): void {
  if (
    data.taskId !== sessionId ||
    !Array.isArray(data.sources) ||
    !Array.isArray(data.referenceUpdates)
  )
    throw new Error('Invalid task context update');
  const sources = new Set(taskSources(events).map((source) => source.sourceId));
  for (const raw of data.sources) {
    const source = sourceRef(raw);
    if (source.taskId !== sessionId) throw new Error('Source belongs to another task');
    sources.add(source.sourceId);
  }
  if (data.referenceRevision !== referenceRevision(events) + (data.referenceUpdates.length ? 1 : 0))
    throw new Error('Reference revision conflict');
  const references = new Map(taskReferences(events).map((item) => [item.referenceId, item]));
  for (const update of data.referenceUpdates as ReferenceUpdate[]) {
    if (!sources.has(update.binding.sourceId)) throw new Error('Reference source not registered');
    applyReference(references, update);
  }
  for (const grant of array<ScopeGrant>(data.scopeGrants))
    if (grant.taskId !== sessionId || !grant.actions.length) throw new Error('Invalid scope grant');
}
export function updateContext(
  session: ContextSessionLike,
  changes: {
    sources?: SourceRef[];
    referenceUpdates?: ReferenceUpdate[];
    scopeGrants?: ScopeGrant[];
    scopeRevocations?: string[];
  },
  expectedRevision?: number,
): unknown {
  const revision = referenceRevision(session.events);
  if (expectedRevision !== undefined && revision !== expectedRevision)
    throw new Error('Reference revision conflict');
  const data: Json = {
    taskId: session.id,
    sources: [],
    referenceUpdates: [],
    ...changes,
    referenceRevision: revision + (changes.referenceUpdates?.length ? 1 : 0),
  };
  validateContextUpdate(data, session.id, session.events);
  return session.append('context/updated', data);
}
export function registerSource(session: ContextSessionLike, source: SourceRef): unknown {
  return updateContext(session, { sources: [source] });
}
export function scopeFromEvents(events: readonly ContextEvent[], taskId: string): TaskSourceScope {
  const grants = new Map<string, ScopeGrant>();
  for (const update of contextUpdates(events)) {
    for (const grant of array<ScopeGrant>(update.scopeGrants)) {
      if (grant.taskId !== taskId) throw new Error('Grant belongs to another task');
      grants.set(grant.grantId, grant);
    }
    for (const id of array<string>(update.scopeRevocations)) grants.delete(id);
  }
  return { taskId, sources: taskSources(events), grants: [...grants.values()] };
}
export function authorizeAccess(
  scope: TaskSourceScope,
  request: AccessRequest,
  now = Date.now(),
): { allowed: boolean; reason: string } {
  const active = scope.grants.filter(
    (grant) =>
      grant.actions.includes(request.action) &&
      (grant.expiresAtMs === null || now <= grant.expiresAtMs),
  );
  const sources = new Map(scope.sources.map((source) => [source.sourceId, source]));
  for (const id of request.sourceIds ?? []) {
    let source = sources.get(id),
      allowed = !!source && active.some((grant) => grant.sourceIds.includes(id));
    const seen = new Set<string>();
    while (!allowed && request.action === 'read' && source && !seen.has(source.sourceId)) {
      seen.add(source.sourceId);
      allowed = ['user-attached', 'user-pointed'].includes(source.origin);
      source = sources.get(source.parentSourceId ?? '');
    }
    if (!allowed) return { allowed: false, reason: `source_not_granted:${id}` };
  }
  for (const path of request.paths ?? [])
    if (!active.some((grant) => grant.folderRoots.some((root) => insidePath(path, root))))
      return { allowed: false, reason: `path_not_granted:${path}` };
  for (const id of request.windowIds ?? [])
    if (!active.some((grant) => grant.windowIds.includes(id)))
      return { allowed: false, reason: `window_not_granted:${id}` };
  for (const recipient of request.recipients ?? [])
    if (!active.some((grant) => grant.recipients.includes(recipient)))
      return { allowed: false, reason: `recipient_not_granted:${recipient}` };
  return { allowed: true, reason: '' };
}
export async function ensureFolderReadScope(
  session: ContextSessionLike,
  root: string,
): Promise<void> {
  const grant: ScopeGrant = {
    grantId: 'workspace-materials',
    taskId: session.id,
    sourceIds: [],
    folderRoots: [resolve(root)],
    windowIds: [],
    recipients: [],
    actions: ['read'],
    expiresAtMs: null,
  };
  if (
    !scopeFromEvents(session.events, session.id).grants.some((item) =>
      isDeepStrictEqual(item, grant),
    )
  )
    await updateContext(session, { scopeGrants: [grant] });
}
export class SourceReaderRegistry {
  private entries: { match(source: SourceRef): boolean; reader: SourceReader }[] = [];
  register(
    match: string | ((source: SourceRef) => boolean),
    reader: SourceReader,
    first = false,
  ): void {
    const entry = {
      match: typeof match === 'string' ? (source: SourceRef) => source.kind === match : match,
      reader,
    };
    if (first) this.entries.unshift(entry);
    else this.entries.push(entry);
  }
  get(source: SourceRef): SourceReader {
    const entry = this.entries.find((item) => item.match(source));
    if (!entry) throw new Error(`No reader for ${source.kind}`);
    return entry.reader;
  }
}
export function emptyRead(
  source: SourceRef,
  backend: string,
  reason: string,
  started = performance.now(),
): ReadResult {
  return {
    sourceId: source.sourceId,
    fragments: [],
    coverage: {
      extent: 'document',
      readRanges: [],
      totalUnits: null,
      complete: false,
      nextCursor: null,
      missingReason: reason,
    },
    evidenceStatus: 'degraded',
    usedBackend: backend,
    latencyMs: performance.now() - started,
  };
}
export class FrozenSelectionReader implements SourceReader {
  constructor(private fallback?: SourceReader) {}
  async read(source: SourceRef, options: ReadOptions = {}): Promise<ReadResult> {
    const identity = source.identity,
      content = String(
        identity.text ?? identity.content ?? record(identity.availableContent).text ?? '',
      );
    const frozenLocator = array<FragmentLocator>(identity.locators)[0] ?? {
      kind: 'visual-region',
      value: { frameLeaseId: identity.frameLeaseId, bbox: identity.bbox },
    };
    const locator = options.locator ?? frozenLocator;
    if (options.cursor || (options.locator && !isDeepStrictEqual(options.locator, frozenLocator))) {
      if (this.fallback)
        return this.fallback.read(source, {
          ...options,
          cursor: options.cursor === 'frozen-selection:remainder' ? undefined : options.cursor,
        });
      return emptyRead(source, 'frozen.selection', 'requested-content-not-in-frozen-selection');
    }
    if (!content.trim())
      return emptyRead(
        source,
        'frozen.selection',
        'Frozen selection has no structured text; use Look on the retained frame',
      );
    const fragments =
      options.query && !content.toLowerCase().includes(options.query.toLowerCase())
        ? []
        : [
            {
              fragmentId: `fragment:${source.sourceId}:selection`,
              locator,
              text: content,
              metadata: {
                historical: true,
                capturedAt: identity.capturedAt,
                frameLeaseId: identity.frameLeaseId,
              },
              citations: [{ sourceId: source.sourceId, locator }],
            },
          ];
    const result: ReadResult = {
      sourceId: source.sourceId,
      fragments,
      coverage: {
        extent: 'selection',
        readRanges: fragments.map((f) => f.locator),
        totalUnits: 1,
        complete: true,
        nextCursor: null,
        missingReason: null,
      },
      evidenceStatus: fragments.length ? 'ok' : 'empty_confirmed',
      usedBackend: 'frozen.selection',
      latencyMs: 0,
    };
    if (options.query && this.fallback) {
      if (fragments.length >= (options.limit ?? 20))
        return {
          ...result,
          coverage: {
            ...result.coverage,
            complete: false,
            nextCursor: 'frozen-selection:remainder',
            missingReason: 'disk-search-pending',
          },
        };
      const disk = await this.fallback.read(source, {
        ...options,
        limit: Math.max(1, (options.limit ?? 20) - fragments.length),
      });
      const combined = [
        ...fragments,
        ...disk.fragments.filter(
          (fragment) =>
            !fragments.some((item) => isDeepStrictEqual(item.locator, fragment.locator)),
        ),
      ];
      return {
        ...disk,
        fragments: combined,
        coverage: {
          ...disk.coverage,
          readRanges: combined.map((fragment) => fragment.locator),
          missingReason: 'historical-selection-overlays-disk-revision',
        },
        usedBackend: `frozen.selection+${disk.usedBackend}`,
      };
    }
    return result;
  }
  async follow(source: SourceRef, fragmentId: string): Promise<SourceRef[]> {
    return (await this.fallback?.follow?.(source, fragmentId)) ?? [];
  }
}
export function registerContextTools(
  registry: ToolRegistry,
  session: ContextSessionLike,
  readers = new SourceReaderRegistry(),
): void {
  const observed = new Map<string, ReadFragment>();
  const string = { type: 'string' },
    object = { type: 'object', additionalProperties: true };
  const schema = (properties: Json, required: string[] = []) => ({
    type: 'object',
    properties,
    required,
  });
  const allowed = (id: string) => {
    const source = resolveSource(session.events, id);
    const decision = authorizeAccess(scopeFromEvents(session.events, session.id), {
      action: 'read',
      sourceIds: [source.sourceId],
    });
    if (!decision.allowed) throw new ActionFailure('permission_denied', decision.reason);
    return source;
  };
  registry.register({
    name: 'Context.list',
    description: 'List the task sources, references and current reference revision.',
    input_schema: schema({}),
    is_concurrency_safe: true,
    execute: () => ({
      sources: taskSources(session.events),
      references: taskReferences(session.events),
      referenceRevision: referenceRevision(session.events),
    }),
  });
  for (const name of ['Context.read', 'Context.search'])
    registry.register({
      name,
      description: name.endsWith('search')
        ? 'Search all authorized document content, with continuation and source locators.'
        : 'Read a task source or precise fragment. Continue using the returned cursor.',
      input_schema: schema(
        {
          source_id: string,
          locator: object,
          cursor: string,
          limit: { type: 'integer', minimum: 1, maximum: 1000 },
          ...(name.endsWith('search') ? { query: string } : {}),
        },
        name.endsWith('search') ? ['source_id', 'query'] : ['source_id'],
      ),
      is_concurrency_safe: true,
      access_for: (args) => ({
        action: 'read',
        sourceIds: [resolveSource(session.events, String(args.source_id)).sourceId],
      }),
      execute: async (args, context) => {
        const source = allowed(String(args.source_id));
        const result = await readers.get(source).read(source, {
          locator: args.locator as FragmentLocator | undefined,
          cursor: args.cursor as string | undefined,
          limit: Number(args.limit ?? 20),
          query: args.query as string | undefined,
          signal: context.signal,
        });
        if (
          result.evidenceStatus === 'ok' ||
          (result.evidenceStatus === 'degraded' && result.fragments.length)
        )
          for (const fragment of result.fragments)
            observed.set(`${source.sourceId}:${JSON.stringify(fragment.locator)}`, fragment);
        return result;
      },
    });
  registry.register({
    name: 'Context.follow',
    description: 'Register traceable child sources from an observed attachment or directory entry.',
    input_schema: schema({ source_id: string, fragment_id: string }, ['source_id', 'fragment_id']),
    execute: async (args) => {
      const source = allowed(String(args.source_id)),
        reader = readers.get(source);
      const children = (await reader.follow?.(source, String(args.fragment_id))) ?? [];
      for (const child of children) {
        if (child.parentSourceId !== source.sourceId || child.taskId !== session.id)
          throw new Error('Invalid child provenance');
        await registerSource(session, child);
      }
      return { sources: children };
    },
  });
  registry.register({
    name: 'Context.bind',
    description: 'Bind an already read locator to a task reference; does not grant new access.',
    input_schema: schema(
      {
        source_id: string,
        locator: object,
        role: { type: 'string', enum: ['source', 'reference', 'target', 'exclude'] },
        reference_id: string,
      },
      ['source_id', 'locator', 'role'],
    ),
    execute: async (args) => {
      const id = resolveSource(session.events, String(args.source_id)).sourceId,
        locator = args.locator as FragmentLocator;
      allowed(id);
      if (!observed.has(`${id}:${JSON.stringify(locator)}`))
        throw new Error('Binding requires an observed locator');
      const references = taskReferences(session.events),
        old = references.find((item) => item.referenceId === args.reference_id);
      if (args.reference_id && !old) throw new Error('Unknown reference');
      const ordinal = old?.ordinal ?? Math.max(0, ...references.map((item) => item.ordinal)) + 1;
      const binding: ReferenceBinding = {
        referenceId: old?.referenceId ?? randomUUID(),
        label: old?.label ?? referenceLabel(ordinal),
        sourceId: id,
        locator,
        role: String(args.role),
        frameLeaseId: old?.frameLeaseId ?? null,
        capturedAtMs: Date.now(),
        ordinal,
        active: true,
      };
      await updateContext(session, {
        referenceUpdates: [{ operation: old ? 'correct' : 'add', binding }],
      });
      return { binding, referenceRevision: referenceRevision(session.events) };
    },
  });
}
export function referenceLabel(ordinal: number): string {
  let label = '';
  while (ordinal > 0) {
    ordinal--;
    label = String.fromCharCode(65 + (ordinal % 26)) + label;
    ordinal = Math.floor(ordinal / 26);
  }
  return label;
}
export function fileSource(
  taskId: string,
  path: string,
  parentSourceId: string | null = null,
): SourceRef {
  const absolutePath = resolve(path);
  return {
    sourceId: randomUUID(),
    taskId,
    kind: 'file',
    title: absolutePath.split(/[\\/]/).pop()!,
    identity: { absolutePath },
    revision: {},
    capabilities: ['read', 'search', 'follow', 'patch'],
    origin: parentSourceId ? 'task-discovered' : 'user-attached',
    parentSourceId,
  };
}
