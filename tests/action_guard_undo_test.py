"""Tests for app.action_guard.undo_log (Compensation / UndoLog).

All compensations use injected fake targets; no real system state is
touched. Covers LIFO undo, by-id undo, failure wrapping, capacity
eviction, audit order and concurrent access.
"""

from __future__ import annotations

import threading

import pytest

from app.action_guard.undo_log import (
    Compensation,
    DEFAULT_UNDO_CAPACITY,
    UndoEmptyError,
    UndoFailedError,
    UndoLog,
    UndoNotFoundError,
)


class FakeTarget:
    """Fake editable target whose content a compensation can restore."""

    def __init__(self, content: str = "") -> None:
        self.content = content


def make_comp(
    action_id: str,
    target: FakeTarget | None = None,
    prior_content: str | None = None,
    cursor_position: tuple[int, int] | None = None,
    was_created: bool = False,
    tool_name: str = "text_insert",
    target_ref: str | None = "anchor-1",
    calls: list[str] | None = None,
) -> Compensation:
    """Build a Compensation with an injected fake compensate."""

    def compensate(c: Compensation) -> None:
        if calls is not None:
            calls.append(c.action_id)
        if target is not None:
            target.content = c.prior_content or ""

    return Compensation(
        action_id=action_id,
        tool_name=tool_name,
        target_ref=target_ref,
        prior_content=prior_content,
        cursor_position=cursor_position,
        was_created=was_created,
        captured_at_utc="2026-08-13T00:00:00Z",
        compensate=compensate,
    )


def test_undo_lifo_order() -> None:
    log = UndoLog()
    log.record(make_comp("a"))
    log.record(make_comp("b"))
    assert log.undo().action_id == "b"
    assert log.undo().action_id == "a"


def test_undo_empty_stack_raises() -> None:
    log = UndoLog()
    with pytest.raises(UndoEmptyError):
        log.undo()


def test_undo_invokes_compensate_once_with_correct_args() -> None:
    log = UndoLog()
    target = FakeTarget(content="new-text")
    calls: list[str] = []
    comp = make_comp(
        "a", target=target, prior_content="old-text", calls=calls
    )
    log.record(comp)
    restored = log.undo()
    assert restored is comp
    assert calls == ["a"]
    assert target.content == "old-text"


def test_undo_compensate_failure_wraps_and_removes() -> None:
    def boom(c: Compensation) -> None:
        raise ValueError("target lost")

    log = UndoLog()
    log.record(make_comp("good"))
    log.record(
        Compensation(
            action_id="bad",
            tool_name="text_insert",
            target_ref=None,
            prior_content=None,
            cursor_position=None,
            was_created=False,
            captured_at_utc="2026-08-13T00:00:00Z",
            compensate=boom,
        )
    )
    with pytest.raises(UndoFailedError) as exc_info:
        log.undo()
    assert exc_info.value.action_id == "bad"
    assert isinstance(exc_info.value.cause, ValueError)
    assert log.can_undo()
    assert log.undo().action_id == "good"
    with pytest.raises(UndoEmptyError):
        log.undo()


def test_undo_failure_does_not_block_next_undo() -> None:
    def boom(c: Compensation) -> None:
        raise RuntimeError("boom")

    log = UndoLog()
    log.record(make_comp("good"))
    log.record(
        Compensation(
            action_id="bad",
            tool_name="text_insert",
            target_ref=None,
            prior_content=None,
            cursor_position=None,
            was_created=False,
            captured_at_utc="2026-08-13T00:00:00Z",
            compensate=boom,
        )
    )
    with pytest.raises(UndoFailedError):
        log.undo()
    assert log.undo().action_id == "good"


def test_undo_by_id_middle_of_stack() -> None:
    log = UndoLog()
    comps = [make_comp(f"a{i}") for i in range(5)]
    for c in comps:
        log.record(c)
    restored = log.undo("a2")
    assert restored is comps[2]
    assert log.all_actions() == [comps[0], comps[1], comps[3], comps[4]]


