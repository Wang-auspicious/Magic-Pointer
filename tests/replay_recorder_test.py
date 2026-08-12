from __future__ import annotations

import json
from pathlib import Path

import pytest
from PIL import Image

from app.replay.recorder import DesktopTraceRecorder
from app.replay.trace_schema import DesktopTrace, PointerSample, TraceFrame


class FakeCaptureBackend:
    def __init__(self, colors: list[tuple[int, int, int]]) -> None:
        self.colors = list(colors)
        self.count = 0

    def __call__(self, bbox_ltrb: tuple[int, int, int, int]) -> Image.Image:
        color = self.colors[min(self.count, len(self.colors) - 1)]
        self.count += 1
        return Image.new(
            "RGB",
            (bbox_ltrb[2] - bbox_ltrb[0], bbox_ltrb[3] - bbox_ltrb[1]),
            color,
        )


class FakeClock:
    def __init__(self) -> None:
        self.index = 0

    def __call__(self) -> str:
        self.index += 1
        return f"2026-08-12T10:00:{self.index:02d}.000000Z"


def _make_recorder(tmp_path: Path, clock: FakeClock | None = None) -> DesktopTraceRecorder:
    recorder = DesktopTraceRecorder(trace_id="trace-test-1", clock=clock or FakeClock())
    recorder.begin(tmp_path / "trace")
    return recorder


def test_begin_creates_directory_structure(tmp_path: Path) -> None:
    trace_dir = tmp_path / "trace"
    recorder = DesktopTraceRecorder(trace_id="trace-test-1", clock=FakeClock())
    recorder.begin(trace_dir)
    assert (trace_dir / "frames").is_dir()
    assert (trace_dir / "uia").is_dir()
    assert (trace_dir / "cdp").is_dir()


def test_capture_frame_with_fake_backend_saves_png(tmp_path: Path) -> None:
    recorder = _make_recorder(tmp_path)
    backend = FakeCaptureBackend(colors=[(255, 0, 0)])
    recorder.capture_frame(backend=backend, region=(0, 0, 320, 200))
    assert backend.count == 1
    trace = recorder.finish()
    assert len(trace.frames) == 1
    frame = trace.frames[0]
    assert isinstance(frame, TraceFrame)
    assert frame.display_bounds_ltrb == (0, 0, 320, 200)
    assert frame.dpi is None
    assert frame.scale_factor is None
    png = tmp_path / "trace" / frame.png_path
    assert png.is_file()
    with Image.open(png) as image:
        assert image.size == (320, 200)
        assert image.getpixel((0, 0)) == (255, 0, 0)


def test_capture_frame_records_explicit_dpi_and_scale(tmp_path: Path) -> None:
    recorder = _make_recorder(tmp_path)
    backend = FakeCaptureBackend(colors=[(0, 0, 255)])
    recorder.capture_frame(backend=backend, region=(0, 0, 640, 400), dpi=192.0, scale_factor=2.0)
    frame = recorder.finish().frames[0]
    assert frame.dpi == 192.0
    assert frame.scale_factor == 2.0


def test_capture_frame_without_backend_is_noop(tmp_path: Path) -> None:
    recorder = _make_recorder(tmp_path)
    recorder.capture_frame()
    trace = recorder.finish()
    assert trace.frames == []
    assert list((tmp_path / "trace" / "frames").iterdir()) == []


def test_capture_frame_backend_without_region_raises(tmp_path: Path) -> None:
    recorder = _make_recorder(tmp_path)
    backend = FakeCaptureBackend(colors=[(0, 0, 255)])
    with pytest.raises(ValueError, match="region"):
        recorder.capture_frame(backend=backend)


def test_pointer_samples_round_trip(tmp_path: Path) -> None:
    clock = FakeClock()
    recorder = _make_recorder(tmp_path, clock=clock)
    recorder.add_pointer_sample(100, 200, "down", 1)
    recorder.add_pointer_sample(150, 250, "move", 1)
    recorder.add_pointer_sample(160, 260, "up", 0)
    trace = recorder.finish()
    assert trace.pointer_trace == [
        PointerSample(t_utc="2026-08-12T10:00:02.000000Z", x=100, y=200, phase="down", buttons=1),
        PointerSample(t_utc="2026-08-12T10:00:03.000000Z", x=150, y=250, phase="move", buttons=1),
        PointerSample(t_utc="2026-08-12T10:00:04.000000Z", x=160, y=260, phase="up", buttons=0),
    ]


