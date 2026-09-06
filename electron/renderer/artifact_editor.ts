'use strict';

(() => {
interface ArtifactRecord {
  artifactId: string;
  revision: number;
  content: string;
  kind: string;
  state: string;
  acceptedRevision: number | null;
  patchPayload: Record<string, unknown> | null;
  [key: string]: unknown;
}

interface ArtifactResponse {
  ok?: boolean;
  error?: string;
  artifact?: ArtifactRecord;
  result?: Record<string, unknown>;
}

interface ArtifactClient {
  read(payload: Record<string, unknown>): Promise<ArtifactResponse>;
  edit(payload: Record<string, unknown>): Promise<ArtifactResponse>;
  accept(payload: Record<string, unknown>): Promise<ArtifactResponse>;
  apply(payload: Record<string, unknown>): Promise<ArtifactResponse>;
}

interface EditorState {
  conversationId: string;
  artifactId: string;
  revision: number;
  content: string;
  savedContent: string;
  kind: string;
  patchPayload: Record<string, unknown> | null;
  acceptedRevision: number | null;
  dirty: boolean;
  status: 'idle' | 'loading' | 'ready' | 'saving' | 'accepting' | 'applying' | 'error';
  error: string;
  applyResult: Record<string, unknown> | null;
}

const emptyState = (): EditorState => ({
  conversationId: '',
  artifactId: '',
  revision: 0,
  content: '',
  savedContent: '',
  kind: '',
  patchPayload: null,
  acceptedRevision: null,
  dirty: false,
  status: 'idle',
  error: '',
  applyResult: null,
});

function artifactValue(value: unknown): ArtifactRecord | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Partial<ArtifactRecord>;
  const revision = Number(item.revision);
  if (!String(item.artifactId || '') || !Number.isInteger(revision) || revision < 1) return null;
  return {
    ...item,
    artifactId: String(item.artifactId),
    revision,
    content: String(item.content || ''),
    kind: String(item.kind || 'text'),
    state: String(item.state || 'generated'),
    acceptedRevision: typeof item.acceptedRevision === 'number'
      && Number.isInteger(item.acceptedRevision)
      && item.acceptedRevision >= 1
      ? item.acceptedRevision
      : null,
    patchPayload: item.patchPayload && typeof item.patchPayload === 'object'
      ? item.patchPayload as Record<string, unknown>
      : null,
  };
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('figma_retarget_value_must_be_object');
  }
  return value as Record<string, unknown>;
}

function cloneValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function figmaBaseValue(
  operation: Record<string, unknown>,
  node: Record<string, unknown>,
  locatorValue: Record<string, unknown>,
): unknown {
  const kind = String(operation.operation || '');
  if (kind === 'replace_text') {
    if (String(node.type || '') !== 'TEXT' || typeof node.characters !== 'string') {
      throw new Error('figma_retarget_requires_text_node');
    }
    locatorValue.textStart = 0;
    locatorValue.textEnd = node.characters.length;
    return node.characters;
  }
  if (kind === 'set_figma_fill') {
    const fills = node.fills;
    const first = Array.isArray(fills) ? record(fills[0]) : null;
    const color = first ? record(first.color) : null;
    if (!first || !color) throw new Error('figma_retarget_fill_unavailable');
    return { r: color.r, g: color.g, b: color.b, a: first.opacity ?? 1 };
  }
  if (kind === 'set_figma_spacing') {
    const after = record(operation.after);
    const property = String(after.property || '');
    if (!property || typeof node[property] !== 'number') {
      throw new Error('figma_retarget_spacing_unavailable');
    }
    return { property, value: node[property] };
  }
  if (kind === 'set_figma_size') {
    if (typeof node.width !== 'number' || typeof node.height !== 'number') {
      throw new Error('figma_retarget_size_unavailable');
    }
    return { width: node.width, height: node.height };
  }
  if (kind === 'set_figma_position') {
    if (typeof node.x !== 'number' || typeof node.y !== 'number') {
      throw new Error('figma_retarget_position_unavailable');
    }
    return { x: node.x, y: node.y };
  }
  throw new Error(`figma_retarget_operation_unsupported:${kind}`);
}

