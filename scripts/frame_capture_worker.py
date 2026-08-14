"""Idle resident frame capture worker.

Arms a bounded in-memory ring of timestamped desktop frames on demand and
commits exactly one immutable PNG artifact per gesture epoch. The worker stays
idle (zero captures) between arm and commit; capture only starts for the active
epoch and stops the moment the epoch is committed or cancelled.

Protocol (newline-delimited JSON on stdio):
  -> {"id": 1, "method": "ping"}
  -> {"id": 2, "method": "arm", "params": {"epochId": ..., "displayId": ...,
      "scaleFactor": ..., "surfaceBoundsPx": [l, t, r, b],
      "targetWindow": {...}, "overlayExcluded": true}}
  -> {"id": 3, "method": "commit", "params": {"epochId": ..., "gesture": {...}}}
  -> {"id": 4, "method": "cancel", "params": {"epochId": ...}}
  -> {"id": 5, "method": "shutdown"}
  <- {"id": ..., "result": {...}} | {"id": ..., "error": {"code": ..., "message": ...}}

The first production backend is Pillow/ImageGrab and reports ``gdi-fallback``
honestly; it is a contract placeholder until a WGC/D3D provider lands.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import threading
import time
import uuid
from collections import deque
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Protocol

from PIL import Image, ImageGrab

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.frame_lease import FrameLeaseError, normalize_frame_lease

RING_SIZE = 8
DEFAULT_CAPTURE_INTERVAL_MS = 33.0
MAX_REQUEST_LINE_BYTES = 64 * 1024


class WorkerError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class Clock(Protocol):
    def monotonic(self) -> float: ...

    def utc_iso(self) -> str: ...


class RealClock:
    def monotonic(self) -> float:
        return time.monotonic()

    def utc_iso(self) -> str:
        return datetime.now(UTC).isoformat()


class CaptureBackend(Protocol):
    source: str

    def capture(self, bbox_ltrb: tuple[int, int, int, int]) -> Any: ...


class PillowDisplayCaptureBackend:
    """Desktop grab via Pillow ImageGrab; reports the honest gdi-fallback source."""

    source = "gdi-fallback"

    def __init__(self) -> None:
        self._grab = ImageGrab.grab

    def capture(self, bbox_ltrb: tuple[int, int, int, int]) -> Any:
        return self._grab(bbox=bbox_ltrb, all_screens=True)


class SolidColorTestBackend:
    """Deterministic solid-color frames for subprocess protocol tests."""

    source = "test"

    def __init__(self) -> None:
        self.count = 0

    def capture(self, bbox_ltrb: tuple[int, int, int, int]) -> Any:
        self.count += 1
        hue = (self.count * 40) % 360
        return Image.new(
            "RGB",
            (bbox_ltrb[2] - bbox_ltrb[0], bbox_ltrb[3] - bbox_ltrb[1]),
            f"hsl({hue}, 80%, 50%)",
        )


def initialize_capture_process(*, enable_dpi, create_backend):
    """Enter physical-coordinate mode before a capture backend can exist."""

    enable_dpi()
    return create_backend()


def _ok(rid: Any, result: dict[str, Any]) -> dict[str, Any]:
    return {"id": rid, "result": result}


def _err(rid: Any, code: str, message: str) -> dict[str, Any]:
    return {"id": rid, "error": {"code": code, "message": message}}


class FrameCaptureService:
    """Arm/commit/cancel state machine independent of stdio."""

    def __init__(
        self,
        *,
        backend: CaptureBackend,
        output_root: Path | str,
        clock: Clock | None = None,
        capture_interval_ms: float | None = DEFAULT_CAPTURE_INTERVAL_MS,
        ring_size: int = RING_SIZE,
    ) -> None:
        self._backend = backend
        self._output_root = Path(output_root)
        self._clock = clock if clock is not None else RealClock()
        self._capture_interval_ms = float(capture_interval_ms or 0)
        self._ring_size = max(1, int(ring_size))
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._epoch: dict[str, Any] | None = None
        self._ring: deque[tuple[float, Any]] | None = None
        self._thread: threading.Thread | None = None

    # -- RPC entry ---------------------------------------------------------

    def handle(self, request: dict[str, Any]) -> dict[str, Any]:
        rid = request.get("id")
        method = str(request.get("method") or "")
        params = request.get("params")
        params = dict(params) if isinstance(params, dict) else {}
        try:
            if method == "ping":
                return _ok(rid, {
                    "pong": True,
                    "backend": self._backend.source,
                    "pid": os.getpid(),
                })
            if method == "arm":
                self.arm(params)
                return _ok(rid, {"epochId": str(params.get("epochId") or "")})
            if method == "commit":
                return _ok(rid, self.commit(params))
            if method == "cancel":
                self.cancel(params)
                return _ok(rid, {"cancelled": True})
            if method == "shutdown":
                self.close()
                return _ok(rid, {"shutdown": True})
            return _err(rid, "unknown_method", f"unknown method: {method}")
        except FrameLeaseError as exc:
            return _err(rid, "invalid_frame_lease", str(exc))
        except WorkerError as exc:
            return _err(rid, exc.code, exc.message)
        except Exception as exc:  # noqa: BLE001 - the boundary answers every request
            return _err(rid, "internal_error", str(exc))

    # -- state machine -----------------------------------------------------

    def arm(self, params: dict[str, Any]) -> None:
        epoch_id = str(params.get("epochId") or "").strip()
        if not epoch_id:
            raise WorkerError("invalid_arm", "epochId is required to arm capture")
        surface = params.get("surfaceBoundsPx")
        if not (isinstance(surface, (list, tuple)) and len(surface) == 4):
            raise WorkerError("invalid_arm", "surfaceBoundsPx is required to arm capture")
        try:
            bounds = tuple(int(round(float(value))) for value in surface)
        except (TypeError, ValueError) as exc:
            raise WorkerError("invalid_arm", "surfaceBoundsPx must contain numbers") from exc
        if bounds[2] - bounds[0] <= 0 or bounds[3] - bounds[1] <= 0:
            raise WorkerError(
                "invalid_arm",
                "surfaceBoundsPx must have positive area (right>left, bottom>top)",
            )
        display_id = str(params.get("displayId") or "").strip()
        if not display_id:
            raise WorkerError("invalid_arm", "displayId is required to arm capture")
        with self._lock:
            self._stop_epoch_locked()
            self._stop = threading.Event()
            self._epoch = {
                "epochId": epoch_id,
                "surfaceBoundsPx": bounds,
                "displayId": display_id,
                "scaleFactor": float(params.get("scaleFactor") or 1),
                "targetWindow": dict(params.get("targetWindow") or {}),
                "overlayExcluded": params.get("overlayExcluded") is True,
            }
            self._ring = deque(maxlen=self._ring_size)
            if self._capture_interval_ms > 0:
                self._thread = threading.Thread(
                    target=self._capture_loop,
                    name="frame-capture",
                    daemon=True,
                )
                self._thread.start()

    def capture_once_for_test(self) -> bool:
        """Synchronous single capture for deterministic tests; no-op when idle."""
        with self._lock:
            if self._stop.is_set() or self._epoch is None:
                return False
            entry = self._capture_once_locked()
            return entry is not None

    def commit(self, params: dict[str, Any]) -> dict[str, Any]:
        requested_epoch = str(params.get("epochId") or "")
        with self._lock:
            epoch = self._epoch
            if epoch is None:
                raise WorkerError("epoch_not_armed", "no armed capture epoch to commit")
            if requested_epoch != epoch["epochId"]:
                raise WorkerError(
                    "epoch_mismatch",
                    f"epoch {requested_epoch or '<empty>'} is not the armed epoch",
                )
            commit_time = self._clock.monotonic()
            self._stop_epoch_locked()
            ring = self._ring
            entries = [
                entry for entry in ring if entry[0] <= commit_time
            ] if ring is not None else []
            entry = entries[-1] if entries else None
            self._ring = None
            self._epoch = None
        if entry is None:
            raise WorkerError("no_frame_buffered", "no frame captured for this epoch")
        captured_at, image = entry
        return self._lease_from_frame(epoch, captured_at, commit_time, image, params)

    def cancel(self, params: dict[str, Any]) -> None:
        with self._lock:
            self._stop_epoch_locked()
            self._ring = None
            self._epoch = None

    def close(self) -> None:
        self.cancel({})

    # -- internals ---------------------------------------------------------

    def _capture_loop(self) -> None:
        # Bind this thread to the stop event and epoch it started with.
        # ``arm`` replaces ``self._stop`` with a fresh event on re-arm; a
        # thread that keeps reading the attribute would latch onto the NEW
        # unset event and keep grabbing forever (writing into the new ring),
        # stacking one zombie capture loop per re-arm (bridge-audit P1).
        stop = self._stop
        while not stop.is_set():
            with self._lock:
                if stop.is_set() or self._epoch is None:
                    break
                if self._stop is not stop:
                    # A newer arm replaced the stop event: this loop is stale.
                    break
                epoch = self._epoch
                ring = self._ring
                bounds = epoch["surfaceBoundsPx"]
            # Grab OUTSIDE the lock: a slow ImageGrab must not stall
            # arm/commit/cancel, and the frame's timestamp is the grab
            # COMPLETION time so commit only selects captures that finished
            # before pointerup (a grab still running at commit is dropped).
            image = self._backend.capture(bounds)
            captured_at = self._clock.monotonic()
            with self._lock:
                if not stop.is_set() and self._epoch is epoch:
                    ring.append((captured_at, image))
            stop.wait(self._capture_interval_ms / 1000.0)

    def _capture_once_locked(self) -> tuple[float, Any] | None:
        epoch = self._epoch
        ring = self._ring
        if epoch is None or ring is None:
            return None
        image = self._backend.capture(epoch["surfaceBoundsPx"])
        captured_at = self._clock.monotonic()
        entry = (captured_at, image)
        ring.append(entry)
        return entry

    def _stop_epoch_locked(self) -> None:
        """Set the stop flag and detach the capture thread.

        The detached thread is never joined: it checks ``_stop`` after its
        grab and its append is epoch-identity guarded, so it cannot pollute
        the next epoch. A join (even outside the lock) would stall
        arm/commit for the duration of a slow in-flight grab.
        """
        self._stop.set()
        self._thread = None

    def _lease_from_frame(
        self,
        epoch: dict[str, Any],
        captured_at: float,
        commit_time: float,
        image: Any,
        params: dict[str, Any],
    ) -> dict[str, Any]:
        output_dir = self._output_root / "frame-leases"
        output_dir.mkdir(parents=True, exist_ok=True)
        filename = f"frame-{uuid.uuid4().hex[:16]}.png"
        output = output_dir / filename
        temp = output.with_suffix(".png.tmp")
        image.convert("RGB").save(temp, format="PNG")
        os.replace(temp, output)
        content_hash = "sha256:" + hashlib.sha256(output.read_bytes()).hexdigest()
        gesture = params.get("gesture")
        gesture = dict(gesture) if isinstance(gesture, dict) else {}
        lease = {
            "schemaVersion": 1,
            "frameLeaseId": f"frame-{uuid.uuid4().hex[:16]}",
            "epochId": epoch["epochId"],
            # The worker clock is monotonic SECONDS; the lease field is named
            # Ms, so convert explicitly. Values are only comparable within
            # this worker process (each process has its own monotonic origin).
            "capturedAtMonotonicMs": int(captured_at * 1000.0),
            "capturedAtUtc": self._clock.utc_iso(),
            "source": self._backend.source,
            "targetWindow": dict(epoch["targetWindow"]),
            "surfaceBoundsPx": list(epoch["surfaceBoundsPx"]),
            "displayId": epoch["displayId"],
            "scaleFactor": epoch["scaleFactor"],
            "gesture": gesture,
            "localArtifact": {
                "path": str(output.resolve()),
                "mimeType": "image/png",
                "width": int(image.width),
                "height": int(image.height),
            },
            "contentHash": content_hash,
            "overlayExcluded": epoch["overlayExcluded"] and os.name == "nt",
            "captureLatencyMs": max(0.0, (commit_time - captured_at) * 1000.0),
        }
        return normalize_frame_lease(lease)

    def ring_len_for_test(self) -> int:
        with self._lock:
            return len(self._ring) if self._ring is not None else 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="idle resident frame capture worker")
    parser.add_argument("--backend", choices=["gdi-fallback", "wgc-window", "test"], default="gdi-fallback")
    parser.add_argument("--output-root", default=str(ROOT / "data" / "runtime"))
    parser.add_argument("--capture-interval-ms", type=float, default=DEFAULT_CAPTURE_INTERVAL_MS)
    parser.add_argument("--ring-size", type=int, default=RING_SIZE)
    args = parser.parse_args(argv)

    def create_backend() -> CaptureBackend:
        if args.backend == "test":
            return SolidColorTestBackend()
        # CaptureProvider contract (Phase B): the requested source, or an
        # honest GDI fallback — the lease always declares what it actually
        # used, so a fallback never pretends to be WGC.
        from app.capture import provider_for

        provider = provider_for(args.backend)
        if provider.available():
            return provider  # type: ignore[return-value]
        sys.stderr.write(
            f"capture backend {args.backend} unavailable: "
            f"{provider.unavailable_reason}; using gdi-fallback\n"
        )
        sys.stderr.flush()
        return PillowDisplayCaptureBackend()

    from app.system_context import enable_dpi_awareness

    backend = initialize_capture_process(
        enable_dpi=enable_dpi_awareness,
        create_backend=create_backend,
    )
    service = FrameCaptureService(
        backend=backend,
        output_root=args.output_root,
        capture_interval_ms=args.capture_interval_ms,
        ring_size=args.ring_size,
    )

    def write_response(response: dict[str, Any]) -> None:
        sys.stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
        sys.stdout.flush()

    stdin = sys.stdin.buffer
    while True:
        line = stdin.readline()
        if not line:
            break
        if len(line) > MAX_REQUEST_LINE_BYTES:
            write_response(_err(
                None,
                "line_too_long",
                f"request line exceeds {MAX_REQUEST_LINE_BYTES} bytes",
            ))
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError:
            write_response(_err(None, "invalid_json", "request line is not valid JSON"))
            continue
        if not isinstance(request, dict):
            write_response(_err(None, "invalid_request", "request must be a JSON object"))
            continue
        response = service.handle(request)
        write_response(response)
        if request.get("method") == "shutdown":
            break
    service.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
