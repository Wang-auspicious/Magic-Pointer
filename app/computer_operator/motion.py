"""Pointer motion policy for the Windows computer operator.

Pure, stdlib-only, no platform coupling — the numbers live here so they can be
tested and retuned without touching the ctypes driver.

Why this module exists: ``Win32InputDriver.move`` used to accept a
``duration_ms`` and immediately discard it (``del duration_ms``), so every
agent-initiated pointer move was an instantaneous teleport. ``drag`` right
below it had the stepped-glide loop the whole time. A teleporting pointer
reads as "the machine did something", not as "something is doing this" — the
user cannot follow the action, cannot tell what was aimed at, and cannot
interrupt in time. The reference implementations (Clicky on macOS, its Qt
Windows port, openclicky) all animate; this is the parity they set.

Values are taken from the Clicky family and cited in
``docs/research/2026-09-16-clicky-twin-cursor.md``:

- easing is smoothstep, ``t * t * (3 - 2t)``, in all three variants
- flight is ``min(max(distance / 800.0, 0.6), 1.4)`` **seconds**
  (``OverlayWindow.swift:510``) — 800 px/s, floored at 600 ms and capped at
  1400 ms
- a click is held down for ~35 ms before release

Both ends of that clamp are taken as-is, deliberately: the point of this module
is to reproduce the feel the user asked for, and the floor is what makes a short
hop read as motion rather than a twitch. They are parameters rather than
hard-coded so a caller that needs a faster profile for a long task can pass one
without editing this policy.
"""

from __future__ import annotations

#: Clicky travels 800 px per second, i.e. 1.25 ms of flight per pixel.
FLIGHT_MS_PER_PIXEL = 1000.0 / 800.0

#: Shortest and longest flight, in milliseconds. Clicky: 0.6 s and 1.4 s.
FLIGHT_MIN_MS = 600
FLIGHT_MAX_MS = 1400

#: How long the button is held down before release. Clicky uses 35 ms; a 0 ms
#: press is delivered so fast that some applications and every OS-level
#: double-click heuristic see an ambiguous or missed click.
CLICK_HOLD_MS = 35

#: Settling time after the pointer arrives, before the press. ``SetCursorPos``
#: returns as soon as the position is queued; the target window has not
#: necessarily processed the resulting ``WM_MOUSEMOVE`` yet, so a press sent
#: immediately can land on the *previous* position. This is the classic
#: synthetic-input race and it is why clicks appear to miss.
CLICK_SETTLE_MS = 20

#: Upper bound on interpolation steps, so a long flight cannot emit an
#: unbounded number of ``SetCursorPos`` calls.
MAX_GLIDE_STEPS = 120

#: The driver samples at roughly 60 Hz, matching the reference implementations'
#: 16 ms follow tick.
GLIDE_STEP_MS = 16


def smoothstep(t: float) -> float:
    """Ease ``t`` in ``[0, 1]`` with smoothstep.

    Clamped, so a caller that overshoots due to floating-point accumulation
    still gets a value in range.
    """
    if t <= 0.0:
        return 0.0
    if t >= 1.0:
        return 1.0
    return t * t * (3.0 - 2.0 * t)


def distance_between(start: tuple[int, int], end: tuple[int, int]) -> float:
    """Euclidean distance between two integer points."""
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
    """Milliseconds of travel for a move of ``distance`` pixels.

    An explicit ``requested_ms`` from the caller always wins — the agent knows
    when a move should be deliberate. Otherwise the duration follows Clicky's
    distance rule, clamped to ``[min_ms, max_ms]``.

    A zero-distance move takes zero time: there is nothing to animate, and
    spending the floor on it would make repeated same-point clicks crawl.
    """
    if requested_ms and int(requested_ms) > 0:
        return int(requested_ms)
    if distance <= 0.0:
        return 0
    scaled = distance * FLIGHT_MS_PER_PIXEL
    return int(max(float(min_ms), min(float(max_ms), scaled)))


def glide_points(
    start: tuple[int, int],
    end: tuple[int, int],
    duration_ms: int,
    *,
    max_steps: int = MAX_GLIDE_STEPS,
    step_ms: int = GLIDE_STEP_MS,
) -> list[tuple[int, int]]:
    """Intermediate points from ``start`` to ``end``, easing with smoothstep.

    Returns intermediate points only — never ``end`` itself. The caller is
    responsible for placing the final exact ``end``, so that a clamped or
    truncated glide can never leave the pointer near-but-not-on the target.

    A non-positive ``duration_ms`` yields an empty list: the caller teleports.
    """
    if duration_ms <= 0:
        return []
    distance = distance_between(start, end)
    if distance <= 0.0:
        return []
    steps = int(duration_ms // max(1, step_ms))
    if steps > max_steps:
        steps = max_steps
    # ``steps`` is the number of *intervals*; the sampled points are the
    # interior ones, so fewer than two intervals means nothing to interpolate.
    if steps < 2:
        return []
    dx = float(end[0]) - float(start[0])
    dy = float(end[1]) - float(start[1])
    points: list[tuple[int, int]] = []
    for index in range(1, steps):
        eased = smoothstep(index / float(steps))
        # round() rather than int(): truncation biases the whole path one pixel
        # toward the origin, which compounds over a long glide.
        points.append((round(start[0] + dx * eased), round(start[1] + dy * eased)))
    return points
