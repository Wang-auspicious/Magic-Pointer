
from __future__ import annotations

import base64
import sys
import time
from typing import Any, TextIO

PROGRESS_PREFIX = "@@mp"


def _token(value: Any) -> str:
    text = str(value)
    out = []
    for ch in text:
        out.append("_" if ch.isspace() else ch)
    token = "".join(out)
    return token[:120] if token else "-"


class PhaseClock:

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
            self.enabled = False
        return total_ms

    def mark_blob(self, phase: str, blob: str) -> float:
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
        breakdown = ",".join(f"{name}:{int(ms)}" for name, ms in self._marks)
        if breakdown:
            fields.setdefault("breakdown", breakdown)
        return self.mark(phase, **fields)


def null_clock(scope: str = "none") -> PhaseClock:
    return PhaseClock(scope, enabled=False)


STREAM_FLUSH_INTERVAL_S = 0.12


class StreamChunkBuffer:

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
        self._last_flush = 0.0

    def append(self, text: str) -> None:
        if not text or self.clock is None:
            return
        self._pending.append(str(text))
        if time.perf_counter() - self._last_flush >= self.interval_s:
            self.flush()

    def flush(self) -> None:
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
