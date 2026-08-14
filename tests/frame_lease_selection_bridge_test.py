from __future__ import annotations

import hashlib
import time
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw

from app.adapters.base import AdapterReadContext
from scripts.bridge_progress import PhaseClock
from scripts.selection_snapshot_bridge import capture_snapshot

FROZEN_BBOX = [0, 0, 320, 200]


class _SlowAdapter:
    """Structured read that takes long enough that a late recapture would be
    visibly wrong (it would see the AFTER screen, not the frozen one)."""

    def __init__(self) -> None:
        self.calls = 0

    def read_context(self, window: dict[str, Any], **_kwargs) -> AdapterReadContext:
        self.calls += 1
        time.sleep(0.05)
        return AdapterReadContext(
            adapter="uia_text_selection",
            app="browser",
            window=window,
            method="uia:text-pattern.selection",
            capabilities=[],
            error="slow probe timed out",
        )


class _SlowRegistry:
    def __init__(self) -> None:
        self.adapter = _SlowAdapter()

    def matching_adapter(self, _window):
        return self.adapter


class _EmptyRegistry:
    def matching_adapter(self, _window):
        return None


def _write_text_image(path: Path, text: str, size: tuple[int, int] = (320, 200)) -> Image.Image:
    image = Image.new("RGB", size, "white")
    draw = ImageDraw.Draw(image)
    draw.text((10, 10), text, fill="black")
    image.save(path)
    return image


def _fake_late_capture(images: list[Image.Image]):
    calls: list[list[int]] = []

    def capture(bbox, all_screens: bool = True):
        calls.append(list(bbox))
        return images[min(len(calls) - 1, len(images) - 1)]

    return calls, capture


def _lease_for(path: Path, *, content_hash: str | None = None) -> dict[str, Any]:
    with Image.open(path) as probe:
        width, height = probe.size
    actual_hash = content_hash if content_hash is not None else (
        "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()
    )
    return {
        "schemaVersion": 1,
        "frameLeaseId": "frame-1",
        "epochId": "epoch-1",
        "capturedAtMonotonicMs": 1250.5,
        "capturedAtUtc": "2026-08-11T00:00:00.000Z",
        "source": "gdi-fallback",
        "targetWindow": {"hwnd": 42, "processId": 7, "processName": "demo.exe", "title": "Demo"},
        "surfaceBoundsPx": list(FROZEN_BBOX),
        "displayId": "display-1",
        "scaleFactor": 1,
        "gesture": {"coordinateSpace": "physical_screen_pixels", "strokes": []},
        "localArtifact": {
            "path": str(path),
            "mimeType": "image/png",
            "width": width,
            "height": height,
        },
        "contentHash": actual_hash,
        "overlayExcluded": True,
        "captureLatencyMs": 12.5,
    }


def _gesture() -> dict[str, Any]:
    return {
        "schemaVersion": 2,
        "coordinateSpace": "physical_screen_pixels",
        "strokes": [{
            "points": [
                {"x": 100, "y": 60, "t": 0},
                {"x": 220, "y": 140, "t": 50},
            ],
        }],
        "bbox": {"x": 100, "y": 60, "width": 120, "height": 80},
    }


def test_bridge_consumes_the_frozen_frame_without_recapture(tmp_path: Path) -> None:
    frozen_path = tmp_path / "frozen.png"
    _write_text_image(frozen_path, "BEFORE")
    after_path = tmp_path / "after.png"
    late_calls, late_capture = _fake_late_capture([_write_text_image(after_path, "AFTER")])
    registry = _SlowRegistry()
    clock = PhaseClock("selection_snapshot", enabled=False)
    lease = _lease_for(frozen_path)

    result = capture_snapshot(
        [{
            "title": "Demo",
            "hwnd": 42,
            "pid": 7,
            "process_name": "demo.exe",
            "supported": True,
            "bbox": list(FROZEN_BBOX),
        }],
        registry=registry,
        target_point={"x": 160, "y": 100},
        gesture=_gesture(),
        visual_capture=late_capture,
        capture_dir=tmp_path / "captures",
        clock=clock,
        frame_lease=lease,
    )

    snapshot = result["selectionSnapshot"]
    assert result["ok"] is True
    # The committed artifact is the sole visual evidence.
    assert snapshot["capture_path"] == str(frozen_path.resolve())
    assert snapshot["annotated_path"] is None
    # Full-surface bounds come from the lease, not from a fresh grab.
    assert snapshot["capture_bbox"] == FROZEN_BBOX
    assert snapshot["frame_lease"]["frameLeaseId"] == "frame-1"
    # The fake late capture was never consulted.
    assert late_calls == []
    # Pixels are attested frozen before the structured read starts.
    marks = [name for name, _ms in clock._marks]
    assert marks.index("pixels_frozen") < marks.index("structured_read")
    # Backend stays honestly gdi-fallback instead of being relabeled.
    assert snapshot["capture_attestation"]["backend"] == "gdi-fallback"
    assert snapshot["capture_attestation"]["status"] == "frame_lease"
    assert snapshot["capture_attestation"]["binding_status"] == "verified"
    assert snapshot["capture_attestation"]["capture_kind"] == "fallback"
    assert snapshot["capture_attestation"]["target"] == {
        "hwnd": 42,
        "processId": 7,
        "processName": "demo.exe",
        "title": "Demo",
    }
    assert snapshot["capture_attestation"]["surface_bounds_px"] == FROZEN_BBOX
    # Gesture selection bbox stays separate from the full-surface bbox.
    assert snapshot["selection_bbox"] == [100, 60, 120, 80]
    assert snapshot["capture_bbox"] != snapshot["selection_bbox"]
    assert snapshot["source_kind"] == "screen_region"