def test_pointer_sample_explicit_timestamp(tmp_path: Path) -> None:
    recorder = _make_recorder(tmp_path)
    recorder.add_pointer_sample(1, 2, "down", 1, t_utc="2026-08-12T09:00:00.000000Z")
    trace = recorder.finish()
    assert trace.pointer_trace[0].t_utc == "2026-08-12T09:00:00.000000Z"


def test_pointer_sample_invalid_phase_rejected(tmp_path: Path) -> None:
    recorder = _make_recorder(tmp_path)
    with pytest.raises(ValueError, match="phase"):
        recorder.add_pointer_sample(1, 2, "click", 1)


def test_pointer_sample_negative_buttons_rejected(tmp_path: Path) -> None:
    recorder = _make_recorder(tmp_path)
    with pytest.raises(ValueError, match="buttons"):
        recorder.add_pointer_sample(1, 2, "down", -1)


def test_uia_snapshot_ids_are_independent_of_frame_counter(tmp_path: Path) -> None:
    recorder = _make_recorder(tmp_path)
    backend = FakeCaptureBackend(colors=[(1, 2, 3)])
    recorder.capture_frame(backend=backend, region=(0, 0, 10, 10))
    recorder.add_uia_snapshot("tree")
    trace = recorder.finish()
    assert trace.frames[0].frame_id == "frame-1"
    assert trace.uia_snapshots[0].snapshot_id == "uia-1"
    assert trace.uia_snapshots[0].tree_path == "uia/uia-1.txt"


def test_uia_snapshot_writes_file(tmp_path: Path) -> None:
    recorder = _make_recorder(tmp_path)
    recorder.add_uia_snapshot("Window 'Notepad'\n  Edit ''", hwnd=98765, pid=1234)
    trace = recorder.finish()
    assert len(trace.uia_snapshots) == 1
    snapshot = trace.uia_snapshots[0]
    assert snapshot.window_hwnd == 98765
    assert snapshot.pid == 1234
    assert snapshot.tree_text is None
    path = tmp_path / "trace" / snapshot.tree_path
    assert path.read_text(encoding="utf-8") == "Window 'Notepad'\n  Edit ''"


def test_focus_events_and_ground_truth(tmp_path: Path) -> None:
    recorder = _make_recorder(tmp_path)
    recorder.add_focus_event(98765, "Untitled - Notepad", "notepad.exe")
    recorder.set_ground_truth({"user_intent": "圈中第二行", "expected_result": "Hello"})
    trace = recorder.finish()
    assert len(trace.focus_events) == 1
    assert trace.focus_events[0].hwnd == 98765
    assert trace.focus_events[0].title == "Untitled - Notepad"
    assert trace.focus_events[0].process_name == "notepad.exe"
    assert trace.ground_truth == {"user_intent": "圈中第二行", "expected_result": "Hello"}


def test_finish_writes_trace_json_that_round_trips(tmp_path: Path) -> None:
    recorder = _make_recorder(tmp_path)
    recorder.add_pointer_sample(10, 20, "down", 1)
    returned = recorder.finish()
    trace_path = tmp_path / "trace" / "trace.json"
    assert trace_path.is_file()
    payload = json.loads(trace_path.read_text(encoding="utf-8"))
    assert payload["schema_version"] == 1
    assert DesktopTrace.from_dict(payload) == returned


def test_methods_without_begin_raise_runtime_error(tmp_path: Path) -> None:
    recorder = DesktopTraceRecorder(trace_id="never-started")
    backend = FakeCaptureBackend(colors=[(1, 2, 3)])
    for call in [
        lambda: recorder.capture_frame(),
        lambda: recorder.capture_frame(backend=backend, region=(0, 0, 10, 10)),
        lambda: recorder.add_pointer_sample(1, 2, "down", 1),
        lambda: recorder.add_uia_snapshot("tree"),
        lambda: recorder.add_focus_event(1, "t", "p"),
        lambda: recorder.set_ground_truth({"k": 1}),
        recorder.finish,
    ]:
        with pytest.raises(RuntimeError, match="begin"):
            call()


def test_trace_id_default_is_generated(tmp_path: Path) -> None:
    recorder = DesktopTraceRecorder(clock=FakeClock())
    recorder.begin(tmp_path / "trace")
    assert recorder.finish().trace_id


def test_clock_controls_recorded_at(tmp_path: Path) -> None:
    clock = FakeClock()
    recorder = DesktopTraceRecorder(trace_id="t", clock=clock)
    recorder.begin(tmp_path / "trace")
    assert recorder.started_at_utc == "2026-08-12T10:00:01.000000Z"
    trace = recorder.finish()
    assert trace.recorded_at_utc == "2026-08-12T10:00:01.000000Z"
