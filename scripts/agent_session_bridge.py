"""Bounded local bridge for durable Agent steer and pending inspection."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

try:
    from scripts._bridge_common import (
        PayloadTooLargeError,
        ensure_root_on_path,
        force_utf8_stdio,
        read_bounded_json_payload,
        write_json,
    )
except ModuleNotFoundError:  # direct script execution
    from _bridge_common import (  # type: ignore[no-redef]
        PayloadTooLargeError,
        ensure_root_on_path,
        force_utf8_stdio,
        read_bounded_json_payload,
        write_json,
    )

ensure_root_on_path()

from app.agent_runtime.session import FileSessionStore  # noqa: E402
from app.context_pack.source_store import register_source, task_sources  # noqa: E402
from app.context_pack.sources import SourceRef, TaskInput  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
TARGETS = frozenset({"next-step", "next-turn"})
MAX_TEXT_CHARS = 4000
MAX_PENDING_MESSAGES = 100


def _session_root() -> Path:
    configured = str(os.environ.get("MAGIC_POINTER_USER_DATA_DIR") or "").strip()
    runtime_root = Path(configured) if configured else ROOT / "data" / "runtime"
    return runtime_root / "agent-sessions"


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
    if action not in {"cancel", "status"} and target not in TARGETS:
        return {"ok": False, "error": "invalid_target"}
    try:
        session = FileSessionStore(_session_root()).resume(session_id, repair=False)
    except FileNotFoundError:
        return {"ok": False, "error": "session_not_found"}
    except ValueError:
        return {"ok": False, "error": "invalid_session_id"}

    if action == "cancel":
        # Graceful stop (O3): the running loop polls this at the next round
        # boundary and terminates with a Receipt instead of being killed.
        # A repeat click while one is already pending stays ok: a cancel IS
        # pending.
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
        """Pending-work query (D2): lets the GUI offer continuation of an
        unfinished task after a restart instead of silently forgetting it."""
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
