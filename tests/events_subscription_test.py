"""Tests for app.events: change event model + per-window subscriptions (L9).

All tests use a fake event source and a fake monotonic clock. Throttle
semantics: trailing-edge merge — while a (window, kind) throttle window is
open, intermediate events are superseded (counted as dropped) and only the
latest is delivered when the window closes (on the next same-key event or
an explicit flush()).
"""

import threading
from dataclasses import FrozenInstanceError

import pytest

from app.events import (
    STORM_COOLDOWN_S,
    STORM_LIMIT,
    ChangeKind,
    SurfaceChangeEvent,
    WindowSubscription,
    create_subscription,
)


def make_event(
    event_id: str,
    kind: ChangeKind,
    window_ref: str,
    *,
    element_ref: str | None = None,
    t_utc: str = "2026-08-13T00:00:00Z",
    args: dict | None = None,
) -> SurfaceChangeEvent:
    return SurfaceChangeEvent(
        event_id=event_id,
        kind=kind,
        window_ref=window_ref,
        element_ref=element_ref,
        t_utc=t_utc,
        args=args if args is not None else {},
    )


class FakeClock:
    def __init__(self, start: float = 0.0) -> None:
        self._now = start

    def advance(self, seconds: float) -> None:
        self._now += seconds

    def __call__(self) -> float:
        return self._now


class FakeSource:
    def __init__(self) -> None:
        self.handler = None
        self.started = 0
        self.stopped = 0

    def start(self) -> None:
        self.started += 1

    def stop(self) -> None:
        self.stopped += 1

    def set_handler(self, handler) -> None:
        self.handler = handler

    def emit(self, event: SurfaceChangeEvent) -> None:
        if self.handler is not None:
            self.handler(event)


class Recorder:
    def __init__(self) -> None:
        self.events: list[SurfaceChangeEvent] = []

    def __call__(self, event: SurfaceChangeEvent) -> None:
        self.events.append(event)


class TestSurfaceChangeEvent:
    def test_all_kinds_construct_with_enum_values(self) -> None:
        assert ChangeKind.STRUCTURE_CHANGED.value == "structure_changed"
        assert ChangeKind.TEXT_CHANGED.value == "text_changed"
        assert ChangeKind.FOCUS_CHANGED.value == "focus_changed"
        assert ChangeKind.PROPERTY_CHANGED.value == "property_changed"
        for kind in ChangeKind:
            event = make_event("e1", kind, "hwnd-1", t_utc="t0")
            assert event.kind is kind
            assert event.window_ref == "hwnd-1"

    def test_args_and_element_ref_passthrough(self) -> None:
        event = make_event("e1", ChangeKind.TEXT_CHANGED, "hwnd-1", element_ref="el-9", args={"text": "hi"})
        assert event.element_ref == "el-9"
        assert event.args == {"text": "hi"}

    def test_missing_event_id_rejected(self) -> None:
        with pytest.raises(TypeError):
            SurfaceChangeEvent(kind=ChangeKind.TEXT_CHANGED, window_ref="hwnd-1", element_ref=None, t_utc="t0")

    def test_empty_event_id_rejected(self) -> None:
        with pytest.raises(ValueError):
            make_event("", ChangeKind.TEXT_CHANGED, "hwnd-1")
        with pytest.raises(ValueError):
            make_event("   ", ChangeKind.TEXT_CHANGED, "hwnd-1")

    def test_empty_window_ref_rejected(self) -> None:
        with pytest.raises(ValueError):
            make_event("e1", ChangeKind.TEXT_CHANGED, "")

    def test_non_change_kind_rejected(self) -> None:
        with pytest.raises(ValueError):
            make_event("e1", "text_changed", "hwnd-1")

    def test_event_is_frozen(self) -> None:
        event = make_event("e1", ChangeKind.TEXT_CHANGED, "hwnd-1")
        with pytest.raises(FrozenInstanceError):
            event.kind = ChangeKind.FOCUS_CHANGED  # type: ignore[misc]


