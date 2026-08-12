"""Cold/warm frame capture benchmark for the resident capture worker.

Starts ONE worker subprocess, arms/commits N rounds against the current
display (or a user-provided bbox), validates every returned artifact (contract,
hash, dimensions) and emits a JSON report plus a human summary. A failed round
stays in the denominator. The GDI/Pillow backend is measured here honestly; it
does not prove WGC/D3D target performance.

``--backend test`` runs the same protocol against the deterministic in-process
backend so the harness can be exercised without a real desktop.
"""

from __future__ import annotations

import argparse
import ctypes
import hashlib
import json
import math
import os
import statistics
import subprocess
import sys
import time
import uuid
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.frame_lease import normalize_frame_lease

WORKER_SCRIPT = ROOT / "scripts" / "frame_capture_worker.py"
DEFAULT_OUTPUT_ROOT = ROOT / "data" / "runtime"


def _percentile(sorted_values: list[float], percentile: float) -> float | None:
    if not sorted_values:
        return None
    index = min(
        len(sorted_values) - 1,
        max(0, math.ceil(percentile / 100.0 * len(sorted_values)) - 1),
    )
    return sorted_values[index]


def build_report(
    *,
    rounds: int,
    success_count: int,
    errors: list[dict[str, Any]],
    latencies_ms: list[float],
    backend: str,
    frame_dimensions: tuple[int, int] | None,
    process_reuse_count: int,
    display_bbox: list[int],
) -> dict[str, Any]:
    sorted_latencies = sorted(latencies_ms)
    warm_latencies = latencies_ms[1:] if len(latencies_ms) > 1 else []
    warm_sorted = sorted(warm_latencies)
    return {
        "schemaVersion": 1,
        "rounds": int(rounds),
        "successes": int(success_count),
        "errors": len(errors),
        "failed_rounds": list(errors),
        "success_rate": (
            (int(success_count) / int(rounds)) if int(rounds) > 0 else 0.0
        ),
        "cold_start_ms": sorted_latencies[0] if sorted_latencies else None,
        "warm_p50_ms": (
            statistics.median(warm_sorted) if warm_sorted else None
        ),
        "p50_ms": (
            statistics.median(sorted_latencies) if sorted_latencies else None
        ),
        "p95_ms": _percentile(sorted_latencies, 95.0),
        "max_ms": sorted_latencies[-1] if sorted_latencies else None,
        "backend": str(backend),
        "frame": (
            {"width": int(frame_dimensions[0]), "height": int(frame_dimensions[1])}
            if frame_dimensions is not None
            else None
        ),
        "process_reuse_count": int(process_reuse_count),
        "display_bbox": [int(value) for value in display_bbox],
    }


def format_human_summary(report: dict[str, Any]) -> str:
    lines = [
        "frame capture benchmark",
        f"  rounds={report['rounds']} successes={report['successes']} "
        f"errors={report['errors']} success_rate={report['success_rate']:.0%}",
        f"  cold_start_ms={report['cold_start_ms']} "
        f"warm_p50_ms={report['warm_p50_ms']} p50_ms={report['p50_ms']} "
        f"p95_ms={report['p95_ms']} max_ms={report['max_ms']}",
        f"  backend={report['backend']} frame={report['frame']} "
        f"process_reuse_count={report['process_reuse_count']}",
        f"  display_bbox={report['display_bbox']}",
    ]
    return "\n".join(lines)


def _current_display_bbox() -> list[int]:
    """Physical virtual-desktop bounds, including negative-monitor origins."""
    if os.name == "nt":
        try:
            user32 = ctypes.windll.user32
            left = int(user32.GetSystemMetrics(76))   # SM_XVIRTUALSCREEN
            top = int(user32.GetSystemMetrics(77))    # SM_YVIRTUALSCREEN
            width = int(user32.GetSystemMetrics(78))  # SM_CXVIRTUALSCREEN
            height = int(user32.GetSystemMetrics(79))  # SM_CYVIRTUALSCREEN
            if width > 0 and height > 0:
                return [left, top, left + width, top + height]
        except Exception:
            pass
    return [0, 0, 1920, 1080]


