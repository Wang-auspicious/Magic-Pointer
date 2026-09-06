'use strict';

interface ArtifactConversation {
  id?: string;
  agentSessionId?: string;
}

interface ArtifactConversationStore {
  get(id: string): ArtifactConversation | undefined;
}

interface ArtifactRuntimeOptions {
  conversationStore: ArtifactConversationStore;
  runBridge(payload: Record<string, unknown>): Promise<Record<string, unknown>>;
}

type ArtifactAction = 'read' | 'edit' | 'accept' | 'apply';

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function identifier(value: unknown): string | null {
  const candidate = String(value || '').trim();
  return IDENTIFIER.test(candidate) ? candidate : null;
}

function revision(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1
    ? value
    : null;
}

function createArtifactRuntime(options: ArtifactRuntimeOptions) {
  const { conversationStore, runBridge } = options;

  async function invoke(
    action: ArtifactAction,
    raw: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const conversationId = identifier(raw.conversationId);
    if (!conversationId) return { ok: false, error: 'conversation_id_invalid' };
    let conversation: ArtifactConversation | undefined;
    try {
      conversation = conversationStore.get(conversationId);
    } catch {
      return { ok: false, error: 'conversation_store_failed' };
    }
    if (!conversation) return { ok: false, error: 'conversation_not_found' };
    const sessionId = identifier(conversation.agentSessionId);
    if (!sessionId) return { ok: false, error: 'conversation_has_no_agent_session' };
    const artifactId = identifier(raw.artifactId);
    if (!artifactId && action !== 'read') {
      return { ok: false, error: 'artifact_id_invalid' };
    }

    const payload: Record<string, unknown> = {
      action,
      sessionId,
      ...(artifactId ? { artifactId } : {}),
    };
    if (action === 'edit') {
      const expectedRevision = revision(raw.expectedRevision);
      if (expectedRevision === null) {
        return { ok: false, error: 'artifact_revision_invalid' };
      }
      const content = typeof raw.content === 'string' ? raw.content : null;
      if (content === null || content.length > 1_000_000) {
        return { ok: false, error: 'artifact_content_invalid' };
      }
      if (
        raw.patchPayload !== undefined
        && (
          raw.patchPayload === null
          || typeof raw.patchPayload !== 'object'
          || Array.isArray(raw.patchPayload)
        )
      ) {
        return { ok: false, error: 'artifact_patch_payload_invalid' };
      }
      payload.expectedRevision = expectedRevision;
      payload.content = content;
      if (raw.patchPayload !== undefined) payload.patchPayload = raw.patchPayload;
    }
    if (action === 'accept' || action === 'apply') {
      const currentRevision = revision(raw.revision);
      if (currentRevision === null) {
        return { ok: false, error: 'artifact_revision_invalid' };
      }
      payload.revision = currentRevision;
    }
    try {
      return await runBridge(payload);
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return {
    read: (raw: Record<string, unknown> = {}) => invoke('read', raw),
    edit: (raw: Record<string, unknown> = {}) => invoke('edit', raw),
    accept: (raw: Record<string, unknown> = {}) => invoke('accept', raw),
    apply: (raw: Record<string, unknown> = {}) => invoke('apply', raw),
  };
}

export { createArtifactRuntime };
