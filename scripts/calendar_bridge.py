from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.actions.calendar import make_calendar_create_proposal, make_calendar_undo_proposal
from app.actions.executor import SafeActionExecutor
from app.actions.schema import ExecutionStatus
from app.dashboard.calendar import (
    CalendarConflict,
    CalendarError,
    CalendarEventStore,
    normalize_event,
)


def read_payload() -> dict[str, Any]:
    raw = sys.stdin.read().lstrip("\ufeff").strip()
    return json.loads(raw) if raw else {}


def emit(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, ensure_ascii=False))


def main() -> int:
    request = read_payload()
    operation = str(request.get("operation") or "")
    request_id = str(request.get("requestId") or "") or None
    store = CalendarEventStore()
    try:
        if operation == "list":
            emit({"ok": True, "requestId": request_id, "state": store.public_calendar()})
            return 0
        if operation == "preview":
            normalized = normalize_event(request.get("event") or {})
            emit({
                "ok": True,
                "requestId": request_id,
                "normalizedEvent": normalized,
                "conflicts": store.preview_conflicts(normalized),
                "state": store.public_calendar(),
            })
            return 0
        if operation == "create":
            if request.get("confirmed") is not True:
                emit({"ok": False, "requestId": request_id, "error": "Calendar creation requires explicit confirmation."})
                return 2
            proposal = make_calendar_create_proposal(
                request.get("event") or {},
                idempotency_key=str(request.get("idempotencyKey") or ""),
                source=request.get("source") if isinstance(request.get("source"), dict) else {},
                allow_conflict=request.get("allowConflict", False),
            )
            result = SafeActionExecutor(calendar_event_store=store).execute(proposal, confirmed=True)
        elif operation == "undo_create":
            event_id = str(request.get("eventId") or "")
            event = next((entry for entry in store.public_calendar()["events"] if entry.get("id") == event_id), None)
            if not event:
                emit({"ok": False, "requestId": request_id, "error": "The calendar event no longer exists.", "state": store.public_calendar()})
                return 2
            proposal = make_calendar_undo_proposal(
                receipt_id=str(request.get("receiptId") or ""),
                event=event,
            )
            if str(request.get("expectedUpdatedAt") or "") != event.get("updated_at"):
                emit({"ok": False, "requestId": request_id, "error": "The calendar event changed. The calendar has been refreshed.", "state": store.public_calendar()})
                return 2
            result = SafeActionExecutor(calendar_event_store=store).execute(proposal, confirmed=False)
        else:
            emit({"ok": False, "requestId": request_id, "error": "Unsupported calendar operation."})
            return 2

        succeeded = result.status == ExecutionStatus.SUCCEEDED
        payload = {
            "ok": succeeded,
            "requestId": request_id,
            "executionResult": result.to_dict(),
            "error": result.error,
            "state": store.public_calendar(),
        }
        if not succeeded:
            payload["conflicts"] = result.output.get("conflicts", [])
        emit(payload)
        return 0 if succeeded else 2
    except CalendarConflict as exc:
        emit({"ok": False, "requestId": request_id, "error": str(exc), "conflicts": exc.conflicts, "state": store.public_calendar()})
        return 2
    except (CalendarError, json.JSONDecodeError, TypeError, ValueError) as exc:
        emit({"ok": False, "requestId": request_id, "error": str(exc)})
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
