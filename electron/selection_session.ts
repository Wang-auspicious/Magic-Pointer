import crypto from 'node:crypto';

type SessionState = 'capturing' | 'ready' | 'unavailable' | 'running' | 'cancelled';
type JsonObject = Record<string, unknown>;

interface ContextPacket extends JsonObject {
  schemaVersion: number;
}

interface AgentPromptDraft {
  prompt: string;
  contextPacket: ContextPacket;
  contextPacketArtifact: string;
  generatedBy: string;
}

interface SelectionSession {
  token: string;
  reason: string;
  cursor: unknown;
  state: SessionState;
  snapshot: JsonObject | null;
  summary: JsonObject | null;
  suggestedCommands: unknown[];
  panelLayoutNonce: string | null;
  panelGeometry: unknown;
  panelPlacement: unknown;
  agentPromptDraft: AgentPromptDraft | null;
  activeRequestId: string | null;
  createdAt: number;
  expiresAt: number;
}

interface StoreOptions {
  ttlMs?: number;
  maxFrozen?: number;
  idFactory?: () => string;
}

interface CreateOptions {
  reason?: string;
  cursor?: unknown;
}

interface SnapshotPayload {
  selectionSnapshot?: JsonObject | null;
  captureSummary?: JsonObject | null;
  suggestedCommands?: unknown[];
}

interface PanelLayout {
  nonce: string;
  geometry: unknown;
}

interface AgentPromptDraftInput {
  prompt?: unknown;
  contextPacket?: ContextPacket | null;
  contextPacketArtifact?: unknown;
  generatedBy?: unknown;
}

// A capture is a *frozen moment*, not a lease on the live screen. Once the
// pixels and the structured read are in hand, waiting three minutes before
// asking the next question changes nothing about what that moment contained,
// so nothing about it may expire. The old 2-minute TTL turned every slow
// human into "NEEDS ATTENTION" and threw the moment away.
//
// What still has a deadline is a capture that never finished: a session stuck
// in `capturing` holds no evidence, so it is ordinary garbage.
class SelectionSessionStore {
  readonly ttlMs: number;
  readonly maxFrozen: number;
  readonly idFactory: () => string;
  readonly sessions = new Map<string, SelectionSession>();

  constructor({
    ttlMs = 2 * 60 * 1000,
    maxFrozen = 24,
    idFactory = () => crypto.randomUUID(),
  }: StoreOptions = {}) {
    this.ttlMs = ttlMs;
    this.maxFrozen = Math.max(1, Math.floor(maxFrozen));
    this.idFactory = idFactory;
  }

  // A session holds evidence once a capture landed on it. `unavailable` counts:
  // "we looked and there was nothing readable there" is itself a frozen fact,
  // and dropping it would make the same question fail differently over time.
  static isFrozen(entry: SelectionSession): boolean {
    return entry.state === 'ready' || entry.state === 'unavailable' || entry.state === 'running';
  }

  prune(now = Date.now()): void {
    for (const [token, entry] of this.sessions.entries()) {
      if (entry.state === 'cancelled') {
        this.sessions.delete(token);
        continue;
      }
      // Frozen evidence never ages out. Only a capture that never produced a
      // snapshot can go stale, because it is holding nothing.
      if (SelectionSessionStore.isFrozen(entry)) continue;
      if (entry.expiresAt <= now) this.sessions.delete(token);
    }
  }

  // Memory, not time, is the only reason a frozen moment is ever released:
  // keep the newest `maxFrozen` captures and drop the oldest beyond that.
  evictOverflow(): void {
    const frozen = [...this.sessions.entries()].filter(([, entry]) =>
      SelectionSessionStore.isFrozen(entry),
    );
    if (frozen.length <= this.maxFrozen) return;
    frozen.sort((a, b) => a[1].createdAt - b[1].createdAt);
    for (const [token] of frozen.slice(0, frozen.length - this.maxFrozen)) {
      this.sessions.delete(token);
    }
  }

