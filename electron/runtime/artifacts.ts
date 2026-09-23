import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, stat, rename } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  array,
  authorizeAccess,
  insidePath,
  record,
  requiredText,
  scopeFromEvents,
  taskReferences,
  taskSources,
  updateContext,
  type AccessRequest,
  type ContextEvent,
  type ContextSessionLike,
  type FragmentLocator,
  type Json,
} from './context';
import { ToolRegistry } from './tools';
import { EventSession } from './session';

export interface DraftArtifact {
  artifactId: string;
  revision: number;
  content: string;
  contentHash: string;
  state: string;
  history: { revision: number; author: string; contentHash: string; seq: number }[];
  kind: string;
  patchPayload: DocumentPatch | null;
  acceptedRevision: number | null;
  title: string;
}
export interface PatchReference {
  referenceId: string;
  sourceId: string;
  locator: FragmentLocator;
  role: string;
}
export interface PatchOperation {
  operationId: string;
  operation: string;
  referenceId: string;
  sourceId: string;
  locator: FragmentLocator;
  before: unknown;
  after: unknown;
}
export interface DocumentPatch {
  patchId: string;
  artifactId: string;
  artifactRevision: number;
  references: PatchReference[];
  operations: PatchOperation[];
}
export interface OperationReadResult {
  ok: boolean;
  value?: unknown;
  usedBackend: string;
  error?: string;
}
export interface OperationWriteResult {
  ok: boolean;
  wrote: boolean;
  usedBackend: string;
  error?: string;
}
export interface OperationBackend {
  readCurrent(operation: PatchOperation): Promise<OperationReadResult>;
  execute(operation: PatchOperation): Promise<OperationWriteResult>;
}
export interface InverseRecord {
  operationId: string;
  forwardOperationId: string;
  operation: string;
  sourceId: string;
  locator: FragmentLocator;
  expectedCurrent: unknown;
  restore: unknown;
  strategy: string;
}
export interface PatchApplyResult {
  patchId: string;
  artifactId: string;
  artifactRevision: number;
  status: string;
  succeededOperationIds: string[];
  writtenOperationIds: string[];
  unexecutedOperationIds: string[];
  inverseRecords: InverseRecord[];
  wrote: boolean;
  verified: boolean;
  usedBackend: string;
  error: string | null;
  difference: Json | null;
}
const operations = new Set([
  'replace_text',
  'set_cell_values',
  'set_shape_text',
  'set_shape_style',
  'set_shape_geometry',
  'set_figma_fill',
  'set_figma_spacing',
  'set_figma_size',
  'set_figma_position',
  'add_pdf_annotation',
  'create_file',
  'move_file',
]);
export const contentHash = (content: string): string =>
  createHash('sha256').update(content).digest('hex');
