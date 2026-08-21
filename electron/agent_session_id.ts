'use strict';

import crypto from 'node:crypto';

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,121}$/;

function agentSessionId(selectionSessionId: unknown): string {
  const raw = String(selectionSessionId || '').trim();
  if (!raw) {
    throw new TypeError('selectionSessionId required');
  }
  if (TOKEN.test(raw)) return `agent-${raw}`;
  return `agent-${crypto.createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 32)}`;
}

export { agentSessionId };
