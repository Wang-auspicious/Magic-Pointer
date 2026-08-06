"""Map an open pen stroke to OCR text rows without widening into neighbours."""

from __future__ import annotations

import math
from typing import Iterable, Sequence

UNDERLINE_TOLERANCE_PX = 14.0
BELOW_STROKE_PENALTY_PX = 10.0


def _rect(value: object) -> tuple[float, float, float, float] | None:
    if not isinstance(value, (list, tuple)) or len(value) != 4:
        return None
    try:
        x, y, width, height = (float(item) for item in value)
    except (TypeError, ValueError):
        return None
    if not all(math.isfinite(item) for item in (x, y, width, height)):
        return None
    if width <= 0 or height <= 0:
        return None
    return x, y, width, height


def _points(value: Iterable[Sequence[float]]) -> list[tuple[float, float]]:
    result: list[tuple[float, float]] = []
    for item in value:
        if not isinstance(item, (list, tuple)) or len(item) < 2:
            continue
        try:
            x, y = float(item[0]), float(item[1])
        except (TypeError, ValueError):
            continue
        if math.isfinite(x) and math.isfinite(y):
            result.append((x, y))
    return result


def _segment_y_samples(
    stroke: list[tuple[float, float]],
    *,
    left: float,
    right: float,
) -> list[float]:
    samples: list[float] = []
    for (ax, ay), (bx, by) in zip(stroke, stroke[1:]):
        segment_left, segment_right = min(ax, bx), max(ax, bx)
        if segment_right < left or segment_left > right:
            continue
        if ax == bx:
            samples.extend((ay, by))
            continue
        overlap_left = max(left, segment_left)
        overlap_right = min(right, segment_right)
        for x in (overlap_left, (overlap_left + overlap_right) / 2.0, overlap_right):
            ratio = (x - ax) / (bx - ax)
            samples.append(ay + (by - ay) * ratio)
    return samples


def _row_cost(
    rectangle: tuple[float, float, float, float],
    stroke: list[tuple[float, float]],
    *,
    tolerance: float,
) -> float | None:
    x, top, width, height = rectangle
    samples = _segment_y_samples(stroke, left=x - tolerance, right=x + width + tolerance)
    if not samples:
        return None
    bottom = top + height
    best: float | None = None
    edge_band = max(2.0, min(4.0, height * 0.12))
    for y in samples:
        if y < top:
            gap = top - y
            if gap > tolerance:
                continue
            # A horizontal mark just above the next row is normally the
            # underline belonging to the row above, not a selection of the row
            # below. Penalise that direction while still allowing a real
            # strikethrough to win once it enters the text body.
            cost = gap + BELOW_STROKE_PENALTY_PX
        elif y > bottom:
            gap = y - bottom
            if gap > tolerance:
                continue
            cost = gap
        elif y <= top + edge_band:
            cost = BELOW_STROKE_PENALTY_PX - (y - top)
        else:
            cost = -min(y - top, bottom - y)
        best = cost if best is None else min(best, cost)
    return best


def select_open_stroke_rect_indexes(
    rectangles: Iterable[object],
    stroke: Iterable[Sequence[float]],
    *,
    tolerance: float = UNDERLINE_TOLERANCE_PX,
) -> list[int]:
    """Return OCR boxes belonging to the single text row indicated by a stroke.

    An underline lives in the gap below a row, so symmetric rectangle inflation
    is ambiguous and often captures the next row too. Rank plausible rows with
    an above-the-stroke bias, then keep every horizontally split box aligned to
    the winning row.
    """
    path = _points(stroke)
    if len(path) < 2:
        return []
    scored: list[tuple[float, int, tuple[float, float, float, float]]] = []
    for index, raw in enumerate(rectangles):
        rectangle = _rect(raw)
        if rectangle is None:
            continue
        cost = _row_cost(rectangle, path, tolerance=max(0.0, float(tolerance)))
        if cost is not None:
            scored.append((cost, index, rectangle))
    if not scored:
        return []
    scored.sort(key=lambda item: (item[0], item[2][1], item[1]))
    _, _, best_rect = scored[0]
    best_top, best_height = best_rect[1], best_rect[3]
    aligned: list[int] = []
    for _, index, rectangle in scored:
        row_slack = max(4.0, min(best_height, rectangle[3]) * 0.35)
        if abs(rectangle[1] - best_top) <= row_slack:
            aligned.append(index)
    return sorted(aligned)