class TestWhitelistDelivery:
    def test_subscribed_same_window_same_kind_accepted(self) -> None:
        sub = WindowSubscription(clock=FakeClock())
        recorder = Recorder()
        sub.set_handler(recorder)
        sub.subscribe("hwnd-1", {ChangeKind.STRUCTURE_CHANGED})
        event = make_event("e1", ChangeKind.STRUCTURE_CHANGED, "hwnd-1")
        assert sub.deliver(event) is True
        sub.flush()
        assert sub.handled_count() == 1
        assert recorder.events == [event]

    def test_unsubscribed_window_dropped(self) -> None:
        sub = WindowSubscription(clock=FakeClock())
        sub.subscribe("hwnd-1", {ChangeKind.STRUCTURE_CHANGED})
        event = make_event("e1", ChangeKind.STRUCTURE_CHANGED, "hwnd-other")
        assert sub.deliver(event) is False
        assert sub.dropped_count() == 1
        assert sub.handled_count() == 0

    def test_wrong_kind_dropped(self) -> None:
        sub = WindowSubscription(clock=FakeClock())
        sub.subscribe("hwnd-1", {ChangeKind.STRUCTURE_CHANGED})
        event = make_event("e1", ChangeKind.TEXT_CHANGED, "hwnd-1")
        assert sub.deliver(event) is False
        assert sub.dropped_count() == 1
        assert sub.handled_count() == 0

    def test_no_subscription_anything_dropped(self) -> None:
        sub = WindowSubscription(clock=FakeClock())
        event = make_event("e1", ChangeKind.FOCUS_CHANGED, "hwnd-1")
        assert sub.deliver(event) is False
        assert sub.dropped_count() == 1


class TestThrottle:
    def test_same_window_same_kind_three_in_window_deliver_one_latest(self) -> None:
        clock = FakeClock()
        sub = WindowSubscription(clock=clock)
        recorder = Recorder()
        sub.set_handler(recorder)
        sub.subscribe("hwnd-1", {ChangeKind.STRUCTURE_CHANGED}, throttle_ms=100)
        assert sub.deliver(make_event("e1", ChangeKind.STRUCTURE_CHANGED, "hwnd-1", args={"v": 1})) is True
        clock.advance(0.05)
        assert sub.deliver(make_event("e2", ChangeKind.STRUCTURE_CHANGED, "hwnd-1", args={"v": 2})) is True
        clock.advance(0.04)
        assert sub.deliver(make_event("e3", ChangeKind.STRUCTURE_CHANGED, "hwnd-1", args={"v": 3})) is True
        assert sub.handled_count() == 0
        assert sub.dropped_count() == 2
        sub.flush()
        assert sub.handled_count() == 1
        assert recorder.events[0].args == {"v": 3}

    def test_different_kind_unaffected_by_throttle(self) -> None:
        clock = FakeClock()
        sub = WindowSubscription(clock=clock)
        recorder = Recorder()
        sub.set_handler(recorder)
        sub.subscribe("hwnd-1", {ChangeKind.STRUCTURE_CHANGED, ChangeKind.FOCUS_CHANGED}, throttle_ms=100)
        sub.deliver(make_event("s1", ChangeKind.STRUCTURE_CHANGED, "hwnd-1", args={"v": 1}))
        clock.advance(0.02)
        sub.deliver(make_event("f1", ChangeKind.FOCUS_CHANGED, "hwnd-1", args={"v": "a"}))
        clock.advance(0.03)
        sub.deliver(make_event("s2", ChangeKind.STRUCTURE_CHANGED, "hwnd-1", args={"v": 2}))
        sub.flush()
        assert sub.handled_count() == 2
        assert {e.args["v"] for e in recorder.events} == {2, "a"}

    def test_different_windows_unaffected_by_throttle(self) -> None:
        clock = FakeClock()
        sub = WindowSubscription(clock=clock)
        recorder = Recorder()
        sub.set_handler(recorder)
        sub.subscribe("hwnd-1", {ChangeKind.TEXT_CHANGED}, throttle_ms=100)
        sub.subscribe("hwnd-2", {ChangeKind.TEXT_CHANGED}, throttle_ms=100)
        sub.deliver(make_event("e1", ChangeKind.TEXT_CHANGED, "hwnd-1", args={"v": 1}))
        clock.advance(0.03)
        sub.deliver(make_event("e2", ChangeKind.TEXT_CHANGED, "hwnd-2", args={"v": 2}))
        clock.advance(0.03)
        sub.deliver(make_event("e3", ChangeKind.TEXT_CHANGED, "hwnd-1", args={"v": 3}))
        sub.flush()
        assert sub.handled_count() == 2
        assert {e.window_ref for e in recorder.events} == {"hwnd-1", "hwnd-2"}

    def test_new_events_after_throttle_window_delivered(self) -> None:
        clock = FakeClock()
        sub = WindowSubscription(clock=clock)
        recorder = Recorder()
        sub.set_handler(recorder)
        sub.subscribe("hwnd-1", {ChangeKind.TEXT_CHANGED}, throttle_ms=100)
        sub.deliver(make_event("e1", ChangeKind.TEXT_CHANGED, "hwnd-1", args={"v": 1}))
        clock.advance(0.05)
        sub.deliver(make_event("e2", ChangeKind.TEXT_CHANGED, "hwnd-1", args={"v": 2}))
        clock.advance(0.06)
        sub.deliver(make_event("e3", ChangeKind.TEXT_CHANGED, "hwnd-1", args={"v": 3}))
        assert sub.handled_count() == 1
        assert recorder.events[0].args == {"v": 2}
        sub.flush()
        assert sub.handled_count() == 2
        assert recorder.events[1].args == {"v": 3}


