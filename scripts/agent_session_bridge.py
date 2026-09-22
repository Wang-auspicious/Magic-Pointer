
from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Any

_BRIDGE_ROOT = Path(__file__).resolve().parents[1]
if str(_BRIDGE_ROOT) not in sys.path:
    sys.path.insert(0, str(_BRIDGE_ROOT))

try:
    from scripts._bridge_common import (
        PayloadTooLargeError,
        ensure_root_on_path,
        force_utf8_stdio,
        read_bounded_json_payload,
        write_json,
    )
except ModuleNotFoundError:
    from _bridge_common import (  # type: ignore[no-redef]
        PayloadTooLargeError,
        ensure_root_on_path,
        force_utf8_stdio,
        read_bounded_json_payload,
        write_json,
    )

ensure_root_on_path()

from app.agent_runtime.session import EventSession, FileSessionStore  # noqa: E402
from app.context_pack.source_store import register_source, task_sources  # noqa: E402
from app.context_pack.sources import SourceRef, TaskInput  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
TARGETS = frozenset({"next-step", "next-turn"})
MAX_TEXT_CHARS = 12000
MAX_PENDING_MESSAGES = 100


def _session_root() -> Path:
    configured = str(os.environ.get("MAGIC_POINTER_USER_DATA_DIR") or "").strip()
    runtime_root = Path(configured) if configured else ROOT / "data" / "runtime"
    return runtime_root / "agent-sessions"


def _context_usage(session: EventSession) -> dict[str, int] | None:
    from app.agent_runtime.loop import _real_prompt_tokens  # noqa: PLC0415
    from app.agent_runtime.token_estimate import estimate_request_tokens  # noqa: PLC0415
    from app.agent_runtime.types import Role  # noqa: PLC0415

    events = list(session.events)
    response = next((event for event in reversed(events)
                     if event.type == "model/response" and _real_prompt_tokens(event.data.get("usage")) > 0), None)
    if response is None:
        return None
    request_index = next((index for index in range(len(events) - 1, -1, -1)
                          if events[index].type == "model/request"
                          and events[index].data.get("turn") == response.data.get("turn")
                          and events[index].data.get("step") == response.data.get("step")), None)
    if request_index is None:
        return None
    request = events[request_index].data
    usage = response.data["usage"]
    messages = EventSession(session.path, session.header, events[:request_index]).derive_messages()
    result = {
        "contextTokens": _real_prompt_tokens(usage),
        "contextEstimated": 0,
        "lastOutputTokens": int(usage.get("completion_tokens") or usage.get("output_tokens") or 0),
        "systemTokensEstimate": estimate_request_tokens([], system_prompt=request.get("header", {}).get("systemPrompt", "")),
        "toolSchemaTokensEstimate": estimate_request_tokens([], tools=request.get("tools", [])),
        "messageTokensEstimate": estimate_request_tokens([m for m in messages if m.role != Role.TOOL]),
        "toolResultTokensEstimate": estimate_request_tokens([m for m in messages if m.role == Role.TOOL]),
    }
    return result


