from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any

from PIL import Image

from scripts.frame_capture_worker import FrameCaptureService, initialize_capture_process


class FakeCaptureBackend:
    """Deterministic backend: returns one solid color per call, never the desktop."""

    source = "test"

    def __init__(self, colors: list[tuple[int, int, int]]) -> None:
        self.colors = list(colors)
        self.count = 0

    def capture(self, bbox_ltrb: tuple[int, int, int, int]) -> Image.Image:
        color = self.colors[min(self.count, len(self.colors) - 1)]
        self.count += 1
        return Image.new(
            "RGB",
            (bbox_ltrb[2] - bbox_ltrb[0], bbox_ltrb[3] - bbox_ltrb[1]),
            color,
        )


class GatedCaptureBackend:
    """Blocks inside capture until released, simulating a slow grab."""

    source = "test"

    def __init__(self) -> None:
        self.started = threading.Event()
        self.release = threading.Event()
        self.count = 0

    def capture(self, bbox_ltrb: tuple[int, int, int, int]) -> Image.Image:
        self.count += 1
        self.started.set()
        self.release.wait(timeout=5.0)
        return Image.new(
            "RGB",
            (bbox_ltrb[2] - bbox_ltrb[0], bbox_ltrb[3] - bbox_ltrb[1]),
            (0, 128, 0),
        )


class FakeClock:
    def __init__(self) -> None:
        self.now = 1000.0

    def monotonic(self) -> float:
        self.now += 100.0
        return self.now

    def utc_iso(self) -> str:
        return "2026-08-11T00:00:00.000Z"


def _arm_params() -> dict[str, Any]:
    return {
        "epochId": "epoch-1",
        "displayId": "display-1",
        "scaleFactor": 1.0,
        "surfaceBoundsPx": [0, 0, 320, 200],
        "targetWindow": {"hwnd": 42, "processId": 7, "processName": "demo.exe", "title": "Demo"},
        "overlayExcluded": True,
    }


def _commit_params() -> dict[str, Any]:
    return {
        "epochId": "epoch-1",
        "gesture": {"coordinateSpace": "physical_screen_pixels", "strokes": []},
    }


def _make_service(tmp_path: Path, backend: FakeCaptureBackend) -> FrameCaptureService:
    return FrameCaptureService(
        backend=backend,
        output_root=tmp_path,
        clock=FakeClock(),
        capture_interval_ms=0,
    )


def test_capture_process_enables_dpi_before_backend_creation() -> None:
    calls: list[str] = []

    backend = initialize_capture_process(
        enable_dpi=lambda: calls.append("dpi"),
        create_backend=lambda: calls.append("backend")
        or FakeCaptureBackend(colors=[(0, 0, 0)]),
    )

    assert calls == ["dpi", "backend"]
    assert isinstance(backend, FakeCaptureBackend)


def test_commit_returns_the_latest_frame_captured_before_commit(tmp_path: Path) -> None:
    backend = FakeCaptureBackend(colors=[(255, 0, 0), (0, 128, 0), (0, 0, 255)])
    worker = _make_service(tmp_path, backend)
    worker.handle({"id": "1", "method": "arm", "params": _arm_params()})
    assert worker.capture_once_for_test() is True
    assert worker.capture_once_for_test() is True
    result = worker.handle({"id": "2", "method": "commit", "params": _commit_params()})
    assert result["id"] == "2"
    assert result["result"]["source"] == "test"
    assert Image.open(result["result"]["localArtifact"]["path"]).getpixel((0, 0)) == (0, 128, 0)


def test_commit_before_arm_returns_epoch_not_armed(tmp_path: Path) -> None:
    worker = _make_service(tmp_path, FakeCaptureBackend(colors=[(0, 0, 0)]))
    result = worker.handle({"id": "1", "method": "commit", "params": _commit_params()})
    assert result["error"]["code"] == "epoch_not_armed"


