"""Bridge channel for the on-screen twin cursor.

This is the last hop of the twin cursor, and the one that was missing: the
driver knows where it is about to click and how long the flight will take
(:class:`~app.computer_operator.windows.ApproachObserver`), the Electron side
knows how to draw and animate a cursor, and nothing carried the news between
them. The cursor existed and followed the pointer; it was never *pointed* at
anything.

The transport is the bridge progress channel, because it is the only structured
line the Python side already has to the main process: ``@@mp phase=... k=v`` on
stderr, parsed by ``electron/bridge_progress_lines.ts`` and handed to each
bridge's ``onProgress``. Adding a second transport for one message would mean a
second thing to keep alive.

Everything except the line format lives here rather than in the driver, so it
can be tested without Windows, without a display and without a model.
"""

from __future__ import annotations

from typing import Any, Callable, Protocol

#: Phase name the main process reacts to. Changing this means changing
#: ``handleAgentCursorProgress`` in ``electron/main.ts`` as well.
AGENT_CURSOR_PHASE = "agent_cursor"

#: Cursor id used for the single agent cursor. Clicky's model is addressable —
#: several cursors, each with its own accent and lifetime — so the wire carries
#: an id from the start; today only one cursor is ever emitted.
DEFAULT_CURSOR_ID = "agent"

#: Actions the renderer understands. ``approach`` begins a flight and must
#: arrive before the press; ``click`` is the press itself; ``idle`` releases
#: the cursor back to following the pointer.
ACTION_APPROACH = "approach"
ACTION_CLICK = "click"
ACTION_IDLE = "idle"


class ProgressSink(Protocol):
    """The subset of :class:`~scripts.bridge_progress.PhaseClock` used here."""

    def mark(self, phase: str, **fields: Any) -> float: ...


def _as_resolver(
    sink: "ProgressSink | Callable[[], ProgressSink | None] | None",
) -> "Callable[[], ProgressSink | None]":
    """Normalize a sink-or-provider into a provider."""
    """Normalize a sink-or-provider into a provider."""
    if sink is None:
        return lambda: None
    if callable(sink):
        return sink  # type: ignore[return-value]
    return lambda: sink


class AgentCursorEmitter:
    """Turns driver callbacks into progress rows for the main process.

    Implements the driver's ``ApproachObserver`` protocol. Every method is
    total and silent on failure: a cursor that cannot be announced must never
    stop the click it was announcing. The twin cursor is a display concern, and
    a display concern that can kill the action it is displaying is worse than
    no display.
    """

    def __init__(
        self,
        sink: ProgressSink | Callable[[], ProgressSink | None] | None,
        *,
        cursor_id: str = DEFAULT_CURSOR_ID,
    ) -> None:
        """``sink`` is a progress sink, or a zero-argument callable returning
        one.

        The callable form matters and the direct form is a trap: the input
        driver is constructed while the plugin tree boots, which is *before*
        the bridge knows which clock it will report on, so a sink captured at
        construction time is ``None`` forever and the cursor is silently never
        announced. Passing ``lambda: sink`` defers the lookup to the moment a
        move actually happens, which is the only moment the answer is known.
        """
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
        """Announce where the pointer is going, and how long it will take.

        The driver then spends ``lead_ms`` gliding, so the drawn cursor and the
        real one arrive together and the press lands after both.
        """
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
        """Release the cursor back to plain following, if it was ever placed."""
        if self._last_point is None:
            return
        self._emit(ACTION_IDLE, self._last_point)


#: Where the twin cursor's progress sink lives.
#
#: Module-level rather than passed down because the input driver is built in
#: two unrelated places — ``app.desktop_actions.session._live_driver`` and
#: ``WindowsComputerOperatorBackend.__init__`` — both lazily, both by callers
#: with no way to hand one in, and both *before* the bridge knows which clock
#: it will report on. Keeping the sink here (rather than in either caller) is
#: what lets both read it at the moment they announce something instead of at
#: the moment they are constructed. ``None`` is the default and means "no
#: cursor"; a stale sink is harmless because every turn replaces it.
_agent_cursor_sink: "ProgressSink | None" = None


def set_agent_cursor_sink(sink: "ProgressSink | None") -> None:
    """Point the twin cursor at ``sink``, or at nothing when ``None``."""
    global _agent_cursor_sink
    _agent_cursor_sink = sink


def current_agent_cursor_sink() -> "ProgressSink | None":
    """The sink in force right now, or ``None``."""
    return _agent_cursor_sink


def agent_cursor_observer() -> AgentCursorEmitter:
    """An observer that follows whatever sink is current.

    Always returns an emitter. An emitter with no sink is a no-op, which is the
    behaviour we want; an emitter that was never attached is not, because it
    can never start working once a sink appears.
    """
    return AgentCursorEmitter(current_agent_cursor_sink)
