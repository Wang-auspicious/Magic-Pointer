from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

from app.dashboard.calendar import (
    CalendarConflict,
    CalendarDataError,
    CalendarEventStore,
    CalendarValidationError,
)


def event_payload(**overrides) -> dict:
    payload = {
        "title": "Product launch",
        "start_at": "2026-07-18T14:00:00+08:00",
        "end_at": "2026-07-18T16:00:00+08:00",
        "timezone": "Asia/Shanghai",
        "location": "Shanghai Xuhui",
        "notes": "Bring the launch brief",
        "all_day": False,
    }
    payload.update(overrides)
    return payload


def test_create_persists_and_verifies_event(tmp_path: Path) -> None:
    store = CalendarEventStore(tmp_path)
    created = store.create_event(
        event_payload(),
        idempotency_key="event-1",
        source={"app": "pdf", "window_title": "Launch poster.pdf"},
    )
    assert created["verified"] is True
    assert created["created"] is True
    persisted = CalendarEventStore(tmp_path).public_calendar()
    assert persisted["events"][0]["id"] == created["event"]["id"]
    assert persisted["events"][0]["source"]["app"] == "pdf"


def test_idempotent_replay_returns_same_event(tmp_path: Path) -> None:
    store = CalendarEventStore(tmp_path)
    first = store.create_event(event_payload(), idempotency_key="same", source={})
    second = store.create_event(event_payload(), idempotency_key="same", source={})
    assert second["created"] is False
    assert second["event"]["id"] == first["event"]["id"]
    assert len(store.public_calendar()["events"]) == 1


@pytest.mark.parametrize(
    "overrides",
    [
        {"title": ""},
        {"end_at": "2026-07-18T13:59:00+08:00"},
        {"start_at": "2026-07-18T14:00:00", "end_at": "2026-07-18T16:00:00"},
        {"timezone": "Not/AZone"},
        {"location": "x" * 241},
        {"notes": "x" * 4001},
    ],
)
def test_invalid_events_fail_before_write(tmp_path: Path, overrides: dict) -> None:
    store = CalendarEventStore(tmp_path)
    with pytest.raises(CalendarValidationError):
        store.create_event(event_payload(**overrides), idempotency_key="invalid", source={})
    assert store.public_calendar()["events"] == []


def test_overlap_conflicts_but_adjacent_event_does_not(tmp_path: Path) -> None:
    store = CalendarEventStore(tmp_path)
    first = store.create_event(event_payload(), idempotency_key="first", source={})["event"]
    adjacent = store.create_event(
        event_payload(title="After party", start_at=first["end_at"], end_at="2026-07-18T17:00:00+08:00"),
        idempotency_key="adjacent",
        source={},
    )
    assert adjacent["created"] is True
    with pytest.raises(CalendarConflict) as exc_info:
        store.create_event(
            event_payload(title="Overlapping review", start_at="2026-07-18T15:30:00+08:00", end_at="2026-07-18T16:30:00+08:00"),
            idempotency_key="overlap",
            source={},
        )
    assert exc_info.value.conflicts[0]["id"] == first["id"]


def test_explicit_conflict_confirmation_can_create(tmp_path: Path) -> None:
    store = CalendarEventStore(tmp_path)
    store.create_event(event_payload(), idempotency_key="first", source={})
    created = store.create_event(
        event_payload(title="Intentional overlap"),
        idempotency_key="second",
        source={},
        allow_conflict=True,
    )
    assert created["created"] is True
    assert len(created["conflicts"]) == 1


def test_undo_create_requires_exact_receipt_and_unchanged_event(tmp_path: Path) -> None:
    store = CalendarEventStore(tmp_path)
    created = store.create_event(event_payload(), idempotency_key="undo", source={})
    event = created["event"]
    undone = store.undo_create(
        event["id"],
        created["receipt_id"],
        event["updated_at"],
    )
    assert undone["verified"] is True
    assert store.public_calendar()["events"] == []


def test_bad_receipt_and_stale_version_fail_closed(tmp_path: Path) -> None:
    store = CalendarEventStore(tmp_path)
    created = store.create_event(event_payload(), idempotency_key="safe", source={})
    event = created["event"]
    with pytest.raises(CalendarConflict):
        store.undo_create(event["id"], "wrong", event["updated_at"])
    with pytest.raises(CalendarConflict):
        store.undo_create(event["id"], created["receipt_id"], "stale")
    assert len(store.public_calendar()["events"]) == 1


def test_unknown_or_corrupt_schema_fails_closed(tmp_path: Path) -> None:
    path = tmp_path / "dashboard" / "calendar_events.json"
    path.parent.mkdir(parents=True)
    path.write_text(json.dumps({"version": 99}), encoding="utf-8")
    with pytest.raises(CalendarDataError):
        CalendarEventStore(tmp_path).public_calendar()


def test_concurrent_creates_do_not_lose_events(tmp_path: Path) -> None:
    def create(index: int) -> None:
        CalendarEventStore(tmp_path).create_event(
            event_payload(
                title=f"Event {index}",
                start_at=f"2026-07-{20 + index // 8:02d}T{index % 8:02d}:00:00+08:00",
                end_at=f"2026-07-{20 + index // 8:02d}T{index % 8:02d}:30:00+08:00",
            ),
            idempotency_key=f"event-{index}",
            source={},
        )

    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(create, range(16)))
    assert len(CalendarEventStore(tmp_path).public_calendar()["events"]) == 16
