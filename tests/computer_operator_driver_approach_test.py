
from __future__ import annotations

import sys

import pytest

pytestmark = pytest.mark.skipif(sys.platform != "win32", reason="Windows-only driver")

from app.computer_operator import motion  # noqa: E402
from app.computer_operator.windows import (  # noqa: E402
    ApproachObserver,
    Win32InputDriver,
    WindowsComputerOperatorBackend,
)
from app.governance.cancellation import CancelledError  # noqa: E402


class Observer:

    def __init__(self) -> None:
        self.approaches: list[tuple[tuple[int, int], int]] = []
        self.clicks: list[tuple[tuple[int, int], str, int]] = []

    def cursor_approach(self, point: tuple[int, int], *, lead_ms: int) -> None:
        self.approaches.append((point, int(lead_ms)))

    def cursor_clicked(self, point: tuple[int, int], *, button: str, count: int) -> None:
        self.clicks.append((point, button, int(count)))


class RecordingDriver(Win32InputDriver):

    def __init__(self, observer: Observer | None = None) -> None:
        super().__init__(approach_observer=observer)
        self.events: list[tuple[str, object]] = []
        self.origin: tuple[int, int] | None = (100, 100)
        self.sleeps: list[float] = []

    def _position(self, point: tuple[int, int]) -> None:
        self.events.append(("position", (int(point[0]), int(point[1]))))

    def _mouse(self, flag: int, data: int = 0) -> None:
        self.events.append(("mouse", int(flag)))

    def _cursor_position(self):
        return self.origin

    def _sleep(self, seconds: float) -> None:
        self.sleeps.append(round(float(seconds), 6))


    @property
    def positions(self) -> list[tuple[int, int]]:
        return [value for kind, value in self.events if kind == "position"]

    @property
    def mouse(self) -> list[int]:
        return [value for kind, value in self.events if kind == "mouse"]

    def index_of_first_mouse(self, flag: int) -> int:
        for index, (kind, value) in enumerate(self.events):
            if kind == "mouse" and value == flag:
                return index
        raise AssertionError(f"no mouse event {flag:#x}")

    def index_of_last_position(self) -> int:
        for index in range(len(self.events) - 1, -1, -1):
            if self.events[index][0] == "position":
                return index
        raise AssertionError("no position events")


@pytest.fixture()
def observer() -> Observer:
    return Observer()


@pytest.fixture()
def driver(observer: Observer) -> RecordingDriver:
    return RecordingDriver(observer)


class TestObserverProtocol:
    def test_the_observer_we_hand_the_driver_is_a_real_observer(self) -> None:
        assert isinstance(Observer(), ApproachObserver)

    def test_the_driver_stores_the_observer_it_was_given(self, observer: Observer) -> None:
        assert RecordingDriver(observer)._approach_observer is observer
        assert Win32InputDriver()._approach_observer is None


class TestApproachLeadIsPure:
    def test_the_floor_is_600ms_for_a_same_point_click(self) -> None:
        assert motion.APPROACH_LEAD_MS == 600
        assert motion.approach_lead_ms(0.0) == 600

    def test_the_lead_grows_with_distance_and_is_never_shorter_than_the_flight(self) -> None:
        for distance in (0.0, 5.0, 400.0, 800.0, 1000.0, 100_000.0):
            assert motion.approach_lead_ms(distance) >= motion.flight_duration_ms(distance)
            assert motion.approach_lead_ms(distance) >= motion.APPROACH_LEAD_MS

    def test_a_long_hop_gets_a_longer_lead_than_a_short_one(self) -> None:
        assert motion.approach_lead_ms(1200.0) > motion.approach_lead_ms(10.0)

    def test_the_lead_is_capped_by_the_flight_ceiling(self) -> None:
        assert motion.approach_lead_ms(1_000_000.0) == motion.FLIGHT_MAX_MS


class TestClickWithoutAnObserver:
    def test_the_clicks_are_unchanged_when_nothing_is_watching(self) -> None:
        plain = RecordingDriver(observer=None)
        plain.click((300, 300), button="left", count=1)
        assert plain.positions == [(300, 300)]
        assert plain.mouse == [0x0002, 0x0004]

    def test_the_settle_and_the_hold_are_still_paid(self) -> None:
        plain = RecordingDriver(observer=None)
        plain.click((300, 300), button="left", count=1)
        assert plain.sleeps == [
            round(motion.CLICK_SETTLE_MS / 1000.0, 6),
            round(motion.CLICK_HOLD_MS / 1000.0, 6),
        ]


