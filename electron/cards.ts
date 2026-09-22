'use strict';

interface CardStep {
  label?: string;
  phase?: string;
  state?: string;
  [key: string]: unknown;
}

interface CardData {
  actions?: unknown[];
  id?: string;
  kind?: string;
  progress?: number | null;
  source?: Record<string, unknown> | null;
  stage?: string;
  startedAt?: number | null;
  state?: string;
  steps?: CardStep[];
  subtitle?: string;
  title?: string;
  [key: string]: unknown;
}


const CardModel = (() => {
  const KINDS = Object.freeze([
    'prose',
    'facts',
    'metric',
    'image',
    'proposal',
    'diff',
    'table',
    'prompt',
    'steps',
    'slot',       // MCP server 自己渲染的一块界面（沙盒 iframe）
  ]);

  const STATES = Object.freeze(['running', 'done', 'failed']);

  const LEGACY_KIND = Object.freeze({
    inline: 'prose',
    'text-draft': 'diff',
    'table-compare': 'table',
    'agent-prompt-draft': 'prompt',
  });

  function normalizeKind(raw: unknown): string {
    const key = String(raw || '').trim();
    if (KINDS.includes(key)) return key;
    const legacyKinds = LEGACY_KIND as Readonly<Record<string, string>>;
    if (legacyKinds[key]) return legacyKinds[key];
    return 'prose';
  }

  const PHASE_TEXT = Object.freeze({
    perceived: '我看到了',
    payload_read: '收到了你要问的',
    settings_loaded: '读了设置',
    windows_enumerated: '过了一遍窗口',
    pixels_frozen: '冻住了这块画面',
    structured_read: '读窗口里的文字',
    context_from_snapshot: '凑上下文',
    enrich_screen_region: '补屏幕上的信息',
    route_recipe: '挑了能用的能力',
    model_request: '交给模型',
    model_response: '模型答完了',
    loop_started: '开工',
    loop_progress: '继续读证据',
    context_compacted: '压缩了上下文，进度已保留',
    steer_absorbed: '你的插话已吸收',
    followup_continued: '按你的补充继续跑',
    backend_recovery: '模型端点抖动，等待恢复后重试',
    tools_truncated: '工具太多，本轮只加载一部分',
    action_planned: '排好了要做的事',
    action_executed: '做完了',
    verify: '回读确认',
    total: '完成',
  });


  const PLUMBING_PHASES: ReadonlySet<string> = new Set([
    'perceived', 'payload_read', 'settings_loaded', 'windows_enumerated',
    'pixels_frozen', 'structured_read', 'context_from_snapshot',
    'enrich_screen_region', 'enrich_local_file', 'route_recipe',
    'loop_started', 'loop_router_start', 'loop_progress',
    'model_request', 'model_response', 'backend_recovery',
    'total',
  ]);

  function isPlumbingPhase(phase: unknown): boolean {
    return PLUMBING_PHASES.has(String(phase || ''));
  }

  const TYPICAL_PHASES = 7;

  function decodeActivity(blob: unknown): Record<string, unknown> | null {
    const text = String(blob || '').trim();
    if (!text) return null;
    try {
      const globalScope = globalThis as unknown as {
        Buffer?: { from(input: string, encoding: string): { toString(encoding: string): string } };
        atob?: (input: string) => string;
      };
      let json = '';
      if (typeof globalScope.Buffer?.from === 'function') {
        json = globalScope.Buffer.from(text, 'base64').toString('utf8');
      } else if (typeof globalScope.atob === 'function') {
        const binary = globalScope.atob(text);
        const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
        json = new TextDecoder().decode(bytes);
      } else {
        return null;
      }
      const parsed = JSON.parse(json);
      return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
    } catch (_) {
      return null;
    }
  }

  function toolStep(record: { phase?: unknown; fields?: unknown } = {}) {
    const phase = String(record.phase || '').trim();
    const fields = record.fields && typeof record.fields === 'object'
      ? record.fields as Record<string, unknown>
      : {};
    if (phase === 'tool_call') {
      const name = String(fields.name || '').trim();
      if (!name) return null;
      return {
        phase: `tool:${String(fields.id || name)}`,
        label: name,
        note: '',
        ms: null,
        state: 'pending',
      };
    }
    if (phase !== 'tool_activity') return null;
    const line = decodeActivity(fields.b64);
    if (!line) return null;
    const tool = String(line.tool || '').trim();
    if (!tool) return null;
    const target = String(line.target || '').trim();
    return {
      phase: `tool:${String(line.id || tool)}`,
      label: target ? `${tool}(${target})` : tool,
      note: String(line.detail || ''),
      ms: null,
      state: line.ok === false ? 'failed' : 'done',
    };
  }

  function phaseStep(record: { phase?: unknown; fields?: unknown; ms?: number } = {}) {
    const phase = String(record.phase || '').trim();
    if (!phase) return null;
    if (phase === 'tool_call' || phase === 'tool_activity') return toolStep(record);
    const label = (PHASE_TEXT as Readonly<Record<string, string>>)[phase] || phase.replace(/_/g, ' ');
    const fields = record.fields && typeof record.fields === 'object'
      ? record.fields as Record<string, unknown>
      : {};
    let note = '';
    if (fields.w && fields.h) note = `${fields.w}×${fields.h}`;
    else if (fields.hit) note = String(fields.hit);
    else if (fields.recipe) note = String(fields.recipe);
    else if (fields.tier) note = String(fields.tier);
    else if (fields.name) note = String(fields.name);
    else if (phase === 'tools_truncated' && fields.count && fields.limit) {
      note = `${fields.count} 个 · 上限 ${fields.limit}`;
      if (fields.names) note += ` · ${fields.names}`;
    }
    const round = Number(fields.turn);
    if (Number.isFinite(round) && round > 0) {
      note = note ? `第 ${round} 轮 · ${note}` : `第 ${round} 轮`;
    }
    return {
      phase,
      label,
      note,
      ms: Number.isFinite(record.ms) ? record.ms : null,
      state: 'done',
    };
  }

  function progressFromSteps(steps: CardStep[] = [], typical = TYPICAL_PHASES): number | null {
    const done = steps.filter((s) => s && s.state === 'done').length;
    if (!done) return null;
    return Math.min(0.92, done / Math.max(1, typical));
  }

  let counter = 0;

  function newCardId(seed: unknown): string {
    counter += 1;
    return `c${seed || 0}-${counter.toString(36)}`;
  }

  function normalizeCard(raw: CardData = {}, options: { id?: string; seed?: unknown } = {}): CardData {
    const kind = normalizeKind(raw.kind);
    const state = typeof raw.state === 'string' && STATES.includes(raw.state) ? raw.state : 'done';
    const steps = Array.isArray(raw.steps) ? raw.steps.filter(Boolean) : [];
    const explicit = typeof raw.progress === 'number' && Number.isFinite(raw.progress)
      ? clamp01(raw.progress)
      : null;
    return {
      ...raw,
      id: raw.id || options.id || newCardId(options.seed),
      kind,
      state,
      title: String(raw.title || ''),
      subtitle: String(raw.subtitle || ''),
      steps,
      progress: state === 'done'
        ? 1
        : (explicit ?? (state === 'failed' ? null : progressFromSteps(steps))),
      stage: String(raw.stage || ''),
      actions: Array.isArray(raw.actions) ? raw.actions : [],
      source: raw.source && typeof raw.source === 'object' ? raw.source : null,
      startedAt: Number.isFinite(raw.startedAt) ? raw.startedAt : null,
    };
  }

  function clamp01(n: number): number | null {
    if (!Number.isFinite(n)) return null;
    return Math.max(0, Math.min(1, n));
  }

  function applyPatch(card: CardData, patch: CardData = {}): CardData {
    const base = normalizeCard(card);
    if (base.state !== 'running') return base;

    const next = { ...base };

    if (Array.isArray(patch.steps) && patch.steps.length) {
      const byPhase = new Map((next.steps || []).map((s) => [s.phase || s.label || '', s]));
      for (const step of patch.steps) {
        if (!step) continue;
        const key = step.phase || step.label || '';
        byPhase.set(key, { ...byPhase.get(key), ...step });
      }
      next.steps = [...byPhase.values()];
    }

    for (const [key, value] of Object.entries(patch)) {
      if (key === 'steps' || key === 'id' || key === 'progress') continue;
      if (value === undefined) continue;
      next[key] = value;
    }

    if (typeof patch.state === 'string' && STATES.includes(patch.state)) next.state = patch.state;
    if (next.state === 'done') {
      next.progress = 1;
    } else if (next.state === 'failed') {
      next.progress = base.progress;
    } else {
      const proposed = typeof patch.progress === 'number' && Number.isFinite(patch.progress)
        ? clamp01(patch.progress)
        : progressFromSteps(next.steps || []);
      next.progress = pickForward(base.progress, proposed);
    }

    return normalizeCard(next, { id: next.id });
  }

  function pickForward(current: number | null | undefined, proposed: number | null): number | null | undefined {
    if (typeof proposed !== 'number' || !Number.isFinite(proposed)) return current;
    if (typeof current !== 'number' || !Number.isFinite(current)) return proposed;
    return Math.max(current, proposed);
  }

  const RUNNING_HINT = Object.freeze({
    image: '正在出图',
    proposal: '正在想该怎么改',
    diff: '正在算改动',
    table: '正在对比',
    prompt: '正在写提示词',
    metric: '正在算',
    facts: '正在核对',
    steps: '正在做',
    slot: '正在连工具',
    prose: '正在想',
  });

  function runningLabel(card: CardData = {}): string {
    if (card.stage) return card.stage;
    const steps = card.steps || [];
    const active = steps.find((s) => s && s.state === 'pending' && s.label);
    if (active) return active.label || '';
    const generic = (RUNNING_HINT as Readonly<Record<string, string>>)[normalizeKind(card.kind)] || '正在处理';
    if (!steps.length) return generic;
    return card.kind === 'image' ? RUNNING_HINT.image : '在等模型回话';
  }

  function perceivedStep(summary: { label?: unknown; detail?: unknown } | null | undefined) {
    const label = String(summary?.label || '').trim();
    if (!label) return null;
    const detail = String(summary?.detail || '').trim();
    return {
      phase: 'perceived',
      label: `我看到了：${label}${detail ? ` · ${detail}` : ''}`,
      note: '',
      ms: 0,
      state: 'done',
    };
  }

  function isSettled(card: CardData = {}): boolean {
    return card.state === 'done' || card.state === 'failed';
  }

  return Object.freeze({
    KINDS,
    STATES,
    LEGACY_KIND,
    PHASE_TEXT,
    isPlumbingPhase,
    TYPICAL_PHASES,
    normalizeKind,
    normalizeCard,
    applyPatch,
    phaseStep,
    toolStep,
    perceivedStep,
    progressFromSteps,
    runningLabel,
    isSettled,
  });
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = CardModel;
}
