
from __future__ import annotations

from typing import Any, Callable, Protocol

AGENT_CURSOR_PHASE = "agent_cursor"

DEFAULT_CURSOR_ID = "agent"

ACTION_APPROACH = "approach"
ACTION_CLICK = "click"
ACTION_IDLE = "idle"


class ProgressSink(Protocol):

    def mark(self, phase: str, **fields: Any) -> float: ...


def _as_resolver(
    sink: "ProgressSink | Callable[[], ProgressSink | None] | None",
) -> "Callable[[], ProgressSink | None]":
    if sink is None:
        return lambda: None
    if callable(sink):
        return sink  # type: ignore[return-value]
    return lambda: sink


class AgentCursorEmitter:

    def __init__(
        self,
        sink: ProgressSink | Callable[[], ProgressSink | None] | None,
        *,
        cursor_id: str = DEFAULT_CURSOR_ID,
    ) -> None:
        self._resolve = _as_resolver(sink)
        self._cursor_id = str(cursor_id or DEFAULT_CURSOR_ID)
        self._last_point: tuple[int, int] | None = None

    @property
    def enabled(self) -> bool:
        return self._resolve() is not None

    def _emit(self, action: str, point: tuple[int, int], **extra: Any) -> None:
        sink = self._resolve()
        if sink is None:
            return
        try:
            sink.mark(
                AGENT_CURSOR_PHASE,
                id=self._cursor_id,
                action=action,
                x=int(point[0]),
                y=int(point[1]),
                **extra,
            )
        except Exception:  # noqa: BLE001 -- announcing a cursor never fails an action
            return

    def cursor_approach(self, point: tuple[int, int], *, lead_ms: int) -> None:
        self._last_point = (int(point[0]), int(point[1]))
        self._emit(ACTION_APPROACH, self._last_point, leadMs=max(0, int(lead_ms)))

    def cursor_clicked(self, point: tuple[int, int], *, button: str, count: int) -> None:
        self._emit(
            ACTION_CLICK,
            (int(point[0]), int(point[1])),
            button=str(button or "left"),
            count=max(1, int(count)),
        )

    def idle(self) -> None:
        if self._last_point is None:
            return
        self._emit(ACTION_IDLE, self._last_point)


_agent_cursor_sink: "ProgressSink | None" = None


def set_agent_cursor_sink(sink: "ProgressSink | None") -> None:
    global _agent_cursor_sink
    _agent_cursor_sink = sink


def current_agent_cursor_sink() -> "ProgressSink | None":
    return _agent_cursor_sink


def agent_cursor_observer() -> AgentCursorEmitter:
    return AgentCursorEmitter(current_agent_cursor_sink)
