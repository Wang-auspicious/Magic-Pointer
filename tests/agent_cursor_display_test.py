
from __future__ import annotations

import pytest

from app.computer_operator import displays
from app.computer_operator.displays import Display

PRIMARY = {"id": 1, "bounds": {"x": 0, "y": 0, "width": 1920, "height": 1080}, "scaleFactor": 1}
SECONDARY = {
    "id": 2,
    "bounds": {"x": 1920, "y": -200, "width": 1600, "height": 900},
    "scaleFactor": 1.25,
}
LEFT = {"id": 3, "bounds": {"x": -1280, "y": 0, "width": 1280, "height": 1024}, "scaleFactor": 1}


def parsed(*raw: dict) -> list[Display]:
    return displays.parse_displays(list(raw))


class TestParse:
    def test_electron_display_objects_round_trip(self) -> None:
        screens = parsed(PRIMARY, SECONDARY)
        assert [screen.display_id for screen in screens] == ["1", "2"]
        assert screens[1].x == 1920
        assert screens[1].y == -200
        assert screens[1].scale_factor == 1.25

    def test_order_is_preserved_because_the_primary_comes_first(self) -> None:
        screens = parsed(SECONDARY, PRIMARY)
        assert [screen.display_id for screen in screens] == ["2", "1"]

    def test_a_malformed_entry_is_skipped_not_fatal(self) -> None:
        screens = displays.parse_displays(
            [PRIMARY, {"id": 9}, {"id": 8, "bounds": {"x": 0, "y": 0, "width": 0, "height": 10}}, None]
        )
        assert [screen.display_id for screen in screens] == ["1"]

    def test_a_non_list_is_an_empty_display_set(self) -> None:
        assert displays.parse_displays(None) == []
        assert displays.parse_displays({"id": 1}) == []

    def test_a_missing_scale_factor_defaults_to_one(self) -> None:
        screens = displays.parse_displays([{"id": 4, "bounds": {"x": 0, "y": 0, "width": 10, "height": 10}}])
        assert screens[0].scale_factor == 1.0

    def test_a_display_without_an_id_still_gets_a_stable_name(self) -> None:
        screens = displays.parse_displays([{"bounds": {"x": 0, "y": 0, "width": 10, "height": 10}}])
        assert screens[0].display_id == "display-0"


class TestOwnership:
    def test_the_point_goes_to_the_display_that_contains_it(self) -> None:
        screens = parsed(PRIMARY, SECONDARY, LEFT)
        assert displays.display_for_point(screens, (100, 100)).display_id == "1"
        assert displays.display_for_point(screens, (2000, -100)).display_id == "2"
        assert displays.display_for_point(screens, (-500, 300)).display_id == "3"

    def test_a_point_outside_every_display_has_no_owner(self) -> None:
        screens = parsed(PRIMARY, SECONDARY)
        assert displays.display_for_point(screens, (5000, 5000)) is None
        assert displays.display_for_point(screens, (-1, 10)) is None

    def test_a_shared_edge_belongs_to_exactly_one_display(self) -> None:
        screens = parsed(PRIMARY, SECONDARY)
        owner = displays.display_for_point(screens, (1920, 10))
        assert owner is not None
        assert owner.display_id == "2", "the half-open rule puts the edge on the next display"
        assert displays.display_for_point(screens, (1919, 10)).display_id == "1"

    def test_the_bottom_edge_is_exclusive(self) -> None:
        screens = parsed(PRIMARY)
        assert displays.display_for_point(screens, (10, 1079)) is not None
        assert displays.display_for_point(screens, (10, 1080)) is None

    def test_a_negative_origin_display_works(self) -> None:
        screens = parsed(LEFT)
        assert displays.display_for_point(screens, (-1280, 0)) is not None
        assert displays.display_for_point(screens, (-1, 1023)) is not None
        assert displays.display_for_point(screens, (-1281, 0)) is None

    def test_a_non_finite_point_has_no_owner(self) -> None:
        screens = parsed(PRIMARY)
        assert displays.display_for_point(screens, (float("nan"), 10)) is None
        assert displays.display_for_point(screens, (10, float("inf"))) is None

    def test_no_displays_means_no_owner(self) -> None:
        assert displays.display_for_point([], (10, 10)) is None


