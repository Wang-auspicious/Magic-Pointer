"""ReplayHarness: load a recorded DesktopTrace and iterate it offline.

All file-backed entries are verified on iteration; a missing file raises
ReplayError instead of being silently skipped.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator

from app.replay.trace_schema import DesktopTrace, PointerSample, TraceFrame, UiaSnapshot


class ReplayError(RuntimeError):
    """Raised when a trace is missing, corrupt or references a missing file."""


def _parse_utc(value: str) -> float:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


class ReplayHarness:
    def __init__(self, trace_dir: Path, trace: DesktopTrace) -> None:
        self.trace_dir = Path(trace_dir)
        self.trace = trace

    @classmethod
    def load(cls, trace_dir: Path) -> "ReplayHarness":
        trace_dir = Path(trace_dir)
        trace_path = trace_dir / "trace.json"
        if not trace_path.is_file():
            raise ReplayError(f"trace.json not found under {trace_dir}")
        try:
            payload = json.loads(trace_path.read_text(encoding="utf-8"))
            trace = DesktopTrace.from_dict(payload)
        except ValueError as error:
            raise ReplayError(f"invalid trace {trace_path}: {error}") from error
        return cls(trace_dir=trace_dir, trace=trace)

    def frames(self) -> Iterator[TraceFrame]:
        for frame in self.trace.frames:
            path = self.trace_dir / frame.png_path
            if not path.is_file():
                raise ReplayError(f"frame file missing: {frame.png_path}")
            yield frame

    def uia_snapshots(self) -> Iterator[UiaSnapshot]:
        for snapshot in self.trace.uia_snapshots:
            if snapshot.tree_path is not None:
                path = self.trace_dir / snapshot.tree_path
                if not path.is_file():
                    raise ReplayError(f"UIA snapshot file missing: {snapshot.tree_path}")
            yield snapshot

    def pointer_samples(self) -> Iterator[PointerSample]:
        yield from self.trace.pointer_trace

    def stats(self) -> dict[str, int | float]:
        frames = len(self.trace.frames)
        snapshots = len(self.trace.uia_snapshots)
        samples = len(self.trace.pointer_trace)
        return {
            "frames": frames,
            "uia_snapshots": snapshots,
            "pointer_samples": samples,
            "cdp_snapshots": len(self.trace.cdp_snapshots),
            "focus_events": len(self.trace.focus_events),
            "duration_seconds": self._duration_seconds(),
        }

    def _duration_seconds(self) -> float:
        pointer_times = [_parse_utc(sample.t_utc) for sample in self.trace.pointer_trace]
        if pointer_times:
            return max(pointer_times) - min(pointer_times)
        frame_times = [_parse_utc(frame.captured_at_utc) for frame in self.trace.frames]
        if frame_times:
            return max(frame_times) - min(frame_times)
        return 0.0

    def timestamp_of_first_frame(self) -> str | None:
        if not self.trace.frames:
            return None
        return self.trace.frames[0].captured_at_utc

    def timestamp_of_first_pointer_sample(self) -> str | None:
        if not self.trace.pointer_trace:
            return None
        return self.trace.pointer_trace[0].t_utc

    def timestamp_of_last_pointer_sample(self) -> str | None:
        if not self.trace.pointer_trace:
            return None
        return self.trace.pointer_trace[-1].t_utc
