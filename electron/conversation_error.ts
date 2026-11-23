'use strict';

interface ConversationBridgeResult {
  answer?: unknown;
  code?: unknown;
  detail?: unknown;
  error?: unknown;
  ok?: unknown;
}

function formatBackendErrorDetail(raw: string): string {
  const detail = raw.trim();
  if (/^model_request_timeout$/i.test(detail)) {
    return '模型响应超时（上游流式连接长时间无响应，已自动重试仍未恢复），可直接点击重试。';
  }
  if (/^http_429\b|rate_limit/i.test(detail)) {
    return '模型接口触发限流（HTTP 429，已自动退避重试仍受限），请稍候几秒后点击重试。';
  }
  if (/^circuit_open:/i.test(detail)) {
    return '模型端点暂时处于冷却保护（连续请求失败），请稍候几秒后点击重试。';
  }
  if (/fetch failed|ECONNRESET|ETIMEDOUT|UND_ERR_/i.test(detail)) {
    return `模型网络连接中断（${detail.slice(0, 140)}），可直接点击重试。`;
  }
  return `模型服务返回错误（${detail.slice(0, 160)}），可直接点击重试。`;
}

function conversationFailureMessage(
  result: ConversationBridgeResult | null | undefined,
): string {
  const error = String(result?.error || '').trim();
  if (error === 'bridge_no_output') {
    const code =
      result?.code === null || result?.code === undefined
        ? 'unknown'
        : String(result.code);
    return `Agent 桥接进程已退出，但没有写出结果（bridge_no_output，exit ${code}）。`;
  }
  if (error === 'provider_unavailable') {
    const rawDetail = String(result?.detail || result?.answer || '')
      .replace(/^backend_error:\s*/i, '')
      .trim();
    if (rawDetail && rawDetail !== 'provider_unavailable') {
      return formatBackendErrorDetail(rawDetail);
    }
    return '模型服务当前不可用（provider_unavailable）。';
  }
  if (/^backend_error:/i.test(error)) {
    const rawDetail = error.replace(/^backend_error:\s*/i, '').trim();
    if (rawDetail) {
      return formatBackendErrorDetail(rawDetail);
    }
  }
  if (error === 'bridge_timeout') {
    return 'Agent 桥接进程长时间没有任何输出（bridge_timeout）。';
  }
  if (error === 'bridge_invalid_json') {
    return 'Agent 桥接进程返回了无法解析的结果（bridge_invalid_json）。';
  }
  if (error) {
    return error;
  }
  if (result?.ok === true && !String(result?.answer || '').trim()) {
    return '模型回合完成，但 answer 字段为空（empty_answer）。';
  }
  return 'Agent 回合失败，桥接结果没有提供 error 字段（missing_bridge_error）。';
}

export {conversationFailureMessage};
