"""Per-display geometry for the twin-cursor surface.

Clicky creates **one overlay window per display** and moves the buddy between
them (``clicky/OverlayWindow.swift:783-808``, iterating ``for screen in
screens`` at ``:792``), and each window hides itself on displays the pointer is
not on (``buddyIsVisibleOnThisScreen``, ``:395-407``). Magic Pointer's cursor
surface is primary-display only, so the twin disappears the moment the pointer
crosses onto a second monitor — the exact failure that guard exists to avoid.

This module is the pure half of that fix: given the display list and a screen
point, which display owns the point, and what rectangle must that display's
window cover. It is pure so it can be tested without Electron, and so the
Electron side (which cannot be tested without a GUI) only has to map these
numbers onto ``BrowserWindow`` options.

Windows-specific, and not optional: the Qt port deliberately leaves a **2 px gap
at the bottom** of the covered area (``clicky-windows/ui/overlay.py:390-392``),
because a topmost full-screen window suppresses the auto-hide taskbar's hover
trigger. A twin cursor that costs the user their taskbar is worse than no twin
cursor, and the bug is invisible in development on a machine with the taskbar
pinned.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

#: Bottom-edge shave, in pixels. ``clicky-windows/ui/overlay.py:392``.
TASKBAR_SHAVE_PX = 2

#: A display with no usable size still gets a 1x1 surface rather than a
#: zero-area window, which some window managers treat as "do not create".
MIN_SURFACE_PX = 1


@dataclass(frozen=True)
class Display:
    """One display, in the same coordinate space as the points given to
    :func:`display_for_point` (Electron reports both in DIP)."""

    display_id: str
    x: int
    y: int
    width: int
    height: int
    scale_factor: float = 1.0

    @property
    def right(self) -> int:
        return self.x + self.width

    @property
    def bottom(self) -> int:
        return self.y + self.height

    def contains(self, point: tuple[float, float]) -> bool:
        """Half-open on both axes: an edge belongs to exactly one display.

        Adjacent displays share an edge coordinate, and a cursor exactly on it
        must not be owned by both — that is how two overlay windows end up
        drawing the same cursor twice.
        """
        x, y = float(point[0]), float(point[1])
        return self.x <= x < self.right and self.y <= y < self.bottom


@dataclass(frozen=True)
class SurfaceBounds:
    """The rectangle one display's cursor window must cover."""

    display_id: str
    x: int
    y: int
    width: int
    height: int

    def as_bounds(self) -> dict[str, int]:
        return {"x": self.x, "y": self.y, "width": self.width, "height": self.height}

    def local_point(self, point: tuple[float, float]) -> tuple[int, int]:
        """Map a screen point into this surface's window-local coordinates.

        The twin cursor is drawn inside the window, so every sample has to be
        rebased. Done here rather than in the renderer so that a display with a
        negative origin (a monitor left of the primary) is handled in one
        place, by a test, instead of in a renderer nobody can unit test.
        """
        return (int(round(float(point[0]) - self.x)), int(round(float(point[1]) - self.y)))


def parse_display(raw: object, *, index: int = 0) -> Display | None:
    """Build a :class:`Display` from an Electron ``Display`` object.

    Accepts the shape ``screen.getAllDisplays()`` returns — ``{id, bounds:{x,y,
    width,height}, scaleFactor}`` — and returns ``None`` for anything that
    cannot be used, so one malformed entry cannot take out the whole cursor
    surface.
    """
    if not isinstance(raw, dict):
        return None
    bounds = raw.get("bounds")
    if not isinstance(bounds, dict):
        return None
    try:
        x = int(bounds["x"])
        y = int(bounds["y"])
        width = int(bounds["width"])
        height = int(bounds["height"])
    except (KeyError, TypeError, ValueError):
        return None
    if width <= 0 or height <= 0:
        return None
    raw_id = raw.get("id")
    display_id = str(raw_id) if raw_id is not None else f"display-{index}"
    try:
        scale = float(raw.get("scaleFactor") or 1.0)
    except (TypeError, ValueError):
        scale = 1.0
    if not math.isfinite(scale) or scale <= 0.0:
        scale = 1.0
    return Display(
        display_id=display_id,
        x=x,
        y=y,
        width=width,
        height=height,
        scale_factor=scale,
    )


