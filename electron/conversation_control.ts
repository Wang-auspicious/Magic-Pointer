'use strict';

/* exported ConversationControl */
// Studio 会话控制的纯决策层：流式正文 / 停止 / 插话共用一条 @@mp 进度协议。
//
// 桥端（scripts/conversation_bridge.py）在 stderr 上发：
//   @@mp phase=session_ready sid=<agent-studio-…>     —— durable session id
//   @@mp phase=answer_chunk b64=<base64 正文增量>      —— 流式回答
//   @@mp phase=plan          b64=<base64 计划快照>     —— todo_write 实时推送
// blob 载荷一律走 b64= 字段：PhaseClock._token 的 120 字符截断会剪断
// base64，多步计划与正文增量都会被静默毁掉。
//
// 渲染层（classic script）与主进程/测试（require）双端共用；base64 解码
// 不依赖 Buffer——浏览器里没有它。

const ConversationControl = (() => {
  const SESSION_READY_PHASE = 'session_ready';
  const ANSWER_CHUNK_PHASE = 'answer_chunk';
  const PLAN_PHASE = 'plan';

  /** agent_session_bridge 只接受这个形状的 durable session id。 */
  const SESSION_ID_PATTERN = /^agent-studio-[0-9a-f]{32}$/;
  /** 与 scripts/agent_session_bridge.py 的 MAX_TEXT_CHARS 一致。 */
  const MAX_STEER_CHARS = 4000;

  function fieldsOf(record: unknown): Record<string, string> {
    if (!record || typeof record !== 'object') return {};
    const fields = (record as { fields?: unknown }).fields;
    return fields && typeof fields === 'object' ? (fields as Record<string, string>) : {};
  }

  function phaseOf(record: unknown): string {
    if (!record || typeof record !== 'object') return '';
    return String((record as { phase?: unknown }).phase || '');
  }

  /** session_ready 记录里的 durable session id；任何不合形都拒绝。 */
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

  /** answer_chunk 增量文本；坏数据一律空串——展示通道不能炸 UI。 */
  function decodeChunkBlob(fields: Record<string, string>): string {
    return decodeBlob(fields);
  }

  interface PlanSteps {
    steps: Array<{ content: string; status: string }>;
  }

  /** plan 快照解码；空/坏快照返回 null（渲染层保持现有计划卡不动）。 */
  function planStepsFromRecord(record: unknown): PlanSteps | null {
    if (phaseOf(record) !== PLAN_PHASE) return null;
    const raw = decodeBlob(fieldsOf(record));
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as { steps?: unknown };
      const steps = Array.isArray(parsed?.steps) ? parsed.steps : [];
      if (!steps.length) return null;
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
    | { action: 'steer'; sessionId: string; text: string }
    | { action: 'none'; reason: 'empty_text' | 'text_too_long' | 'no_session' };

  function planConversationSteer(input: {
    text?: string | null;
    agentSessionId?: string | null;
  }): ConversationSteerPlan {
    const text = String(input.text || '').trim();
    if (!text) return { action: 'none', reason: 'empty_text' };
    if (text.length > MAX_STEER_CHARS) return { action: 'none', reason: 'text_too_long' };
    const sessionId = String(input.agentSessionId || '').trim();
    if (!SESSION_ID_PATTERN.test(sessionId)) return { action: 'none', reason: 'no_session' };
    return { action: 'steer', sessionId, text };
  }

  return {
    SESSION_READY_PHASE,
    ANSWER_CHUNK_PHASE,
    PLAN_PHASE,
    sessionIdFromRecord,
    decodeChunkBlob,
    planStepsFromRecord,
    planConversationStop,
    planConversationSteer,
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = ConversationControl;
}