class TestClickWithAnObserver:
    def test_the_approach_is_announced_before_anything_moves(self, observer: Observer, driver: RecordingDriver) -> None:
        driver.click((900, 500), button="left", count=1)
        assert len(observer.approaches) == 1
        point, lead = observer.approaches[0]
        assert point == (900, 500)
        assert lead >= motion.APPROACH_LEAD_MS

    def test_the_cursor_is_on_target_before_the_button_goes_down(
        self, observer: Observer, driver: RecordingDriver
    ) -> None:
        driver.click((900, 500), button="left", count=1)
        assert driver.index_of_last_position() < driver.index_of_first_mouse(0x0002)
        assert driver.positions[-1] == (900, 500)

    def test_the_lead_is_spent_moving_not_waiting(self, driver: RecordingDriver) -> None:
        driver.click((900, 500), button="left", count=1)
        assert len(driver.positions) > 5

    def test_the_glow_is_announced_at_the_press_not_at_the_approach(
        self, observer: Observer, driver: RecordingDriver
    ) -> None:
        driver.click((900, 500), button="right", count=2)
        assert observer.clicks == [((900, 500), "right", 2)]

    def test_the_announced_lead_matches_the_time_actually_spent(self, observer: Observer, driver: RecordingDriver) -> None:
        driver.click((1600, 900), button="left", count=1)
        point, lead = observer.approaches[0]
        assert point == (1600, 900)
        spent = sum(driver.sleeps)
        expected = (lead + motion.CLICK_SETTLE_MS + motion.CLICK_HOLD_MS) / 1000.0
        assert spent == pytest.approx(expected, abs=0.001)

    def test_a_same_point_click_still_gets_the_floor(self, observer: Observer, driver: RecordingDriver) -> None:
        driver.click((100, 100), button="left", count=1)
        assert observer.approaches[0][1] == motion.APPROACH_LEAD_MS
        assert driver.positions[-1] == (100, 100)

    def test_an_unreadable_origin_still_announces_and_waits(self, observer: Observer, driver: RecordingDriver) -> None:
        driver.origin = None
        driver.click((400, 400), button="left", count=1)
        assert observer.approaches[0][1] == motion.APPROACH_LEAD_MS
        assert driver.positions == [(400, 400)]
        assert sum(driver.sleeps) == pytest.approx(
            (motion.APPROACH_LEAD_MS + motion.CLICK_SETTLE_MS + motion.CLICK_HOLD_MS) / 1000.0,
            abs=0.001,
        )

    def test_the_pre_roll_can_be_switched_off_per_call(self, observer: Observer, driver: RecordingDriver) -> None:
        driver.click((900, 500), button="left", count=1, approach=False)
        assert observer.approaches == []
        assert driver.positions == [(900, 500)]

    def test_the_pre_roll_can_be_forced_on_without_an_observer(self) -> None:
        forced = RecordingDriver(observer=None)
        forced.click((900, 500), button="left", count=1, approach=True)
        assert len(forced.positions) > 5


class TestMoveEdgeCases:
    def test_an_absurd_duration_does_not_become_an_absurd_stall(self, driver: RecordingDriver) -> None:
        driver.move((900, 600), duration_ms=600_000)
        assert sum(driver.sleeps) <= motion.GLIDE_HARD_MAX_MS / 1000.0 + 0.05
        assert driver.positions[-1] == (900, 600)

    def test_a_negative_duration_falls_back_to_the_distance_rule(self, driver: RecordingDriver) -> None:
        driver.move((900, 600), duration_ms=-1)
        assert len(driver.positions) > 2

    def test_a_zero_duration_glide_is_still_a_teleport(self, driver: RecordingDriver) -> None:
        driver._glide((0, 0), (900, 600), 0)
        assert driver.positions == [(900, 600)]
        assert driver.sleeps == []

    def test_a_move_to_the_current_position_does_not_crawl(self, driver: RecordingDriver) -> None:
        driver.move((100, 100), duration_ms=0)
        assert driver.positions == [(100, 100)]
        assert driver.sleeps == []

    def test_a_move_with_a_readable_origin_glides(self, driver: RecordingDriver) -> None:
        driver.move((900, 600), duration_ms=0)
        assert len(driver.positions) > 2
        assert driver.positions[-1] == (900, 600)

    def test_a_move_without_an_origin_teleports_rather_than_failing(self, driver: RecordingDriver) -> None:
        driver.origin = None
        driver.move((900, 600), duration_ms=500)
        assert driver.positions == [(900, 600)]


