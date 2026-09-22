
from __future__ import annotations

import math

import pytest

from app.computer_operator import cursors
from app.computer_operator.cursors import CursorRegistry


def registry(*, pointer: tuple[float, float] | None = None) -> CursorRegistry:
    instance = CursorRegistry()
    if pointer is not None:
        instance.set_pointer(pointer)
    return instance


def run_until_landed(
    model: CursorRegistry,
    cursor_id: str,
    *,
    start_ms: int,
    step_ms: int = 16,
    limit_ms: int = 20_000,
):
    frame = None
    now = start_ms
    while now <= start_ms + limit_ms:
        frame = next(f for f in model.tick(now) if f.cursor_id == cursor_id)
        if frame.state != cursors.CursorState.FLYING.value:
            return frame
        now += step_ms
    raise AssertionError("cursor never landed")


class TestMotionSpecConstants:

    def test_dwell_is_three_seconds(self) -> None:
        assert cursors.DWELL_MS == 3000

    def test_return_is_a_flat_1400(self) -> None:
        assert cursors.RETURN_MS == 1400

    def test_ring_is_26_plus_pulse_times_6(self) -> None:
        assert cursors.RING_BASE_RADIUS == 26.0
        assert cursors.RING_PULSE_PX == 6.0
        assert cursors.ring_radius(0.0) == 26.0
        assert cursors.ring_radius(1.0) == 32.0
        assert cursors.ring_radius(0.5) == pytest.approx(29.0)

    def test_click_glow_is_2400_clamped(self) -> None:
        assert cursors.GLOW_MS == 2400
        assert cursors.GLOW_MIN_MS == 400
        assert cursors.GLOW_MAX_MS == 12000

    def test_pulse_is_bounded_and_starts_at_the_midpoint(self) -> None:
        assert cursors.ring_pulse(0.0) == pytest.approx(0.5)
        pulses = [cursors.ring_pulse(i / 20.0) for i in range(200)]
        assert all(0.0 <= value <= 1.0 for value in pulses)

    def test_flight_timing_reuses_the_driver_policy(self) -> None:
        model = registry()
        model.spawn("twin", (0, 0), now_ms=0)
        model.begin_flight("twin", (1000, 0), now_ms=0)
        frame = next(f for f in model.tick(16) if f.cursor_id == "twin")
        assert frame.state == cursors.CursorState.FLYING.value
        assert run_until_landed(model, "twin", start_ms=16).x == 1000


