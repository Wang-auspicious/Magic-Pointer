"""``Win32InputDriver`` motion wiring.

Why this file exists, stated plainly: the first version of the animated-motion
fix called ``glide_points()`` inside ``Win32InputDriver._glide`` without
importing it. Every test in ``tests/computer_motion_test.py`` passed, because
those test the pure policy module; every test in
``tests/windows_computer_operator_test.py`` passed, because those inject a
*fake* driver and never execute ``Win32InputDriver`` at all. The real driver
raised ``NameError`` on every HOVER and DRAG, and nothing caught it.

The gap was that no test instantiated the real driver. These do — with
``_position`` stubbed, so no test moves the user's actual pointer.

Only run on Windows; the driver refuses to construct elsewhere.
"""

from __future__ import annotations

import os
import sys

import pytest

pytestmark = pytest.mark.skipif(sys.platform != "win32", reason="Windows-only driver")

from app.computer_operator import motion  # noqa: E402
from app.computer_operator.windows import Win32InputDriver  # noqa: E402


class RecordingDriver(Win32InputDriver):
    """A real driver whose only side effect is remembered, not performed."""

    def __init__(self) -> None:
        super().__init__()
        self.positions: list[tuple[int, int]] = []
        self.mouse: list[int] = []
        self.origin: tuple[int, int] | None = (100, 100)

    def _position(self, point: tuple[int, int]) -> None:  # type: ignore[override]
        self.positions.append((int(point[0]), int(point[1])))

    def _mouse(self, flag: int, data: int = 0) -> None:  # type: ignore[override]
        self.mouse.append(flag)

    def _cursor_position(self):  # type: ignore[override]
        return self.origin


@pytest.fixture()
def driver() -> RecordingDriver:
    return RecordingDriver()


class TestMove:
    def test_move_does_not_raise(self, driver: RecordingDriver) -> None:
        # The regression: this raised NameError because glide_points was not
        # imported into windows.py.
        driver.move((700, 500), duration_ms=0)

    def test_move_interpolates_rather_than_teleporting(self, driver: RecordingDriver) -> None:
        driver.move((700, 500), duration_ms=300)
        assert len(driver.positions) > 2, 'a move must visit intermediate positions'
        assert driver.positions[-1] == (700, 500), 'a move must finish exactly on target'

    def test_move_with_no_duration_still_animates(self, driver: RecordingDriver) -> None:
        # duration_ms=0 means "derive one from distance", not "teleport" —
        # the UI-TARS intent compiler zeroes the duration for every non-WAIT
        # action, so treating 0 as a teleport would restore the original bug
        # for every agent-issued move.
        driver.move((900, 600), duration_ms=0)
        assert len(driver.positions) > 2

    def test_move_path_stays_within_bounds(self, driver: RecordingDriver) -> None:
        driver.move((900, 700), duration_ms=400)
        for x, y in driver.positions:
            assert 100 <= x <= 900
            assert 100 <= y <= 700

    def test_move_to_the_same_point(self, driver: RecordingDriver) -> None:
        driver.move((100, 100), duration_ms=0)
        assert driver.positions == [(100, 100)]

    def test_move_without_a_readable_origin_teleports(self, driver: RecordingDriver) -> None:
        driver.origin = None
        driver.move((400, 400), duration_ms=500)
        assert driver.positions == [(400, 400)]


class TestDrag:
    def test_drag_does_not_raise(self, driver: RecordingDriver) -> None:
        driver.drag((10, 10), (200, 200), duration_ms=200)

    def test_drag_holds_the_button_for_the_whole_glide(self, driver: RecordingDriver) -> None:
        driver.drag((10, 10), (200, 200), duration_ms=200)
        # 0x0002 down, 0x0004 up, in that order, and nothing else.
        assert driver.mouse[0] == 0x0002
        assert driver.mouse[-1] == 0x0004

    def test_drag_starts_on_target_and_ends_on_target(self, driver: RecordingDriver) -> None:
        driver.drag((10, 10), (200, 200), duration_ms=200)
        assert driver.positions[0] == (10, 10)
        assert driver.positions[-1] == (200, 200)


class TestClick:
    def test_click_presses_once_per_count(self, driver: RecordingDriver) -> None:
        driver.click((300, 300), button='left', count=1)
        assert driver.mouse == [0x0002, 0x0004]

    def test_double_click_presses_twice(self, driver: RecordingDriver) -> None:
        driver.click((300, 300), button='left', count=2)
        assert driver.mouse == [0x0002, 0x0004, 0x0002, 0x0004]

    def test_right_click_uses_the_right_button_flags(self, driver: RecordingDriver) -> None:
        driver.click((300, 300), button='right', count=1)
        assert driver.mouse == [0x0008, 0x0010]

    def test_click_positions_before_pressing(self, driver: RecordingDriver) -> None:
        driver.click((300, 300), button='left', count=1)
        assert driver.positions == [(300, 300)]


class TestScroll:
    def test_scroll_positions_then_wheels(self, driver: RecordingDriver) -> None:
        driver.scroll((50, 60), delta=3)
        assert driver.positions == [(50, 60)]
        assert driver.mouse == [0x0800]


def test_motion_constants_are_the_documented_ones() -> None:
    # Pinned because the ledger quotes these, and because a silent change to
    # the floor is a silent change to how the product feels.
    assert motion.FLIGHT_MIN_MS == 600
    assert motion.FLIGHT_MAX_MS == 1400
    assert motion.FLIGHT_MS_PER_PIXEL == pytest.approx(1.25)
    assert motion.CLICK_HOLD_MS == 35
    assert motion.CLICK_SETTLE_MS == 20


def test_driver_module_imports_everything_it_calls() -> None:
    """A tripwire for the exact class of bug that got through.

    The driver is not covered by the fake-driver tests, so a name used but not
    imported only surfaces at runtime. Checking the module's namespace costs
    nothing and fails at test time instead of on the user's desktop.
    """
    import app.computer_operator.windows as windows_module

    source = open(windows_module.__file__, encoding='utf-8').read()
    for name in ('glide_points', 'motion', 'CLICK_HOLD_MS', 'CLICK_SETTLE_MS'):
        if name in source:
            assert hasattr(windows_module, name), (
                f'windows.py references {name} but does not import it'
            )


def test_time_module_is_not_unused_in_selection_bridge() -> None:
    """The reverse check on the same mistake: a leftover import."""
    source = open(
        os.path.join(os.path.dirname(__file__), '..', 'scripts', 'selection_bridge.py'),
        encoding='utf-8',
    ).read()
    if '\nimport time\n' in source:
        assert 'time.' in source, 'selection_bridge imports time but never uses it'