  create(
    { reason = 'manual', cursor = null }: CreateOptions = {},
    now = Date.now(),
  ): SelectionSession {
    this.prune(now);
    const token = this.idFactory();
    const entry: SelectionSession = {
      token,
      reason,
      cursor,
      state: 'capturing',
      snapshot: null,
      summary: null,
      suggestedCommands: [],
      panelLayoutNonce: null,
      panelGeometry: null,
      panelPlacement: null,
      agentPromptDraft: null,
      activeRequestId: null,
      createdAt: now,
      expiresAt: now + this.ttlMs,
    };
    this.sessions.set(token, entry);
    this.evictOverflow();
    return entry;
  }

  get(token: unknown, now = Date.now()): SelectionSession | null {
    this.prune(now);
    if (typeof token !== 'string' || !token) return null;
    return this.sessions.get(token) ?? null;
  }

  attachSnapshot(
    token: unknown,
    payload: SnapshotPayload | null | undefined,
    now = Date.now(),
  ): SelectionSession | null {
    const entry = this.get(token, now);
    if (!entry) return null;
    entry.snapshot = payload?.selectionSnapshot || null;
    entry.summary = payload?.captureSummary || null;
    entry.suggestedCommands = Array.isArray(payload?.suggestedCommands)
      ? payload.suggestedCommands.slice(0, 4)
      : [];
    entry.state = entry.snapshot ? 'ready' : 'unavailable';
    // The entry only becomes frozen here, so this is where the cap can first
    // be exceeded.
    this.evictOverflow();
    return this.sessions.get(entry.token) ?? entry;
  }

  setPanelLayout(
    token: unknown,
    { nonce, geometry }: PanelLayout,
    now = Date.now(),
  ): SelectionSession | null {
    const entry = this.get(token, now);
    if (!entry || typeof nonce !== 'string' || !nonce) return null;
    entry.panelLayoutNonce = nonce;
    entry.panelGeometry = geometry || null;
    entry.panelPlacement = null;
    return entry;
  }

  setPanelPlacement(token: unknown, placement: unknown, now = Date.now()): SelectionSession | null {
    const entry = this.get(token, now);
    if (!entry) return null;
    entry.panelPlacement = placement || null;
    return entry;
  }

  setAgentPromptDraft(
    token: unknown,
    draft?: AgentPromptDraftInput | null,
    now = Date.now(),
  ): AgentPromptDraft | null {
    const entry = this.get(token, now);
    const prompt = String(draft?.prompt || '').trim();
    const contextPacket = draft?.contextPacket;
    if (
      !entry ||
      !prompt ||
      prompt.length > 60000 ||
      !contextPacket ||
      contextPacket.schemaVersion !== 2
    ) {
      return null;
    }
    entry.agentPromptDraft = {
      prompt,
      contextPacket: JSON.parse(JSON.stringify(contextPacket)) as ContextPacket,
      contextPacketArtifact: String(draft?.contextPacketArtifact || ''),
      generatedBy: String(draft?.generatedBy || ''),
    };
    return entry.agentPromptDraft;
  }

  getAgentPromptDraft(token: unknown, now = Date.now()): AgentPromptDraft | null {
    return this.get(token, now)?.agentPromptDraft ?? null;
  }

  clearAgentPromptDraft(token: unknown, now = Date.now()): boolean {
    const entry = this.get(token, now);
    if (!entry) return false;
    entry.agentPromptDraft = null;
    return true;
  }

  startRequest(token: unknown, now = Date.now()): string | null {
    const entry = this.get(token, now);
    if (!entry || !entry.snapshot) return null;
    const requestId = this.idFactory();
    entry.activeRequestId = requestId;
    entry.state = 'running';
    entry.expiresAt = now + this.ttlMs;
    return requestId;
  }

  finishRequest(token: unknown, requestId: unknown, now = Date.now()): SelectionSession | null {
    const entry = this.get(token, now);
    if (!entry || entry.activeRequestId !== requestId) return null;
    entry.state = 'ready';
    entry.activeRequestId = null;
    entry.expiresAt = now + this.ttlMs;
    return entry;
  }

  isCurrentRequest(token: unknown, requestId: unknown, now = Date.now()): boolean {
    const entry = this.get(token, now);
    return Boolean(entry && entry.activeRequestId === requestId);
  }

  cancel(token: string): boolean {
    const entry = this.sessions.get(token);
    if (!entry) return false;
    entry.state = 'cancelled';
    this.sessions.delete(token);
    return true;
  }
}

export { SelectionSessionStore };
