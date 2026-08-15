"""Bind an immutable frame to the window and gesture it claims to represent.

FrameLease schema validation proves that a payload is well formed.  This module
proves the cross-object facts that the schema cannot prove on its own: the
structured source is the same process/window, the image dimensions describe the
declared physical surface, and the gesture is expressed inside that surface.

The boundary is deliberately small.  It does not capture, read accessibility,
run OCR, or infer identity from pixels.  A caller receives one verified binding
or one stable fail-closed reason.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True, slots=True)
class EvidenceBinding:
    status: str
    target: dict[str, Any]
    surface_bounds_px: tuple[int, int, int, int]
    capture_kind: str


class EvidenceBindingError(ValueError):
    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def _mapping(value: Any) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def _positive_int(value: Any) -> int:
    try:
        normalized = int(value or 0)
    except (TypeError, ValueError, OverflowError):
        return 0
    return normalized if normalized > 0 else 0


def _identity(value: Any) -> dict[str, Any]:
    source = _mapping(value)
    return {
        "hwnd": _positive_int(source.get("hwnd")),
        "processId": _positive_int(
            source.get("processId") or source.get("process_id") or source.get("pid")
        ),
        "processName": str(
            source.get("processName") or source.get("process_name") or ""
        ).strip(),
        "title": str(source.get("title") or ""),
    }


def _require_complete_identity(target: Mapping[str, Any]) -> None:
    if (
        _positive_int(target.get("hwnd")) == 0
        or _positive_int(target.get("processId")) == 0
        or not str(target.get("processName") or "").strip()
    ):
        raise EvidenceBindingError("target_identity_incomplete")


def _process_name(value: Any) -> str:
    name = str(value or "").strip().casefold()
    return name[:-4] if name.endswith(".exe") else name


def _require_same_identity(
    expected: Mapping[str, Any],
    observed: Mapping[str, Any],
) -> None:
    if observed.get("hwnd") != expected.get("hwnd"):
        raise EvidenceBindingError("target_hwnd_mismatch")
    if observed.get("processId") != expected.get("processId"):
        raise EvidenceBindingError("target_process_mismatch")
    if _process_name(observed.get("processName")) != _process_name(
        expected.get("processName")
    ):
        raise EvidenceBindingError("target_process_name_mismatch")


def _surface(value: Any) -> tuple[int, int, int, int]:
    if not isinstance(value, (list, tuple)) or len(value) != 4:
        raise EvidenceBindingError("surface_bounds_invalid")
    try:
        left, top, right, bottom = (int(round(float(item))) for item in value)
    except (TypeError, ValueError, OverflowError) as exc:
        raise EvidenceBindingError("surface_bounds_invalid") from exc
    if right <= left or bottom <= top:
        raise EvidenceBindingError("surface_bounds_invalid")
    return left, top, right, bottom


def _artifact_size(value: Any) -> tuple[int, int]:
    artifact = _mapping(value)
    width = _positive_int(artifact.get("width"))
    height = _positive_int(artifact.get("height"))
    if width == 0 or height == 0:
        raise EvidenceBindingError("artifact_dimensions_invalid")
    return width, height


def _require_artifact_matches_surface(
    artifact: Any,
    surface: tuple[int, int, int, int],
) -> None:
    width, height = _artifact_size(artifact)
    expected = surface[2] - surface[0], surface[3] - surface[1]
    if (width, height) != expected:
        raise EvidenceBindingError("artifact_surface_mismatch")


def _gesture_points(value: Any) -> list[tuple[float, float]]:
    gesture = _mapping(value)
    values: list[Any] = list(gesture.get("points") or [])
    for stroke in gesture.get("strokes") or []:
        values.extend(_mapping(stroke).get("points") or [])
    points: list[tuple[float, float]] = []
    for item in values:
        point = _mapping(item)
        try:
            points.append((float(point.get("x")), float(point.get("y"))))
        except (TypeError, ValueError, OverflowError):
            raise EvidenceBindingError("gesture_geometry_invalid") from None
    return points


def _require_physical_gesture_inside(
    gesture: Any,
    surface: tuple[int, int, int, int],
) -> None:
    value = _mapping(gesture)
    points = _gesture_points(value)
    if not points:
        return
    if str(value.get("coordinateSpace") or "") != "physical_screen_pixels":
        raise EvidenceBindingError("gesture_coordinate_space_mismatch")
    left, top, right, bottom = surface
    if any(not (left <= x < right and top <= y < bottom) for x, y in points):
        raise EvidenceBindingError("gesture_outside_surface")


def _capture_kind(source: str) -> str:
    if source == "wgc-window":
        return "window"
    if source in {"wgc-display", "dxgi-display"}:
        return "display"
    return "fallback"


def bind_frozen_evidence(
    lease: Mapping[str, Any],
    source_window: Mapping[str, Any] | None,
    gesture: Mapping[str, Any] | None,
) -> EvidenceBinding:
    """Return a verified cross-evidence binding or raise one stable reason."""

    target = _identity(lease.get("targetWindow"))
    observed = _identity(source_window)
    _require_complete_identity(target)
    _require_same_identity(target, observed)
    surface = _surface(lease.get("surfaceBoundsPx"))
    _require_artifact_matches_surface(lease.get("localArtifact"), surface)
    _require_physical_gesture_inside(gesture, surface)
    return EvidenceBinding(
        status="verified",
        target=target,
        surface_bounds_px=surface,
        capture_kind=_capture_kind(str(lease.get("source") or "")),
    )


__all__ = ["EvidenceBinding", "EvidenceBindingError", "bind_frozen_evidence"]
