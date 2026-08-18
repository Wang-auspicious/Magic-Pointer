"""Terminal-to-answer mapping for the loop-driven answer path (batch 4).

``selection_bridge``'s answer contract is a plain dict with ``answer``,
``answerShape``, ``route`` etc. When the free loop drives the answer
(``run_agent_turn``), the :class:`Terminal` must map back into that shape
without leaking harness internals. This module owns the mapping so it can be
tested headlessly; it performs no I/O and no model calls.

Honest rules:
- ``LOCAL_ACTION`` terminals return the deterministic action instead of
  fabricating a model answer.
- Non-completed terminations (budget, max turns, interrupt) still return
  the partial answer text with ``loopTerminatedReason`` so the caller can
  decide whether to fall back to the legacy single-shot path.
- Tool receipts are exposed as ``loopReceipts`` (used_backend / latency /
  failure_type) for audit, never merged into the answer text.
"""

from __future__ import annotations

from typing import Any

from app.agent_runtime.types import Terminal, TransitionReason

__all__ = ["terminal_to_answer"]


def terminal_to_answer(terminal: Terminal, command: str) -> dict[str, Any]:
    """Map a loop :class:`Terminal` to the selection_bridge answer shape."""
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
        return {
            "ok": True,
            "prompt": command,
            "answer": visible_answer,
            "error": None,
            "answerShape": "clarification",
            "awaitingUserInput": True,
            "pendingInput": {"question": question, "options": options},
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
    return {
        "ok": not terminated,
        "prompt": command,
        "answer": terminal.message or "",
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
    """Tool-call chain for the GUI (DSH tool rows: name/arguments/result).

    Pure projection of the same receipts; the renderer shows each tool as an
    IN/OUT row instead of hiding the agent chain behind the final answer.
    """
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
