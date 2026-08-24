"""Phase timing for Electron-facing bridges.

The Electron side accumulates stdout and only parses its last line when the
process exits, so a bridge that wants to say something *while* it works has to
use stderr. ``python_bridge_runner`` streams stderr through a splitter that
picks out lines shaped like::

    @@mp phase=structured_read ms=412 hit=uia

Everything else on stderr keeps flowing into ``data/runtime/electron.log``
untouched. Emission is deliberately unconditional: the timings we need are the
ones from a real run on a real machine, and a diagnostic that has to be armed
ahead of time is a diagnostic nobody has when it matters.
"""

from __future__ import annotations

import sys
import time
from typing import Any, TextIO

PROGRESS_PREFIX = "@@mp"


def _token(value: Any) -> str:
    """Collapse a value into a whitespace-free token the line parser accepts."""
    text = str(value)
    out = []
    for ch in text:
        out.append("_" if ch.isspace() else ch)
    token = "".join(out)
    return token[:120] if token else "-"


class PhaseClock:
    """Wall-clock stopwatch that reports each phase boundary as it is reached.

    Phases are cumulative from construction (``ms``) and also carry the gap
    since the previous mark (``d``), because "which step was slow" and "how
    long until the user saw anything" are different questions.
    """

    def __init__(self, scope: str, *, stream: TextIO | None = None, enabled: bool = True) -> None:
        self.scope = _token(scope)
        self.enabled = enabled
        self._stream = stream if stream is not None else sys.stderr
        self._start = time.perf_counter()
        self._last = self._start
        self._marks: list[tuple[str, float]] = []

    def _elapsed_ms(self) -> float:
        return (time.perf_counter() - self._start) * 1000.0

    def mark(self, phase: str, **fields: Any) -> float:
        """Record a phase boundary and return milliseconds since construction."""
        now = time.perf_counter()
        total_ms = (now - self._start) * 1000.0
        delta_ms = (now - self._last) * 1000.0
        self._last = now
        self._marks.append((str(phase), total_ms))
        if not self.enabled:
            return total_ms
        parts = [
            PROGRESS_PREFIX,
            f"phase={_token(phase)}",
            f"ms={int(total_ms)}",
            f"d={int(delta_ms)}",
            f"scope={self.scope}",
        ]
        for key, value in fields.items():
            parts.append(f"{_token(key)}={_token(value)}")
        try:
            self._stream.write(" ".join(parts) + "\n")
            self._stream.flush()
        except Exception:
            # Diagnostics must never be able to fail a capture.
            self.enabled = False
        return total_ms

    def mark_blob(self, phase: str, blob: str) -> float:
        """mark() 变体：blob 原样作为一个 token 上线，不做 120 字符截断。

        base64 载荷（计划快照、流式正文增量）天然无空白，但会超过 _token
        的截断上限——多步计划的 JSON 一旦被截断，解码端就静默失败。调用方
        必须保证 blob 不含空白字符。
        """
        now = time.perf_counter()
        total_ms = (now - self._start) * 1000.0
        delta_ms = now - self._last
        self._last = now
        self._marks.append((str(phase), total_ms))
        if not self.enabled:
            return total_ms
        parts = [
            PROGRESS_PREFIX,
            f"phase={_token(phase)}",
            f"ms={int(total_ms)}",
            f"d={int(delta_ms)}",
            f"scope={self.scope}",
            f"b64={blob}",
        ]
        try:
            self._stream.write(" ".join(parts) + "\n")
            self._stream.flush()
        except Exception:
            self.enabled = False
        return total_ms

    def total(self, phase: str = "total", **fields: Any) -> float:
        """Emit a closing mark carrying the per-phase breakdown."""
        breakdown = ",".join(f"{name}:{int(ms)}" for name, ms in self._marks)
        if breakdown:
            fields.setdefault("breakdown", breakdown)
        return self.mark(phase, **fields)


def null_clock(scope: str = "none") -> PhaseClock:
    """A clock that measures but never writes — for tests and library use."""
    return PhaseClock(scope, enabled=False)