function retargetFigmaPatch(
  patchPayload: Record<string, unknown>,
  operationIndex: number,
  selectedNode: Record<string, unknown>,
): Record<string, any> {
  const payload = cloneValue(record(patchPayload));
  const operations = payload.operations;
  const references = payload.references;
  if (!Array.isArray(operations) || !Array.isArray(references)) {
    throw new Error('figma_retarget_patch_shape_invalid');
  }
  if (!Number.isInteger(operationIndex) || operationIndex < 0 || operationIndex >= operations.length) {
    throw new Error('figma_retarget_operation_index_invalid');
  }
  const selected = record(selectedNode);
  const nodeId = String(selected.id || '').trim();
  if (!nodeId) throw new Error('figma_retarget_selection_missing_node_id');
  const chosen = record(operations[operationIndex]);
  const chosenLocator = record(chosen.locator);
  if (chosenLocator.kind !== 'figma-node') throw new Error('figma_retarget_requires_figma_locator');
  const referenceId = String(chosen.referenceId || '');
  if (!referenceId) throw new Error('figma_retarget_reference_missing');

  let updatedCount = 0;
  payload.operations = operations.map((raw) => {
    const operation = record(raw);
    if (String(operation.referenceId || '') !== referenceId) return operation;
    const locator = record(operation.locator);
    if (locator.kind !== 'figma-node') throw new Error('figma_retarget_reference_locator_mismatch');
    const value: Record<string, unknown> = { ...record(locator.value), nodeId };
    if (typeof selected.pageId === 'string' && selected.pageId) value.pageId = selected.pageId;
    const before = figmaBaseValue(operation, selected, value);
    if (JSON.stringify(before) === JSON.stringify(operation.after)) {
      throw new Error('figma_retarget_would_be_noop');
    }
    updatedCount += 1;
    return { ...operation, locator: { ...locator, value }, before };
  });
  if (!updatedCount) throw new Error('figma_retarget_target_operation_missing');

  let targetFound = false;
  payload.references = references.map((raw) => {
    const reference = record(raw);
    if (String(reference.referenceId || '') !== referenceId) return reference;
    if (reference.role !== 'target') throw new Error('figma_retarget_reference_is_not_target');
    const locator = record(reference.locator);
    if (locator.kind !== 'figma-node') throw new Error('figma_retarget_reference_locator_mismatch');
    const value: Record<string, unknown> = { ...record(locator.value), nodeId };
    if (typeof selected.pageId === 'string' && selected.pageId) value.pageId = selected.pageId;
    targetFound = true;
    return { ...reference, locator: { ...locator, value } };
  });
  if (!targetFound) throw new Error('figma_retarget_target_reference_missing');
  return payload as Record<string, any>;
}

