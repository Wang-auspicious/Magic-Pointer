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

import base64
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


#: Streaming deltas are throttled to this window. Too tight floods the stderr
#: line protocol with one row per token; too loose leaves the user watching an
#: empty card. 120 ms is below the threshold where text stops reading as
#: continuous and far above one row per token.
STREAM_FLUSH_INTERVAL_S = 0.12


class StreamChunkBuffer:
    """Buffers model text deltas and flushes them as base64 progress rows.

    The receiving end of this channel — ``electron/main.ts`` reacting to
    ``phase=answer_chunk`` — predates the sending end by a long way, and the
    two bridges that drive it each grew their own copy of this buffering. One
    of them never got written at all, so the selection surface showed the
    whole answer at once while the Studio surface streamed it. Shared here so
    there is one implementation to have, and one implementation to forget.

    ``clock`` may be ``None``; the buffer then accumulates nothing and flushes
    nothing, which is what a bridge running without progress reporting wants.

    Nothing here may raise. Streaming is a display concern, and a display
    concern that can kill the turn it is displaying is worse than no display.
    """

    def __init__(
        self,
        clock: PhaseClock | None,
        phase: str,
        *,
        interval_s: float = STREAM_FLUSH_INTERVAL_S,
    ) -> None:
        self.clock = clock
        self.phase = str(phase)
        self.interval_s = float(interval_s)
        self._pending: list[str] = []
        # Zero rather than "now": the first delta of a turn always flushes, so
        # the first token is painted the moment it arrives instead of waiting
        # out a throttle window. Time-to-first-token is the number the user
        # actually feels; only the deltas after it are worth coalescing.
        self._last_flush = 0.0

    def append(self, text: str) -> None:
        """Add a delta, flushing if the throttle window has elapsed.

        The first call always flushes, whatever the interval."""
        if not text or self.clock is None:
            return
        self._pending.append(str(text))
        if time.perf_counter() - self._last_flush >= self.interval_s:
            self.flush()

    def flush(self) -> None:
        """Send whatever is buffered right now, if anything."""
        if not self._pending or self.clock is None:
            return
        text = "".join(self._pending)
        self._pending.clear()
        self._last_flush = time.perf_counter()
        try:
            blob = base64.b64encode(text.encode("utf-8")).decode("ascii")
            self.clock.mark_blob(self.phase, blob)
        except Exception:  # noqa: BLE001 - 流式展示永远不能弄坏回合本身
            self._pending.clear()
