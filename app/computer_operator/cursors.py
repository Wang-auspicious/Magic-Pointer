
from __future__ import annotations

import math
from dataclasses import dataclass
from enum import Enum
from typing import Any

from .motion import distance_between, flight_duration_ms, smoothstep


OFFSET_X = 35
OFFSET_Y = 25

TRIANGLE_SIZE = 16
TRIANGLE_REST_DEGREES = -35.0

ACCENT_BLUE = "#3380FF"

SPRING_STIFFNESS = 0.28
SPRING_DAMPING = 0.62
TICK_MS = 16

TICK_CATCHUP_MAX = 8

SPRING_SNAP_PX = 0.5
SPRING_SNAP_VELOCITY = 0.5

DWELL_MS = 3000

RETURN_MS = 1400

ARC_FRACTION = 0.20
ARC_MAX_PX = 80.0

SCALE_PULSE = 0.30

RING_BASE_RADIUS = 26.0
RING_PULSE_PX = 6.0
RING_PHASE_STEP = 0.08
RING_PHASE_PER_MS = RING_PHASE_STEP / float(TICK_MS)

GLOW_MS = 2400
GLOW_MIN_MS = 400
GLOW_MAX_MS = 12000

TTL_MIN_MS = 200

DEFAULT_TTL_MS = 2000

CANCEL_DISTANCE_PX = 100.0


class CursorState(str, Enum):

    IDLE = "idle"
    FLYING = "flying"
    DWELLING = "dwelling"
    CLICKING = "clicking"


APPROACH = "approach"
RETURN = "return"


def ring_pulse(phase: float) -> float:
    return (math.sin(phase) + 1.0) / 2.0


def ring_radius(pulse: float) -> float:
    clamped = 0.0 if pulse < 0.0 else 1.0 if pulse > 1.0 else pulse
    return RING_BASE_RADIUS + clamped * RING_PULSE_PX


def flight_scale(progress: float) -> float:
    clamped = 0.0 if progress < 0.0 else 1.0 if progress > 1.0 else progress
    return 1.0 + math.sin(clamped * math.pi) * SCALE_PULSE


def arc_height(distance: float) -> float:
    return min(max(0.0, distance) * ARC_FRACTION, ARC_MAX_PX)


def bezier_point(
    start: tuple[float, float],
    control: tuple[float, float],
    end: tuple[float, float],
    t: float,
) -> tuple[float, float]:
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
    tangent_x, tangent_y = bezier_tangent(start, control, end, t)
    if tangent_x == 0.0 and tangent_y == 0.0:
        return TRIANGLE_REST_DEGREES
    return math.degrees(math.atan2(tangent_y, tangent_x)) + 90.0


@dataclass(frozen=True)
class CursorFrame:

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
    hold_dwell: bool = False
    flight: _Flight | None = None
    scale: float = 1.0
    rotation: float = TRIANGLE_REST_DEGREES
    return_anchor: tuple[float, float] | None = None


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
        self.x, self.y = flight.end
        self.scale = 1.0
        self.rotation = TRIANGLE_REST_DEGREES
        self.flight = None
        if flight.purpose == APPROACH:
            self.state = CursorState.DWELLING.value
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
                self.x = self.target_x
                self.y = self.target_y
                self.velocity_x = 0.0
                self.velocity_y = 0.0
                return

    def advance(self, now_ms: int, steps: int, pointer: tuple[float, float] | None) -> None:
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
            self.ring_phase += RING_PHASE_PER_MS * (steps * TICK_MS)
            if self.ring_phase > math.tau * 1024.0:
                self.ring_phase = math.fmod(self.ring_phase, math.tau)


class CursorRegistry:

    def __init__(self, *, default_ttl_ms: int | None = None) -> None:
        self._cursors: dict[str, Cursor] = {}
        self._pointer: tuple[float, float] | None = None
        self._now_ms: int | None = None
        self._last_tick_ms: int | None = None
        self.default_ttl_ms = default_ttl_ms


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
        now = self._effective_now(now_ms)
        expired = [
            cursor_id
            for cursor_id, cursor in self._cursors.items()
            if cursor.expires_ms is not None and cursor.expires_ms <= now
        ]
        for cursor_id in expired:
            del self._cursors[cursor_id]
        return expired


    def set_pointer(self, position: tuple[float, float] | None) -> None:
        self._pointer = None if position is None else (float(position[0]), float(position[1]))

    def set_target(
        self,
        cursor_id: str,
        position: tuple[float, float],
        *,
        now_ms: int | None = None,
    ) -> CursorFrame | None:
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


    def begin_flight(
        self,
        cursor_id: str,
        target: tuple[float, float],
        *,
        duration_ms: int = 0,
        purpose: str = APPROACH,
        now_ms: int | None = None,
    ) -> CursorFrame | None:
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
        cursor = self._cursors.get(str(cursor_id))
        if cursor is None:
            return None
        cursor.hold_dwell = bool(held)
        now = self._effective_now(now_ms)
        if not held and cursor.state == CursorState.DWELLING.value:
            cursor.dwell_until_ms = now + DWELL_MS
        return cursor.frame(now)

    def release_dwell(
        self,
        cursor_id: str,
        *,
        now_ms: int | None = None,
    ) -> CursorFrame | None:
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


    def tick(self, now_ms: int | None = None) -> list[CursorFrame]:
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
        now = self._effective_now(now_ms)
        return [cursor.frame(now) for cursor in self._cursors.values()]

    def payload(self, now_ms: int | None = None) -> list[dict[str, Any]]:
        return [frame.as_payload() for frame in self.frames(now_ms)]

    def tick_payload(self, now_ms: int | None = None) -> list[dict[str, Any]]:
        return [frame.as_payload() for frame in self.tick(now_ms)]


    def _effective_now(self, now_ms: int | None) -> int:
        if now_ms is None:
            return self._now_ms if self._now_ms is not None else 0
        now = int(now_ms)
        if self._now_ms is not None and now < self._now_ms:
            return self._now_ms
        self._now_ms = now
        return now
