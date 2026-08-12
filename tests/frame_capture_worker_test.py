from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

from PIL import Image

from scripts.frame_capture_worker import FrameCaptureService


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