class TestFlightReachesTargetExactly:
    def test_a_flight_lands_on_the_exact_pixel(self) -> None:
        model = registry()
        model.spawn("twin", (10, 20), now_ms=0)
        model.begin_flight("twin", (901, 733), duration_ms=800, now_ms=0)
        frame = run_until_landed(model, "twin", start_ms=0)
        assert (frame.x, frame.y) == (901, 733)
        assert frame.state == cursors.CursorState.DWELLING.value

    def test_a_flight_does_not_arrive_before_its_duration(self) -> None:
        model = registry()
        model.spawn("twin", (0, 0), now_ms=0)
        model.begin_flight("twin", (800, 0), duration_ms=1000, now_ms=0)
        halfway = next(f for f in model.tick(500) if f.cursor_id == "twin")
        assert halfway.state == cursors.CursorState.FLYING.value
        assert halfway.x < 800

    def test_short_and_long_flights_use_the_clicky_clamp(self) -> None:
        for target, expected_ms in (((5, 0), 600), ((4000, 0), 1400)):
            model = registry()
            model.spawn("twin", (0, 0), now_ms=0)
            model.begin_flight("twin", target, now_ms=0)
            just_before = next(
                f for f in model.tick(expected_ms - 32) if f.cursor_id == "twin"
            )
            assert just_before.state == cursors.CursorState.FLYING.value
            landed = next(f for f in model.tick(expected_ms + 16) if f.cursor_id == "twin")
            assert landed.state != cursors.CursorState.FLYING.value

    def test_the_path_bows_above_the_straight_line(self) -> None:
        model = registry()
        model.spawn("twin", (0, 400), now_ms=0)
        model.begin_flight("twin", (1000, 400), duration_ms=1000, now_ms=0)
        ys = []
        for now in range(0, 1000, 50):
            ys.append(next(f for f in model.tick(now) if f.cursor_id == "twin").y)
        assert min(ys) < 400, "the flight must rise above the straight line"
        assert cursors.arc_height(1000.0) == pytest.approx(80.0)
        assert cursors.arc_height(10_000.0) == pytest.approx(80.0)
        assert cursors.arc_height(100.0) == pytest.approx(20.0)

    def test_scale_pulses_and_returns_to_one(self) -> None:
        model = registry()
        model.spawn("twin", (0, 0), now_ms=0)
        model.begin_flight("twin", (600, 0), duration_ms=1000, now_ms=0)
        apex = next(f for f in model.tick(500) if f.cursor_id == "twin")
        assert apex.scale > 1.2
        assert apex.scale < 1.31
        landed = run_until_landed(model, "twin", start_ms=500)
        assert landed.scale == 1.0

    def test_rotation_follows_the_curve_tangent(self) -> None:
        model = registry()
        model.spawn("twin", (0, 0), now_ms=0)
        model.begin_flight("twin", (800, 0), duration_ms=1000, now_ms=0)
        early = next(f for f in model.tick(100) if f.cursor_id == "twin")
        late = next(f for f in model.tick(900) if f.cursor_id == "twin")
        assert early.rotation_degrees != cursors.TRIANGLE_REST_DEGREES
        assert late.rotation_degrees != early.rotation_degrees

    def test_a_degenerate_flight_does_not_divide_by_zero(self) -> None:
        model = registry()
        model.spawn("twin", (50, 50), now_ms=0)
        model.begin_flight("twin", (50, 50), now_ms=0)
        frame = run_until_landed(model, "twin", start_ms=0)
        assert (frame.x, frame.y) == (50, 50)
        assert frame.rotation_degrees == cursors.TRIANGLE_REST_DEGREES


