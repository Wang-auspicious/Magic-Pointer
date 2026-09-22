
from __future__ import annotations

FLIGHT_MS_PER_PIXEL = 1000.0 / 800.0

FLIGHT_MIN_MS = 600
FLIGHT_MAX_MS = 1400

CLICK_HOLD_MS = 35

CLICK_SETTLE_MS = 20

APPROACH_LEAD_MS = 600

APPROACH_ACK_TIMEOUT_MS = 250

GLIDE_HARD_MAX_MS = 10_000

MAX_GLIDE_STEPS = 120

GLIDE_STEP_MS = 16


def smoothstep(t: float) -> float:
    if t <= 0.0:
        return 0.0
    if t >= 1.0:
        return 1.0
    return t * t * (3.0 - 2.0 * t)


def distance_between(start: tuple[int, int], end: tuple[int, int]) -> float:
    dx = float(end[0]) - float(start[0])
    dy = float(end[1]) - float(start[1])
    return (dx * dx + dy * dy) ** 0.5


def flight_duration_ms(
    distance: float,
    *,
    requested_ms: int = 0,
    min_ms: int = FLIGHT_MIN_MS,
    max_ms: int = FLIGHT_MAX_MS,
) -> int:
    if requested_ms and int(requested_ms) > 0:
        return int(requested_ms)
    if distance <= 0.0:
        return 0
    scaled = distance * FLIGHT_MS_PER_PIXEL
    return int(max(float(min_ms), min(float(max_ms), scaled)))


def bounded_glide_ms(duration_ms: int, *, hard_max_ms: int = GLIDE_HARD_MAX_MS) -> int:
    value = int(duration_ms)
    if value > hard_max_ms:
        return int(hard_max_ms)
    return value


def approach_lead_ms(
    distance: float,
    *,
    floor_ms: int = APPROACH_LEAD_MS,
) -> int:
    return max(int(floor_ms), flight_duration_ms(distance))


def glide_points(
    start: tuple[int, int],
    end: tuple[int, int],
    duration_ms: int,
    *,
    max_steps: int = MAX_GLIDE_STEPS,
    step_ms: int = GLIDE_STEP_MS,
) -> list[tuple[int, int]]:
    if duration_ms <= 0:
        return []
    distance = distance_between(start, end)
    if distance <= 0.0:
        return []
    steps = int(duration_ms // max(1, step_ms))
    if steps > max_steps:
        steps = max_steps
    if steps < 2:
        return []
    dx = float(end[0]) - float(start[0])
    dy = float(end[1]) - float(start[1])
    points: list[tuple[int, int]] = []
    for index in range(1, steps):
        eased = smoothstep(index / float(steps))
        points.append((round(start[0] + dx * eased), round(start[1] + dy * eased)))
    return points