class _WorkerProtocol:
    def __init__(self, process: subprocess.Popen[str]) -> None:
        self.process = process
        self.seq = 0

    def rpc(self, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        assert self.process.stdin is not None
        assert self.process.stdout is not None
        self.seq += 1
        rid = f"bench-{self.seq}"
        self.process.stdin.write(
            json.dumps({"id": rid, "method": method, "params": params or {}}) + "\n"
        )
        self.process.stdin.flush()
        line = self.process.stdout.readline()
        if not line:
            raise RuntimeError(f"worker closed before answering {method}")
        response = json.loads(line)
        if response.get("id") != rid:
            raise RuntimeError("worker answered out of order")
        return response


def _validate_committed_lease(lease: dict[str, Any]) -> tuple[int, int]:
    normalized = normalize_frame_lease(lease)
    artifact = Path(normalized["localArtifact"]["path"])
    if not artifact.exists():
        raise RuntimeError("committed artifact is missing from disk")
    expected_hash = normalized["contentHash"]
    if expected_hash.startswith("sha256:"):
        actual_hash = "sha256:" + hashlib.sha256(artifact.read_bytes()).hexdigest()
        if actual_hash != expected_hash:
            raise RuntimeError("committed artifact hash mismatch")
    return int(normalized["localArtifact"]["width"]), int(normalized["localArtifact"]["height"])


def run_benchmark(
    *,
    rounds: int,
    bbox: list[int],
    backend: str,
    output_root: Path,
) -> dict[str, Any]:
    process = subprocess.Popen(
        [
            sys.executable,
            "-u",
            str(WORKER_SCRIPT),
            "--backend",
            backend,
            "--output-root",
            str(output_root),
        ],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        env={**os.environ, "PYTHONIOENCODING": "utf-8"},
    )
    protocol = _WorkerProtocol(process)
    latencies_ms: list[float] = []
    errors: list[dict[str, Any]] = []
    frame_dimensions: tuple[int, int] | None = None
    try:
        for round_index in range(1, max(1, int(rounds)) + 1):
            epoch_id = f"bench-{uuid.uuid4().hex[:8]}-{round_index}"
            arm_params = {
                "epochId": epoch_id,
                "displayId": "benchmark-display",
                "scaleFactor": 1.0,
                "surfaceBoundsPx": bbox,
                "targetWindow": {
                    "hwnd": 0,
                    "processId": 0,
                    "processName": "benchmark",
                    "title": "benchmark",
                },
                "overlayExcluded": False,
            }
            try:
                arm_response = protocol.rpc("arm", arm_params)
                if "error" in arm_response:
                    errors.append({
                        "round": round_index,
                        "error": str(arm_response["error"].get("code") or "arm_failed"),
                        "message": str(arm_response["error"].get("message") or ""),
                    })
                    continue
                started = time.perf_counter()
                commit_response = protocol.rpc("commit", {
                    "epochId": epoch_id,
                    "gesture": {"coordinateSpace": "physical_screen_pixels", "strokes": []},
                })
                latency_ms = (time.perf_counter() - started) * 1000.0
                if "error" in commit_response:
                    errors.append({
                        "round": round_index,
                        "error": str(commit_response["error"].get("code") or "commit_failed"),
                        "message": str(commit_response["error"].get("message") or ""),
                    })
                    continue
                lease = commit_response["result"]
                width, height = _validate_committed_lease(lease)
                frame_dimensions = (width, height)
                latencies_ms.append(latency_ms)
            except Exception as exc:  # noqa: BLE001 - a failed round is data
                errors.append({
                    "round": round_index,
                    "error": "protocol_failure",
                    "message": str(exc),
                })
    finally:
        try:
            if process.poll() is None:
                process.stdin.write(json.dumps({"id": "bench-shutdown", "method": "shutdown", "params": {}}) + "\n")
                process.stdin.flush()
                process.wait(timeout=5)
        except Exception:
            pass
        if process.poll() is None:
            process.kill()
        process.wait(timeout=5)
    return build_report(
        rounds=max(1, int(rounds)),
        success_count=len(latencies_ms),
        errors=errors,
        latencies_ms=latencies_ms,
        backend=backend,
        frame_dimensions=frame_dimensions,
        process_reuse_count=1,
        display_bbox=bbox,
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="frame capture benchmark")
    parser.add_argument("--rounds", type=int, default=20)
    parser.add_argument("--bbox", type=int, nargs=4, default=None)
    parser.add_argument("--backend", choices=["gdi-fallback", "test"], default="gdi-fallback")
    parser.add_argument("--output-root", default=str(DEFAULT_OUTPUT_ROOT))
    args = parser.parse_args(argv)
    bbox = list(args.bbox) if args.bbox else _current_display_bbox()
    report = run_benchmark(
        rounds=args.rounds,
        bbox=bbox,
        backend=args.backend,
        output_root=Path(args.output_root),
    )
    print(format_human_summary(report))
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
