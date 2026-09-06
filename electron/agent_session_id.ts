'use strict';

import crypto from 'node:crypto';

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,121}$/;
const STUDIO_TOKEN = /^agent-studio-(?:new|conv)-[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;

function agentSessionId(selectionSessionId: unknown): string {
  const raw = String(selectionSessionId || '').trim();
  if (!raw) {
    throw new TypeError('selectionSessionId required');
  }
  if (TOKEN.test(raw)) return `agent-${raw}`;
  return `agent-${crypto.createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 32)}`;
}

function studioConversationSessionId({
  existing,
  conversationId,
  idFactory = () => crypto.randomUUID(),
}: {
  existing?: unknown;
  conversationId?: unknown;
  idFactory?: () => string;
} = {}): string {
  const current = String(existing || '').trim();
  if (STUDIO_TOKEN.test(current)) return current;
  const conversation = String(conversationId || '').trim();
  if (conversation) {
    return `agent-studio-conv-${crypto.createHash('sha256').update(conversation, 'utf8').digest('hex').slice(0, 32)}`;
  }
  const fresh = String(idFactory() || '').replace(/[^A-Za-z0-9._-]/g, '').replace(/-/g, '');
  if (fresh) return `agent-studio-new-${fresh.slice(0, 96)}`;
  return `agent-studio-new-${crypto.randomUUID().replace(/-/g, '')}`;
}

export { agentSessionId, studioConversationSessionId };