class TestDwellAndReturn:
    def test_dwell_lasts_3000ms_then_the_cursor_returns(self) -> None:
        model = registry(pointer=(0.0, 0.0))
        model.spawn("twin", (0, 0), follow_pointer=True, now_ms=0)
        model.begin_flight("twin", (400, 0), duration_ms=600, now_ms=0)
        landed = run_until_landed(model, "twin", start_ms=0)
        assert landed.state == cursors.CursorState.DWELLING.value
        assert next(f for f in model.tick(2000) if f.cursor_id == "twin").state == (
            cursors.CursorState.DWELLING.value
        )
        after = next(f for f in model.tick(3700) if f.cursor_id == "twin")
        assert after.state != cursors.CursorState.DWELLING.value

    def test_the_return_leg_is_a_flat_1400ms_regardless_of_distance(self) -> None:
        for target in ((30, 0), (2000, 0)):
            model = registry(pointer=(0.0, 0.0))
            model.spawn("twin", (0, 0), follow_pointer=True, now_ms=0)
            model.begin_flight("twin", target, duration_ms=16, now_ms=0)
            landed = run_until_landed(model, "twin", start_ms=0)
            assert landed.state == cursors.CursorState.DWELLING.value
            model.release_dwell("twin", now_ms=0)
            frame = next(f for f in model.tick(0) if f.cursor_id == "twin")
            assert frame.state == cursors.CursorState.FLYING.value
            mid = next(f for f in model.tick(700) if f.cursor_id == "twin")
            assert mid.state == cursors.CursorState.FLYING.value

    def test_a_held_cursor_stays_on_target_past_the_dwell(self) -> None:
        model = registry(pointer=(0.0, 0.0))
        model.spawn("twin", (0, 0), follow_pointer=True, now_ms=0)
        model.begin_flight("twin", (400, 0), duration_ms=600, now_ms=0)
        run_until_landed(model, "twin", start_ms=0)
        model.hold("twin", True, now_ms=0)
        for now in range(0, 12_000, 250):
            frame = next(f for f in model.tick(now) if f.cursor_id == "twin")
            assert frame.state == cursors.CursorState.DWELLING.value, now
        model.hold("twin", False, now_ms=12_000)
        later = next(f for f in model.tick(12_000 + cursors.DWELL_MS + 16) if f.cursor_id == "twin")
        assert later.state != cursors.CursorState.DWELLING.value

    def test_holding_before_arrival_survives_the_landing(self) -> None:
        model = registry(pointer=(0.0, 0.0))
        model.spawn("twin", (0, 0), follow_pointer=True, now_ms=0)
        model.begin_flight("twin", (400, 0), duration_ms=600, now_ms=0)
        model.hold("twin", True, now_ms=0)
        landed = run_until_landed(model, "twin", start_ms=0)
        assert landed.state == cursors.CursorState.DWELLING.value
        assert next(f for f in model.tick(9000) if f.cursor_id == "twin").state == (
            cursors.CursorState.DWELLING.value
        )

    def test_a_pointer_move_cancels_the_return_leg(self) -> None:
        model = registry(pointer=(0.0, 0.0))
        model.spawn("twin", (0, 0), follow_pointer=True, now_ms=0)
        model.begin_flight("twin", (400, 0), duration_ms=600, now_ms=0)
        run_until_landed(model, "twin", start_ms=0)
        model.release_dwell("twin", now_ms=0)
        model.set_pointer((500.0, 500.0))
        frame = next(f for f in model.tick(100) if f.cursor_id == "twin")
        assert frame.state == cursors.CursorState.IDLE.value

    def test_a_small_pointer_move_does_not_cancel_the_return(self) -> None:
        model = registry(pointer=(0.0, 0.0))
        model.spawn("twin", (0, 0), follow_pointer=True, now_ms=0)
        model.begin_flight("twin", (400, 0), duration_ms=600, now_ms=0)
        run_until_landed(model, "twin", start_ms=0)
        model.release_dwell("twin", now_ms=0)
        model.set_pointer((20.0, 0.0))
        frame = next(f for f in model.tick(100) if f.cursor_id == "twin")
        assert frame.state == cursors.CursorState.FLYING.value


class TestTtlExpiry:
    def test_a_cursor_with_a_ttl_is_removed_when_it_expires(self) -> None:
        model = registry()
        model.spawn("marker", (10, 10), ttl_ms=1000, now_ms=0)
        assert "marker" in model
        assert model.expire(999) == []
        assert "marker" in model
        assert model.expire(1000) == ["marker"]
        assert "marker" not in model
        assert len(model) == 0

    def test_the_brief_asks_for_exactly_this(self) -> None:
        model = registry()
        model.spawn("marker", (10, 10), ttl_ms=500, now_ms=0)
        model.tick(0)
        model.tick(200)
        assert model.ids() == ["marker"]
        removed = model.expire(500)
        assert removed == ["marker"]
        assert model.ids() == []

    def test_a_ttl_of_zero_is_floored_not_ignored(self) -> None:
        model = registry()
        frame = model.spawn("marker", (10, 10), ttl_ms=0, now_ms=0)
        assert frame.ttl_remaining_ms == cursors.TTL_MIN_MS
        assert model.expire(cursors.TTL_MIN_MS - 1) == []
        assert model.expire(cursors.TTL_MIN_MS) == ["marker"]

    def test_a_cursor_without_a_ttl_never_expires(self) -> None:
        model = registry()
        model.spawn("twin", (10, 10), now_ms=0)
        assert model.expire(10_000_000) == []
        assert model.ids() == ["twin"]

    def test_the_default_ttl_is_applied_when_the_registry_sets_one(self) -> None:
        model = CursorRegistry(default_ttl_ms=cursors.DEFAULT_TTL_MS)
        frame = model.spawn("marker", (10, 10), now_ms=0)
        assert frame.ttl_remaining_ms == cursors.DEFAULT_TTL_MS

    def test_expiry_does_not_touch_the_other_cursors(self) -> None:
        model = registry()
        model.spawn("twin", (0, 0), now_ms=0)
        model.spawn("marker", (10, 10), ttl_ms=500, now_ms=0)
        assert model.expire(500) == ["marker"]
        assert model.ids() == ["twin"]


