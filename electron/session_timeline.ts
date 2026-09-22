'use strict';


const MAX_SESSIONS = 20;
const MAX_PHASES_PER_SESSION = 40;

const HEADLINE_PHASES = Object.freeze({
  structured_read: '读取结构',
  pixels_frozen: '冻结画面',
  enrich_screen_region: 'OCR',
  engine_plan: '规划',
  model_compile: '模型',
  route_l0: '快路径',
  total: '合计',
});
type PhaseName = keyof typeof HEADLINE_PHASES;
type TimelinePhase = {
  script: string;
  phase: string;
  ms: number;
  detail: string;
  at: number;
};
type TimelineSession = {
  id: string;
  reason: string;
  startedAt: number;
  endedAt: number | null;
  phases: TimelinePhase[];
  outcome: string;
  error: string;
  tier: string;
};

class SessionTimeline {
  maxSessions: number;
  now: () => number;
  sessions: TimelineSession[];

  constructor({
    maxSessions = MAX_SESSIONS,
    now = () => Date.now(),
  }: { maxSessions?: number; now?: () => number } = {}) {
    this.maxSessions = Math.max(1, Number(maxSessions) || MAX_SESSIONS);
    this.now = now;
    this.sessions = [];
  }

  begin(token: unknown, { reason = '' }: { reason?: unknown } = {}): TimelineSession | null {
    const id = String(token || '');
    if (!id) return null;
    const existing = this.sessions.find((session) => session.id === id);
    if (existing) return existing;
    const session = {
      id,
      reason: String(reason || ''),
      startedAt: this.now(),
      endedAt: null,
      phases: [],
      outcome: '',
      error: '',
      tier: '',
    };
    this.sessions.unshift(session);
    if (this.sessions.length > this.maxSessions) this.sessions.length = this.maxSessions;
    return session;
  }

  phase(
    token: unknown,
    {
      script = '',
      phase = '',
      ms = 0,
      detail = '',
    }: { script?: unknown; phase?: unknown; ms?: unknown; detail?: unknown } = {},
  ): void {
    const session = this.sessions.find((item) => item.id === String(token || ''));
    if (!session) return;
    if (session.phases.length >= MAX_PHASES_PER_SESSION) return;
    const elapsed = Number(ms);
    session.phases.push({
      script: String(script || '').replace(/^scripts\//, ''),
      phase: String(phase || ''),
      ms: Number.isFinite(elapsed) ? Math.max(0, Math.round(elapsed)) : 0,
      detail: String(detail || '').slice(0, 120),
      at: this.now(),
    });
  }

  finish(
    token: unknown,
    {
      outcome = '',
      error = '',
      tier = '',
    }: { outcome?: unknown; error?: unknown; tier?: unknown } = {},
  ): void {
    const session = this.sessions.find((item) => item.id === String(token || ''));
    if (!session) return;
    session.endedAt = this.now();
    session.outcome = String(outcome || '');
    if (error) session.error = String(error).slice(0, 300);
    if (tier) session.tier = String(tier).slice(0, 8);
  }

  snapshot() {
    return this.sessions.map((session) => {
      const headline = [];
      for (const [phase, label] of Object.entries(HEADLINE_PHASES) as Array<[PhaseName, string]>) {
        const match = session.phases.filter((item) => item.phase === phase).pop();
        if (match) headline.push({ label, phase, ms: match.ms });
      }
      const totalMs = session.endedAt === null ? null : session.endedAt - session.startedAt;
      return {
        id: session.id,
        reason: session.reason,
        startedAt: session.startedAt,
        totalMs,
        outcome: session.outcome,
        error: session.error,
        tier: session.tier,
        headline,
        phases: session.phases.map((item) => ({
          script: item.script,
          phase: item.phase,
          ms: item.ms,
          detail: item.detail,
        })),
      };
    });
  }

  clear(): void {
    this.sessions = [];
  }
}

module.exports = { HEADLINE_PHASES, MAX_PHASES_PER_SESSION, MAX_SESSIONS, SessionTimeline };
