'use strict';

// The last N sessions, as a timeline you can read.
//
// Diagnosing the 2026-08-04 failures meant hand-reading data/runtime/electron.log
// and correlating timestamps by eye. Every number needed was already being
// emitted — bridge_progress.py stamps every phase — it just went to a log file
// and nowhere a person would look.
//
// This keeps a bounded in-memory ring of recent sessions so the diagnostics page
// can show "snapshot 12.9s / OCR 0.4s / model 2.1s / result" per session. Bounded
// because a diagnostic that grows without limit becomes the problem it was meant
// to find.
//
// Deliberately not persisted: session timings are for the session you are in.
// Writing them to disk would mean deciding how long to keep timing data about
// what the user pointed at, and that is a privacy question this does not need to
// open. The audit log already covers what has to survive a restart.

const MAX_SESSIONS = 20;
const MAX_PHASES_PER_SESSION = 40;

// Phases whose duration a person actually reads. Everything else is kept for
// the raw list but these are what the summary row shows.
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

  // A session begins when the user activates, not when a bridge starts: the
  // interesting question is how long from gesture to answer.
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

  // How the session ended, in the user's terms. `error` is a written sentence,
  // never a bridge code: this feeds a page a person reads.
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

  // What the diagnostics page renders. Durations only — no window titles, no
  // selected text, no capture paths. A timing page must not become a second
  // place the user's screen content lives.
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
