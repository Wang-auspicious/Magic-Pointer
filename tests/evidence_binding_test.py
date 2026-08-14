from __future__ import annotations

from typing import Any

import pytest

from app.grounding.evidence_binding import (
    EvidenceBindingError,
    bind_frozen_evidence,
)


def _gesture(*, points: list[dict[str, int]] | None = None) -> dict[str, Any]:
    return {
        "coordinateSpace": "physical_screen_pixels",
        "points": points or [{"x": 120, "y": 140}, {"x": 220, "y": 240}],
    }


def _lease(
    *,
    target: dict[str, Any] | None = None,
    surface: list[int] | None = None,
    image_size: tuple[int, int] | None = None,
    gesture: dict[str, Any] | None = None,
) -> dict[str, Any]:
    bounds = surface or [0, 0, 1920, 1080]
    width, height = image_size or (bounds[2] - bounds[0], bounds[3] - bounds[1])
    return {
        "source": "gdi-fallback",
        "targetWindow": target
        or {
            "hwnd": 42,
            "processId": 7,
            "processName": "notepad.exe",
            "title": "Notes",
        },
        "surfaceBoundsPx": bounds,
        "localArtifact": {"width": width, "height": height},
        "gesture": gesture or _gesture(),
    }


def _source_window(**overrides: Any) -> dict[str, Any]:
    value = {
        "hwnd": 42,
        "pid": 7,
        "process_name": "notepad.exe",
        "title": "Notes",
    }
    value.update(overrides)
    return value


def test_bind_frozen_evidence_accepts_matching_window_and_gesture() -> None:
    lease = _lease()

    result = bind_frozen_evidence(
        lease,
        source_window=_source_window(),
        gesture=lease["gesture"],
    )

    assert result.status == "verified"
    assert result.target["hwnd"] == 42
    assert result.surface_bounds_px == (0, 0, 1920, 1080)
    assert result.capture_kind == "display"


@pytest.mark.parametrize(
    ("source_window", "reason"),
    [
        (_source_window(hwnd=99), "target_hwnd_mismatch"),
        (_source_window(pid=8), "target_process_mismatch"),
        (_source_window(process_name="other.exe"), "target_process_name_mismatch"),
    ],
)
def test_bind_frozen_evidence_rejects_wrong_source(
    source_window: dict[str, Any],
    reason: str,
) -> None:
    with pytest.raises(EvidenceBindingError, match=reason):
        bind_frozen_evidence(_lease(), source_window, _gesture())


@pytest.mark.parametrize(
    "target",
    [
        {"hwnd": 0, "processId": 7, "processName": "notepad.exe", "title": ""},
        {"hwnd": 42, "processId": 0, "processName": "notepad.exe", "title": ""},
        {"hwnd": 42, "processId": 7, "processName": "", "title": ""},
    ],
)
def test_bind_frozen_evidence_rejects_incomplete_target_identity(
    target: dict[str, Any],
) -> None:
    with pytest.raises(EvidenceBindingError, match="target_identity_incomplete"):
        bind_frozen_evidence(_lease(target=target), _source_window(), _gesture())


def test_bind_frozen_evidence_rejects_artifact_surface_size_mismatch() -> None:
    lease = _lease(surface=[0, 0, 1920, 1080], image_size=(960, 540))

    with pytest.raises(EvidenceBindingError, match="artifact_surface_mismatch"):
        bind_frozen_evidence(lease, _source_window(), _gesture())


def test_bind_frozen_evidence_rejects_gesture_outside_surface() -> None:
    gesture = _gesture(points=[{"x": 120, "y": 140}, {"x": 3000, "y": 2000}])

    with pytest.raises(EvidenceBindingError, match="gesture_outside_surface"):
        bind_frozen_evidence(_lease(gesture=gesture), _source_window(), gesture)


def test_bind_frozen_evidence_rejects_nonphysical_gesture() -> None:
    gesture = {"coordinateSpace": "screen_dip", "points": [{"x": 120, "y": 140}]}

    with pytest.raises(EvidenceBindingError, match="gesture_coordinate_space_mismatch"):
        bind_frozen_evidence(_lease(gesture=gesture), _source_window(), gesture)