def test_stale_epoch_cannot_commit_another_epoch(tmp_path: Path) -> None:
    worker = _make_service(tmp_path, FakeCaptureBackend(colors=[(0, 128, 0)]))
    worker.handle({"id": "1", "method": "arm", "params": _arm_params()})
    worker.capture_once_for_test()
    result = worker.handle({
        "id": "2",
        "method": "commit",
        "params": {"epochId": "epoch-old", "gesture": {}},
    })
    assert result["error"]["code"] == "epoch_mismatch"


def test_cancel_releases_all_buffered_images(tmp_path: Path) -> None:
    backend = FakeCaptureBackend(colors=[(0, 128, 0)])
    worker = _make_service(tmp_path, backend)
    worker.handle({"id": "1", "method": "arm", "params": _arm_params()})
    assert worker.capture_once_for_test() is True
    assert worker.ring_len_for_test() == 1
    result = worker.handle({"id": "2", "method": "cancel", "params": {"epochId": "epoch-1"}})
    assert result["result"]["cancelled"] is True
    assert worker.ring_len_for_test() == 0
    assert worker.capture_once_for_test() is False
    commit = worker.handle({"id": "3", "method": "commit", "params": _commit_params()})
    assert commit["error"]["code"] == "epoch_not_armed"


def test_ring_size_is_bounded(tmp_path: Path) -> None:
    backend = FakeCaptureBackend(colors=[(0, 128, 0)] * 10)
    worker = FrameCaptureService(
        backend=backend,
        output_root=tmp_path,
        clock=FakeClock(),
        capture_interval_ms=0,
        ring_size=3,
    )
    worker.handle({"id": "1", "method": "arm", "params": _arm_params()})
    for _ in range(5):
        assert worker.capture_once_for_test() is True
    assert worker.ring_len_for_test() == 3


def test_commit_persists_exactly_one_immutable_artifact(tmp_path: Path) -> None:
    backend = FakeCaptureBackend(colors=[(255, 0, 0), (0, 128, 0)])
    worker = _make_service(tmp_path, backend)
    worker.handle({"id": "1", "method": "arm", "params": _arm_params()})
    worker.capture_once_for_test()
    worker.capture_once_for_test()
    result = worker.handle({"id": "2", "method": "commit", "params": _commit_params()})
    lease = result["result"]
    artifacts = list((tmp_path / "frame-leases").glob("*.png"))
    assert len(artifacts) == 1
    assert Path(lease["localArtifact"]["path"]) == artifacts[0]
    assert lease["localArtifact"]["width"] == 320
    assert lease["localArtifact"]["height"] == 200
    assert lease["contentHash"].startswith("sha256:")
    assert lease["overlayExcluded"] == (os.name == "nt")
    assert lease["schemaVersion"] == 1
    assert lease["captureLatencyMs"] >= 0
    assert Image.open(artifacts[0]).getpixel((0, 0)) == (0, 128, 0)
    # The committed frame is immutable: the ring is detached and a later capture
    # is refused instead of appending to the same epoch.
    assert worker.capture_once_for_test() is False
    assert list((tmp_path / "frame-leases").glob("*.png")) == artifacts


def test_idle_worker_performs_no_captures(tmp_path: Path) -> None:
    backend = FakeCaptureBackend(colors=[(0, 128, 0)])
    worker = _make_service(tmp_path, backend)
    assert worker.capture_once_for_test() is False
    assert backend.count == 0
    result = worker.handle({"id": "1", "method": "ping"})
    assert result["result"]["pong"] is True
    assert backend.count == 0


def test_armed_background_thread_captures_and_stops_on_cancel(tmp_path: Path) -> None:
    backend = FakeCaptureBackend(colors=[(0, 128, 0)])
    worker = FrameCaptureService(
        backend=backend,
        output_root=tmp_path,
        clock=FakeClock(),
        capture_interval_ms=10,
        ring_size=3,
    )
    worker.handle({"id": "1", "method": "arm", "params": _arm_params()})
    deadline = time.monotonic() + 1.0
    while worker.ring_len_for_test() < 2 and time.monotonic() < deadline:
        time.sleep(0.005)
    assert worker.ring_len_for_test() >= 2
    result = worker.handle({"id": "2", "method": "cancel", "params": {"epochId": "epoch-1"}})
    assert result["result"]["cancelled"] is True
    count_after_cancel = backend.count
    time.sleep(0.05)
    assert backend.count == count_after_cancel