function createArtifactEditor(client: ArtifactClient) {
  let current = emptyState();
  let selectionGeneration = 0;

  function adopt(artifact: ArtifactRecord, options: { keepContent?: boolean } = {}) {
    const priorContent = current.content;
    const priorDirty = current.dirty;
    current = {
      ...current,
      artifactId: artifact.artifactId,
      revision: artifact.revision,
      content: options.keepContent && priorDirty ? priorContent : artifact.content,
      savedContent: artifact.content,
      kind: artifact.kind,
      patchPayload: artifact.patchPayload,
      acceptedRevision: artifact.acceptedRevision,
      dirty: options.keepContent && priorDirty ? priorContent !== artifact.content : false,
      status: 'ready',
      error: '',
    };
  }

  function fail(error: unknown): ArtifactResponse {
    current = {
      ...current,
      status: 'error',
      error: String(error || 'artifact_operation_failed'),
    };
    return { ok: false, error: current.error };
  }

  async function select(conversationId: string, artifactId: string): Promise<ArtifactResponse> {
    const generation = ++selectionGeneration;
    current = {
      ...emptyState(),
      conversationId: String(conversationId || ''),
      artifactId: String(artifactId || ''),
      status: 'loading',
    };
    try {
      const response = await client.read({
        conversationId: current.conversationId,
        artifactId: current.artifactId,
      });
      if (generation !== selectionGeneration) return { ok: false, error: 'selection_changed' };
      const artifact = artifactValue(response?.artifact);
      if (response?.ok !== true || artifact === null) {
        return fail(response?.error || 'artifact_read_failed');
      }
      adopt(artifact);
      return response;
    } catch (error) {
      if (generation !== selectionGeneration) return { ok: false, error: 'selection_changed' };
      return fail(error instanceof Error ? error.message : error);
    }
  }

  function updateContent(content: unknown): void {
    if (!current.artifactId) return;
    const value = String(content ?? '');
    current = {
      ...current,
      content: value,
      dirty: value !== current.savedContent,
      acceptedRevision: value === current.savedContent ? current.acceptedRevision : null,
      status: 'ready',
      error: '',
      applyResult: null,
    };
  }

  function updatePatchPayload(patchPayload: Record<string, unknown>): void {
    if (!current.artifactId || !patchPayload || typeof patchPayload !== 'object') return;
    current = {
      ...current,
      patchPayload,
      dirty: true,
      acceptedRevision: null,
      status: 'ready',
      error: '',
      applyResult: null,
    };
  }

  async function save(): Promise<ArtifactResponse> {
    if (!current.artifactId || current.revision < 1) return fail('artifact_not_selected');
    if (!current.dirty) return { ok: true, artifact: undefined };
    const generation = selectionGeneration;
    const submittedContent = current.content;
    current = { ...current, status: 'saving', error: '' };
    try {
      const response = await client.edit({
        conversationId: current.conversationId,
        artifactId: current.artifactId,
        expectedRevision: current.revision,
        content: submittedContent,
        patchPayload: current.patchPayload,
      });
      if (generation !== selectionGeneration) return { ok: false, error: 'selection_changed' };
      const artifact = artifactValue(response?.artifact);
      if (response?.ok !== true || artifact === null) {
        return fail(response?.error || 'artifact_save_failed');
      }
      adopt(artifact, { keepContent: current.content !== submittedContent });
      return response;
    } catch (error) {
      if (generation !== selectionGeneration) return { ok: false, error: 'selection_changed' };
      return fail(error instanceof Error ? error.message : error);
    }
  }

  async function accept(): Promise<ArtifactResponse> {
    if (!current.artifactId || current.revision < 1) return fail('artifact_not_selected');
    if (current.dirty) return fail('save_required_before_accept');
    const generation = selectionGeneration;
    current = { ...current, status: 'accepting', error: '' };
    try {
      const response = await client.accept({
        conversationId: current.conversationId,
        artifactId: current.artifactId,
        revision: current.revision,
      });
      if (generation !== selectionGeneration) return { ok: false, error: 'selection_changed' };
      const artifact = artifactValue(response?.artifact);
      if (response?.ok !== true || artifact === null) {
        return fail(response?.error || 'artifact_accept_failed');
      }
      adopt(artifact);
      return response;
    } catch (error) {
      if (generation !== selectionGeneration) return { ok: false, error: 'selection_changed' };
      return fail(error instanceof Error ? error.message : error);
    }
  }

  async function apply(): Promise<ArtifactResponse> {
    if (!current.artifactId || current.revision < 1) return fail('artifact_not_selected');
    if (current.dirty) return fail('save_required_before_apply');
    if (current.acceptedRevision !== current.revision) return fail('accept_required_before_apply');
    const generation = selectionGeneration;
    current = { ...current, status: 'applying', error: '', applyResult: null };
    try {
      const response = await client.apply({
        conversationId: current.conversationId,
        artifactId: current.artifactId,
        revision: current.revision,
      });
      if (generation !== selectionGeneration) return { ok: false, error: 'selection_changed' };
      if (response?.ok !== true || !response.result) {
        return fail(response?.error || 'artifact_apply_failed');
      }
      current = {
        ...current,
        status: response.result.status === 'succeeded' ? 'ready' : 'error',
        error: response.result.status === 'succeeded'
          ? ''
          : String(response.result.error || response.result.status || 'artifact_apply_failed'),
        applyResult: response.result,
      };
      return response;
    } catch (error) {
      if (generation !== selectionGeneration) return { ok: false, error: 'selection_changed' };
      return fail(error instanceof Error ? error.message : error);
    }
  }

  return {
    select,
    updateContent,
    updatePatchPayload,
    save,
    accept,
    apply,
    clear: () => {
      selectionGeneration += 1;
      current = emptyState();
    },
    state: () => ({ ...current }),
  };
}

const ArtifactEditor = { createArtifactEditor, retargetFigmaPatch };
if (typeof module !== 'undefined' && module.exports) module.exports = ArtifactEditor;
if (typeof globalThis !== 'undefined') {
  (globalThis as typeof globalThis & { ArtifactEditor?: typeof ArtifactEditor })
    .ArtifactEditor = ArtifactEditor;
}
})();
