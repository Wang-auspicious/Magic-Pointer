'use strict';

/* exported ConversationControl */

const ConversationControl = (() => {
  const SESSION_READY_PHASE = 'session_ready';
  const ANSWER_CHUNK_PHASE = 'answer_chunk';
  const PLAN_PHASE = 'plan';

  const SESSION_ID_PATTERN = /^(?:agent-studio-(?:new|conv)-[0-9a-f]{32}|agent-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/;
  const MAX_STEER_CHARS = 12000;

  function fieldsOf(record: unknown): Record<string, string> {
    if (!record || typeof record !== 'object') return {};
    const fields = (record as { fields?: unknown }).fields;
    return fields && typeof fields === 'object' ? (fields as Record<string, string>) : {};
  }

  function phaseOf(record: unknown): string {
    if (!record || typeof record !== 'object') return '';
    return String((record as { phase?: unknown }).phase || '');
  }

  function isConversationSender(
    event: { sender?: unknown } | null | undefined,
    dashboardWindow: { isDestroyed: () => boolean; webContents: unknown } | null | undefined,
    companionWindow: { isDestroyed: () => boolean; webContents: unknown } | null | undefined,
  ): boolean {
    const sender = event?.sender;
    return [dashboardWindow, companionWindow].some((window) => Boolean(
      window
      && !window.isDestroyed()
      && sender === window.webContents
    ));
  }

  function sessionIdFromRecord(record: unknown): string | null {
    if (phaseOf(record) !== SESSION_READY_PHASE) return null;
    const sid = String(fieldsOf(record).sid || '');
    return SESSION_ID_PATTERN.test(sid) ? sid : null;
  }

  function blobToUtf8(blob: string): string {
    if (!blob || !/^[A-Za-z0-9+/=]+$/.test(blob)) return '';
    let bytes: Uint8Array;
    try {
      if (typeof Buffer !== 'undefined') {
        bytes = new Uint8Array(Buffer.from(blob, 'base64'));
      } else {
        const binary = atob(blob);
        bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      }
      return new TextDecoder('utf8').decode(bytes);
    } catch {
      return '';
    }
  }

  function decodeBlob(fields: Record<string, string>): string {
    return blobToUtf8(String(fields.b64 || ''));
  }

  function decodeChunkBlob(fields: Record<string, string>): string {
    return decodeBlob(fields);
  }

  function createTranscript(): { answer: string; thinking: string; trajectory: Array<Record<string, unknown>> } {
    return { answer: '', thinking: '', trajectory: [] };
  }

  function appendTranscript(transcript: ReturnType<typeof createTranscript>, record: unknown): boolean {
    const phase = phaseOf(record);
    const fields = fieldsOf(record);
    const at = Number((record as { ms?: number })?.ms) || 0;
    let message = [...transcript.trajectory].reverse().find(item => item.kind === 'message');
    if (phase === 'model_request') {
      if (message) message.state = 'done';
      transcript.answer = '';
      transcript.thinking = '';
      transcript.trajectory.push({ kind: 'message', turn: Number(fields.turn) || 1, text: '', reasoning: '', state: 'running', startedAt: at });
    } else if (phase === 'answer_chunk' || phase === 'reasoning_chunk') {
      const text = decodeChunkBlob(fields);
      if (!text) return false;
      if (!message) {
        message = { kind: 'message', turn: 1, text: '', reasoning: '', state: 'running', startedAt: at };
        transcript.trajectory.push(message);
      }
      const field = phase === 'answer_chunk' ? 'text' : 'reasoning';
      message[field] = String(message[field] || '') + text;
      transcript[phase === 'answer_chunk' ? 'answer' : 'thinking'] = String(message[field]);
    } else if (phase === 'subagent') {
      try {
        const child = JSON.parse(decodeBlob(fields));
        const parent = transcript.trajectory.find(item => item.kind === 'tool' && item.callId === child.parentCallId);
        if (!parent || !child.id) return false;
        parent.subagent = child;
      } catch { return false; }
    } else if (phase === 'model_usage') {
      try {
        const usage = JSON.parse(decodeBlob(fields));
        if (message) message.modelUsage = usage;
      } catch { return false; }
    } else if (phase === 'tool_call' || phase === 'tool_result') {
      const id = String(fields.id || fields.name || '');
      let tool = transcript.trajectory.find(item => item.kind === 'tool' && item.callId === id);
      if (!tool) {
        tool = { kind: 'tool', callId: id, name: fields.name, turn: message?.turn || 1, startedAt: at };
        transcript.trajectory.push(tool);
      }
      Object.assign(tool, { state: phase === 'tool_call' ? 'running' : fields.state, text: fields.args || tool.text || '' });
      if (phase === 'tool_result') Object.assign(tool, { result: fields.result || '', isError: fields.state === 'error', completedAt: at, usedBackend: fields.backend, latencyMs: Number(fields.latency_ms) || 0 });
    } else if (phase === 'model_response') {
      if (message) Object.assign(message, { state: 'done', completedAt: at });
    } else return false;
    return true;
  }

  interface PlanSteps {
    steps: Array<{ content: string; status: string }>;
  }

  function planStepsFromRecord(record: unknown): PlanSteps | null {
    if (phaseOf(record) !== PLAN_PHASE) return null;
    const raw = decodeBlob(fieldsOf(record));
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as { steps?: unknown };
      if (!Array.isArray(parsed?.steps)) return null;
      const steps = parsed.steps;
      return {
        steps: steps.map((step: any) => ({
          content: String(step?.content || ''),
          status: String(step?.status || 'pending'),
        })),
      };
    } catch {
      return null;
    }
  }

  type ConversationStopPlan =
    | { action: 'cancel'; sessionId: string }
    | { action: 'none'; reason: 'no_request' | 'no_session' };

  function planConversationStop(input: {
    requestId?: string | null;
    agentSessionId?: string | null;
  }): ConversationStopPlan {
    const requestId = String(input.requestId || '').trim();
    if (!requestId) return { action: 'none', reason: 'no_request' };
    const sessionId = String(input.agentSessionId || '').trim();
    if (!SESSION_ID_PATTERN.test(sessionId)) return { action: 'none', reason: 'no_session' };
    return { action: 'cancel', sessionId };
  }

  type ConversationSteerPlan =
    | { action: 'steer'; sessionId: string; text: string; taskInput?: Record<string, unknown> }
    | { action: 'none'; reason: 'empty_text' | 'text_too_long' | 'no_session' };

  function planConversationSteer(input: {
    text?: string | null;
    agentSessionId?: string | null;
    taskInput?: unknown;
  }): ConversationSteerPlan {
    const taskInput = input.taskInput && typeof input.taskInput === 'object'
      ? input.taskInput as Record<string, unknown>
      : null;
    const text = String(taskInput?.instruction ?? input.text ?? '').trim();
    const hasStructuredMaterial = Boolean(
      taskInput
      && (
        (Array.isArray(taskInput.referenceUpdates) && taskInput.referenceUpdates.length > 0)
        || (Array.isArray(taskInput.sourceIds) && taskInput.sourceIds.length > 0)
      ),
    );
    if (!text && !hasStructuredMaterial) return { action: 'none', reason: 'empty_text' };
    if (text.length > MAX_STEER_CHARS) return { action: 'none', reason: 'text_too_long' };
    const sessionId = String(input.agentSessionId || '').trim();
    if (!SESSION_ID_PATTERN.test(sessionId)) return { action: 'none', reason: 'no_session' };
    return taskInput
      ? { action: 'steer', sessionId, text, taskInput }
      : { action: 'steer', sessionId, text };
  }

  function sanitizePermissionRule(value: unknown): string {
    const rule = String(value || '').trim();
    if (/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(rule)) return rule;
    const match = /^Bash\(([^()\r\n]{1,160})\)$/.exec(rule);
    const prefix = String(match?.[1] || '').trim();
    if (!prefix || /[|&;<>`]|\$\(|[\r\n]/.test(prefix)) return '';
    return `Bash(${prefix})`;
  }

  function permissionGrantRule(tool: unknown, prefix: unknown = ''): string {
    const canonical = sanitizePermissionRule(tool);
    if (!canonical) return '';
    const boundedPrefix = String(prefix || '').trim();
    if (canonical !== 'Bash' || !boundedPrefix) return canonical;
    return sanitizePermissionRule(`Bash(${boundedPrefix})`);
  }

  function failedDraftValue(current: unknown, submitted: unknown): string {
    const currentText = String(current ?? '');
    const submittedText = String(submitted ?? '');
    return currentText === '' || currentText === submittedText
      ? submittedText
      : currentText;
  }

  function bridgeHistoryTurns(turns: unknown): Array<Record<string, unknown>> {
    if (!Array.isArray(turns)) return [];
    return turns.slice(-12).map(turn => ({
      question: String(turn?.question || ''),
      answer: String(turn?.answer || ''),
      ...(turn?.evidence && typeof turn.evidence === 'object' ? { evidence: turn.evidence } : {}),
    }));
  }

  async function callConversationAction(
    action: () => Promise<{ ok?: boolean; error?: string }>,
  ): Promise<{ ok: boolean; error: string }> {
    try {
      const result = await action();
      return result?.ok === true
        ? { ok: true, error: '' }
        : { ok: false, error: String(result?.error || '请求未送达，请重试。') };
    } catch {
      return { ok: false, error: '请求未送达，请重试。' };
    }
  }

  return {
    SESSION_READY_PHASE,
    ANSWER_CHUNK_PHASE,
    PLAN_PHASE,
    sessionIdFromRecord,
    decodeChunkBlob,
    createTranscript,
    appendTranscript,
    failedDraftValue,
    bridgeHistoryTurns,
    isConversationSender,
    callConversationAction,
    planStepsFromRecord,
    planConversationStop,
    planConversationSteer,
    permissionGrantRule,
    sanitizePermissionRule,
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = ConversationControl;
}
