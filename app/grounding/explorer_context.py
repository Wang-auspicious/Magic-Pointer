from __future__ import annotations

import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app.adapters.base import AdapterReadContext
from app.grounding.explorer_adapter import ExplorerFileGrounder, is_explorer_window
from app.grounding.schema import PointerSelection

JsonDict = dict[str, Any]


def _gesture_points(gesture: JsonDict | None) -> list[tuple[int, int]]:
    strokes = gesture.get("strokes") if isinstance(gesture, dict) else []
    return [
        (int(point["x"]), int(point["y"]))
        for stroke in list(strokes or [])
        if isinstance(stroke, dict)
        for point in list(stroke.get("points") or [])
        if isinstance(point, dict) and "x" in point and "y" in point
    ]


def _mark_bbox(gesture: JsonDict | None) -> list[int] | None:
    raw = dict((gesture or {}).get("bbox") or {})
    try:
        x = int(raw.get("x") or 0)
        y = int(raw.get("y") or 0)
        width = max(0, int(raw.get("width") or 0))
        height = max(0, int(raw.get("height") or 0))
    except (TypeError, ValueError):
        return None
    if width <= 0 and height <= 0:
        return None
    if width <= 0:
        x -= 4
        width = 8
    if height <= 0:
        y -= 4
        height = 8
    return [x, y, width, height]


def read_explorer_file_context(
    windows: list[JsonDict],
    *,
    gesture: JsonDict | None,
    fallback_point: dict[str, int] | None,
) -> tuple[AdapterReadContext | None, JsonDict | None, JsonDict | None]:
    """Freeze one user-grounded Explorer object without reading its contents.

    The absolute path comes only from Explorer COM/UIA/PowerShell grounding.
    Content ingestion happens later, after the user's command says what to do.
    """

    target_window = windows[0] if windows else None
    if target_window is None or not is_explorer_window(target_window):
        return None, None, None
    mark = _mark_bbox(gesture)
    semantic = dict((gesture or {}).get("semanticPoint") or {})
    release = dict((gesture or {}).get("releasePoint") or {})
    point_source = semantic or release or dict(fallback_point or {})
    try:
        point = (int(point_source["x"]), int(point_source["y"]))
    except (KeyError, TypeError, ValueError):
        return None, None, None
    bbox = None if mark is None else (mark[0], mark[1], mark[0] + mark[2], mark[1] + mark[3])
    selection = PointerSelection(
        id=f"explorer-selection-{uuid.uuid4().hex[:12]}",
        point=point,
        bbox=bbox,
        selected_at=datetime.now(timezone.utc).isoformat(),
        source="gesture",
    )
    try:
        bundle = ExplorerFileGrounder().ground(
            selection,
            windows=windows,
            stroke_points=_gesture_points(gesture),
            row_candidates=[],
        )
    except Exception:
        return None, None, None
    primary = bundle.primary
    path = str((primary.metadata or {}).get("path") or "") if primary is not None else ""
    if primary is None or not path:
        return None, bundle.to_dict(), None
    local_file = {
        **dict(primary.metadata or {}),
        "path": path,
        "kind": primary.kind,
        "label": primary.label,
        "confidence": primary.confidence,
    }
    method = str(local_file.get("source") or "explorer:grounded-file")
    context = AdapterReadContext(
        adapter="explorer_file",
        app="explorer",
        window=dict(target_window),
        content=path,
        label=str(primary.label or Path(path).name),
        method=method,
        artifacts={
            "path": path,
            "local_file": local_file,
            "selection_rectangles": [mark] if mark is not None else [],
            "selection_rectangles_format": "xywh",
            "selection_rectangles_coordinate_space": "physical_screen_pixels",
        },
    )
    trace = {
        "schemaVersion": 1,
        "selectedLayer": "explorer",
        "selectedAdapter": "explorer_file",
        "selectedMethod": method,
        "pixelFallbackUsed": False,
        "fallbackReason": None,
        "policyMode": None,
        "attempts": [{
            "layer": "explorer",
            "adapter": "explorer_file",
            "method": method,
            "status": "success",
            "reason": "gesture_grounded_local_file",
        }],
    }
    return context, bundle.to_dict(), trace