def test_frozen_lease_target_mismatch_fails_before_perception(tmp_path: Path) -> None:
    frozen_path = tmp_path / "frozen.png"
    _write_text_image(frozen_path, "BEFORE")
    late_calls, late_capture = _fake_late_capture(
        [Image.new("RGB", (320, 200), "red")]
    )
    registry = _SlowRegistry()

    result = capture_snapshot(
        [{
            "title": "Wrong",
            "hwnd": 99,
            "pid": 8,
            "process_name": "other.exe",
            "supported": True,
            "bbox": list(FROZEN_BBOX),
        }],
        registry=registry,
        target_point={"x": 160, "y": 100},
        gesture=_gesture(),
        visual_capture=late_capture,
        capture_dir=tmp_path / "captures",
        clock=PhaseClock("selection_snapshot", enabled=False),
        frame_lease=_lease_for(frozen_path),
    )

    snapshot = result["selectionSnapshot"]
    assert result["ok"] is False
    assert result["error"] == "invalid_frame_lease"
    assert snapshot["status"] == "invalid_frame_lease"
    assert snapshot["structured_gap_reason"] == (
        "invalid_frame_lease:target_hwnd_mismatch"
    )
    assert registry.adapter.calls == 0
    assert late_calls == []


def test_invalid_lease_fails_closed_without_recapture(tmp_path: Path) -> None:
    late_calls, late_capture = _fake_late_capture([Image.new("RGB", (320, 200), "red")])
    result = capture_snapshot(
        [{"title": "Demo", "hwnd": 42, "supported": True}],
        target_point={"x": 10, "y": 10},
        visual_capture=late_capture,
        capture_dir=tmp_path / "captures",
        clock=PhaseClock("selection_snapshot", enabled=False),
        frame_lease={"schemaVersion": 1, "frameLeaseId": "x"},
    )
    assert result["ok"] is False
    assert result["error"] == "invalid_frame_lease"
    assert result["selectionSnapshot"]["status"] == "invalid_frame_lease"
    assert late_calls == []


def test_gesture_without_lease_fails_closed_without_recapture(tmp_path: Path) -> None:
    """A completed-gesture snapshot without a FrameLease must not grab the
    live screen: post-gesture pixels are not the frozen evidence (bridge
    audit P1)."""
    late_calls, late_capture = _fake_late_capture([Image.new("RGB", (320, 200), "red")])
    result = capture_snapshot(
        [{"title": "Demo", "hwnd": 42, "supported": True}],
        registry=_EmptyRegistry(),
        target_point={"x": 160, "y": 100},
        gesture=_gesture(),
        visual_capture=late_capture,
        capture_dir=tmp_path / "captures",
        clock=PhaseClock("selection_snapshot", enabled=False),
        frame_lease=None,
    )
    assert result["ok"] is False
    assert result["error"] == "invalid_frame_lease"
    snapshot = result["selectionSnapshot"]
    assert snapshot["status"] == "invalid_frame_lease"
    assert snapshot["structured_gap_reason"] == (
        "invalid_frame_lease:missing_frame_lease"
    )
    assert late_calls == []


def test_tampered_artifact_fails_closed(tmp_path: Path) -> None:
    frozen_path = tmp_path / "frozen.png"
    _write_text_image(frozen_path, "BEFORE")
    lease = _lease_for(frozen_path, content_hash="sha256:" + "0" * 64)
    late_calls, late_capture = _fake_late_capture([Image.new("RGB", (320, 200), "red")])
    result = capture_snapshot(
        [{"title": "Demo", "hwnd": 42, "supported": True}],
        target_point={"x": 10, "y": 10},
        visual_capture=late_capture,
        clock=PhaseClock("selection_snapshot", enabled=False),
        frame_lease=lease,
    )
    assert result["ok"] is False
    assert result["error"] == "invalid_frame_lease"
    assert late_calls == []


def test_missing_artifact_fails_closed(tmp_path: Path) -> None:
    frozen_path = tmp_path / "frozen.png"
    _write_text_image(frozen_path, "BEFORE")
    lease = _lease_for(frozen_path)
    lease["localArtifact"]["path"] = str(tmp_path / "missing.png")
    late_calls, late_capture = _fake_late_capture([Image.new("RGB", (320, 200), "red")])
    result = capture_snapshot(
        [{"title": "Demo", "hwnd": 42, "supported": True}],
        target_point={"x": 10, "y": 10},
        visual_capture=late_capture,
        clock=PhaseClock("selection_snapshot", enabled=False),
        frame_lease=lease,
    )
    assert result["ok"] is False
    assert result["error"] == "invalid_frame_lease"
    assert late_calls == []


def test_dimension_mismatch_fails_closed(tmp_path: Path) -> None:
    frozen_path = tmp_path / "frozen.png"
    _write_text_image(frozen_path, "BEFORE", size=(320, 200))
    lease = _lease_for(frozen_path)
    lease["localArtifact"]["width"] = 999
    late_calls, late_capture = _fake_late_capture([Image.new("RGB", (320, 200), "red")])
    result = capture_snapshot(
        [{"title": "Demo", "hwnd": 42, "supported": True}],
        target_point={"x": 10, "y": 10},
        visual_capture=late_capture,
        clock=PhaseClock("selection_snapshot", enabled=False),
        frame_lease=lease,
    )
    assert result["ok"] is False
    assert result["error"] == "invalid_frame_lease"
    assert late_calls == []
