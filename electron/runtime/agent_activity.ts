import { asObject, type AgentEvent, type Data } from './agent';

const text = (value: unknown) => typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value);
export class RuntimeActivitySink {
  readonly trajectory: Data[] = [];
  readonly activities: Data[] = [];
  private started = performance.now();
  private activeMessage?: Data;
  private activeModel?: Data;
  private tools = new Map<string, Data>();
  private pendingText = '';
  private pendingReasoning = '';
  private flushAt = 0;
  constructor(readonly progress: (phase: string, fields: Data) => void, readonly header: Data = {}) {}
  private mark(phase: string, fields: Data = {}): number {
    const atMs = performance.now() - this.started;
    this.progress(phase, { ...fields, atMs }); return atMs;
  }
  private blob(phase: string, value: unknown): number {
    return this.mark(phase, { b64: Buffer.from(text(value)).toString('base64') });
  }
  private add(row: Data): Data { row.seq = this.trajectory.length + 1; this.trajectory.push(row); return row; }
  flush(): void {
    if (this.pendingText) { this.blob('answer_chunk', this.pendingText); this.pendingText = ''; }
    if (this.pendingReasoning) { this.blob('reasoning_chunk', this.pendingReasoning); this.pendingReasoning = ''; }
    this.flushAt = performance.now();
  }
  readonly onEvent = (event: AgentEvent): void => {
    const kind = event.kind;
    if (kind === 'loop_start') { this.mark('agent_start'); this.mark('session_ready', { sid: event.sessionId }); return; }
    if (kind === 'subagent' || kind === 'subagent_progress') {
      const payload = asObject(event.payload); const parent = this.tools.get(text(payload.parentCallId));
      if (parent) parent.subagent = payload;
      this.blob('subagent', payload); return;
    }
    if (kind === 'turn_started') {
      this.flush(); const at = this.mark('model_request', { turn: event.turn });
      this.add({ kind: 'request-header', turn: event.turn, step: event.turn, startedAt: at, ...this.header });
      this.activeMessage = this.add({ kind: 'message', turn: event.turn, step: event.turn, state: 'running', text: '', startedAt: at });
      this.activeModel = { kind: 'model', turn: event.turn, state: 'running', startedMs: at }; this.activities.push(this.activeModel); return;
    }
    if (kind === 'model_chunk' || kind === 'reasoning_chunk') {
      const value = text(event.text), field = kind === 'model_chunk' ? 'text' : 'reasoning';
      if (this.activeMessage) {
        this.activeMessage[field] = text(this.activeMessage[field]) + value;
        if (kind === 'model_chunk' && this.activeMessage.firstTokenAt === undefined) {
          const at = this.mark('model_first_chunk'); this.activeMessage.firstTokenAt = at;
          if (this.activeModel) this.activeModel.firstTokenMs = at - Number(this.activeModel.startedMs);
        }
      }
      if (kind === 'model_chunk') this.pendingText += value; else this.pendingReasoning += value;
      if (performance.now() - this.flushAt >= 120) this.flush(); return;
    }
    if (kind === 'model_usage') { const at = this.blob('model_usage', event.usage); if (this.activeMessage) Object.assign(this.activeMessage, { modelUsage: event.usage, completedAt: at }); return; }
    if (kind === 'tool_call_started') {
      this.flush(); const at = this.blob('tool_call', { id: event.id, name: event.name, args: text(event.arguments) });
      const record = this.add({ kind: 'tool', turn: this.activeMessage?.turn ?? 0, callId: event.id, name: event.name, state: 'running', text: text(event.arguments), startedAt: at });
      this.tools.set(text(event.id), record); this.activities.push({ kind: 'tool', id: event.id, name: event.name, state: 'running' }); return;
    }
    if (kind === 'tool_call_finished') {
      const result = asObject(event.result), state = result.is_error ? 'error' : 'done';
      const at = this.blob('tool_result', { id: result.tool_call_id, name: result.tool_name, state, backend: result.used_backend ?? '-', latency_ms: result.latency_ms, args: text(result.arguments), result: text(result.value) });
      const record = this.tools.get(text(result.tool_call_id)) ?? this.add({ kind: 'tool', callId: result.tool_call_id, name: result.tool_name, turn: this.activeMessage?.turn ?? 0 });
      Object.assign(record, { state, completedAt: at, latencyMs: result.latency_ms, usedBackend: result.used_backend, text: text(result.arguments), result: text(result.value), isError: result.is_error });
      const activity = this.activities.find(item => item.id === result.tool_call_id); if (activity) Object.assign(activity, { state, latencyMs: result.latency_ms, usedBackend: result.used_backend }); return;
    }
    if (kind === 'turn_finished' || kind === 'loop_stopped') {
      this.flush(); const at = this.mark('model_response', { state: kind === 'loop_stopped' ? asObject(event.terminal).reason : 'tool_result' });
      if (this.activeMessage) { this.activeMessage.state = 'done'; this.activeMessage.completedAt ??= at; }
      if (this.activeModel) Object.assign(this.activeModel, { state: 'done', latencyMs: at - Number(this.activeModel.startedMs) }); return;
    }
    if (kind === 'plan_updated') { this.blob('plan', event.plan); return; }
    const phases: Record<string, string> = { steered: 'steer_absorbed', followup_continued: 'followup_continued', context_compacted: 'context_compacted', budget_renewed: 'budget_renewed', verification_nudged: 'verification_nudged' };
    if (phases[kind]) this.mark(phases[kind], event);
    else if (kind === 'tool_warning') this.add({ kind: 'notice', state: 'done', text: event.message });
  };
}
