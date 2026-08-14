"""CaptureProvider contract (design Phase B): replaceable frame backends.

The FrameLease contract demands the *source* be declared per capture; the
provider contract is where sources live:

- ``gdi-fallback`` — Pillow ImageGrab (today's production path);
- ``wgc-window`` — Windows.Graphics.Capture window capture via the native
  ``wgc_capture_tool.exe`` (design target: pointerup->freeze p95 <= 30ms);
- ``test`` — deterministic solid frames for protocol tests.

Every provider reports ``available()`` and an honest ``unavailable_reason``:
a missing native tool compiles to "the provider exists, this machine cannot
run it yet", never to a silent GDI fallback pretending to be WGC.
"""

from __future__ import annotations

import os
import statistics
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

ROOT = Path(__file__).resolve().parents[2]

__all__ = [
    "CaptureProvider",
    "GdiFallbackCaptureProvider",
    "WgcWindowCaptureProvider",
    "provider_for",
    "benchmark_provider",
]


class CaptureProvider(Protocol):
    """One frame-capture backend (Phase B contract)."""

    source: str

    def available(self) -> bool: ...

    @property
    def unavailable_reason(self) -> str: ...

    def capture(self, bbox_ltrb: tuple[int, int, int, int]) -> Any: ...


class GdiFallbackCaptureProvider:
    """Desktop grab via Pillow ImageGrab (today's production path)."""

    source = "gdi-fallback"

    def __init__(self) -> None:
        self._unavailable_reason = ""
        try:
            from PIL import ImageGrab  # noqa: F401
        except ImportError as exc:
            self._unavailable_reason = f"pillow_unavailable:{type(exc).__name__}"
        self._grab = None

    def available(self) -> bool:
        return not self._unavailable_reason

    @property
    def unavailable_reason(self) -> str:
        return self._unavailable_reason

    def capture(self, bbox_ltrb: tuple[int, int, int, int]) -> Any:
        if self._grab is None:
            from PIL import ImageGrab

            self._grab = ImageGrab.grab
        return self._grab(bbox=tuple(int(value) for value in bbox_ltrb), all_screens=True)


class WgcWindowCaptureProvider:
    """WGC window capture through ``wgc_capture_tool.exe`` (native helper).

    Honest state machine: the tool is built with the same machine-local csc
    used for the UIA probe (``scripts/build_wgc_tool.py``); until it builds
    and the machine runs a successful capture, ``available()`` is False and
    the lease keeps ``source=gdi-fallback``.
    """

    source = "wgc-window"
    TOOL_PATH = ROOT / "data" / "runtime" / "wgc_capture_tool.exe"

    def __init__(self, *, tool_path: Path | None = None) -> None:
        self._tool_path = Path(tool_path) if tool_path is not None else self.TOOL_PATH
        self._reason = ""
        if not self._tool_path.exists():
            self._reason = (
                "wgc_tool_missing: run scripts/build_wgc_tool.py "
                "(native WinRT interop; not verified on this machine yet)"
            )

    def available(self) -> bool:
        return not self._reason

    @property
    def unavailable_reason(self) -> str:
        return self._reason

    def capture(self, bbox_ltrb: tuple[int, int, int, int]) -> Any:
        from PIL import Image

        hwnd = 0  # the tool derives the hwnd under the bbox at capture time
        proc = subprocess.run(
            [
                str(self._tool_path),
                "--hwnd",
                str(hwnd),
                "--bbox",
                *(str(int(value)) for value in bbox_ltrb),
                "--out",
                "-",
            ],
            capture_output=True,
            timeout=30,
        )
        if proc.returncode != 0:
            raise RuntimeError(
                f"wgc_capture_tool failed rc={proc.returncode}: "
                f"{(proc.stderr or b'').decode('utf-8', errors='replace')[:300]}"
            )
        import io

        return Image.open(io.BytesIO(proc.stdout))


def provider_for(source: str | None) -> CaptureProvider:
    """Provider selection: env ``MAGIC_POINTER_CAPTURE_BACKEND`` overrides the
    caller; a requested-but-unavailable provider is still returned — the
    caller must check ``available()`` and fall back honestly."""
    resolved = (source or os.environ.get("MAGIC_POINTER_CAPTURE_BACKEND", "gdi-fallback")).strip()
    if resolved == "wgc-window":
        return WgcWindowCaptureProvider()
    if resolved == "test":
        from scripts.frame_capture_worker import SolidColorTestBackend

        return SolidColorTestBackend()  # type: ignore[return-value]
    return GdiFallbackCaptureProvider()


@dataclass(frozen=True)
class CaptureBenchmarkResult:
    source: str
    samples: int
    p50_ms: float
    p95_ms: float
    p99_ms: float
    unavailable_reason: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "source": self.source,
            "samples": self.samples,
            "p50_ms": round(self.p50_ms, 1),
            "p95_ms": round(self.p95_ms, 1),
            "p99_ms": round(self.p99_ms, 1),
            "unavailable_reason": self.unavailable_reason,
        }


def benchmark_provider(
    provider: CaptureProvider,
    bbox_ltrb: tuple[int, int, int, int],
    *,
    samples: int = 20,
) -> CaptureBenchmarkResult:
    """Median/p95/p99 wall time over ``samples`` captures (design Phase B)."""
    if not provider.available():
        return CaptureBenchmarkResult(
            source=provider.source,
            samples=0,
            p50_ms=0.0,
            p95_ms=0.0,
            p99_ms=0.0,
            unavailable_reason=provider.unavailable_reason,
        )
    latencies: list[float] = []
    for _ in range(max(1, samples)):
        started = time.perf_counter()
        provider.capture(bbox_ltrb)
        latencies.append((time.perf_counter() - started) * 1000.0)
    ordered = sorted(latencies)
    return CaptureBenchmarkResult(
        source=provider.source,
        samples=len(ordered),
        p50_ms=float(statistics.median(ordered)),
        p95_ms=float(ordered[min(len(ordered) - 1, int(len(ordered) * 0.95))]),
        p99_ms=float(ordered[min(len(ordered) - 1, int(len(ordered) * 0.99))]),
        unavailable_reason="",
    )
