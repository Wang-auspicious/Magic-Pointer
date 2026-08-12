from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.replay.replayer import ReplayError, ReplayHarness
from app.replay.recorder import DesktopTraceRecorder
from app.replay.trace_schema import PointerSample, TraceFrame, UiaSnapshot


class FakeCaptureBackend:
    def __init__(self, color: tuple[int, int, int]) -> None:
        self.color = color

    def __call__(self, bbox_ltrb: tuple[int, int, int, int]):
        from PIL import Image

        return Image.new("RGB", (bbox_ltrb[2] - bbox_ltrb[0], bbox_ltrb[3] - bbox_ltrb[1]), self.color)


class FixedClock:
    def __init__(self) -> None:
        self.index = 0

    def __call__(self) -> str:
        self.index += 1
        return f"2026-08-12T10:00:{self.index:02d}.000000Z"


def _record_trace(
    tmp_path: Path, *, frames: int = 2, snapshots: int = 1, clock: FixedClock | None = None
) -> Path:
    trace_dir = tmp_path / "trace"
    recorder = DesktopTraceRecorder(trace_id="trace-replay-1", clock=clock or FixedClock())
    recorder.begin(trace_dir)
    backend = FakeCaptureBackend((0, 128, 255))
    for index in range(frames):
        recorder.capture_frame(backend=backend, region=(0, 0, 64 * (index + 1), 48))
    for index in range(snapshots):
        recorder.add_uia_snapshot(f"snapshot tree {index}", hwnd=100 + index, pid=200 + index)
    recorder.add_pointer_sample(10, 10, "down", 1, t_utc="2026-08-12T10:00:00.100000Z")
    recorder.add_pointer_sample(20, 20, "move", 1, t_utc="2026-08-12T10:00:00.200000Z")
    recorder.add_pointer_sample(30, 30, "up", 0, t_utc="2026-08-12T10:00:00.500000Z")
    recorder.set_ground_truth({"user_intent": "demo"})
    recorder.finish()
    return trace_dir


def test_load_valid_trace(tmp_path: Path) -> None:
    trace_dir = _record_trace(tmp_path)
    harness = ReplayHarness.load(trace_dir)
    assert harness.trace.trace_id == "trace-replay-1"
    assert harness.trace.schema_version == 1


def test_load_missing_trace_json_raises(tmp_path: Path) -> None:
    with pytest.raises(ReplayError, match="trace.json"):
        ReplayHarness.load(tmp_path / "does-not-exist")


def test_load_unsupported_schema_version_raises(tmp_path: Path) -> None:
    trace_dir = _record_trace(tmp_path)
    payload = json.loads((trace_dir / "trace.json").read_text(encoding="utf-8"))
    payload["schema_version"] = 99
    (trace_dir / "trace.json").write_text(json.dumps(payload), encoding="utf-8")
    with pytest.raises(ReplayError, match="schema_version"):
        ReplayHarness.load(trace_dir)


def test_frames_iterator_yields_all_frames_in_order(tmp_path: Path) -> None:
    harness = ReplayHarness.load(_record_trace(tmp_path))
    frames = list(harness.frames())
    assert len(frames) == 2
    assert isinstance(frames[0], TraceFrame)
    assert frames[0].display_bounds_ltrb == (0, 0, 64, 48)
    assert frames[1].display_bounds_ltrb == (0, 0, 128, 48)


def test_frames_iterator_raises_when_png_missing(tmp_path: Path) -> None:
    trace_dir = _record_trace(tmp_path)
    (trace_dir / "frames" / "frame-1.png").unlink()
    harness = ReplayHarness.load(trace_dir)
    with pytest.raises(ReplayError, match="frame-1.png"):
        list(harness.frames())


def test_uia_snapshots_iterator_raises_when_tree_file_missing(tmp_path: Path) -> None:
    trace_dir = _record_trace(tmp_path)
    (trace_dir / "uia" / "uia-1.txt").unlink()
    harness = ReplayHarness.load(trace_dir)
    with pytest.raises(ReplayError, match="uia-1.txt"):
        list(harness.uia_snapshots())


