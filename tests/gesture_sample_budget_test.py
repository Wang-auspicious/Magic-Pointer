"""Perception must stay inside a budget the user can wait through.

2026-08-04, from data/runtime/electron.log:

    07:56:50.518  windows_enumerated  ms=6
    07:57:03.385  structured_read     ms=12873   <- 12.9s
    07:57:03.426  grounding wait expired
    07:57:04.195  capture done                  <- it worked, 0.8s too late

The 12.9s was the gesture fallback: when the region read finds nothing, it
samples up to nine points along the stroke and runs a full adapter cascade at
each one. A cascade costs 0.3-3.7s against a slow automation provider, so nine
in series is a quarter of a minute. These tests pin the budget that stops it.
"""

from __future__ import annotations

import time

import scripts.selection_snapshot_bridge as bridge


class _SlowAdapter:
    """An adapter as slow as Chromium's devtools reader measured on this machine."""

    name = "slow_probe"

    def __init__(self, delay_s: float = 2.1) -> None:
        self.delay_s = delay_s
        self.calls = 0

    def matches_window(self, window):  # noqa: ANN001 - registry duck type
        return True

    def read_context(self, window, **kwargs):  # noqa: ANN001, ANN003
        self.calls += 1
        time.sleep(self.delay_s)
        from app.adapters import AdapterReadContext

        return AdapterReadContext(
            adapter=self.name,
            app="application",
            window=dict(window),
            content="",
            label="",
            method="slow:none",
            error="nothing selected",
        )


class _Registry:
    def __init__(self, adapters) -> None:  # noqa: ANN001
        self._adapters = list(adapters)

    def matching_adapters(self, window):  # noqa: ANN001
        return [a for a in self._adapters if a.matches_window(window)]

    def matching_adapter(self, window):  # noqa: ANN001
        return next(iter(self.matching_adapters(window)), None)


def _gesture(points: int = 40) -> dict:
    return {
        "coordinateSpace": "physical_screen_pixels",
        # No bbox worth reading, so the region attempt is skipped and the
        # per-sample fallback is what runs.
        "bbox": {"x": 0, "y": 0, "width": 2, "height": 2},
        "semanticPoint": {"x": 100, "y": 100},
        # A stroke is {points: [...]}, not a bare array — see _gesture_strokes.
        "strokes": [{"points": [{"x": 100 + index * 12, "y": 100} for index in range(points)]}],
    }


def _window() -> dict:
    return {
        "hwnd": 4242,
        "title": "Slow App",
        "process_name": "slow.exe",
        "process_id": 99,
        "class_name": "SlowWindowClass",
        "bbox": [0, 0, 1920, 1080],
    }


def test_the_sample_fallback_stops_at_the_budget_instead_of_running_all_nine() -> None:
    adapter = _SlowAdapter(delay_s=2.1)
    started = time.monotonic()
    window, context, trace, grounding, bbox = bridge._read_gesture_target_context(
        [_window()],
        registry=_Registry([adapter]),
        gesture=_gesture(),
        fallback_point={"x": 100, "y": 100},
    )
    elapsed = time.monotonic() - started

    # Nine samples would be ~19s. The budget is 3.5s; allow one cascade of
    # overshoot because a sample in flight is never abandoned mid-read.
    assert elapsed < bridge.GESTURE_SAMPLE_BUDGET_S + adapter.delay_s + 1.0, elapsed
    assert adapter.calls < 9, adapter.calls
    assert context is None
    assert grounding["state"] == "unresolved"


def test_the_unresolved_report_says_how_many_samples_actually_ran() -> None:
    adapter = _SlowAdapter(delay_s=2.1)
    _, _, _, grounding, _ = bridge._read_gesture_target_context(
        [_window()],
        registry=_Registry([adapter]),
        gesture=_gesture(),
        fallback_point={"x": 100, "y": 100},
    )
    # Claiming nine attempts when the budget stopped us at two would hide why a
    # hard window failed.
    assert grounding["sample_count"] == adapter.calls
    assert grounding["sample_count_planned"] >= grounding["sample_count"]
    assert grounding["budget_exhausted"] is True


def test_at_least_one_sample_always_runs_even_on_a_pathological_window() -> None:
    # A single adapter slower than the whole budget must still be tried once:
    # giving up without reading anything would be worse than being slow.
    adapter = _SlowAdapter(delay_s=bridge.GESTURE_SAMPLE_BUDGET_S + 0.4)
    _, _, _, grounding, _ = bridge._read_gesture_target_context(
        [_window()],
        registry=_Registry([adapter]),
        gesture=_gesture(),
        fallback_point={"x": 100, "y": 100},
    )
    assert adapter.calls == 1
    assert grounding["sample_count"] == 1


def test_a_fast_window_still_gets_every_sample() -> None:
    adapter = _SlowAdapter(delay_s=0.0)
    _, _, _, grounding, _ = bridge._read_gesture_target_context(
        [_window()],
        registry=_Registry([adapter]),
        gesture=_gesture(),
        fallback_point={"x": 100, "y": 100},
    )
    # The budget must not cost precision where there is no latency to save.
    assert grounding["sample_count"] == grounding["sample_count_planned"]
    assert grounding["budget_exhausted"] is False