class TestTwoCursorsDoNotInterfere:
    def test_flying_one_cursor_leaves_the_other_alone(self) -> None:
        model = registry()
        model.spawn("a", (100, 100), accent="#3380FF", now_ms=0)
        model.spawn("b", (800, 800), accent="#FF5533", now_ms=0)
        model.begin_flight("a", (300, 300), duration_ms=600, now_ms=0)
        for now in range(0, 700, 16):
            frames = {f.cursor_id: f for f in model.tick(now)}
            assert (frames["b"].x, frames["b"].y) == (800, 800)
            assert frames["b"].accent == "#FF5533"
        landed = next(f for f in model.frames(700) if f.cursor_id == "a")
        assert (landed.x, landed.y) == (300, 300)
        assert landed.accent == "#3380FF"

    def test_each_cursor_keeps_its_own_accent_and_caption(self) -> None:
        model = registry()
        model.spawn("a", (0, 0), accent="#111111", caption="first", now_ms=0)
        model.spawn("b", (0, 0), accent="#222222", caption="second", now_ms=0)
        frames = {f.cursor_id: f for f in model.frames(0)}
        assert frames["a"].accent == "#111111"
        assert frames["a"].caption == "first"
        assert frames["b"].accent == "#222222"
        assert frames["b"].caption == "second"

    def test_only_the_follow_anchored_cursor_chases_the_pointer(self) -> None:
        model = registry(pointer=(100.0, 100.0))
        model.spawn("twin", (0, 0), follow_pointer=True, now_ms=0)
        model.spawn("marker", (600, 600), follow_pointer=False, now_ms=0)
        model.set_pointer((300.0, 200.0))
        for now in range(0, 3000, 16):
            model.tick(now)
        frames = {f.cursor_id: f for f in model.frames(3000)}
        assert (frames["twin"].x, frames["twin"].y) == (
            300 + cursors.OFFSET_X,
            200 + cursors.OFFSET_Y,
        )
        assert (frames["marker"].x, frames["marker"].y) == (600, 600)

    def test_a_marker_can_be_moved_without_stealing_the_twin(self) -> None:
        model = registry(pointer=(0.0, 0.0))
        model.spawn("twin", (0, 0), follow_pointer=True, now_ms=0)
        model.spawn("marker", (0, 0), now_ms=0)
        model.set_target("marker", (500, 500), now_ms=0)
        for now in range(0, 4000, 16):
            model.tick(now)
        frames = {f.cursor_id: f for f in model.frames(4000)}
        assert (frames["marker"].x, frames["marker"].y) == (500, 500)

    def test_removing_one_cursor_leaves_the_rest(self) -> None:
        model = registry()
        model.spawn("a", (0, 0), now_ms=0)
        model.spawn("b", (1, 1), now_ms=0)
        assert model.remove("a") is True
        assert model.remove("a") is False
        assert model.ids() == ["b"]

    def test_the_ring_belongs_only_to_the_cursor_that_was_pointed(self) -> None:
        model = registry()
        model.spawn("a", (0, 0), now_ms=0)
        model.spawn("b", (0, 0), now_ms=0)
        model.begin_flight("a", (200, 200), duration_ms=600, now_ms=0)
        frames = {f.cursor_id: f for f in model.tick(100)}
        assert frames["a"].ring_radius is not None
        assert frames["b"].ring_radius is None