def parse_displays(raw: object) -> list[Display]:
    """Every usable display in ``raw``, in the order given.

    Order is preserved rather than sorted: ``screen.getAllDisplays()`` puts the
    primary first, and "first containing display wins" then matches the
    platform's own notion of which display a point is on.
    """
    if not isinstance(raw, (list, tuple)):
        return []
    displays: list[Display] = []
    for index, item in enumerate(raw):
        parsed = parse_display(item, index=index)
        if parsed is not None:
            displays.append(parsed)
    return displays


def surface_bounds(display: Display, *, shave_px: int = TASKBAR_SHAVE_PX) -> SurfaceBounds:
    """The rectangle to cover for ``display``, with the bottom edge shaved.

    Only the bottom is shaved. Left/right/top are not: the taskbar can be
    docked to any edge in principle, but the measured failure in the Qt port is
    the bottom one, and shaving edges that do not need it only shrinks the
    area the twin cursor can be drawn in.
    """
    height = display.height - max(0, int(shave_px))
    if height < MIN_SURFACE_PX:
        height = MIN_SURFACE_PX
    return SurfaceBounds(
        display_id=display.display_id,
        x=display.x,
        y=display.y,
        width=max(MIN_SURFACE_PX, display.width),
        height=height,
    )


def surfaces_for(displays: list[Display], *, shave_px: int = TASKBAR_SHAVE_PX) -> list[SurfaceBounds]:
    """One surface per display, in the same order."""
    return [surface_bounds(display, shave_px=shave_px) for display in displays]


def display_for_point(displays: list[Display], point: tuple[float, float]) -> Display | None:
    """Which display owns ``point``, or ``None`` if it is outside every one.

    ``None`` is a real answer and must stay one: a sample from a display that
    was just unplugged, or a coordinate outside the virtual desktop, must not
    be rounded onto some display and drawn — that is how a cursor appears to
    teleport to a screen corner.
    """
    if not displays or not _is_point(point):
        return None
    for display in displays:
        if display.contains(point):
            return display
    return None


def surface_for_point(
    displays: list[Display],
    point: tuple[float, float],
    *,
    shave_px: int = TASKBAR_SHAVE_PX,
) -> tuple[SurfaceBounds, tuple[int, int]] | None:
    """The owning display's surface and the point in that surface's coordinates.

    This is the whole per-display answer in one call, which is what the sample
    loop needs: which window to send the sample to, and where inside it the
    twin cursor belongs. Returns ``None`` when no display owns the point.
    """
    display = display_for_point(displays, point)
    if display is None:
        return None
    surface = surface_bounds(display, shave_px=shave_px)
    return (surface, surface.local_point(point))


def screen_point_for(
    displays: list[Display],
    surface: SurfaceBounds,
    local_point: tuple[int, int],
) -> tuple[int, int] | None:
    """Turn a surface-local point back into a screen point.

    The addressable-cursor API hands out window-local coordinates ("a marker at
    (100, 40) of display 2"), so this is the inverse of
    :meth:`SurfaceBounds.local_point`. Points past the right or bottom edge are
    clamped onto the display rather than rejected: the missing 2 px at the
    bottom is a taskbar workaround, not a hole in the desktop, and a cursor
    aimed at the taskbar should land on the display rather than vanish.
    """
    for display in displays:
        if display.display_id != surface.display_id:
            continue
        x = min(max(surface.x + int(local_point[0]), display.x), display.right - 1)
        y = min(max(surface.y + int(local_point[1]), display.y), display.bottom - 1)
        return (x, y)
    return None


def _is_point(point: object) -> bool:
    if not isinstance(point, (tuple, list)) or len(point) != 2:
        return False
    try:
        x = float(point[0])
        y = float(point[1])
    except (TypeError, ValueError):
        return False
    return math.isfinite(x) and math.isfinite(y)