def test_in_flight_grab_is_not_selected_by_commit(tmp_path: Path) -> None:
    """A grab still running at commit must never become the frozen frame.

    The frame timestamp is the grab COMPLETION time, so a capture that
    started before pointerup but finishes after it is excluded. With an
    otherwise empty ring the commit fails closed (no_frame_buffered).
    """
    backend = GatedCaptureBackend()
    worker = FrameCaptureService(
        backend=backend,
        output_root=tmp_path,
        clock=FakeClock(),
        capture_interval_ms=5,
        ring_size=4,
    )
    worker.handle({"id": "1", "method": "arm", "params": _arm_params()})
    assert backend.started.wait(timeout=2.0)

    result = worker.handle({"id": "2", "method": "commit", "params": _commit_params()})
    assert result["error"]["code"] == "no_frame_buffered"

    backend.release.set()
    time.sleep(0.05)
    # The late grab completed after the epoch was stopped: it is dropped,
    # never appended to any ring.
    assert worker.ring_len_for_test() == 0


def test_arm_does_not_wait_for_a_hung_previous_grab(tmp_path: Path) -> None:
    """Re-arming while the previous capture thread is blocked in a grab must
    return immediately instead of joining the stuck thread (review P2.3)."""
    backend = GatedCaptureBackend()
    worker = FrameCaptureService(
        backend=backend,
        output_root=tmp_path,
        clock=FakeClock(),
        capture_interval_ms=5,
        ring_size=4,
    )
    worker.handle({"id": "1", "method": "arm", "params": _arm_params()})
    assert backend.started.wait(timeout=2.0)

    started = time.monotonic()
    rearmed = worker.handle({"id": "2", "method": "arm", "params": _arm_params()})
    elapsed = time.monotonic() - started
    assert rearmed["result"]["epochId"] == "epoch-1"
    assert elapsed < 0.5, f"arm waited {elapsed:.2f}s on a hung grab"

    backend.release.set()
    time.sleep(0.05)
    worker.handle({"id": "3", "method": "cancel", "params": {"epochId": "epoch-1"}})
    time.sleep(0.05)


def test_re_arm_does_not_stack_zombie_capture_threads(tmp_path: Path) -> None:
    """Bridge-audit P1: each re-arm used to replace the stop event while the
    old thread kept reading the attribute — the old thread latched onto the
    NEW unset event and kept grabbing forever, stacking one concurrent
    ImageGrab loop per re-arm. After the fix the stale thread must exit and
    the new epoch must see exactly one live capture loop."""
    backend = GatedCaptureBackend()
    worker = FrameCaptureService(
        backend=backend,
        output_root=tmp_path,
        clock=FakeClock(),
        capture_interval_ms=5,
        ring_size=4,
    )
    worker.handle({"id": "1", "method": "arm", "params": _arm_params()})
    assert backend.started.wait(timeout=2.0)
    first_thread = worker._thread

    for request_id in range(2, 5):
        worker.handle({"id": str(request_id), "method": "arm", "params": _arm_params()})

    backend.release.set()
    deadline = time.monotonic() + 1.0
    while first_thread.is_alive() and time.monotonic() < deadline:
        time.sleep(0.005)

    # The stale thread bound to the replaced stop event exits; only the
    # latest armed epoch keeps a live loop. The stale thread's late grab is
    # epoch-identity guarded and never pollutes the current ring.
    assert not first_thread.is_alive()
    current_thread = worker._thread
    assert current_thread is not None and current_thread.is_alive()
    worker.handle({"id": "99", "method": "cancel", "params": {"epochId": "epoch-1"}})
    deadline = time.monotonic() + 1.0
    while current_thread.is_alive() and time.monotonic() < deadline:
        time.sleep(0.005)
    assert not current_thread.is_alive()
    alive = [
        thread for thread in threading.enumerate()
        if thread.name == "frame-capture"
    ]
    assert len(alive) == 0


