"""Python side of the FrameLease v1 contract.

Mirrors ``electron/frame_lease.ts`` field-for-field so a lease produced by the
resident capture worker is accepted by Electron and a lease forwarded by
Electron is consumed by the selection bridge without reinterpretation. The
validators must stay in lock-step: same required fields, same accepted sources,
same geometry rules, same fail-fast message style.
"""

from __future__ import annotations

import math
from typing import Any

ALLOWED_SOURCES = frozenset({
    "wgc-window",
    "wgc-display",
    "dxgi-display",
    "gdi-fallback",
    "test",
})

REQUIRED_FIELDS = (
    "frameLeaseId",
    "epochId",
    "capturedAtMonotonicMs",
    "capturedAtUtc",
    "source",
    "targetWindow",
    "surfaceBoundsPx",
    "displayId",
    "scaleFactor",
    "gesture",
    "localArtifact",
    "contentHash",
    "overlayExcluded",
    "captureLatencyMs",
)


class FrameLeaseError(ValueError):
    """A FrameLease that fails validation. Callers fail closed, never recapture."""


def _blank(value: Any) -> bool:
    if value is None:
        return True
    if isinstance(value, str):
        return not value.strip()
    if isinstance(value, bool):
        return False
    if isinstance(value, (int, float)):
        return not math.isfinite(float(value))
    if isinstance(value, (list, tuple)):
        return len(value) == 0
    return not isinstance(value, dict)


def _require_string(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise FrameLeaseError(f"{field} must be a non-empty string")
    return value


def _require_number(value: Any, field: str) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise FrameLeaseError(f"{field} must be a finite non-negative number") from None
    if not math.isfinite(number) or number < 0:
        raise FrameLeaseError(f"{field} must be a finite non-negative number")
    return number


def _window_identity(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise FrameLeaseError("targetWindow must be an object")
    return {
        "hwnd": int(_require_number(value.get("hwnd"), "targetWindow.hwnd")),
        "processId": int(_require_number(value.get("processId"), "targetWindow.processId")),
        "processName": _require_string(value.get("processName"), "targetWindow.processName"),
        "title": str(value.get("title") or ""),
    }


def _surface_bounds(value: Any) -> list[int]:
    if not isinstance(value, (list, tuple)) or len(value) != 4:
        raise FrameLeaseError("surfaceBoundsPx must be [left, top, right, bottom]")
    try:
        numbers = [float(entry) for entry in value]
    except (TypeError, ValueError):
        raise FrameLeaseError("surfaceBoundsPx must contain finite numbers") from None
    if not all(math.isfinite(entry) for entry in numbers):
        raise FrameLeaseError("surfaceBoundsPx must contain finite numbers")
    left, top, right, bottom = (int(entry) for entry in numbers)
    if right - left <= 0 or bottom - top <= 0:
        raise FrameLeaseError("surfaceBoundsPx must have positive area")
    return [left, top, right, bottom]


def _artifact(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise FrameLeaseError("localArtifact must be an object")
    width = _require_number(value.get("width"), "localArtifact.width")
    height = _require_number(value.get("height"), "localArtifact.height")
    if width <= 0 or height <= 0:
        raise FrameLeaseError("localArtifact.width/height must be positive")
    return {
        "path": _require_string(value.get("path"), "localArtifact.path"),
        "mimeType": _require_string(value.get("mimeType"), "localArtifact.mimeType"),
        "width": int(width),
        "height": int(height),
    }


def normalize_frame_lease(value: Any) -> dict[str, Any]:
    """Validate and copy a raw FrameLease payload.

    Returns a brand-new dictionary; the input is never mutated. Raises
    ``FrameLeaseError`` with the offending field named in the message.
    """
    if not isinstance(value, dict):
        raise FrameLeaseError("frameLease must be an object")
    if value.get("schemaVersion") != 1:
        raise FrameLeaseError("schemaVersion must be 1")
    missing = [field for field in REQUIRED_FIELDS if _blank(value.get(field))]
    if missing:
        raise FrameLeaseError(f"missing frame lease field(s): {', '.join(missing)}")
    source = _require_string(value.get("source"), "source")
    if source not in ALLOWED_SOURCES:
        raise FrameLeaseError(f"source must be one of {'|'.join(sorted(ALLOWED_SOURCES))}")
    scale_factor = _require_number(value.get("scaleFactor"), "scaleFactor")
    if scale_factor <= 0:
        raise FrameLeaseError("scaleFactor must be positive")
    gesture = value.get("gesture")
    if not isinstance(gesture, dict):
        raise FrameLeaseError("gesture must be an object")
    return {
        "schemaVersion": 1,
        "frameLeaseId": _require_string(value.get("frameLeaseId"), "frameLeaseId"),
        "epochId": _require_string(value.get("epochId"), "epochId"),
        "capturedAtMonotonicMs": _require_number(
            value.get("capturedAtMonotonicMs"), "capturedAtMonotonicMs"
        ),
        "capturedAtUtc": _require_string(value.get("capturedAtUtc"), "capturedAtUtc"),
        "source": source,
        "targetWindow": _window_identity(value.get("targetWindow")),
        "surfaceBoundsPx": _surface_bounds(value.get("surfaceBoundsPx")),
        "displayId": _require_string(value.get("displayId"), "displayId"),
        "scaleFactor": scale_factor,
        "gesture": dict(gesture),
        "localArtifact": _artifact(value.get("localArtifact")),
        "contentHash": _require_string(value.get("contentHash"), "contentHash"),
        "overlayExcluded": value.get("overlayExcluded") is True,
        "captureLatencyMs": _require_number(value.get("captureLatencyMs"), "captureLatencyMs"),
    }