export function documentPatch(value: unknown): DocumentPatch {
  const patch = structuredClone(record(value)) as unknown as DocumentPatch;
  for (const key of ['patchId', 'artifactId'] as const) requiredText(patch[key], key);
  if (
    !Number.isInteger(patch.artifactRevision) ||
    patch.artifactRevision < 1 ||
    !patch.references?.length ||
    !patch.operations?.length
  )
    throw new Error('Invalid document patch revision or empty operations');
  if (
    new Set(patch.references.map((item) => item.referenceId)).size !== patch.references.length ||
    new Set(patch.operations.map((item) => item.operationId)).size !== patch.operations.length
  )
    throw new Error('Duplicate patch reference or operation');
  for (const operation of patch.operations) {
    const target = patch.references.find((item) => item.referenceId === operation.referenceId);
    if (
      !operations.has(operation.operation) ||
      isDeepStrictEqual(operation.before, operation.after)
    )
      throw new Error('Invalid patch operation');
    if (
      !target ||
      target.role !== 'target' ||
      target.sourceId !== operation.sourceId ||
      !isDeepStrictEqual(target.locator, operation.locator)
    )
      throw new Error('Patch operation does not match its target reference');
  }
  return patch;
}
export function projectArtifacts(events: readonly ContextEvent[]): DraftArtifact[] {
  const drafts = new Map<string, DraftArtifact>();
  for (const event of events) {
    const data = event.data,
      id = String(data.artifactId ?? ''),
      current = drafts.get(id);
    if (!event.type.startsWith('artifact/')) continue;
    if (event.type === 'artifact/generated' || event.type === 'artifact/patched') {
      const generated = event.type === 'artifact/generated';
      if (generated ? drafts.has(id) : !current) throw new Error('Invalid artifact event identity');
      const content = requiredText(data.content, 'content'),
        revision = generated ? 1 : Number(data.revision);
      if (!generated && revision !== current!.revision + 1)
        throw new Error('Artifact revision conflict');
      const hash = contentHash(String(data.content));
      if (data.contentHash && data.contentHash !== hash)
        throw new Error('Artifact content mismatch');
      const kind = String(data.kind ?? current?.kind ?? 'text');
      let patch =
        data.patchPayload === undefined ? (current?.patchPayload ?? null) : data.patchPayload;
      if (patch)
        patch = documentPatch({ ...record(patch), artifactId: id, artifactRevision: revision });
      drafts.set(id, {
        artifactId: id,
        revision,
        content: String(data.content ?? content),
        contentHash: hash,
        state: generated ? 'generated' : 'edited',
        kind,
        title: String(data.title ?? current?.title ?? ''),
        patchPayload: patch as DocumentPatch | null,
        acceptedRevision: null,
        history: [
          ...(current?.history ?? []),
          {
            revision,
            author: String(data.author ?? 'model'),
            contentHash: hash,
            seq: event.seq ?? -1,
          },
        ],
      });
    } else if (event.type === 'artifact/accepted') {
      if (
        !current ||
        data.revision !== current.revision ||
        data.contentHash !== current.contentHash
      )
        throw new Error('Accepted artifact revision changed');
      drafts.set(id, { ...current, acceptedRevision: current.revision, state: 'approved' });
    }
  }
  return [...drafts.values()];
}
export function latestTurnArtifactSummaries(events: readonly ContextEvent[]): Json[] {
  const start = Math.max(
      -1,
      ...events.filter((event) => event.type === 'turn/start').map((event) => event.seq ?? -1),
    ),
    changed = new Set(
      events
        .filter(
          (event) =>
            ['artifact/generated', 'artifact/patched'].includes(event.type) &&
            (event.seq ?? -1) > start,
        )
        .map((event) => event.data.artifactId),
    );
  return projectArtifacts(events)
    .filter((draft) => changed.has(draft.artifactId))
    .map((draft) => ({
      artifactId: draft.artifactId,
      revision: draft.revision,
      kind: draft.kind,
      state: draft.state,
      title: draft.title,
      name: draft.title || draft.content.split('\n').find(Boolean)?.slice(0, 120),
      summary: draft.content.replace(/\s+/g, ' ').slice(0, 240),
    }));
}
export async function createArtifact(
  session: ContextSessionLike,
  content: string,
  title = '',
  kind = 'text',
  patchPayload: Json | null = null,
): Promise<DraftArtifact> {
  requiredText(content, 'content');
  const artifactId = randomUUID();
  const patch = patchPayload
    ? documentPatch({ ...patchPayload, artifactId, artifactRevision: 1 })
    : null;
  await session.append('artifact/generated', {
    artifactId,
    revision: 1,
    content,
    title,
    kind,
    contentHash: contentHash(content),
    patchPayload: patch,
    author: 'agent',
  });
  return projectArtifacts(session.events).find((item) => item.artifactId === artifactId)!;
}
export async function patchArtifact(
  session: ContextSessionLike,
  id: string,
  expectedRevision: number,
  content: string,
  options: { title?: string; author?: string; patchPayload?: unknown } = {},
): Promise<DraftArtifact> {
  const current = projectArtifacts(session.events).find((item) => item.artifactId === id);
  if (!current || current.revision !== expectedRevision) throw new Error('stale_revision');
  requiredText(content, 'content');
  const revision = current.revision + 1,
    raw = options.patchPayload ?? current.patchPayload,
    patchPayload = raw
      ? documentPatch({ ...record(raw), artifactId: id, artifactRevision: revision })
      : null;
  await session.append('artifact/patched', {
    artifactId: id,
    revision,
    content,
    contentHash: contentHash(content),
    title: options.title ?? current.title,
    kind: current.kind,
    author: options.author ?? 'agent',
    patchPayload,
  });
  return projectArtifacts(session.events).find((item) => item.artifactId === id)!;
}
export function documentPatchPaths(patch: DocumentPatch): string[] {
  return [
    ...new Set(
      patch.operations
        .flatMap((operation) => {
          const before = record(operation.before),
            after = record(operation.after);
          return operation.operation === 'create_file'
            ? [after.path]
            : operation.operation === 'move_file'
              ? [before.path, after.path]
              : operation.operation === 'add_pdf_annotation'
                ? [after.outputPath]
                : [];
        })
        .filter((value): value is string => typeof value === 'string' && !!value.trim()),
    ),
  ];
}
export function inverseDocumentPatch(
  patch: DocumentPatch,
  records: InverseRecord[],
): DocumentPatch | null {
  const references: PatchReference[] = [],
    inverse: PatchOperation[] = [];
  for (const entry of [...records].reverse()) {
    if (entry.strategy === 'retain_created_file') continue;
    const locator = structuredClone(entry.locator);
    if (entry.operation === 'replace_text') {
      const text =
        typeof entry.expectedCurrent === 'string'
          ? entry.expectedCurrent
          : String(record(entry.expectedCurrent).text ?? '');
      if ('start' in locator.value && 'end' in locator.value)
        locator.value.end = Number(locator.value.start) + text.length;
      if ('textEnd' in locator.value)
        locator.value.textEnd = Number(locator.value.textStart ?? 0) + text.length;
    }
    const referenceId = entry.operationId;
    references.push({ referenceId, sourceId: entry.sourceId, locator, role: 'target' });
    inverse.push({
      operationId: entry.operationId,
      operation: entry.operation,
      referenceId,
      sourceId: entry.sourceId,
      locator,
      before: entry.expectedCurrent,
      after: entry.restore,
    });
  }
  return inverse.length
    ? documentPatch({
        ...patch,
        patchId: `inverse:${patch.patchId}`,
        references,
        operations: inverse,
      })
    : null;
}
export async function applyDocumentPatch(
  patch: DocumentPatch,
  options: {
    backend: OperationBackend;
    state():
      | Promise<{ revision: number; acceptedRevision: number | null }>
      | { revision: number; acceptedRevision: number | null };
    authorize(request: AccessRequest): { allowed: boolean; reason: string };
    signal?: AbortSignal;
    allowAlreadyApplied?: boolean;
  },
): Promise<PatchApplyResult> {
  const succeeded: string[] = [],
    written: string[] = [],
    inverseRecords: InverseRecord[] = [],
    backends = new Set<string>();
  const result = (
    status: string,
    start: number,
    error: string | null = null,
    difference: Json | null = null,
  ): PatchApplyResult => ({
    patchId: patch.patchId,
    artifactId: patch.artifactId,
    artifactRevision: patch.artifactRevision,
    status,
    succeededOperationIds: succeeded,
    writtenOperationIds: written,
    unexecutedOperationIds: patch.operations.slice(start).map((item) => item.operationId),
    inverseRecords,
    wrote: !!written.length,
    verified: status === 'succeeded',
    usedBackend: [...backends].join('+'),
    error,
    difference,
  });
  const access = options.authorize({
    action: 'patch',
    sourceIds: [...new Set(patch.operations.map((operation) => operation.sourceId))],
    paths: documentPatchPaths(patch),
  });
  if (!access.allowed) return result('denied', 0, access.reason);
  for (const [index, operation] of patch.operations.entries()) {
    options.signal?.throwIfAborted();
    const state = await options.state();
    if (
      state.revision !== patch.artifactRevision ||
      state.acceptedRevision !== patch.artifactRevision
    )
      return result(
        written.length ? 'partial' : 'stale_revision',
        index,
        'artifact_revision_not_accepted',
      );
    const before = await options.backend.readCurrent(operation);
    backends.add(before.usedBackend);
    if (!before.ok)
      return result(
        written.length ? 'partial' : 'failed',
        index,
        before.error ?? 'pre_read_failed',
      );
    if (options.allowAlreadyApplied && isDeepStrictEqual(before.value, operation.after)) {
      succeeded.push(operation.operationId);
      continue;
    }
    if (!isDeepStrictEqual(before.value, operation.before))
      return result(written.length ? 'partial' : 'base_mismatch', index, 'base_mismatch', {
        operationId: operation.operationId,
        expected: operation.before,
        actual: before.value,
      });
    let write: OperationWriteResult;
    try {
      write = await options.backend.execute(operation);
    } catch (error) {
      return result(written.length ? 'partial' : 'failed', index + 1, String(error));
    }
    backends.add(write.usedBackend);
    if (write.wrote) {
      written.push(operation.operationId);
      inverseRecords.push({
        operationId: `inverse:${operation.operationId}`,
        forwardOperationId: operation.operationId,
        operation: operation.operation,
        sourceId: operation.sourceId,
        locator: operation.locator,
        expectedCurrent: operation.after,
        restore: operation.operation === 'create_file' ? null : operation.before,
        strategy:
          operation.operation === 'create_file'
            ? 'retain_created_file'
            : operation.operation === 'add_pdf_annotation'
              ? 'remove_annotation_if_unchanged'
              : 'restore_if_unchanged',
      });
    }
    if (!write.ok || !write.wrote)
      return result(
        written.length ? 'partial' : 'failed',
        index + 1,
        write.error ?? 'write_reported_no_effect',
      );
    const after = await options.backend.readCurrent(operation);
    backends.add(after.usedBackend);
    if (!after.ok || !isDeepStrictEqual(after.value, operation.after))
      return result('unverified', index + 1, after.error ?? 'readback_mismatch', {
        operationId: operation.operationId,
        expected: operation.after,
        actual: after.value,
      });
    succeeded.push(operation.operationId);
  }
  return result('succeeded', patch.operations.length);
}
export function registerArtifactTools(registry: ToolRegistry, session: ContextSessionLike): void {
  const string = { type: 'string' },
    schema = (properties: Json, required: string[]) => ({ type: 'object', properties, required });
  registry.register({
    name: 'Artifact.create',
    description:
      'Create a complete independent deliverable the user wants to read, edit or reuse. Ordinary answers, progress and task plans stay in conversation. Creating does not publish.',
    input_schema: schema(
      {
        title: string,
        kind: { type: 'string', enum: ['text', 'markdown', 'code', 'html', 'svg', 'mermaid'] },
        content: string,
      },
      ['title', 'kind', 'content'],
    ),
    resource_keys: ['draft-artifacts'],
    execute: (args) =>
      createArtifact(
        session,
        String(args.content),
        requiredText(args.title, 'title'),
        String(args.kind),
      ),
  });
  registry.register({
    name: 'Artifact.read',
    description:
      'Read the latest editable draft and revision before updating; creates no new card.',
    input_schema: schema({ artifact_id: string }, ['artifact_id']),
    is_concurrency_safe: true,
    execute: (args) => {
      const draft = projectArtifacts(session.events).find(
        (item) => item.artifactId === args.artifact_id,
      );
      if (!draft) throw new Error('Unknown artifact');
      return draft;
    },
  });
  registry.register({
    name: 'Artifact.update',
    description:
      'Update an existing deliverable using its current revision; preserve user edits. Does not publish.',
    input_schema: schema(
      {
        artifact_id: string,
        expected_revision: { type: 'integer' },
        content: string,
        title: string,
      },
      ['artifact_id', 'expected_revision', 'content'],
    ),
    resource_keys: ['draft-artifacts'],
    execute: (args) =>
      patchArtifact(
        session,
        String(args.artifact_id),
        Number(args.expected_revision),
        String(args.content),
        { title: args.title as string | undefined },
      ),
  });
  registry.register({
    name: 'Document.propose_patch',
    description:
      'Propose exact before/after edits to current task target references as an editable document patch. Applying requires acceptance of its revision. For PowerPoint set_shape_text, read the selected source for officeShapes styleSpans. When edited text crosses mixed styles, before and after must each include text and complete styleSpans with zero-based UTF-16 start/length and bold, italic, underline, fontName, fontSize, colorRgb. Map emphasis to the new words; if its destination is unclear, ask the user before applying.',
    input_schema: schema(
      {
        summary: string,
        operations: { type: 'array', items: { type: 'object', additionalProperties: true } },
      },
      ['summary', 'operations'],
    ),
    resource_keys: ['draft-artifacts'],
    execute: async (args) => {
      const references = taskReferences(session.events)
        .filter((item) => item.active)
        .map(({ referenceId, sourceId, locator, role }) => ({
          referenceId,
          sourceId,
          locator,
          role,
        }));
      return createArtifact(session, String(args.summary), 'Document changes', 'document_patch', {
        patchId: randomUUID(),
        references,
        operations: args.operations,
      });
    },
  });
}