def test_lease_timestamps_are_milliseconds(tmp_path: Path) -> None:
    """capturedAtMonotonicMs and captureLatencyMs must be milliseconds.

    The worker clock is monotonic seconds; before the fix the raw seconds
    value was stored under the Ms-named fields (review P2.1). FakeClock
    advances 100 per call: first capture completion at 1100.0 s, commit at
    1200.0 s -> 1_100_000 ms and 100_000 ms latency.
    """
    backend = FakeCaptureBackend(colors=[(0, 128, 0)])
    worker = _make_service(tmp_path, backend)
    worker.handle({"id": "1", "method": "arm", "params": _arm_params()})
    assert worker.capture_once_for_test() is True
    result = worker.handle({"id": "2", "method": "commit", "params": _commit_params()})
    lease = result["result"]
    assert isinstance(lease["capturedAtMonotonicMs"], (int, float))
    assert lease["capturedAtMonotonicMs"] == 1_100_000
    assert lease["captureLatencyMs"] == 100_000.0


def test_arm_rejects_reversed_or_zero_area_bounds(tmp_path: Path) -> None:
    worker = _make_service(tmp_path, FakeCaptureBackend(colors=[(0, 0, 0)]))
    for bad in ([100, 100, 50, 50], [0, 0, 0, 0], [0, 0, 320, 0]):
        params = dict(_arm_params())
        params["surfaceBoundsPx"] = bad
        result = worker.handle({"id": "1", "method": "arm", "params": params})
        assert result["error"]["code"] == "invalid_arm", bad


def test_real_subprocess_protocol_without_desktop_capture(tmp_path: Path) -> None:
    script = Path("scripts/frame_capture_worker.py").resolve()
    process = subprocess.Popen(
        [
            sys.executable,
            "-u",
            str(script),
            "--backend",
            "test",
            "--output-root",
            str(tmp_path),
        ],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        env={**os.environ, "PYTHONIOENCODING": "utf-8"},
    )
    assert process.stdin is not None
    assert process.stdout is not None

    def rpc(rid: str, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        process.stdin.write(json.dumps({"id": rid, "method": method, "params": params or {}}) + "\n")
        process.stdin.flush()
        line = process.stdout.readline()
        assert line, f"worker closed before answering {method}"
        return json.loads(line)

    try:
        pong = rpc("ping-1", "ping")
        assert pong["id"] == "ping-1"
        assert pong["result"]["pong"] is True
        assert pong["result"]["backend"] == "test"

        armed = rpc("arm-1", "arm", _arm_params())
        assert armed["id"] == "arm-1"
        assert armed["result"]["epochId"] == "epoch-1"

        # Give the resident thread a beat to buffer frames; the worker captures
        # the first frame immediately after arm.
        deadline = time.monotonic() + 1.0
        committed = None
        while time.monotonic() < deadline:
            time.sleep(0.02)
            committed = rpc("commit-1", "commit", _commit_params())
            if "result" in committed:
                break
        assert committed is not None and "result" in committed, committed
        assert committed["id"] == "commit-1"
        lease = committed["result"]
        assert lease["source"] == "test"
        assert lease["epochId"] == "epoch-1"
        assert Path(lease["localArtifact"]["path"]).exists()

        stopped = rpc("shutdown-1", "shutdown")
        assert stopped["id"] == "shutdown-1"
        assert stopped["result"]["shutdown"] is True
    finally:
        if process.poll() is None:
            process.kill()
        process.wait(timeout=10)

    remainder = process.stdout.read() if process.stdout is not None else ""
    assert remainder == "", f"stdout must contain JSON lines only, got: {remainder!r}"
