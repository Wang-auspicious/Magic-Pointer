
import pytest

from app.computer_operator import motion


class TestSmoothstep:
    def test_endpoints_are_exact(self) -> None:
        assert motion.smoothstep(0.0) == 0.0
        assert motion.smoothstep(1.0) == 1.0

    def test_midpoint_is_half(self) -> None:
        assert motion.smoothstep(0.5) == pytest.approx(0.5)

    def test_is_monotonic_and_clamped_outside_the_unit_interval(self) -> None:
        values = [motion.smoothstep(i / 100.0) for i in range(101)]
        assert values == sorted(values)
        assert motion.smoothstep(-3.0) == 0.0
        assert motion.smoothstep(4.0) == 1.0

    def test_eases_in_and_out(self) -> None:
        assert motion.smoothstep(0.25) < 0.25
        assert motion.smoothstep(0.75) > 0.75


class TestDistanceBetween:
    def test_axis_aligned(self) -> None:
        assert motion.distance_between((0, 0), (30, 40)) == pytest.approx(50.0)

    def test_identical_points_are_zero(self) -> None:
        assert motion.distance_between((7, 9), (7, 9)) == 0.0

    def test_negative_direction_is_symmetric(self) -> None:
        assert motion.distance_between((10, 10), (0, 0)) == pytest.approx(
            motion.distance_between((0, 0), (10, 10))
        )


class TestFlightDuration:
    def test_explicit_request_always_wins(self) -> None:
        assert motion.flight_duration_ms(5000.0, requested_ms=250) == 250
        assert motion.flight_duration_ms(1.0, requested_ms=900) == 900

    def test_zero_request_derives_from_distance(self) -> None:
        assert motion.flight_duration_ms(800.0) == 1000
        assert motion.flight_duration_ms(1000.0) == 1250

    def test_floor_for_short_moves(self) -> None:
        assert motion.flight_duration_ms(1.0) == motion.FLIGHT_MIN_MS

    def test_ceiling_for_long_moves(self) -> None:
        assert motion.flight_duration_ms(100_000.0) == motion.FLIGHT_MAX_MS

    def test_zero_distance_costs_nothing(self) -> None:
        assert motion.flight_duration_ms(0.0) == 0

    def test_negative_request_falls_back_to_distance(self) -> None:
        assert motion.flight_duration_ms(1.0, requested_ms=-5) == motion.FLIGHT_MIN_MS

    def test_is_monotonic_in_distance(self) -> None:
        durations = [motion.flight_duration_ms(float(d)) for d in range(0, 4000, 50)]
        assert durations == sorted(durations)


class TestGlidePoints:
    def test_zero_duration_has_no_intermediate_points(self) -> None:
        assert motion.glide_points((0, 0), (100, 100), 0) == []

    def test_identical_points_have_no_intermediate_points(self) -> None:
        assert motion.glide_points((5, 5), (5, 5), 400) == []

    def test_path_never_ends_on_the_target(self) -> None:
        points = motion.glide_points((0, 0), (100, 0), 320)
        assert points
        assert points[-1] != (100, 0)

    def test_points_stay_within_the_bounding_box(self) -> None:
        points = motion.glide_points((10, 20), (200, 90), 400)
        for x, y in points:
            assert 10 <= x <= 200
            assert 20 <= y <= 90

    def test_points_are_integers(self) -> None:
        points = motion.glide_points((0, 0), (500, 300), 1000)
        assert points
        assert all(isinstance(x, int) and isinstance(y, int) for x, y in points)

    def test_step_count_is_bounded(self) -> None:
        points = motion.glide_points((0, 0), (100_000, 100_000), 60_000)
        assert len(points) <= motion.MAX_GLIDE_STEPS

    def test_duration_shorter_than_two_intervals_has_no_interior(self) -> None:
        assert motion.glide_points((0, 0), (50, 0), 5) == []
        assert motion.glide_points((0, 0), (50, 0), motion.GLIDE_STEP_MS) == []

    def test_motion_eases_in_and_out(self) -> None:
        points = motion.glide_points((0, 0), (1200, 0), 800)
        xs = [0] + [p[0] for p in points] + [1200]
        deltas = [b - a for a, b in zip(xs, xs[1:])]
        middle = deltas[len(deltas) // 2]
        assert deltas[0] < middle
        assert deltas[-1] < middle

    def test_endpoint_is_not_a_sampled_point(self) -> None:
        points = motion.glide_points((0, 0), (10_000, 0), 640)
        assert points[-1][0] < 10_000
        assert 10_000 - points[-1][0] >= 1

    def test_non_axis_aligned_path_is_monotonic_in_both_axes(self) -> None:
        points = motion.glide_points((0, 0), (300, 400), 600)
        xs = [p[0] for p in points]
        ys = [p[1] for p in points]
        assert xs == sorted(xs)
        assert ys == sorted(ys)