def handle_request(payload: dict[str, Any]) -> dict[str, Any]:
    action = str(payload.get("action") or "").strip()
    session_id = str(payload.get("sessionId") or "").strip()
    raw_task_input = payload.get("taskInput")
    try:
        task_input = (
            TaskInput.from_dict(raw_task_input)
            if isinstance(raw_task_input, dict)
            else None
        )
    except ValueError as exc:
        return {"ok": False, "error": f"invalid_task_input: {exc}"}
    target = str(
        task_input.target if task_input is not None else payload.get("target") or ""
    ).strip()
    if action not in {"cancel", "status", "usage", "fork", "recovery-resolve", "subagent-respond"} and target not in TARGETS:
        return {"ok": False, "error": "invalid_target"}
    try:
        session = FileSessionStore(_session_root()).resume(session_id, repair=False)
    except FileNotFoundError:
        return {"ok": False, "error": "session_not_found"}
    except ValueError:
        return {"ok": False, "error": "invalid_session_id"}

    if action == 'subagent-respond':
        from app.agent_runtime.background_agent import respond
        return respond(_session_root(), str(payload.get('parentSessionId') or ''), session_id,
                       str(payload.get('requestId') or ''), payload.get('response') or {})
    if action == "fork":
        through_turn = payload.get("throughTurn")
        if through_turn is not None and (type(through_turn) is not int or through_turn < 1):
            return {"ok": False, "error": "invalid_turn_boundary"}
        try:
            child = FileSessionStore(_session_root()).fork(
                session.id, str(payload.get("childSessionId") or ""), through_turn=through_turn,
            )
            from scripts.conversation_bridge import _task_context_payload
            return {"ok": True, "sessionId": child.id, "taskContext": _task_context_payload(child)}
        except (ValueError, RuntimeError, OSError) as exc:
            return {"ok": False, "error": f"fork_failed: {exc}"}
    if action == "recovery-resolve":
        try:
            session.resolve_operation_recovery(
                str(payload.get("operationId") or ""), str(payload.get("verificationCallId") or ""),
                confirmed=payload.get("confirmed") is True,
            )
            return {"ok": True, "sessionId": session.id, "pendingRecovery": session.pending_recovery()}
        except (ValueError, RuntimeError) as exc:
            return {"ok": False, "error": f"recovery_rejected: {exc}"}
    if action == "usage":
        return {"ok": True, "sessionId": session.id, "contextUsage": _context_usage(session)}
    if action == "cancel":
        if 'parentSessionId' in payload and (
            not session.header.parent_session_id
            or session.header.parent_session_id != str(payload.get('parentSessionId') or '')
        ):
            return {'ok': False, 'error': 'subagent_parent_mismatch'}
        from app.agent_runtime.background_agent import read_status, stop
        if read_status(_session_root(), session_id) is not None:
            return stop(_session_root(), str(payload.get('parentSessionId') or ''), session_id)
        turn = session.open_turn
        if turn is None:
            return {"ok": False, "error": "no_open_turn"}
        try:
            event = session.request_cancel(reason=str(payload.get("reason") or "user stop"))
        except RuntimeError as exc:
            if "pending cancel" in str(exc):
                return {"ok": True, "sessionId": session.id, "turn": turn}
            return {"ok": False, "error": f"cancel_rejected: {exc}"}
        return {
            "ok": True,
            "sessionId": session.id,
            "turn": int(event.data["turn"]),
        }
    if action == "status":
        last_reason = None
        for event in reversed(session.events):
            if event.type == "turn/end":
                last_reason = str(event.data.get("reason") or "")
                break
        return {
            "ok": True,
            "sessionId": session.id,
            "hasPendingWork": session.has_pending_work(),
            "lastTurnReason": last_reason,
            "openTurn": session.open_turn,
            "pendingInput": session.pending_user_input(),
            "answeredInputIds": [event.data['requestId'] for event in session.events if event.type == 'user_input/answered'],
            "lastInputAnswer": next(({'requestId': event.data['requestId'], 'message': event.data['message']}
                for event in reversed(session.events) if event.type == 'user_input/answered'), None),
            "pendingRecovery": session.pending_recovery(),
        }
    if action == "put":
        text = str(
            task_input.instruction if task_input is not None else payload.get("text") or ""
        ).strip()
        if len(text) > MAX_TEXT_CHARS or (task_input is None and not text):
            return {"ok": False, "error": "invalid_text"}
        if task_input is not None and task_input.task_id != session.id:
            return {"ok": False, "error": "task_mismatch"}
        try:
            for raw_source in list(payload.get("sources") or []):
                source = SourceRef.from_dict(raw_source)
                if source.task_id != session.id:
                    return {"ok": False, "error": "source_task_mismatch"}
                known = {item.source_id: item for item in task_sources(session.events)}
                if source.source_id not in known:
                    register_source(session, source)
                elif known[source.source_id] != source:
                    return {"ok": False, "error": "source_identity_changed"}
        except (TypeError, ValueError):
            return {"ok": False, "error": "invalid_source"}
        message_id = (
            task_input.input_id
            if task_input is not None
            else str(payload.get("messageId") or "").strip() or None
        )
        try:
            event = session.enqueue_inbox(
                text,
                target,
                message_id=message_id,
                payload=task_input.to_dict() if task_input is not None else None,
            )
        except RuntimeError:
            return {"ok": False, "error": "duplicate_message_id"}
        except ValueError as exc:
            return {"ok": False, "error": f"invalid_task_input: {exc}"}
        if task_input is not None:
            return {
                "ok": True,
                "sessionId": session.id,
                "inputId": task_input.input_id,
                "target": target,
                "status": "queued",
            }
        return {
            "ok": True,
            "sessionId": session.id,
            "messageId": str(event.data["messageId"]),
            "target": target,
        }
    if action == "pending":
        items = session.pending_inbox(target)[:MAX_PENDING_MESSAGES]
        return {
            "ok": True,
            "sessionId": session.id,
            "messages": [
                {
                    "messageId": item.message_id,
                    "target": item.target,
                    "text": item.text,
                    **({"taskInput": item.payload} if item.payload else {}),
                }
                for item in items
            ],
        }
    return {"ok": False, "error": "invalid_action"}


def main() -> int:
    force_utf8_stdio()
    try:
        payload = read_bounded_json_payload()
        result = handle_request(payload)
    except (PayloadTooLargeError, ValueError) as exc:
        result = {"ok": False, "error": f"invalid_request: {exc}"}
    write_json(result)
    return 0 if result.get("ok") is True else 1


if __name__ == "__main__":
    raise SystemExit(main())