class TestStormBreaker:
    def test_breaker_trips_drops_followups_and_recovers(self) -> None:
        clock = FakeClock()
        sub = WindowSubscription(clock=clock)
        recorder = Recorder()
        sub.set_handler(recorder)
        sub.subscribe("hwnd-1", {ChangeKind.TEXT_CHANGED}, throttle_ms=0)

        for i in range(50):
            clock.advance(0.001)
            assert sub.deliver(make_event(f"s{i}", ChangeKind.TEXT_CHANGED, "hwnd-1")) is True
        status = sub.breaker_status("hwnd-1")
        assert status["broken"] is False

        clock.advance(0.001)
        assert sub.deliver(make_event("s50", ChangeKind.TEXT_CHANGED, "hwnd-1")) is False
        status = sub.breaker_status("hwnd-1")
        assert status["broken"] is True
        assert status["triggered_count"] == 1
        assert status["dropped_while_broken"] == 1
        assert sub.handled_count() == 49
        assert sub.dropped_count() == 2

        clock.advance(0.001)
        assert sub.deliver(make_event("s51", ChangeKind.TEXT_CHANGED, "hwnd-1")) is False
        assert sub.dropped_count() == 3
        assert sub.breaker_status("hwnd-1")["dropped_while_broken"] == 2

        clock.advance(STORM_COOLDOWN_S + 0.1)
        assert sub.deliver(make_event("s52", ChangeKind.TEXT_CHANGED, "hwnd-1")) is True
        assert sub.breaker_status("hwnd-1")["broken"] is False
        sub.flush()
        assert sub.handled_count() == 50

    def test_breaker_status_shape(self) -> None:
        sub = WindowSubscription(clock=FakeClock())
        sub.subscribe("hwnd-1", {ChangeKind.TEXT_CHANGED})
        status = sub.breaker_status("hwnd-1")
        assert set(status) == {
            "window_ref",
            "broken",
            "broken_until",
            "event_count_1s",
            "limit",
            "cooldown_s",
            "triggered_count",
            "dropped_while_broken",
        }
        assert status["limit"] == STORM_LIMIT
        assert status["cooldown_s"] == STORM_COOLDOWN_S