def test_undo_by_id_not_found_raises() -> None:
    log = UndoLog()
    log.record(make_comp("a"))
    with pytest.raises(UndoNotFoundError):
        log.undo("missing")


def test_undo_by_id_is_idempotent() -> None:
    log = UndoLog()
    log.record(make_comp("a"))
    log.record(make_comp("b"))
    log.undo("a")
    with pytest.raises(UndoNotFoundError):
        log.undo("a")


def test_undo_by_id_on_empty_stack_raises_not_found() -> None:
    log = UndoLog()
    with pytest.raises(UndoNotFoundError):
        log.undo("anything")


def test_capacity_evicts_oldest() -> None:
    log = UndoLog()
    comps = [make_comp(f"a{i}") for i in range(DEFAULT_UNDO_CAPACITY + 1)]
    for c in comps:
        log.record(c)
    assert log.size() == DEFAULT_UNDO_CAPACITY
    assert log.peek() is comps[-1]
    assert log.all_actions() == comps[1:]


def test_custom_capacity() -> None:
    log = UndoLog(capacity=2)
    log.record(make_comp("a"))
    log.record(make_comp("b"))
    log.record(make_comp("c"))
    assert [c.action_id for c in log.all_actions()] == ["b", "c"]


def test_can_undo_size_peek() -> None:
    log = UndoLog()
    assert not log.can_undo()
    assert log.size() == 0
    assert log.peek() is None
    comp = make_comp("a")
    log.record(comp)
    assert log.can_undo()
    assert log.size() == 1
    assert log.peek() is comp
    log.undo()
    assert not log.can_undo()
    assert log.size() == 0


def test_concurrent_record_undo_is_safe() -> None:
    log = UndoLog(capacity=1000)
    errors: list[BaseException] = []
    lock = threading.Lock()

    def worker(worker_id: int) -> None:
        try:
            for i in range(50):
                log.record(
                    make_comp(
                        f"w{worker_id}-{i}", target_ref=f"t{worker_id}"
                    )
                )
                if i % 3 == 0 and log.can_undo():
                    log.undo()
        except BaseException as exc:  # pragma: no cover - failure path
            with lock:
                errors.append(exc)

    threads = [
        threading.Thread(target=worker, args=(w,)) for w in range(8)
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert errors == []
    assert 0 <= log.size() <= 8 * 50


def test_all_actions_audit_order() -> None:
    log = UndoLog()
    comps = [make_comp(f"a{i}") for i in range(4)]
    for c in comps:
        log.record(c)
    assert log.all_actions() == comps
    assert [c.action_id for c in log.all_actions()] == [
        "a0",
        "a1",
        "a2",
        "a3",
    ]


def test_field_passthrough() -> None:
    log = UndoLog()
    comp = make_comp(
        "a",
        target_ref="hwnd-0x1234",
        prior_content="before",
        cursor_position=(10, 20),
        was_created=True,
    )
    log.record(comp)
    assert comp.action_id == "a"
    assert comp.tool_name == "text_insert"
    assert comp.target_ref == "hwnd-0x1234"
    assert comp.prior_content == "before"
    assert comp.cursor_position == (10, 20)
    assert comp.was_created is True
    assert comp.captured_at_utc == "2026-08-13T00:00:00Z"
    assert log.peek() is comp


def test_undo_empty_has_no_action_id() -> None:
    log = UndoLog()
    with pytest.raises(UndoEmptyError):
        log.undo()


def test_compensation_is_frozen() -> None:
    comp = make_comp("a")
    with pytest.raises(Exception):
        comp.action_id = "mutated"  # type: ignore[misc]


def test_duplicate_action_ids_undo_newest_by_id() -> None:
    log = UndoLog()
    newer = make_comp("dup")
    log.record(make_comp("dup"))
    log.record(newer)
    assert log.undo("dup") is newer
    assert log.undo("dup").action_id == "dup"
    with pytest.raises(UndoNotFoundError):
        log.undo("dup")
