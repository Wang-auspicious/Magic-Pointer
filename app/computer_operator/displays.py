
from __future__ import annotations

import math
from dataclasses import dataclass

TASKBAR_SHAVE_PX = 2

MIN_SURFACE_PX = 1


@dataclass(frozen=True)
class Display:

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
        x, y = float(point[0]), float(point[1])
        return self.x <= x < self.right and self.y <= y < self.bottom


@dataclass(frozen=True)
class SurfaceBounds:

    display_id: str
    x: int
    y: int
    width: int
    height: int

    def as_bounds(self) -> dict[str, int]:
        return {"x": self.x, "y": self.y, "width": self.width, "height": self.height}

    def local_point(self, point: tuple[float, float]) -> tuple[int, int]:
        return (int(round(float(point[0]) - self.x)), int(round(float(point[1]) - self.y)))


def parse_display(raw: object, *, index: int = 0) -> Display | None:
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
    if not isinstance(raw, (list, tuple)):
        return []
    displays: list[Display] = []
    for index, item in enumerate(raw):
        parsed = parse_display(item, index=index)
        if parsed is not None:
            displays.append(parsed)
    return displays


def surface_bounds(display: Display, *, shave_px: int = TASKBAR_SHAVE_PX) -> SurfaceBounds:
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
    return [surface_bounds(display, shave_px=shave_px) for display in displays]


def display_for_point(displays: list[Display], point: tuple[float, float]) -> Display | None:
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