export class ArtifactRegistry {
  constructor(readonly root: string) {}
  private async append(value: Json): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await appendFile(join(this.root, 'artifact-index.jsonl'), `${JSON.stringify(value)}\n`);
  }
  async list(limit = 100): Promise<Json[]> {
    let raw: string;
    try {
      raw = await readFile(join(this.root, 'artifact-index.jsonl'), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const map = new Map<string, Json>();
    for (const line of raw.split('\n').filter(Boolean)) {
      try {
        const item = record(JSON.parse(line));
        if (item.artifactId) map.set(String(item.artifactId), item);
      } catch {}
    }
    return [...map.values()]
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
      .slice(0, limit);
  }
  async get(id: string): Promise<Json> {
    const found = (await this.list(10000)).find((item) => item.artifactId === id);
    if (!found) throw new Error('artifact_not_found');
    return found;
  }
  async register(path: string, metadata: Json = {}, allowedRoots?: string[]): Promise<Json> {
    const absolute = resolve(path),
      managed = !allowedRoots;
    if (
      !(
        allowedRoots ??
        ['artifacts', 'evidence', 'context', 'review'].map((name) => join(this.root, name))
      ).some((root) => insidePath(absolute, root))
    )
      throw new Error('artifact_outside_allowed_root');
    const info = await stat(absolute);
    if (!info.isFile()) throw new Error('artifact_file_missing');
    const existing = (await this.list(10000)).find(
        (item) => String(item.path).toLowerCase() === absolute.toLowerCase(),
      ),
      now = new Date().toISOString(),
      retentionDays = managed ? Number(metadata.retentionDays ?? 30) : 0;
    const value = {
      schemaVersion: 1,
      artifactId: existing?.artifactId ?? randomUUID(),
      state: managed ? 'active' : 'external',
      managed,
      kind: extname(path).slice(1),
      path: absolute,
      trashPath: '',
      sizeBytes: info.size,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      expiresAt: managed ? new Date(Date.now() + retentionDays * 86400000).toISOString() : '',
      retentionDays,
      ...metadata,
    };
    await this.append(value);
    return value;
  }
  async cleanupExpired(confirmed: boolean): Promise<Json> {
    const candidates = (await this.list(10000)).filter(
      (item) =>
        item.managed && item.state === 'active' && Date.parse(String(item.expiresAt)) <= Date.now(),
    );
    if (!confirmed)
      return {
        status: 'confirmation_required',
        candidateArtifactIds: candidates.map((item) => item.artifactId),
        candidateCount: candidates.length,
      };
    const trashed: string[] = [];
    for (const item of candidates) {
      const path = String(item.path);
      if (!insidePath(path, this.root)) throw new Error('artifact_outside_managed_root');
      const trashPath = join(this.root, 'artifact-trash', String(item.artifactId), basename(path));
      await mkdir(dirname(trashPath), { recursive: true });
      try {
        await stat(trashPath);
        throw new Error('artifact_trash_collision');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await rename(path, trashPath);
      await this.append({
        ...item,
        state: 'trashed',
        trashPath,
        updatedAt: new Date().toISOString(),
      });
      trashed.push(String(item.artifactId));
    }
    return { status: 'trashed', trashedArtifactIds: trashed };
  }
  async restore(id: string): Promise<Json> {
    const item = await this.get(id),
      path = String(item.path),
      trash = String(item.trashPath);
    if (
      item.state !== 'trashed' ||
      !insidePath(path, this.root) ||
      !insidePath(trash, join(this.root, 'artifact-trash'))
    )
      throw new Error('artifact_not_trashed');
    try {
      await stat(path);
      throw new Error('artifact_restore_collision');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await mkdir(dirname(path), { recursive: true });
    await rename(trash, path);
    const value = {
      ...item,
      state: 'active',
      trashPath: '',
      updatedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + Number(item.retentionDays) * 86400000).toISOString(),
    };
    await this.append(value);
    return value;
  }
}
export async function handleArtifact(payload: Json, userDataDir: string): Promise<Json> {
  try {
    const session = await EventSession.open(userDataDir, String(payload.sessionId), false),
      id = String(payload.artifactId ?? ''),
      action = String(payload.action),
      all = projectArtifacts(session.events),
      current = all.find((item) => item.artifactId === id);
    const wire = (draft: DraftArtifact) => {
      const applied = [...session.events]
        .reverse()
        .find(
          (event) =>
            event.type === 'artifact/applied' &&
            event.data.artifactId === draft.artifactId &&
            event.data.artifactRevision === draft.revision,
        );
      const undone = new Set(
        session.events
          .filter(
            (event) =>
              event.type === 'artifact/undone' &&
              event.data.forwardReceiptId === applied?.data.receiptId,
          )
          .flatMap((event) => array<string>(record(event.data.result).succeededOperationIds)),
      );
      return {
        ...draft,
        latestApply: applied?.data ?? null,
        undoAvailable: array<InverseRecord>(record(applied?.data.result).inverseRecords).some(
          (entry) => entry.strategy !== 'retain_created_file' && !undone.has(entry.operationId),
        ),
      };
    };
    if (action === 'read')
      return id
        ? current
          ? { ok: true, artifact: wire(current) }
          : { ok: false, error: 'artifact_not_found' }
        : { ok: true, artifacts: all.map(wire) };
    if (!current) return { ok: false, error: 'artifact_not_found' };
    const revision = Number(action === 'edit' ? payload.expectedRevision : payload.revision);
    if (revision !== current.revision)
      return { ok: false, error: 'stale_revision', currentRevision: current.revision };
    if (action === 'edit')
      return {
        ok: true,
        artifact: wire(
          await patchArtifact(session, id, revision, String(payload.content ?? ''), {
            author: 'user',
            patchPayload: payload.patchPayload,
          }),
        ),
      };
    if (action === 'accept') {
      if (current.patchPayload) {
        const patch = documentPatch(current.patchPayload),
          sources = taskSources(session.events);
        for (const operation of patch.operations)
          if (
            !sources.some(
              (source) =>
                source.sourceId === operation.sourceId && (source.capabilities.includes('patch') ||
                  operation.operation === 'move_file' && source.capabilities.includes('move_file')),
            )
          )
            throw new Error('Patch source not granted');
        await updateContext(session, {
          scopeGrants: [
            {
              grantId: `artifact-patch:${id}:${revision}`,
              taskId: session.id,
              sourceIds: [...new Set(patch.operations.map((operation) => operation.sourceId))],
              folderRoots: [...new Set(documentPatchPaths(patch).map(dirname))],
              windowIds: [],
              recipients: [],
              actions: ['patch'],
              expiresAtMs: null,
            },
          ],
        });
      }
      await session.append('artifact/accepted', {
        artifactId: id,
        revision,
        contentHash: current.contentHash,
      });
      return {
        ok: true,
        artifact: wire(projectArtifacts(session.events).find((item) => item.artifactId === id)!),
      };
    }
    if (action !== 'apply' && action !== 'undo') throw new Error('Unsupported artifact action');
    if (!current.patchPayload) throw new Error('artifact_is_not_document_patch');
    let patch = documentPatch(current.patchPayload);
    const previous = [...session.events]
        .reverse()
        .find(
          (event) =>
            event.type === 'artifact/applied' &&
            event.data.artifactId === id &&
            event.data.artifactRevision === revision &&
            array(record(event.data.result).inverseRecords).length,
        ),
      restored = new Set(
        session.events
          .filter(
            (event) =>
              event.type === 'artifact/undone' &&
              event.data.forwardReceiptId === previous?.data.receiptId,
          )
          .flatMap((event) => array<string>(record(event.data.result).succeededOperationIds)),
      ),
      records = array<InverseRecord>(record(previous?.data.result).inverseRecords).filter(
        (entry) => !restored.has(entry.operationId),
      );
    if (action === 'apply' && records.length) throw new Error('patch_has_unreverted_writes');
    if (action === 'undo') {
      if (payload.confirmed !== true) throw new Error('undo_confirmation_required');
      const inverse = inverseDocumentPatch(patch, records);
      if (!inverse) throw new Error('no_recorded_write_to_undo');
      patch = inverse;
    }
    const { DocumentOperationBackend } = require('./actions') as typeof import('./actions');
    const backend = new DocumentOperationBackend(
      taskSources(session.events),
      array<Json>(payload._figmaRuntimeConnections),
    );
    const result = await applyDocumentPatch(patch, {
      backend,
      authorize: (request) => authorizeAccess(scopeFromEvents(session.events, session.id), request),
      state: async () => {
        const fresh = await EventSession.open(userDataDir, session.id, false),
          draft = projectArtifacts(fresh.events).find((item) => item.artifactId === id)!;
        return {
          revision: draft.revision,
          acceptedRevision: action === 'undo' ? revision : draft.acceptedRevision,
        };
      },
      allowAlreadyApplied: action === 'undo',
    });
    const receipt = {
      receiptId: randomUUID(),
      status: result.status,
      effect: 'reversible_write',
      verificationMethod: 'document_patch_readback',
      usedBackend: result.usedBackend,
      artifactIds: [id],
      wrote: result.wrote,
      verified: result.verified,
      failureType: result.error,
    };
    await session.append(action === 'undo' ? 'artifact/undone' : 'artifact/applied', {
      artifactId: id,
      artifactRevision: revision,
      receiptId: receipt.receiptId,
      result,
      receipt,
      ...(action === 'undo' ? { forwardReceiptId: previous?.data.receiptId } : {}),
    });
    const bySource = new Map(taskSources(session.events).map((source) => [source.sourceId, source]));
    const rebound = new Map<string, import('./context').SourceRef>();
    const samePath = (left: string, right: string) => {
      const a = resolve(left), b = resolve(right);
      return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
    };
    for (const operation of patch.operations) {
      if (operation.operation !== 'move_file' || !result.succeededOperationIds.includes(operation.operationId)) continue;
      const source = bySource.get(operation.sourceId), beforePath = String(record(operation.before).path ?? ''), afterPath = String(record(operation.after).path ?? '');
      const currentPath = String(source?.identity.absolutePath ?? source?.identity.path ?? '');
      if (!source || !beforePath || !afterPath || !currentPath || !samePath(currentPath, beforePath)) continue;
      const nextPath = resolve(afterPath);
      const next = { ...source, title: basename(nextPath), identity: {
        ...source.identity, absolutePath: nextPath,
        ...(source.identity.path ? { path: nextPath } : {}),
        moveRoot: source.identity.moveRoot || dirname(resolve(currentPath)),
      } };
      bySource.set(operation.sourceId, next);
      rebound.set(operation.sourceId, next);
    }
    if (rebound.size) {
      const sources = await Promise.all([...rebound.values()].map(async (source) => {
        const path = String(source.identity.absolutePath ?? source.identity.path),
          info = await stat(path);
        return { ...source, revision: {
          mtimeMs: info.mtimeMs,
          size: info.isDirectory() ? null : info.size,
          authority: 'disk',
        } };
      }));
      await updateContext(session, { sources });
    }
    const registry = new ArtifactRegistry(userDataDir),
      registered: Json[] = [];
    for (const operation of patch.operations.filter((operation) =>
      result.succeededOperationIds.includes(operation.operationId),
    )) {
      const after = record(operation.after),
        path = ['create_file', 'move_file'].includes(operation.operation)
          ? after.path
          : operation.operation === 'add_pdf_annotation'
            ? after.outputPath
            : null;
      if (typeof path === 'string' && (await stat(path).catch(() => null))?.isFile())
        registered.push(
          await registry.register(
            path,
            {
              taskId: session.id,
              sourceId: operation.sourceId,
              draftArtifactId: id,
              artifactRevision: revision,
              receiptId: receipt.receiptId,
              verificationReceipt: receipt,
              references: patch.references,
              preview: patch,
            },
            [dirname(path)],
          ),
        );
    }
    return { ok: result.verified, result, receipt, artifact: wire(current), artifacts: registered };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
