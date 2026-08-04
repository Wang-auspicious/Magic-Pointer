"""Frame things in windows that expose nothing to frame.

Measured on 2026-08-05: WeChat 4.x publishes eight UI Automation nodes for its
entire window, and the chat area is a single opaque `MMUIRenderSubWindowHW` with
no children. There is nothing to enumerate, so "point at that message" had no
answer — and WeChat is not the exception. Qt, Flutter, GPU-composited Electron
and every game are the same shape, and they are the same windows PrintWindow
cannot grab either.

What we do have for those windows is OCR: a flat list of text lines, each with a
rectangle. A line is not a thing a person points at, though. Nobody means "that
one line" when they point at a chat bubble — they mean the bubble. So the job
here is to put the lines back together into the objects they came from.

The grouping rule is spatial and deliberately conservative: lines join when they
sit in the same column and are close enough vertically that a person reading
would call them one block. Getting it wrong in the joining direction is worse
than leaving two boxes: an over-merged element frames text the user did not mean
and quietly widens whatever gets acted on.

Pure — rectangles and strings in, rectangles and strings out.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

# Two lines belong together when the gap between them is under this multiple of
# their own height.
#
# Measured against a live WeChat conversation list on 2026-08-05, which is the
# hardest case to hand because its rows are tightly stacked:
#
#   within one row (title + preview)   gap -4 .. 0 px      ratio <= 0
#   between two rows                   gap 44 .. 56 px     ratio 1.05 .. 1.56
#
# The boundary sits just under 1.0, so a 1.1 threshold merged five conversations
# into one element. 0.55 has margin on both sides and still joins ordinary
# paragraph lines, whose gap runs about 0.2-0.4 of their height.
MAX_LINE_GAP_RATIO = 0.55

# ...and they have to be in the same column. Chat is two columns of bubbles;
# joining across them would merge what you said with what they replied.
MIN_HORIZONTAL_OVERLAP_RATIO = 0.35

# An element wider than this fraction of the window is the surface, not a thing
# on it — the same judgement `rect_is_container` makes for UIA elements.
MAX_ELEMENT_WIDTH_RATIO = 0.94

# Beyond this the overlay is a wall of boxes rather than something to aim at.
MAX_ELEMENTS = 60
MAX_LINES_PER_ELEMENT = 24


@dataclass
class VisualElement:
    """A pointable thing recovered from pixels."""

    rect: list[int]
    text: str
    line_count: int
    lines: list[list[int]] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "rect": list(self.rect),
            "text": self.text,
            "lineCount": self.line_count,
            "source": "pixel",
        }


def _rect(value: Any) -> tuple[int, int, int, int] | None:
    if not isinstance(value, (list, tuple)) or len(value) != 4:
        return None
    try:
        left, top, width, height = (int(round(float(item))) for item in value)
    except (TypeError, ValueError):
        return None
    if width <= 0 or height <= 0:
        return None
    return left, top, width, height


def _horizontal_overlap_ratio(a: tuple[int, ...], b: tuple[int, ...]) -> float:
    left = max(a[0], b[0])
    right = min(a[0] + a[2], b[0] + b[2])
    overlap = max(0, right - left)
    narrower = min(a[2], b[2])
    return overlap / narrower if narrower > 0 else 0.0


def _joins(previous: tuple[int, ...], candidate: tuple[int, ...]) -> bool:
    gap = candidate[1] - (previous[1] + previous[3])
    if gap < 0:
        # Overlapping vertically — the same visual row, or a tight paragraph.
        gap = 0
    reference_height = max(1, min(previous[3], candidate[3]))
    if gap > reference_height * MAX_LINE_GAP_RATIO:
        return False
    return _horizontal_overlap_ratio(previous, candidate) >= MIN_HORIZONTAL_OVERLAP_RATIO


def _union(rects: list[tuple[int, int, int, int]]) -> list[int]:
    left = min(rect[0] for rect in rects)
    top = min(rect[1] for rect in rects)
    right = max(rect[0] + rect[2] for rect in rects)
    bottom = max(rect[1] + rect[3] for rect in rects)
    return [left, top, right - left, bottom - top]


def group_blocks_into_elements(
    blocks: list[dict[str, Any]] | None,
    *,
    window_bbox: Any = None,
) -> list[VisualElement]:
    """Reassemble OCR lines into the objects a person would point at.

    `blocks` are `{"text": str, "rect": [x, y, w, h]}` in physical screen pixels,
    as produced by the local OCR pass. `window_bbox` is `[l, t, r, b]`; lines
    outside it are dropped, because a full-screen capture contains every other
    window too and framing those would attribute someone else's text to this one.
    """
    bounds = _rect(
        [window_bbox[0], window_bbox[1], window_bbox[2] - window_bbox[0], window_bbox[3] - window_bbox[1]]
    ) if isinstance(window_bbox, (list, tuple)) and len(window_bbox) == 4 else None

    entries: list[tuple[tuple[int, int, int, int], str]] = []
    for block in list(blocks or []):
        if not isinstance(block, dict):
            continue
        rect = _rect(block.get("rect"))
        text = str(block.get("text") or "").strip()
        if rect is None or not text:
            continue
        if bounds is not None:
            centre_x = rect[0] + rect[2] // 2
            centre_y = rect[1] + rect[3] // 2
            inside = (
                bounds[0] <= centre_x <= bounds[0] + bounds[2]
                and bounds[1] <= centre_y <= bounds[1] + bounds[3]
            )
            if not inside:
                continue
        entries.append((rect, text))

    # Reading order first, so "the line above" means what it says.
    entries.sort(key=lambda item: (item[0][1], item[0][0]))

    groups: list[list[tuple[tuple[int, int, int, int], str]]] = []
    for entry in entries:
        placed = False
        for group in reversed(groups):
            if len(group) >= MAX_LINES_PER_ELEMENT:
                continue
            if _joins(group[-1][0], entry[0]):
                group.append(entry)
                placed = True
                break
        if not placed:
            groups.append([entry])

    elements: list[VisualElement] = []
    for group in groups:
        rects = [item[0] for item in group]
        union = _union(rects)
        if bounds is not None and union[2] > bounds[2] * MAX_ELEMENT_WIDTH_RATIO:
            # Spans the window: this is the background, not an object on it.
            continue
        elements.append(VisualElement(
            rect=union,
            text="\n".join(item[1] for item in group),
            line_count=len(group),
            lines=[list(rect) for rect in rects],
        ))
        if len(elements) >= MAX_ELEMENTS:
            break
    return elements


def element_at_point(elements: list[VisualElement], point: Any) -> VisualElement | None:
    """The smallest element containing the point — the most specific thing there."""
    try:
        x = int(round(float((point or {}).get("x"))))
        y = int(round(float((point or {}).get("y"))))
    except (AttributeError, TypeError, ValueError):
        return None
    hits = [
        element for element in elements
        if element.rect[0] <= x <= element.rect[0] + element.rect[2]
        and element.rect[1] <= y <= element.rect[1] + element.rect[3]
    ]
    if not hits:
        return None
    return min(hits, key=lambda element: element.rect[2] * element.rect[3])
