
from __future__ import annotations

from typing import Any

from app.agent_runtime.types import Terminal, TransitionReason

__all__ = ["terminal_to_answer"]

_PARTIAL_DELIVERY_REASONS = frozenset({
    TransitionReason.PROVIDER_UNAVAILABLE,
    TransitionReason.BUDGET_EXHAUSTED,
    TransitionReason.STALLED,
})


def _backend_error_brief(reason: str) -> str:
    code = str(reason or "").split(":", 1)[1] if ":" in str(reason or "") else ""
    if code.startswith("http_5"):
        return f"HTTP {code[5:]}"
    if code == "credential_missing":
        return "缺少模型密钥"
    if code == "model_request_timeout":
        return "请求超时"
    return code or "未知错误"


def terminal_to_answer(terminal: Terminal, command: str) -> dict[str, Any]:
    if terminal.reason is TransitionReason.LOCAL_ACTION:
        return {
            "ok": True,
            "prompt": command,
            "answer": "",
            "localAction": terminal.local_action,
            "route": {
                "tier": "L0",
                "action": "local_action",
                "localAction": terminal.local_action,
            },
            "loopReceipts": _receipts(terminal),
            "events": _events(terminal),
            "modelUsage": terminal.model_usage,
        }
    if terminal.reason is TransitionReason.AWAITING_USER:
        pending = dict(terminal.pending_input or {})
        question = str(pending.get("question") or terminal.message or "").strip()
        options = [
            str(option)
            for option in pending.get("options", [])
            if str(option).strip()
        ]
        visible_answer = question
        if options:
            visible_answer += "\n\n" + "\n".join(
                f"{index}. {option}" for index, option in enumerate(options, 1)
            )
        pending_input: dict[str, Any] = {"question": question, "options": options}
        if pending.get('requestId'):
            pending_input['requestId'] = pending['requestId']
        if pending.get('questions'):
            pending_input['questions'] = pending['questions']
        if str(pending.get("kind") or "").strip() == "permission":
            pending_input["kind"] = "permission"
            tool = str(pending.get("tool") or "").strip()
            if tool:
                pending_input["tool"] = tool
            prefix = str(pending.get("prefix") or "").strip()
            if prefix:
                pending_input["prefix"] = prefix
        return {
            "ok": True,
            "prompt": command,
            "answer": visible_answer,
            "error": None,
            "answerShape": "clarification",
            "awaitingUserInput": True,
            "pendingInput": pending_input,
            "loopTerminated": False,
            "loopTerminatedReason": None,
            "route": {
                "tier": "L2",
                "action": "await_user",
                "turns": terminal.turns,
            },
            "loopReceipts": _receipts(terminal),
            "events": _events(terminal),
            "modelUsage": terminal.model_usage,
        }
    terminated = terminal.reason is not TransitionReason.COMPLETED
    partial_answer = ""
    if (
        terminated
        and terminal.reason in _PARTIAL_DELIVERY_REASONS
        and any(not result.is_error for result in terminal.results)
    ):
        done_steps = [
            result.tool_name or result.tool_call_id
            for result in terminal.results
            if not result.is_error and result.tool_name
        ]
        gap = (
            "模型连接中断"
            if terminal.reason is TransitionReason.PROVIDER_UNAVAILABLE
            else ("预算用尽" if terminal.reason is TransitionReason.BUDGET_EXHAUSTED else "多轮重试未获得新证据，已停止")
        )
        listing = "\n".join(
            f"{index}. {name}"
            for index, name in enumerate(done_steps[:12], 1)
        )
        partial_answer = (
            f"{gap}，未能生成最终答复。此前已完成的操作：\n{listing}\n"
            "（以上操作已真实执行；如需继续请重试或换一个范围。）"
        )
    if partial_answer:
        return {
            "ok": True,
            "prompt": command,
            "answer": partial_answer,
            "error": None,
            "answerShape": "answer",
            "loopTerminated": True,
            "loopTerminatedReason": terminal.reason.value,
            "route": {
                "tier": "L2",
                "action": "model_loop_partial",
                "turns": terminal.turns,
            },
            "loopReceipts": _receipts(terminal),
            "events": _events(terminal),
            "modelUsage": terminal.model_usage,
        }
    answer = terminal.message or ""
    if terminated and answer.startswith("backend_error:"):
        answer = (
            f"模型服务刚才没有响应（{_backend_error_brief(answer)}）。"
            "通常是网关瞬时故障，稍等几秒重发即可；"
            "若连续出现，请到设置里检查模型与网络。"
        )
    return {
        "ok": not terminated,
        "prompt": command,
        "answer": answer,
        "error": terminal.reason.value if terminated else None,
        "answerShape": "answer",
        "loopTerminated": terminated,
        "loopTerminatedReason": terminal.reason.value if terminated else None,
        "route": {
            "tier": "L2",
            "action": "model_loop",
            "turns": terminal.turns,
        },
        "loopReceipts": _receipts(terminal),
        "events": _events(terminal),
        "modelUsage": terminal.model_usage,
    }


def _receipts(terminal: Terminal) -> list[dict[str, Any]]:
    receipts: list[dict[str, Any]] = []
    for result in terminal.results:
        receipts.append({
            "toolCallId": result.tool_call_id,
            "toolName": result.tool_name,
            "arguments": result.arguments,
            "isError": result.is_error,
            "failureType": result.failure_type,
            "usedBackend": result.used_backend,
            "latencyMs": result.latency_ms,
            "valuePreview": (result.value or "")[:200],
        })
    return receipts


def _events(terminal: Terminal) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    for result in terminal.results:
        name = result.tool_name
        if not name:
            continue
        events.append({
            "name": name,
            "arguments": result.arguments,
            "result": (result.value or ""),
            "isError": result.is_error,
            "usedBackend": result.used_backend,
            "latencyMs": result.latency_ms,
        })
    return events