class TestUnsubscribe:
    def test_unsubscribe_stops_delivery(self) -> None:
        clock = FakeClock()
        sub = WindowSubscription(clock=clock)
        sub.set_handler(Recorder())
        sub.subscribe("hwnd-1", {ChangeKind.TEXT_CHANGED})
        assert sub.deliver(make_event("e1", ChangeKind.TEXT_CHANGED, "hwnd-1")) is True
        sub.flush()
        assert sub.handled_count() == 1
        sub.unsubscribe("hwnd-1")
        assert sub.deliver(make_event("e2", ChangeKind.TEXT_CHANGED, "hwnd-1")) is False
        assert sub.dropped_count() == 1
        assert sub.handled_count() == 1

    def test_resubscribe_after_unsubscribe_works(self) -> None:
        clock = FakeClock()
        sub = WindowSubscription(clock=clock)
        sub.set_handler(Recorder())
        sub.subscribe("hwnd-1", {ChangeKind.TEXT_CHANGED})
        sub.unsubscribe("hwnd-1")
        sub.subscribe("hwnd-1", {ChangeKind.FOCUS_CHANGED})
        assert sub.deliver(make_event("e1", ChangeKind.FOCUS_CHANGED, "hwnd-1")) is True
        assert sub.deliver(make_event("e2", ChangeKind.TEXT_CHANGED, "hwnd-1")) is False


class TestCreateSubscription:
    def test_connects_source_to_subscription(self) -> None:
        source = FakeSource()
        sub = WindowSubscription(clock=FakeClock())
        recorder = Recorder()
        sub.set_handler(recorder)
        sub.subscribe("hwnd-1", {ChangeKind.FOCUS_CHANGED})
        handle = create_subscription(source, sub)
        assert source.handler is not None
        source.emit(make_event("e1", ChangeKind.FOCUS_CHANGED, "hwnd-1"))
        sub.flush()
        assert sub.handled_count() == 1
        assert recorder.events[0].event_id == "e1"
        handle.close()

    def test_close_detaches_and_is_idempotent(self) -> None:
        source = FakeSource()
        sub = WindowSubscription(clock=FakeClock())
        sub.set_handler(Recorder())
        sub.subscribe("hwnd-1", {ChangeKind.FOCUS_CHANGED})
        handle = create_subscription(source, sub)
        handle.close()
        assert handle.is_closed is True
        assert source.handler is None
        source.emit(make_event("e1", ChangeKind.FOCUS_CHANGED, "hwnd-1"))
        assert sub.handled_count() == 0
        handle.close()
        assert source.handler is None


class TestConcurrency:
    def test_eight_threads_deliver_without_loss(self) -> None:
        sub = WindowSubscription(storm_limit=10**6)
        sub.set_handler(Recorder())
        sub.subscribe("hwnd-1", {ChangeKind.PROPERTY_CHANGED}, throttle_ms=0)
        failures: list[BaseException] = []
        barrier = threading.Barrier(8)

        def worker(worker_id: int) -> None:
            try:
                barrier.wait()
                for i in range(25):
                    sub.deliver(
                        make_event(
                            f"w{worker_id}-{i}",
                            ChangeKind.PROPERTY_CHANGED,
                            "hwnd-1",
                            args={"worker": worker_id},
                        )
                    )
            except BaseException as exc:  # pragma: no cover - failure path
                failures.append(exc)

        threads = [threading.Thread(target=worker, args=(i,)) for i in range(8)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        assert not failures
        sub.flush()
        assert sub.handled_count() == 200
        assert sub.dropped_count() == 0
        assert sub.breaker_status("hwnd-1")["broken"] is False


class TestAutoFlush:
    def test_isolated_event_is_delivered_by_background_flusher(self) -> None:
        """A single event with no same-key follow-up must not be stranded
        (review P2.9): the optional background flusher closes the throttle
        window on a timer."""
        import time as _time

        sub = WindowSubscription(auto_flush_interval_s=0.02)
        recorder = Recorder()
        sub.set_handler(recorder)
        sub.subscribe("hwnd-1", {ChangeKind.TEXT_CHANGED}, throttle_ms=50)
        assert sub.deliver(make_event("e1", ChangeKind.TEXT_CHANGED, "hwnd-1")) is True
        deadline = _time.monotonic() + 2.0
        while sub.handled_count() == 0 and _time.monotonic() < deadline:
            _time.sleep(0.01)
        sub.close()
        assert sub.handled_count() == 1
        assert recorder.events[0].event_id == "e1"

    def test_no_auto_flush_by_default(self) -> None:
        """Without auto_flush_interval_s the subscription never spawns a
        flusher thread and consumers must call flush() themselves."""
        sub = WindowSubscription()
        sub.subscribe("hwnd-1", {ChangeKind.TEXT_CHANGED})
        assert sub._flush_thread is None
        sub.close()
