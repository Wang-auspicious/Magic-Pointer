'use strict';

interface ConversationBridgeResult {
  answer?: unknown;
  code?: unknown;
  error?: unknown;
  ok?: unknown;
}

function conversationFailureMessage(result: ConversationBridgeResult | null | undefined): string {
  const error = String(result?.error || '').trim();
  if (error === 'bridge_no_output') {
    const code = result?.code === null || result?.code === undefined ? 'unknown' : String(result.code);
    return `Agent 桥接进程已退出，但没有写出结果（bridge_no_output，exit ${code}）。`;
  }
  if (error === 'provider_unavailable') return '模型服务当前不可用（provider_unavailable）。';
  if (error === 'bridge_timeout') return 'Agent 桥接进程长时间没有任何输出（bridge_timeout）。';
  if (error === 'bridge_invalid_json') return 'Agent 桥接进程返回了无法解析的结果（bridge_invalid_json）。';
  if (error) return error;
  if (result?.ok === true && !String(result?.answer || '').trim()) {
    return '模型回合完成，但 answer 字段为空（empty_answer）。';
  }
  return 'Agent 回合失败，桥接结果没有提供 error 字段（missing_bridge_error）。';
}

export { conversationFailureMessage };
