from __future__ import annotations

from app.actions.calendar import (
    CALENDAR_TARGET_URI,
    make_calendar_create_proposal,
    make_calendar_undo_proposal,
)
from app.actions.executor import SafeActionExecutor
from app.actions.policy import LocalPermissionPolicy
from app.actions.schema import ActionProposal, ActionTarget, ExecutionStatus, SafetyLevel
from app.dashboard.calendar import CalendarEventStore


def event_payload() -> dict:
    return {
        "title": "Design review",
        "start_at": "2026-07-20T10:00:00+08:00",
        "end_at": "2026-07-20T11:00:00+08:00",
        "timezone": "Asia/Shanghai",
        "location": "Room A",
        "notes": "",
        "all_day": False,
    }


def test_calendar_create_requires_confirmation_and_allowlisted_target(tmp_path) -> None:
    proposal = make_calendar_create_proposal(
        event_payload(),
        idempotency_key="calendar-action-1",
        source={"app": "pdf"},
        allow_conflict=False,
    )
    assert proposal.target.object_id == CALENDAR_TARGET_URI
    decision = LocalPermissionPolicy().decide(proposal)
    assert decision.allowed is True
    assert decision.requires_confirmation is True

    executor = SafeActionExecutor(calendar_event_store=CalendarEventStore(tmp_path))
    skipped = executor.execute(proposal, confirmed=False)
    assert skipped.status == ExecutionStatus.SKIPPED
    assert CalendarEventStore(tmp_path).public_calendar()["events"] == []

    wrong_target = ActionProposal(
        id="wrong",
        action_type="calendar_event_create",
        target=ActionTarget(object_id="magic-pointer://dashboard/calendar/other"),
        parameters=proposal.parameters,
        safety_level=SafetyLevel.MEDIUM,
        confirmation_required=True,
    )
    assert LocalPermissionPolicy().decide(wrong_target).allowed is False


def test_confirmed_create_returns_verified_event_receipt_and_precise_undo(tmp_path) -> None:
    store = CalendarEventStore(tmp_path)
    executor = SafeActionExecutor(calendar_event_store=store)
    proposal = make_calendar_create_proposal(
        event_payload(),
        idempotency_key="calendar-action-2",
        source={"app": "pdf"},
        allow_conflict=False,
    )
    created = executor.execute(proposal, confirmed=True)
    assert created.status == ExecutionStatus.SUCCEEDED
    assert created.output["verified"] is True
    assert created.output["event"]["title"] == "Design review"
    assert created.output["undo_proposal"]["action_type"] == "calendar_event_undo_create"

    undo = ActionProposal.from_dict(created.output["undo_proposal"])
    undone = executor.execute(undo, confirmed=False)
    assert undone.status == ExecutionStatus.SUCCEEDED
    assert undone.output["verified"] is True
    assert store.public_calendar()["events"] == []


def test_undo_builder_binds_receipt_and_event_version() -> None:
    event = {"id": "event-1", "title": "Review", "updated_at": "v1"}
    proposal = make_calendar_undo_proposal(receipt_id="receipt-1", event=event)
    assert proposal.parameters == {
        "receipt_id": "receipt-1",
        "event_id": "event-1",
        "expected_updated_at": "v1",
    }
    assert proposal.confirmation_required is False
