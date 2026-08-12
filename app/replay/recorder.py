"""DesktopTraceRecorder: record a real desktop interaction into a replayable trace.

The recorder never captures the real screen by itself. ``capture_frame`` only
captures when an explicit capture backend (``Callable[[ltrb], Image.Image]``)
is passed; the default ``None`` records nothing.
"""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from app.replay.trace_schema import (
    POINTER_PHASES,
    DesktopTrace,
    FocusEvent,
    PointerSample,
    TraceFrame,
    UiaSnapshot,
)

_LTRB = tuple[int, int, int, int]
FrameCapture = Callable[[_LTRB], Any]
Clock = Callable[[], str]


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


@dataclass(frozen=True)
class _PendingUia:
    tree_text: str
    hwnd: int | None
    pid: int | None
    note: str | None


class DesktopTraceRecorder:
    """Incremental builder that writes a DesktopTrace fixture into a directory."""

    def __init__(self, trace_id: str | None = None, clock: Clock | None = None) -> None:
        self.trace_id = trace_id or f"trace-{uuid.uuid4().hex[:12]}"
        self.clock = clock or utc_now_iso
        self._trace_dir: Path | None = None
        self.started_at_utc: str | None = None
        self._frames: list[TraceFrame] = []
        self._uia_pending: list[_PendingUia] = []
        self._uia_snapshots: list[UiaSnapshot] = []
        self._pointer_samples: list[PointerSample] = []
        self._focus_events: list[FocusEvent] = []
        self._display_config: dict[str, Any] = {}
        self._ground_truth: dict[str, Any] | None = None
        self._frame_counter = 0
        self._uia_counter = 0

    def begin(self, trace_dir: Path) -> None:
        for subdir in ("frames", "uia", "cdp"):
            (Path(trace_dir) / subdir).mkdir(parents=True, exist_ok=True)
        self._trace_dir = Path(trace_dir)
        self.started_at_utc = self.clock()

    def _require_begin(self) -> Path:
        if self._trace_dir is None:
            raise RuntimeError("begin() must be called before recording")
        return self._trace_dir

    def capture_frame(
        self,
        backend: FrameCapture | None = None,
        region: _LTRB | None = None,
        *,
        dpi: float | None = None,
        scale_factor: float | None = None,
    ) -> None:
        trace_dir = self._require_begin()
        if backend is None:
            return
        if region is None:
            raise ValueError("region (ltrb) is required when a capture backend is provided")
        image = backend(tuple(region))
        self._frame_counter += 1
        frame_id = f"frame-{self._frame_counter}"
        rel_path = f"frames/{frame_id}.png"
        image.save(trace_dir / rel_path, format="PNG")
        self._frames.append(
            TraceFrame(
                frame_id=frame_id,
                png_path=rel_path,
                captured_at_utc=self.clock(),
                display_bounds_ltrb=tuple(region),
                dpi=dpi,
                scale_factor=scale_factor,
            )
        )

    def add_pointer_sample(
        self,
        x: int,
        y: int,
        phase: str,
        buttons: int,
        t_utc: str | None = None,
    ) -> None:
        self._require_begin()
        if phase not in POINTER_PHASES:
            raise ValueError(f"phase must be one of {sorted(POINTER_PHASES)}, got {phase!r}")
        if int(buttons) < 0:
            raise ValueError("buttons must be a non-negative integer")
        self._pointer_samples.append(
            PointerSample(
                t_utc=t_utc or self.clock(),
                x=int(x),
                y=int(y),
                phase=phase,
                buttons=int(buttons),
            )
        )

    def add_uia_snapshot(
        self,
        tree_text: str,
        hwnd: int | None = None,
        pid: int | None = None,
        note: str | None = None,
    ) -> None:
        self._require_begin()
        self._uia_pending.append(_PendingUia(tree_text=tree_text, hwnd=hwnd, pid=pid, note=note))

    def add_focus_event(
        self,
        hwnd: int,
        title: str,
        process_name: str,
        t_utc: str | None = None,
    ) -> None:
        self._require_begin()
        self._focus_events.append(
            FocusEvent(
                t_utc=t_utc or self.clock(),
                hwnd=int(hwnd),
                title=str(title),
                process_name=str(process_name),
            )
        )

    def set_ground_truth(self, ground_truth: dict[str, Any]) -> None:
        self._require_begin()
        self._ground_truth = dict(ground_truth)

    def set_display_config(self, display_config: dict[str, Any]) -> None:
        self._require_begin()
        self._display_config = dict(display_config)

    def finish(self) -> DesktopTrace:
        trace_dir = self._require_begin()
        for pending in self._uia_pending:
            self._uia_counter += 1
            snapshot_id = f"uia-{self._uia_counter}"
            rel_path = f"uia/{snapshot_id}.txt"
            (trace_dir / rel_path).write_text(pending.tree_text, encoding="utf-8")
            self._uia_snapshots.append(
                UiaSnapshot(
                    snapshot_id=snapshot_id,
                    tree_text=None,
                    tree_path=rel_path,
                    captured_at_utc=self.clock(),
                    window_hwnd=pending.hwnd,
                    pid=pending.pid,
                    note=pending.note,
                )
            )
        self._uia_pending = []
        trace = DesktopTrace(
            trace_id=self.trace_id,
            recorded_at_utc=self.started_at_utc or self.clock(),
            frames=self._frames,
            uia_snapshots=self._uia_snapshots,
            pointer_trace=self._pointer_samples,
            cdp_snapshots=[],
            focus_events=self._focus_events,
            display_config=self._display_config,
            ground_truth=self._ground_truth,
        )
        (trace_dir / "trace.json").write_text(
            json.dumps(trace.to_dict(), indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
        return trace