class TestSurfaceBounds:
    def test_the_bottom_edge_is_shaved_by_two_pixels(self) -> None:
        surface = displays.surface_bounds(parsed(PRIMARY)[0])
        assert surface.as_bounds() == {"x": 0, "y": 0, "width": 1920, "height": 1078}
        assert displays.TASKBAR_SHAVE_PX == 2

    def test_other_edges_are_untouched(self) -> None:
        surface = displays.surface_bounds(parsed(SECONDARY)[0])
        assert (surface.x, surface.y, surface.width) == (1920, -200, 1600)
        assert surface.height == 898

    def test_a_display_smaller_than_the_shave_still_gets_a_window(self) -> None:
        tiny = Display(display_id="t", x=0, y=0, width=10, height=1)
        surface = displays.surface_bounds(tiny)
        assert surface.height == displays.MIN_SURFACE_PX
        assert surface.width == 10

    def test_the_shave_is_configurable_for_a_screen_recorder_style_need(self) -> None:
        surface = displays.surface_bounds(parsed(PRIMARY)[0], shave_px=0)
        assert surface.height == 1080

    def test_one_surface_per_display_in_order(self) -> None:
        surfaces = displays.surfaces_for(parsed(PRIMARY, SECONDARY, LEFT))
        assert [surface.display_id for surface in surfaces] == ["1", "2", "3"]
        assert len(surfaces) == 3

    def test_negative_origin_displays_keep_their_origin(self) -> None:
        surface = displays.surfaces_for(parsed(LEFT))[0]
        assert (surface.x, surface.y) == (-1280, 0)


class TestLocalCoordinates:
    def test_a_screen_point_is_rebased_into_its_window(self) -> None:
        surface = displays.surfaces_for(parsed(SECONDARY))[0]
        assert surface.local_point((1920, -200)) == (0, 0)
        assert surface.local_point((2020, -150)) == (100, 50)

    def test_a_negative_origin_display_rebases_correctly(self) -> None:
        surface = displays.surfaces_for(parsed(LEFT))[0]
        assert surface.local_point((-1280, 10)) == (0, 10)
        assert surface.local_point((-200, 10)) == (1080, 10)

    def test_the_whole_answer_comes_back_in_one_call(self) -> None:
        answer = displays.surface_for_point(parsed(PRIMARY, SECONDARY), (2000, -100))
        assert answer is not None
        surface, local = answer
        assert surface.display_id == "2"
        assert surface.as_bounds() == {"x": 1920, "y": -200, "width": 1600, "height": 898}
        assert local == (80, 100)

    def test_a_point_no_display_owns_has_no_answer(self) -> None:
        assert displays.surface_for_point(parsed(PRIMARY), (9999, 9999)) is None

    def test_a_local_point_becomes_a_screen_point_again(self) -> None:
        screens = parsed(PRIMARY, SECONDARY)
        surface, local = displays.surface_for_point(screens, (2000, -100))
        assert displays.screen_point_for(screens, surface, local) == (2000, -100)

    def test_the_shaved_bottom_is_clamped_rather_than_dropped(self) -> None:
        screens = parsed(PRIMARY)
        surface = displays.surface_bounds(screens[0])
        assert displays.screen_point_for(screens, surface, (10, 2000)) == (10, 1079)

    def test_a_local_point_on_an_unknown_surface_has_no_screen_point(self) -> None:
        screens = parsed(PRIMARY)
        orphan = displays.SurfaceBounds(display_id="nope", x=0, y=0, width=10, height=10)
        assert displays.screen_point_for(screens, orphan, (1, 1)) is None


def test_the_shave_is_the_one_windows_needs() -> None:
    assert displays.TASKBAR_SHAVE_PX == 2
    assert pytest.approx(2) == displays.TASKBAR_SHAVE_PX