class TestTickIsMonotonicAndDeterministic:
    def _scripted(self, model: CursorRegistry) -> list[tuple[int, int, str, float]]:
        out = []
        for now in range(0, 2500, 50):
            for frame in model.tick(now):
                out.append((frame.x, frame.y, frame.state, round(frame.scale, 6)))
        return out

    def test_two_identical_scripts_produce_identical_frames(self) -> None:
        def build() -> CursorRegistry:
            model = registry(pointer=(640.0, 360.0))
            model.spawn("twin", (0, 0), follow_pointer=True, now_ms=0)
            model.begin_flight("twin", (900, 400), duration_ms=700, now_ms=0)
            model.click("twin", now_ms=300)
            return model

        assert self._scripted(build()) == self._scripted(build())

    def test_a_stale_timestamp_does_not_rewind_time(self) -> None:
        model = registry()
        model.spawn("twin", (0, 0), now_ms=0)
        model.begin_flight("twin", (800, 0), duration_ms=800, now_ms=0)
        model.tick(500)
        fresh = [(f.x, f.y) for f in model.tick(800)]
        stale = [(f.x, f.y) for f in model.tick(10)]
        assert stale == fresh

    def test_the_clock_never_reports_less_than_it_has_seen(self) -> None:
        model = registry()
        model.spawn("twin", (0, 0), ttl_ms=1000, now_ms=0)
        model.tick(5000)
        assert model.get("twin") is not None
        assert model.expire(100) == ["twin"]

    def test_a_flight_closes_on_its_target_monotonically(self) -> None:
        model = registry()
        model.spawn("twin", (0, 0), now_ms=0)
        model.begin_flight("twin", (1200, 0), duration_ms=1000, now_ms=0)
        remaining = []
        for now in range(0, 1001, 25):
            frame = next(f for f in model.tick(now) if f.cursor_id == "twin")
            remaining.append(abs(1200 - frame.x))
        assert remaining == sorted(remaining, reverse=True)
        assert remaining[-1] == 0

    def test_the_spring_is_a_function_of_the_clock_not_the_call_count(self) -> None:
        def advance(step_ms: int) -> tuple[int, int]:
            model = registry(pointer=(0.0, 0.0))
            model.spawn("twin", (0, 0), follow_pointer=True, now_ms=0)
            model.tick(0)
            model.set_pointer((400.0, 0.0))
            now = 0
            while now < 128:
                now += step_ms
                model.tick(now)
            frame = next(f for f in model.frames(128) if f.cursor_id == "twin")
            return (frame.x, frame.y)

        assert advance(128) == advance(64) == advance(16)

    def test_a_long_stall_does_not_replay_a_backlog_of_spring_steps(self) -> None:
        def frame_at(now_ms: int):
            model = registry(pointer=(0.0, 0.0))
            model.spawn("twin", (0, 0), follow_pointer=True, now_ms=0)
            model.tick(0)
            model.set_pointer((400.0, 0.0))
            return next(f for f in model.tick(now_ms) if f.cursor_id == "twin")

        assert frame_at(10_000) == frame_at(cursors.TICK_CATCHUP_MAX * cursors.TICK_MS)
        assert frame_at(10_000).x != 400 + cursors.OFFSET_X

    def test_the_spring_snaps_shut_on_the_follow_anchor(self) -> None:
        model = registry(pointer=(0.0, 0.0))
        model.spawn("twin", (0, 0), follow_pointer=True, now_ms=0)
        model.tick(0)
        model.set_pointer((400.0, 250.0))
        for now in range(16, 8000, 16):
            model.tick(now)
        frame = next(f for f in model.frames(8000) if f.cursor_id == "twin")
        assert (frame.x, frame.y) == (400 + cursors.OFFSET_X, 250 + cursors.OFFSET_Y)

    def test_the_ring_phase_advances_with_the_clock(self) -> None:
        model = registry()
        model.spawn("twin", (0, 0), now_ms=0)
        model.begin_flight("twin", (400, 0), duration_ms=10_000, now_ms=0)
        early = next(f for f in model.tick(16) if f.cursor_id == "twin").ring_radius
        late = next(f for f in model.tick(5000) if f.cursor_id == "twin").ring_radius
        assert early is not None and late is not None
        assert early != late
        for now in range(5000, 6000, 50):
            radius = next(f for f in model.tick(now) if f.cursor_id == "twin").ring_radius
            assert radius is not None
            assert 26.0 <= radius <= 32.0 + 1e-9