class TestDrag:
    def test_the_drop_is_settled_before_the_button_comes_up(self, driver: RecordingDriver) -> None:
        driver.drag((10, 10), (600, 400), duration_ms=200)
        up_index = driver.index_of_first_mouse(0x0004)
        assert driver.index_of_last_position() < up_index
        assert driver.sleeps[-1] == round(motion.CLICK_SETTLE_MS / 1000.0, 6)

    def test_the_button_is_held_for_the_whole_glide(self, driver: RecordingDriver) -> None:
        driver.drag((10, 10), (600, 400), duration_ms=200)
        assert driver.mouse[0] == 0x0002
        assert driver.mouse[-1] == 0x0004
        assert driver.mouse.count(0x0002) == 1
        assert driver.mouse.count(0x0004) == 1

    def test_the_drag_starts_and_ends_on_its_endpoints(self, driver: RecordingDriver) -> None:
        driver.drag((10, 10), (600, 400), duration_ms=200)
        assert driver.positions[0] == (10, 10)
        assert driver.positions[-1] == (600, 400)

    def test_an_absurd_drag_duration_is_bounded_too(self, driver: RecordingDriver) -> None:
        driver.drag((0, 0), (600, 400), duration_ms=600_000)
        assert sum(driver.sleeps) <= motion.GLIDE_HARD_MAX_MS / 1000.0 + 0.05


class TestCancellation:
    def test_a_move_can_be_interrupted_mid_glide(self, driver: RecordingDriver) -> None:
        calls = {"n": 0}

        def cancel() -> None:
            calls["n"] += 1
            if calls["n"] > 3:
                raise CancelledError("operator_action_cancelled")

        driver.bind_cancel_check(cancel)
        with pytest.raises(CancelledError):
            driver.move((1500, 900), duration_ms=1000)
        assert driver.positions[-1] != (1500, 900), "a cancelled move must not finish"

    def test_a_cancelled_drag_still_releases_the_button(self, driver: RecordingDriver) -> None:
        calls = {"n": 0}

        def cancel() -> None:
            calls["n"] += 1
            if calls["n"] > 2:
                raise CancelledError("operator_action_cancelled")

        driver.bind_cancel_check(cancel)
        with pytest.raises(CancelledError):
            driver.drag((0, 0), (900, 900), duration_ms=1000)
        assert driver.mouse[0] == 0x0002
        assert driver.mouse[-1] == 0x0004

    def test_a_cancelled_click_does_not_press(self, driver: RecordingDriver) -> None:
        calls = {"n": 0}

        def cancel() -> None:
            calls["n"] += 1
            if calls["n"] > 2:
                raise CancelledError("operator_action_cancelled")

        driver.bind_cancel_check(cancel)
        with pytest.raises(CancelledError):
            driver.click((1200, 800), button="left", count=1)
        assert 0x0002 not in driver.mouse

    def test_unbinding_restores_normal_operation(self, driver: RecordingDriver) -> None:
        driver.bind_cancel_check(lambda: None)
        driver.bind_cancel_check(None)
        driver.move((200, 200), duration_ms=100)
        assert driver.positions[-1] == (200, 200)


class _Scope:

    def __init__(self, cancelled: bool = False) -> None:
        self.cancelled = cancelled

    def raise_if_cancelled(self) -> None:
        if self.cancelled:
            raise CancelledError("operator_action_cancelled")


class _SilentDriver:

    def __init__(self) -> None:
        self.moves: list[tuple[int, int]] = []

    def window_at(self, point): return 0
    def foreground_window(self): return 0
    def click(self, point, *, button, count): pass
    def move(self, point, *, duration_ms): self.moves.append(point)
    def drag(self, start, end, *, duration_ms): pass
    def scroll(self, point, *, delta): pass
    def type_text(self, value): pass
    def key_down(self, key): pass
    def key_up(self, key): pass


