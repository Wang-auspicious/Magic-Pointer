"""Addressable multi-cursor model behind the Windows twin cursor.

The structural idea being ported is openclicky's: the twin cursor is a
**first-class addressable surface**, not a side effect of an action. An agent
can say "put a marker here" without touching the pointer, and several markers
can be alive at once, each with its own accent colour and lifetime
(``CompanionManager.swift:37-42``, rendered at ``OverlayWindow.swift:1113-1132``).

This module is deliberately pure. It has no ctypes, no Electron, no
``time.time()``: every public method takes the clock as an argument, so the
whole motion model is reproducible in a test at whatever frame rate the test
wants to simulate. The values are the Clicky family's, cited in
``docs/research/2026-09-16-clicky-twin-cursor.md``:

- flight duration ``min(max(distance / 800, 0.6), 1.4)`` s
  (``clicky/OverlayWindow.swift:510``) — reused from :mod:`.motion` so the
  driver and the cursor can never disagree about how long a hop takes
- flight easing is smoothstep on the Bézier parameter, the path is a quadratic
  Bézier with the control point raised ``min(distance * 0.2, 80)`` px
  (``:521``, ``:540``), and the avatar rotates to the curve tangent and pulses
  to ``1.3x`` at the apex (``:561``, ``:566``)
- dwell at the target is 3000 ms (``:592``), the return leg is a flat 1400 ms
  (``clicky-windows/ui/overlay.py:164``)
- the ring is radius ``26 + pulse * 6`` (``ui/overlay.py:272``, ``:695``) with
  the phase advanced ``0.08`` per 16 ms tick (``:506``)
- the click glow lives 2400 ms, clamped to ``[400, 12000]``
  (``openclicky/CompanionManager.swift:2921``, ``:2939``)
- the idle follow spring is the explicit 60 Hz integrator from
  ``ui/overlay.py:492-502`` — ``stiffness 0.28``, ``damping 0.62``, evaluated
  with no dt term, which is why the tick length is part of the spec rather
  than an implementation detail

Nothing here hides or moves the OS pointer. None of the three reference
implementations ever calls ``SetCursorPos``/``NSCursor.hide`` for the twin
cursor, and this model does not either: the human cursor keeps rendering
natively, and the twin is a companion drawn at ``pointer + (35, 25)``.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from enum import Enum
from typing import Any

from .motion import distance_between, flight_duration_ms, smoothstep

# --------------------------------------------------------------------------
# Clicky motion spec. Named, not inlined: these are the numbers the product
# feels like, and ``tests/agent_cursor_model_test.py`` pins the four the brief
# calls out.
# --------------------------------------------------------------------------

#: Where the twin sits relative to the real pointer while following it.
#: ``clicky/OverlayWindow.swift:348`` and ``:439-440``.
OFFSET_X = 35
OFFSET_Y = 25

#: Avatar geometry. ``clicky/OverlayWindow.swift:307``; ``ui/overlay.py:38``.
TRIANGLE_SIZE = 16
TRIANGLE_REST_DEGREES = -35.0

#: ``ui/overlay.py:43``. The default accent for a cursor that does not choose
#: one, so a caller that only has a screen point still gets a coloured cursor.
ACCENT_BLUE = "#3380FF"

#: Idle follow spring, per 16 ms tick. ``ui/overlay.py:492-502``.
SPRING_STIFFNESS = 0.28
SPRING_DAMPING = 0.62
TICK_MS = 16

#: How many ticks a single ``tick()`` call may catch up on. A stalled renderer
#: must not replay a backlog of spring steps as one jump, and a monotonic clock
#: that advanced by ten seconds must not integrate ten seconds of spring.
TICK_CATCHUP_MAX = 8

#: Below this distance and speed the spring is snapped shut. The integrator is
#: asymptotic and would otherwise never actually arrive, which makes
#: "did it reach the target" untestable and leaves a sub-pixel crawl forever.
SPRING_SNAP_PX = 0.5
SPRING_SNAP_VELOCITY = 0.5

#: Dwell at the target. ``clicky/OverlayWindow.swift:592``.
DWELL_MS = 3000

#: The return leg is a flat 1400 ms regardless of distance.
#: ``clicky-windows/ui/overlay.py:164``.
RETURN_MS = 1400

#: Flight arc: control point raised ``min(distance * ARC_FRACTION, ARC_MAX_PX)``.
ARC_FRACTION = 0.20
ARC_MAX_PX = 80.0

#: Scale pulse at the apex: ``1.0 + sin(progress * pi) * SCALE_PULSE``.
SCALE_PULSE = 0.30

#: Ring geometry and phase step per tick. ``ui/overlay.py:272``, ``:506``,
#: ``:695``.
RING_BASE_RADIUS = 26.0
RING_PULSE_PX = 6.0
RING_PHASE_STEP = 0.08
RING_PHASE_PER_MS = RING_PHASE_STEP / float(TICK_MS)

#: Click glow, clamped. ``openclicky/CompanionManager.swift:2921``, ``:2939``.
GLOW_MS = 2400
GLOW_MIN_MS = 400
GLOW_MAX_MS = 12000

#: A cursor may not be given a lifetime shorter than this: openclicky floors
#: the TTL at 0.2 s (``CompanionManager.swift:2531-2534``) so that a caller
#: passing 0 gets a visible flash rather than an invisible no-op.
TTL_MIN_MS = 200

#: A secondary cursor with no stated lifetime gets one. openclicky refuses to
#: leave the TTL infinite when the caller omits it
#: (``CompanionManager.swift:545-551``); an orphaned cursor that never expires
#: is indistinguishable from a stuck one.
DEFAULT_TTL_MS = 2000

#: A pointer move larger than this during the *return* leg cancels the return
#: and snaps back to following the pointer (``clicky/OverlayWindow.swift:426``).
#: During the forward flight the pointer is ignored entirely (``:416-419``).
CANCEL_DISTANCE_PX = 100.0


class CursorState(str, Enum):
    """Where a cursor is in its lifecycle.

    ``idle`` follows the pointer, ``flying`` is on a scripted Bézier leg,
    ``dwelling`` is planted on a target it was pointed at, and ``clicking`` is
    showing the post-click glow.
    """

    IDLE = "idle"
    FLYING = "flying"
    DWELLING = "dwelling"
    CLICKING = "clicking"


#: The two reasons a cursor is ever on a Bézier. The approach leg lands on a
#: target and then dwells; the return leg goes back to the follow anchor and
#: then resumes following.
APPROACH = "approach"
RETURN = "return"


def ring_pulse(phase: float) -> float:
    """Ring brightness in ``[0, 1]`` from a phase. ``ui/overlay.py:694-695``."""
    return (math.sin(phase) + 1.0) / 2.0


def ring_radius(pulse: float) -> float:
    """Ring radius in pixels: ``26 + pulse * 6``. ``ui/overlay.py:695``."""
    clamped = 0.0 if pulse < 0.0 else 1.0 if pulse > 1.0 else pulse
    return RING_BASE_RADIUS + clamped * RING_PULSE_PX


def flight_scale(progress: float) -> float:
    """Avatar scale during a flight: ``1 + sin(progress * pi) * 0.30``.

    Peaks at the apex of the arc, which is what makes the avatar read as
    "thrown" rather than "slid": ``clicky/OverlayWindow.swift:565-566``.
    """
    clamped = 0.0 if progress < 0.0 else 1.0 if progress > 1.0 else progress
    return 1.0 + math.sin(clamped * math.pi) * SCALE_PULSE


def arc_height(distance: float) -> float:
    """Control-point lift for a flight of ``distance`` pixels."""
    return min(max(0.0, distance) * ARC_FRACTION, ARC_MAX_PX)


def bezier_point(
    start: tuple[float, float],
    control: tuple[float, float],
    end: tuple[float, float],
    t: float,
) -> tuple[float, float]:
    """Quadratic Bézier evaluated at ``t``."""
    inverse = 1.0 - t
    x = inverse * inverse * start[0] + 2.0 * inverse * t * control[0] + t * t * end[0]
    y = inverse * inverse * start[1] + 2.0 * inverse * t * control[1] + t * t * end[1]
    return (x, y)


def bezier_tangent(
    start: tuple[float, float],
    control: tuple[float, float],
    end: tuple[float, float],
    t: float,
) -> tuple[float, float]:
    """First derivative of the quadratic Bézier at ``t``."""
    x = 2.0 * (1.0 - t) * (control[0] - start[0]) + 2.0 * t * (end[0] - control[0])
    y = 2.0 * (1.0 - t) * (control[1] - start[1]) + 2.0 * t * (end[1] - control[1])
    return (x, y)


def build_flight(
    start: tuple[float, float],
    end: tuple[float, float],
    *,
    now_ms: int,
    duration_ms: int,
    purpose: str,
) -> _Flight:
    """A flight from ``start`` to ``end`` with Clicky's arc and timing.

    ``duration_ms <= 0`` means "derive it": distance over 800 px/s with the
    600 ms floor and the 1400 ms ceiling, except on the return leg, which is a
    flat 1400 ms regardless of distance (``ui/overlay.py:164``).
    """
    resolved = int(duration_ms)
    if resolved <= 0:
        if purpose == RETURN:
            resolved = RETURN_MS
        else:
            resolved = flight_duration_ms(
                distance_between(
                    (round(start[0]), round(start[1])),
                    (round(end[0]), round(end[1])),
                )
            )
    distance = distance_between(
        (round(start[0]), round(start[1])),
        (round(end[0]), round(end[1])),
    )
    return _Flight(
        start=(start[0], start[1]),
        control=(
            (start[0] + end[0]) / 2.0,
            (start[1] + end[1]) / 2.0 - arc_height(distance),
        ),
        end=(end[0], end[1]),
        started_ms=now_ms,
        duration_ms=resolved,
        purpose=purpose,
    )


def rotation_degrees(
    start: tuple[float, float],
    control: tuple[float, float],
    end: tuple[float, float],
    t: float,
) -> float:
    """Avatar rotation following the curve tangent.

    ``+90`` because the triangle's tip points up at rest
    (``clicky/OverlayWindow.swift:561``, ``ui/overlay.py:429``). A degenerate
    tangent falls back to the rest angle instead of ``atan2(0, 0)``'s zero.
    """
    tangent_x, tangent_y = bezier_tangent(start, control, end, t)
    if tangent_x == 0.0 and tangent_y == 0.0:
        return TRIANGLE_REST_DEGREES
    return math.degrees(math.atan2(tangent_y, tangent_x)) + 90.0


@dataclass(frozen=True)
class CursorFrame:
    """One cursor as the renderer needs it for a single frame.

    Positions are rounded to whole pixels here and only here — the model
    integrates in floats so that a slow spring does not stall on rounding, and
    the wire format stays close to what ``SetCursorPos``-space consumers expect.
    """

    cursor_id: str
    x: int
    y: int
    accent: str
    state: str
    scale: float
    rotation_degrees: float
    caption: str | None
    ring_radius: float | None
    glow_remaining_ms: int
    ttl_remaining_ms: int | None

    def as_payload(self) -> dict[str, Any]:
        """JSON-ready form for the Electron bridge."""
        return {
            "id": self.cursor_id,
            "x": self.x,
            "y": self.y,
            "accent": self.accent,
            "state": self.state,
            "scale": round(self.scale, 4),
            "rotation": round(self.rotation_degrees, 3),
            "caption": self.caption,
            "ringRadius": None if self.ring_radius is None else round(self.ring_radius, 3),
            "glowMs": self.glow_remaining_ms,
            "ttlMs": self.ttl_remaining_ms,
        }


@dataclass
class _Flight:
    start: tuple[float, float]
    control: tuple[float, float]
    end: tuple[float, float]
    started_ms: int
    duration_ms: int
    purpose: str

    def progress(self, now_ms: int) -> float:
        if self.duration_ms <= 0:
            return 1.0
        return min(1.0, max(0.0, (now_ms - self.started_ms) / float(self.duration_ms)))


@dataclass
class Cursor:
    """One addressable cursor. Mutated only through :class:`CursorRegistry`."""

    cursor_id: str
    x: float
    y: float
    accent: str = ACCENT_BLUE
    caption: str | None = None
    state: str = CursorState.IDLE.value
    follow_pointer: bool = True
    target_x: float = 0.0
    target_y: float = 0.0
    velocity_x: float = 0.0
    velocity_y: float = 0.0
    created_ms: int = 0
    expires_ms: int | None = None
    ring_phase: float = 0.0
    ring_visible: bool = False
    glow_until_ms: int = 0
    dwell_until_ms: int = 0
    #: While held, the dwell never expires — the cursor stays planted on the
    #: target for as long as the agent is still talking about it
    #: (``clicky-windows/ui/overlay.py:281-297``).
    hold_dwell: bool = False
    flight: _Flight | None = None
    scale: float = 1.0
    rotation: float = TRIANGLE_REST_DEGREES
    #: Pointer position observed when the return leg started; a large move
    #: after that cancels the return.
    return_anchor: tuple[float, float] | None = None

    # -- state queries ----------------------------------------------------

    def ring_radius(self) -> float | None:
        if not self.ring_visible:
            return None
        return ring_radius(ring_pulse(self.ring_phase))

    def frame(self, now_ms: int) -> CursorFrame:
        remaining_glow = 0
        if self.state == CursorState.CLICKING.value and self.glow_until_ms > now_ms:
            remaining_glow = int(self.glow_until_ms - now_ms)
        ttl_remaining: int | None = None
        if self.expires_ms is not None:
            ttl_remaining = max(0, int(self.expires_ms - now_ms))
        return CursorFrame(
            cursor_id=self.cursor_id,
            x=int(round(self.x)),
            y=int(round(self.y)),
            accent=self.accent,
            state=self.state,
            scale=self.scale,
            rotation_degrees=self.rotation,
            caption=self.caption,
            ring_radius=self.ring_radius(),
            glow_remaining_ms=remaining_glow,
            ttl_remaining_ms=ttl_remaining,
        )

    # -- motion -----------------------------------------------------------

    def _advance_flight(self, now_ms: int) -> None:
        flight = self.flight
        if flight is None:
            return
        progress = flight.progress(now_ms)
        eased = smoothstep(progress)
        point = bezier_point(flight.start, flight.control, flight.end, eased)
        self.x, self.y = point
        self.scale = flight_scale(progress)
        self.rotation = rotation_degrees(flight.start, flight.control, flight.end, eased)
        if progress < 1.0:
            return
        # Land exactly. The Bézier is exact at t == 1, but the eased parameter
        # plus float rounding can leave a fraction of a pixel behind, and a
        # cursor that stops 0.4 px off its target is a cursor that missed.
        self.x, self.y = flight.end
        self.scale = 1.0
        self.rotation = TRIANGLE_REST_DEGREES
        self.flight = None
        if flight.purpose == APPROACH:
            self.state = CursorState.DWELLING.value
            # Ring keeps marking the target through the dwell; the dwell shows
            # the user what was pointed at before anything else moves.
            if not self.hold_dwell:
                self.dwell_until_ms = now_ms + DWELL_MS
        else:
            self.state = CursorState.IDLE.value
            self.ring_visible = False
            self.return_anchor = None
            self.velocity_x = 0.0
            self.velocity_y = 0.0

    def begin_return(
        self,
        pointer: tuple[float, float] | None,
        now_ms: int,
    ) -> None:
        """Leave the target and fly back to the follow anchor.

        With no pointer sample the cursor simply stops dwelling where it is;
        inventing an anchor would move the twin somewhere the user never put
        their cursor.
        """
        self.ring_visible = False
        self.dwell_until_ms = 0
        self.hold_dwell = False
        if pointer is None:
            self.state = CursorState.IDLE.value
            return
        self.flight = build_flight(
            (self.x, self.y),
            (pointer[0] + OFFSET_X, pointer[1] + OFFSET_Y),
            now_ms=now_ms,
            duration_ms=RETURN_MS,
            purpose=RETURN,
        )
        self.state = CursorState.FLYING.value
        self.return_anchor = pointer

    def _advance_spring(self, steps: int) -> None:
        for _ in range(steps):
            accel_x = (self.target_x - self.x) * SPRING_STIFFNESS
            accel_y = (self.target_y - self.y) * SPRING_STIFFNESS
            self.velocity_x = self.velocity_x * SPRING_DAMPING + accel_x
            self.velocity_y = self.velocity_y * SPRING_DAMPING + accel_y
            self.x += self.velocity_x
            self.y += self.velocity_y
            if (
                abs(self.target_x - self.x) <= SPRING_SNAP_PX
                and abs(self.target_y - self.y) <= SPRING_SNAP_PX
                and abs(self.velocity_x) <= SPRING_SNAP_VELOCITY
                and abs(self.velocity_y) <= SPRING_SNAP_VELOCITY
            ):
                # Asymptotic integrator: close enough is arrived.
                self.x = self.target_x
                self.y = self.target_y
                self.velocity_x = 0.0
                self.velocity_y = 0.0
                return

    def advance(self, now_ms: int, steps: int, pointer: tuple[float, float] | None) -> None:
        """Advance this cursor to ``now_ms``.

        ``steps`` is the number of whole ``TICK_MS`` intervals elapsed since the
        previous advance, so the spring is a function of the clock rather than
        of how often the caller happened to call in.
        """
        if self.follow_pointer and self.state in {
            CursorState.IDLE.value,
            CursorState.CLICKING.value,
        }:
            if pointer is not None:
                self.target_x = pointer[0] + OFFSET_X
                self.target_y = pointer[1] + OFFSET_Y
        if (
            self.flight is not None
            and self.flight.purpose == RETURN
            and self.return_anchor is not None
            and pointer is not None
            and math.hypot(
                pointer[0] - self.return_anchor[0],
                pointer[1] - self.return_anchor[1],
            )
            > CANCEL_DISTANCE_PX
        ):
            # The user grabbed the mouse mid-return: the twin stops playing
            # catch-up and just follows. ``clicky/OverlayWindow.swift:426``.
            self.flight = None
            self.state = CursorState.IDLE.value
            self.ring_visible = False
            self.return_anchor = None
            self.scale = 1.0
            self.rotation = TRIANGLE_REST_DEGREES
            self.velocity_x = 0.0
            self.velocity_y = 0.0
        if self.state == CursorState.FLYING.value:
            self._advance_flight(now_ms)
        elif self.state == CursorState.DWELLING.value:
            if not self.hold_dwell and self.dwell_until_ms and now_ms >= self.dwell_until_ms:
                self.begin_return(pointer, now_ms)
        elif self.state == CursorState.IDLE.value and steps > 0:
            self._advance_spring(steps)
        elif self.state == CursorState.CLICKING.value:
            if now_ms >= self.glow_until_ms:
                self.state = CursorState.IDLE.value
                self.glow_until_ms = 0
            elif steps > 0:
                self._advance_spring(steps)
        if self.ring_visible:
            # Phase advances with the clock, not with the call count, so a
            # dropped frame does not slow the pulse.
            self.ring_phase += RING_PHASE_PER_MS * (steps * TICK_MS)
            if self.ring_phase > math.tau * 1024.0:
                self.ring_phase = math.fmod(self.ring_phase, math.tau)


class CursorRegistry:
    """The set of live cursors, and the only thing that moves them.

    The clock is a parameter everywhere. ``tick`` refuses to move backwards: a
    caller that passes a stale timestamp gets the previous frame's state rather
    than a rewound animation.
    """

    def __init__(self, *, default_ttl_ms: int | None = None) -> None:
        self._cursors: dict[str, Cursor] = {}
        self._pointer: tuple[float, float] | None = None
        self._now_ms: int | None = None
        self._last_tick_ms: int | None = None
        self.default_ttl_ms = default_ttl_ms

    # -- registry ---------------------------------------------------------

    def __contains__(self, cursor_id: str) -> bool:
        return str(cursor_id) in self._cursors

    def __len__(self) -> int:
        return len(self._cursors)

    def ids(self) -> list[str]:
        return list(self._cursors)

    def get(self, cursor_id: str) -> CursorFrame | None:
        cursor = self._cursors.get(str(cursor_id))
        if cursor is None:
            return None
        return cursor.frame(self._now_ms or 0)

    def spawn(
        self,
        cursor_id: str,
        position: tuple[float, float],
        *,
        accent: str = ACCENT_BLUE,
        ttl_ms: int | None = None,
        caption: str | None = None,
        follow_pointer: bool = False,
        now_ms: int | None = None,
    ) -> CursorFrame:
        """Add (or replace) a cursor at ``position``.

        ``follow_pointer`` is for the single primary twin; secondary markers
        get ``False`` and stay where they were told, which is what makes two
        cursors non-interfering rather than two things chasing one pointer.
        """
        now = self._effective_now(now_ms)
        lifetime = self.default_ttl_ms if ttl_ms is None else int(ttl_ms)
        expires: int | None = None
        if lifetime is not None:
            expires = now + max(TTL_MIN_MS, int(lifetime))
        cursor = Cursor(
            cursor_id=str(cursor_id),
            x=float(position[0]),
            y=float(position[1]),
            accent=str(accent or ACCENT_BLUE),
            caption=caption,
            state=CursorState.IDLE.value,
            follow_pointer=bool(follow_pointer),
            target_x=float(position[0]),
            target_y=float(position[1]),
            created_ms=now,
            expires_ms=expires,
        )
        if follow_pointer and self._pointer is not None:
            cursor.target_x = self._pointer[0] + OFFSET_X
            cursor.target_y = self._pointer[1] + OFFSET_Y
        self._cursors[cursor.cursor_id] = cursor
        return cursor.frame(now)

    def remove(self, cursor_id: str) -> bool:
        return self._cursors.pop(str(cursor_id), None) is not None

    def clear(self) -> list[str]:
        removed = list(self._cursors)
        self._cursors.clear()
        return removed

    def expire(self, now_ms: int | None = None) -> list[str]:
        """Drop cursors whose TTL has run out. Returns the ids removed."""
        now = self._effective_now(now_ms)
        expired = [
            cursor_id
            for cursor_id, cursor in self._cursors.items()
            if cursor.expires_ms is not None and cursor.expires_ms <= now
        ]
        for cursor_id in expired:
            del self._cursors[cursor_id]
        return expired

    # -- pointer / targets ------------------------------------------------

    def set_pointer(self, position: tuple[float, float] | None) -> None:
        """Tell the registry where the real pointer is.

        Called once per sample. Follow-anchored cursors spring toward
        ``position + (OFFSET_X, OFFSET_Y)``; everything else is unaffected.
        """
        self._pointer = None if position is None else (float(position[0]), float(position[1]))

    def set_target(
        self,
        cursor_id: str,
        position: tuple[float, float],
        *,
        now_ms: int | None = None,
    ) -> CursorFrame | None:
        """Move a cursor's resting place without starting a flight.

        This is the "put a marker here" path: the cursor eases across with the
        follow spring rather than arcing, which is what a marker should do.
        """
        cursor = self._cursors.get(str(cursor_id))
        if cursor is None:
            return None
        cursor.target_x = float(position[0])
        cursor.target_y = float(position[1])
        cursor.follow_pointer = False
        cursor.flight = None
        if cursor.state != CursorState.CLICKING.value:
            cursor.state = CursorState.IDLE.value
        return cursor.frame(self._effective_now(now_ms))

    # -- scripted motion --------------------------------------------------

    def begin_flight(
        self,
        cursor_id: str,
        target: tuple[float, float],
        *,
        duration_ms: int = 0,
        purpose: str = APPROACH,
        now_ms: int | None = None,
    ) -> CursorFrame | None:
        """Send a cursor along a Bézier to ``target``.

        ``duration_ms`` of 0 means "derive it from distance" — the Clicky rule
        in :func:`app.computer_operator.motion.flight_duration_ms`, so a 5 px
        hop still takes the 600 ms floor and never teleports.
        """
        cursor = self._cursors.get(str(cursor_id))
        if cursor is None:
            return None
        now = self._effective_now(now_ms)
        cursor.flight = build_flight(
            (cursor.x, cursor.y),
            (float(target[0]), float(target[1])),
            now_ms=now,
            duration_ms=int(duration_ms),
            purpose=purpose,
        )
        cursor.state = CursorState.FLYING.value
        cursor.ring_visible = purpose == APPROACH
        cursor.dwell_until_ms = 0
        cursor.return_anchor = self._pointer if purpose == RETURN else None
        cursor.velocity_x = 0.0
        cursor.velocity_y = 0.0
        return cursor.frame(now)

    def hold(
        self,
        cursor_id: str,
        held: bool = True,
        *,
        now_ms: int | None = None,
    ) -> CursorFrame | None:
        """Pin (or release) a cursor's dwell.

        While held the cursor stays on the target no matter how long the agent
        keeps talking about it. Without this the twin leaves the target
        mid-sentence, which is the single most visible way a pointer overlay
        reads as broken (``clicky-windows/ui/overlay.py:281-297``).
        """
        cursor = self._cursors.get(str(cursor_id))
        if cursor is None:
            return None
        cursor.hold_dwell = bool(held)
        now = self._effective_now(now_ms)
        if not held and cursor.state == CursorState.DWELLING.value:
            # Releasing the hold gives the remaining dwell its full 3000 ms
            # from now, so a release does not immediately yank the cursor away.
            cursor.dwell_until_ms = now + DWELL_MS
        return cursor.frame(now)

    def release_dwell(
        self,
        cursor_id: str,
        *,
        now_ms: int | None = None,
    ) -> CursorFrame | None:
        """End a dwell now and fly back to the follow anchor.

        The release path for TTS: the answer finished, so the cursor stops
        marking the target and goes back to following the pointer.
        """
        cursor = self._cursors.get(str(cursor_id))
        if cursor is None:
            return None
        now = self._effective_now(now_ms)
        if cursor.state != CursorState.DWELLING.value:
            return cursor.frame(now)
        cursor.begin_return(self._pointer, now)
        return cursor.frame(now)

    def click(
        self,
        cursor_id: str,
        *,
        duration_ms: int = GLOW_MS,
        now_ms: int | None = None,
    ) -> CursorFrame | None:
        """Show the click glow. ``duration_ms`` is clamped to ``[400, 12000]``.

        The clamp is openclicky's (``CompanionManager.swift:2939``): a caller
        that passes 0 gets the 400 ms floor rather than an invisible click.
        """
        cursor = self._cursors.get(str(cursor_id))
        if cursor is None:
            return None
        now = self._effective_now(now_ms)
        clamped = int(duration_ms)
        if clamped < GLOW_MIN_MS:
            clamped = GLOW_MIN_MS
        if clamped > GLOW_MAX_MS:
            clamped = GLOW_MAX_MS
        cursor.state = CursorState.CLICKING.value
        cursor.glow_until_ms = now + clamped
        return cursor.frame(now)

    # -- frame production -------------------------------------------------

    def tick(self, now_ms: int | None = None) -> list[CursorFrame]:
        """Advance every cursor and return the frame for each.

        Monotonic and deterministic: the result is a pure function of the
        registry state, the pointer samples, and the timestamps passed in. A
        timestamp older than the last one advances nothing.
        """
        now = self._effective_now(now_ms)
        if self._last_tick_ms is None:
            steps = 0
            self._last_tick_ms = now
        else:
            elapsed = now - self._last_tick_ms
            steps = min(int(elapsed // TICK_MS), TICK_CATCHUP_MAX) if elapsed >= TICK_MS else 0
            if steps:
                self._last_tick_ms += steps * TICK_MS
        for cursor in self._cursors.values():
            cursor.advance(now, steps, self._pointer)
        return [cursor.frame(now) for cursor in self._cursors.values()]

    def frames(self, now_ms: int | None = None) -> list[CursorFrame]:
        """The current frame without advancing anything."""
        now = self._effective_now(now_ms)
        return [cursor.frame(now) for cursor in self._cursors.values()]

    def payload(self, now_ms: int | None = None) -> list[dict[str, Any]]:
        """Every cursor as a JSON-ready dict, for the renderer queue."""
        return [frame.as_payload() for frame in self.frames(now_ms)]

    def tick_payload(self, now_ms: int | None = None) -> list[dict[str, Any]]:
        return [frame.as_payload() for frame in self.tick(now_ms)]

    # -- clock ------------------------------------------------------------

    def _effective_now(self, now_ms: int | None) -> int:
        """Never move the clock backwards.

        The renderer and the driver sample independently; a stale timestamp
        arriving after a fresh one must not rewind an animation, so it is
        treated as "now".
        """
        if now_ms is None:
            return self._now_ms if self._now_ms is not None else 0
        now = int(now_ms)
        if self._now_ms is not None and now < self._now_ms:
            return self._now_ms
        self._now_ms = now
        return now