class TestClickGlow:
    def test_a_click_sets_the_glow_and_then_releases_the_cursor(self) -> None:
        model = registry()
        model.spawn("twin", (0, 0), now_ms=0)
        model.click("twin", now_ms=0)
        frame = next(f for f in model.tick(0) if f.cursor_id == "twin")
        assert frame.state == cursors.CursorState.CLICKING.value
        assert frame.glow_remaining_ms == cursors.GLOW_MS
        still = next(f for f in model.tick(2000) if f.cursor_id == "twin")
        assert still.state == cursors.CursorState.CLICKING.value
        after = next(f for f in model.tick(2500) if f.cursor_id == "twin")
        assert after.state != cursors.CursorState.CLICKING.value
        assert after.glow_remaining_ms == 0

    def test_the_glow_duration_is_clamped(self) -> None:
        model = registry()
        model.spawn("twin", (0, 0), now_ms=0)
        assert model.click("twin", duration_ms=0, now_ms=0) is not None
        frame = next(f for f in model.frames(0) if f.cursor_id == "twin")
        assert frame.glow_remaining_ms == cursors.GLOW_MIN_MS
        model.click("twin", duration_ms=10_000_000, now_ms=0)
        frame = next(f for f in model.frames(0) if f.cursor_id == "twin")
        assert frame.glow_remaining_ms == cursors.GLOW_MAX_MS

    def test_clicking_an_unknown_cursor_is_a_no_op(self) -> None:
        model = registry()
        assert model.click("nobody", now_ms=0) is None
        assert model.begin_flight("nobody", (1, 1), now_ms=0) is None
        assert model.set_target("nobody", (1, 1), now_ms=0) is None
        assert model.hold("nobody", True, now_ms=0) is None
        assert model.get("nobody") is None


class TestPayload:
    def test_the_wire_payload_carries_what_the_renderer_needs(self) -> None:
        model = registry()
        model.spawn("twin", (12, 34), accent="#3380FF", caption="target", now_ms=0)
        frame = next(f for f in model.frames(0) if f.cursor_id == "twin")
        payload = frame.as_payload()
        assert payload["id"] == "twin"
        assert (payload["x"], payload["y"]) == (12, 34)
        assert payload["accent"] == "#3380FF"
        assert payload["caption"] == "target"
        assert payload["state"] == "idle"
        assert payload["ringRadius"] is None

    def test_every_payload_is_json_serializable(self) -> None:
        import json

        model = registry(pointer=(10.0, 10.0))
        model.spawn("twin", (0, 0), follow_pointer=True, now_ms=0)
        model.begin_flight("twin", (900, 400), now_ms=0)
        model.click("twin", now_ms=0)
        model.spawn("marker", (5, 5), ttl_ms=1000, now_ms=0)
        model.tick(100)
        encoded = json.dumps(model.payload(100))
        assert "twin" in encoded

    def test_clear_returns_every_id_it_removed(self) -> None:
        model = registry()
        model.spawn("a", (0, 0), now_ms=0)
        model.spawn("b", (0, 0), now_ms=0)
        assert sorted(model.clear()) == ["a", "b"]
        assert model.ids() == []


def test_no_public_helper_reads_the_wall_clock() -> None:
    import inspect

    source = inspect.getsource(cursors)
    body = "\n".join(
        line for line in source.splitlines() if not line.lstrip().startswith(("#", '"""', "*"))
    )
    for banned in ("import time", "import datetime", "monotonic(", "datetime.now"):
        assert banned not in body, f"cursors.py must stay pure, found {banned}"


def test_the_follow_spring_is_the_documented_integrator() -> None:
    assert cursors.SPRING_STIFFNESS == 0.28
    assert cursors.SPRING_DAMPING == 0.62
    assert cursors.TICK_MS == 16
    assert cursors.RING_PHASE_STEP == 0.08
    assert math.isclose(cursors.RING_PHASE_PER_MS, 0.005)
