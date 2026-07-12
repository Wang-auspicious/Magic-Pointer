from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from app.actions.schema import ActionProposal, ActionTarget, SafetyLevel
from app.dashboard.calendar import normalize_event

CALENDAR_TARGET_URI = "magic-pointer://dashboard/calendar/local"


def _now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def make_calendar_create_proposal(
    event: dict[str, Any],
    *,
    idempotency_key: str,
    source: dict[str, Any],
    allow_conflict: bool,
) -> ActionProposal:
    normalized = normalize_event(event)
    return ActionProposal(
        id=f"calendar-create-{uuid.uuid4().hex[:12]}",
        action_type="calendar_event_create",
        target=ActionTarget(
            object_id=CALENDAR_TARGET_URI,
            description=normalized["title"],
            metadata={"provider": "magic_pointer_dashboard", "calendar_id": "local-calendar"},
        ),
        parameters={
            "event": normalized,
            "idempotency_key": str(idempotency_key or ""),
            "source": dict(source or {}),
            "allow_conflict": allow_conflict,
        },
        safety_level=SafetyLevel.MEDIUM,
        confirmation_required=True,
        rationale="Create one reviewed event in the local Magic Pointer calendar.",
        created_at=_now_iso(),
        metadata={"trusted_dashboard_action": True, "provider": "local-calendar"},
    )


def make_calendar_undo_proposal(*, receipt_id: str, event: dict[str, Any]) -> ActionProposal:
    return ActionProposal(
        id=f"calendar-undo-{uuid.uuid4().hex[:12]}",
        action_type="calendar_event_undo_create",
        target=ActionTarget(
            object_id=CALENDAR_TARGET_URI,
            description=str(event.get("title") or "Calendar event"),
            metadata={"provider": "magic_pointer_dashboard", "calendar_id": "local-calendar"},
        ),
        parameters={
            "receipt_id": str(receipt_id or ""),
            "event_id": str(event.get("id") or ""),
            "expected_updated_at": str(event.get("updated_at") or ""),
        },
        safety_level=SafetyLevel.LOW,
        confirmation_required=False,
        rationale="Precisely undo one verified local calendar event creation.",
        created_at=_now_iso(),
        metadata={"trusted_dashboard_action": True, "provider": "local-calendar"},
    )