class TestBackendBindsTheCancelCheck:
    def test_a_real_driver_receives_the_scope(self, tmp_path) -> None:
        driver = RecordingDriver(observer=None)
        backend = WindowsComputerOperatorBackend(output_root=tmp_path, driver=driver)
        backend._bind_cancel(_Scope())
        assert callable(driver._cancel_check)

    def test_a_driver_double_without_the_binder_is_not_a_crash(self, tmp_path) -> None:
        backend = WindowsComputerOperatorBackend(output_root=tmp_path, driver=_SilentDriver())
        backend._bind_cancel(_Scope())
        backend._bind_cancel(None)

    def test_the_check_raises_the_scopes_own_cancellation(self, tmp_path) -> None:
        driver = RecordingDriver(observer=None)
        backend = WindowsComputerOperatorBackend(output_root=tmp_path, driver=driver)
        backend._bind_cancel(_Scope(cancelled=True))
        assert driver._cancel_check is not None
        with pytest.raises(CancelledError):
            driver._cancel_check()

    def test_a_quiet_scope_does_not_abort(self, tmp_path) -> None:
        driver = RecordingDriver(observer=None)
        backend = WindowsComputerOperatorBackend(output_root=tmp_path, driver=driver)
        backend._bind_cancel(_Scope(cancelled=False))
        assert driver._cancel_check is not None
        driver._cancel_check()

    def test_the_binding_is_cleared_after_the_action(self, tmp_path) -> None:
        from datetime import UTC, datetime, timedelta

        from app.computer_operator.schema import (
            ComputerAction,
            ComputerActionKind,
            Effect,
            SurfaceGrant,
        )

        driver = RecordingDriver(observer=None)
        driver.window_at = lambda point: 42  # type: ignore[method-assign]
        backend = WindowsComputerOperatorBackend(output_root=tmp_path, driver=driver)
        action = ComputerAction(
            action_id="hover-1",
            kind=ComputerActionKind.HOVER,
            effect=Effect.REVERSIBLE_WRITE,
            source_observation_id="source-1",
            source_image_sha256="a" * 64,
            start=(0.5, 0.5),
        )
        grant = SurfaceGrant(
            grant_id="grant-1",
            surface_id="surface-1",
            source_frame_id="frame-1",
            source_frame_sha256="a" * 64,
            bounds_ltrb=(100, 200, 900, 800),
            target_lease={"window": {"hwnd": 42}},
            allowed_effects=(Effect.REVERSIBLE_WRITE,),
            expires_at=(datetime.now(UTC) + timedelta(minutes=1)).isoformat(),
        )
        result = backend.execute(action, grant, scope=_Scope())
        assert result.executed is True, result.error
        assert driver._cancel_check is None

    def test_the_driver_is_interrupted_by_the_actions_own_scope(self, tmp_path) -> None:
        from datetime import UTC, datetime, timedelta

        from app.computer_operator.schema import (
            ComputerAction,
            ComputerActionKind,
            Effect,
            SurfaceGrant,
        )

        driver = RecordingDriver(observer=None)
        driver.window_at = lambda point: 42  # type: ignore[method-assign]
        backend = WindowsComputerOperatorBackend(output_root=tmp_path, driver=driver)
        action = ComputerAction(
            action_id="hover-2",
            kind=ComputerActionKind.HOVER,
            effect=Effect.REVERSIBLE_WRITE,
            source_observation_id="source-1",
            source_image_sha256="a" * 64,
            start=(0.9, 0.9),
            duration_ms=5000,
        )
        grant = SurfaceGrant(
            grant_id="grant-1",
            surface_id="surface-1",
            source_frame_id="frame-1",
            source_frame_sha256="a" * 64,
            bounds_ltrb=(100, 200, 900, 800),
            target_lease={"window": {"hwnd": 42}},
            allowed_effects=(Effect.REVERSIBLE_WRITE,),
            expires_at=(datetime.now(UTC) + timedelta(minutes=1)).isoformat(),
        )
        with pytest.raises(CancelledError):
            backend.execute(action, grant, scope=_Scope(cancelled=True))
        assert driver._cancel_check is None
