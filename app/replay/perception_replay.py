"""Perception replay: a DesktopTrace becomes a selection-bridge payload (L12).

The replay base closes the loop: record a real interaction (or a
synthetic-but-schema-valid fixture) -> replay it into the perception chain
offline -> run selection_bridge -> assert the answer/proposals against the
trace's ground_truth. No live desktop is touched in replay mode.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from app.replay.trace_schema import DesktopTrace, UiaSnapshot

__all__ = [
    "load_trace",
    "trace_to_snapshot_payload",
    "expected_from_trace",
]

GROUND_TRUTH_KEY = "replay_expectation"


def load_trace(path: Path) -> DesktopTrace:
    with path.open("r", encoding="utf-8") as handle:
        data = json.load(handle)
    return DesktopTrace.from_dict(data)


def _uia_content(snapshots: list[UiaSnapshot]) -> tuple[str, str | None]:
    """tree_text of the last snapshot (falling back to tree_path); ('', None)
    when the trace has no UIA evidence."""
    for snapshot in reversed(snapshots):
        if snapshot.tree_text is not None:
            return snapshot.tree_text, None
        if snapshot.tree_path is not None:
            return "", snapshot.tree_path
    return "", None


def trace_to_snapshot_payload(trace: DesktopTrace) -> dict[str, Any]:
    """Build the selection_bridge input payload for one trace.

    The payload carries the trace's frozen frame as the capture (the FrameLease
    contract holds: replay never recaptures the screen) and the UIA tree as the
    structured context, so selection_bridge runs its normal chain — routing,
    guard preconditions (against replay data), answer — offline. The snapshot
    timestamps are stamped at replay time: a replay IS a fresh consumption of
    the frozen evidence, so the TTL gate must not reject it.
    """
    from datetime import datetime, timedelta, timezone

    now = datetime.now(timezone.utc)
    frame_paths = [frame.png_path for frame in trace.frames]
    capture_path = str(frame_paths[0]) if frame_paths else None
    content, tree_path = _uia_content(trace.uia_snapshots)
    pointer = trace.pointer_trace
    gesture_points = [
        {"x": sample.x, "y": sample.y, "t": 0} for sample in pointer if sample.phase in {"down", "move", "up"}
    ][:512]
    window_hwnd = (
        trace.uia_snapshots[0].window_hwnd if trace.uia_snapshots else None
    )
    focus = trace.focus_events[-1] if trace.focus_events else None
    ground_truth = trace.ground_truth or {}
    return {
        "command": str(ground_truth.get("command") or ""),
        "requestMode": "auto",
        "selectionSessionId": f"replay:{trace.trace_id}",
        "selectionSnapshot": {
            "snapshot_id": f"replay-{trace.trace_id}",
            "captured_at": now.isoformat(),
            "expires_at": (now + timedelta(seconds=600)).isoformat(),
            "status": "replay",
            "source_kind": "replay",
            "target_point": gesture_points[-1] if gesture_points else None,
            "target_point_space": "physical_screen_pixels",
            "source_window": {
                "hwnd": window_hwnd,
                "title": focus.title if focus else "replay",
                "process_name": focus.process_name if focus else "",
            },
            "context": {
                "adapter": "replay:uia",
                "app": "replay",
                "window": {"hwnd": window_hwnd},
                "content": content,
                "label": str(ground_truth.get("label") or "replay"),
                "method": "replay:uia",
                "artifacts": {
                    "replay_trace_id": trace.trace_id,
                    "replay_tree_path": tree_path,
                    "captured_rects_source": "replay",
                    "captured_rects": [],
                },
                "error": None,
            },
            "capture_path": capture_path,
            "annotated_path": None,
            "capture_attestation": {
                "status": "replay",
                "backend": "replay",
                "content_hash": str(ground_truth.get("content_hash") or "replay"),
                "overlay_excluded": True,
                "phase": "complete",
            },
            "perception_trace": {
                "schemaVersion": 1,
                "selectedLayer": "replay",
                "selectedAdapter": "trace",
                "selectedMethod": "fixture",
                "pixelFallbackUsed": False,
                "fallbackReason": None,
                "attempts": [{
                    "layer": "replay",
                    "adapter": "trace",
                    "method": "fixture",
                    "status": "ok",
                    "reason": trace.trace_id,
                }],
            },
            "frame_lease": None,
        },
        "selectionGesture": {"points": gesture_points},
        "replay": {"traceId": trace.trace_id, "path": str(trace.recorded_at_utc)},
    }


def expected_from_trace(trace: DesktopTrace) -> dict[str, Any]:
    """The ground-truth expectation carried inside the trace."""
    ground_truth = trace.ground_truth or {}
    expectation = ground_truth.get(GROUND_TRUTH_KEY)
    if isinstance(expectation, dict):
        return dict(expectation)
    return {}