def test_uia_snapshots_iterator_accepts_inline_text(tmp_path: Path) -> None:
    trace_dir = _record_trace(tmp_path)
    payload = json.loads((trace_dir / "trace.json").read_text(encoding="utf-8"))
    payload["uia_snapshots"].append(
        {
            "snapshot_id": "uia-inline",
            "tree_text": "inline tree",
            "tree_path": None,
            "captured_at_utc": "2026-08-12T10:00:06.000000Z",
            "window_hwnd": 1,
            "pid": 2,
            "note": None,
        }
    )
    (trace_dir / "trace.json").write_text(json.dumps(payload), encoding="utf-8")
    harness = ReplayHarness.load(trace_dir)
    snapshots = list(harness.uia_snapshots())
    assert len(snapshots) == 2
    assert snapshots[1].tree_text == "inline tree"
    assert isinstance(snapshots[0], UiaSnapshot)


def test_pointer_samples_iterator(tmp_path: Path) -> None:
    harness = ReplayHarness.load(_record_trace(tmp_path))
    samples = list(harness.pointer_samples())
    assert [sample.phase for sample in samples] == ["down", "move", "up"]
    assert isinstance(samples[0], PointerSample)


def test_stats_counts(tmp_path: Path) -> None:
    harness = ReplayHarness.load(_record_trace(tmp_path))
    stats = harness.stats()
    assert stats["frames"] == 2
    assert stats["uia_snapshots"] == 1
    assert stats["pointer_samples"] == 3
    assert stats["cdp_snapshots"] == 0
    assert stats["focus_events"] == 0


def test_stats_duration_from_pointer_samples(tmp_path: Path) -> None:
    harness = ReplayHarness.load(_record_trace(tmp_path))
    assert harness.stats()["duration_seconds"] == pytest.approx(0.4)


def test_stats_duration_from_frames_when_no_pointer_samples(tmp_path: Path) -> None:
    trace_dir = tmp_path / "frames-only"
    recorder = DesktopTraceRecorder(trace_id="frames-only", clock=FixedClock())
    recorder.begin(trace_dir)
    backend = FakeCaptureBackend((0, 128, 255))
    recorder.capture_frame(backend=backend, region=(0, 0, 64, 48))
    recorder.capture_frame(backend=backend, region=(0, 0, 128, 48))
    recorder.finish()
    harness = ReplayHarness.load(trace_dir)
    assert harness.stats()["duration_seconds"] == pytest.approx(1.0)


def test_stats_empty_trace_is_zero(tmp_path: Path) -> None:
    trace_dir = tmp_path / "empty"
    recorder = DesktopTraceRecorder(trace_id="empty-trace")
    recorder.begin(trace_dir)
    recorder.finish()
    harness = ReplayHarness.load(trace_dir)
    stats = harness.stats()
    assert stats["frames"] == 0
    assert stats["uia_snapshots"] == 0
    assert stats["pointer_samples"] == 0
    assert stats["duration_seconds"] == 0.0


def test_readonly_timestamp_queries(tmp_path: Path) -> None:
    harness = ReplayHarness.load(_record_trace(tmp_path))
    assert harness.timestamp_of_first_frame() == "2026-08-12T10:00:02.000000Z"
    assert harness.timestamp_of_first_pointer_sample() == "2026-08-12T10:00:00.100000Z"
    assert harness.timestamp_of_last_pointer_sample() == "2026-08-12T10:00:00.500000Z"


def test_timestamp_queries_return_none_when_empty(tmp_path: Path) -> None:
    trace_dir = tmp_path / "empty"
    recorder = DesktopTraceRecorder(trace_id="empty-trace")
    recorder.begin(trace_dir)
    recorder.finish()
    harness = ReplayHarness.load(trace_dir)
    assert harness.timestamp_of_first_frame() is None
    assert harness.timestamp_of_first_pointer_sample() is None
    assert harness.timestamp_of_last_pointer_sample() is None
