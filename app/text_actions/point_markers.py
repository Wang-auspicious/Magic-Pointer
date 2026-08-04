"""`[POINT x,y]` — let the answer point at the screen while it explains.

"The button you want is in the top right" is a worse answer than an arrow landing
on the button. When the model knows where something is, it can say so inline and
the stage draws it:

    先点 [POINT 1840,220] 这个齿轮，再选「导出」[POINT 1690,540]。

Two things have to be true for that to be safe.

**The marker must leave the text.** Whatever the user copies, or reads aloud, or
pastes into a document must be a sentence — not a sentence with coordinates in
it. So parsing returns clean prose plus a separate list of points, and the two
are never carried together.

**A point we cannot trust is dropped, not drawn.** Models invent coordinates.
A confident arrow landing on empty desktop is worse than no arrow at all, so
anything outside the screen — or outside the window the answer is about — is
discarded silently rather than rendered.

Pure: text in, text and points out.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

# `[POINT 100,200]`, `[POINT: 100, 200]`, `[point 100 200]` — models are not
# consistent about punctuation and it is not worth failing over.
_MARKER = re.compile(
    r"\[\s*point\s*[:\s]\s*(-?\d{1,5})\s*[,\s]\s*(-?\d{1,5})\s*\]",
    re.IGNORECASE,
)

# More arrows than this is not guidance, it is a diagram nobody asked for.
MAX_POINTS = 6


@dataclass(frozen=True)
class ScreenPoint:
    x: int
    y: int
    # Index of the point in reading order, so the stage can number them the way
    # the sentence does: first this, then that.
    order: int

    def to_dict(self) -> dict[str, Any]:
        return {"x": self.x, "y": self.y, "order": self.order}


def _bounds(value: Any) -> tuple[int, int, int, int] | None:
    if not isinstance(value, (list, tuple)) or len(value) != 4:
        return None
    try:
        left, top, right, bottom = (int(round(float(item))) for item in value)
    except (TypeError, ValueError):
        return None
    if right <= left or bottom <= top:
        return None
    return left, top, right, bottom


def parse_points(answer: str, *, bounds: Any = None) -> tuple[str, list[ScreenPoint]]:
    """Split an answer into what to say and where to point.

    `bounds` is `[left, top, right, bottom]` in physical screen pixels — the
    screen, or the window the answer is about. Points outside it are dropped:
    the marker is removed from the text either way, because leaving `[POINT ...]`
    on screen would be worse than losing the arrow.
    """
    text = str(answer or "")
    limits = _bounds(bounds)
    points: list[ScreenPoint] = []

    def take(match: re.Match[str]) -> str:
        if len(points) >= MAX_POINTS:
            return ""
        try:
            x, y = int(match.group(1)), int(match.group(2))
        except (TypeError, ValueError):
            return ""
        if limits is not None:
            left, top, right, bottom = limits
            if not (left <= x <= right and top <= y <= bottom):
                # Outside anything we can vouch for. Drop it rather than draw a
                # confident arrow onto empty desktop.
                return ""
        points.append(ScreenPoint(x=x, y=y, order=len(points) + 1))
        return ""

    cleaned = _MARKER.sub(take, text)
    # Removing an inline marker leaves doubled spaces and orphaned punctuation
    # spacing; tidy without touching the user's own line structure.
    cleaned = re.sub(r"[ \t]{2,}", " ", cleaned)
    cleaned = re.sub(r"[ \t]+([，。、；：,.;:!?！？）)])", r"\1", cleaned)
    cleaned = re.sub(r"([（(])[ \t]+", r"\1", cleaned)
    # A marker at the end of a line leaves a trailing space that shows up when
    # the answer is pasted somewhere that cares.
    cleaned = re.sub(r"[ \t]+$", "", cleaned, flags=re.MULTILINE)
    return cleaned.strip(), points


def instruction_for_model(bounds: Any = None) -> str:
    """The line that tells a model it may point, and where it may point."""
    limits = _bounds(bounds)
    where = (
        f"坐标必须落在 [{limits[0]},{limits[1]}] 到 [{limits[2]},{limits[3]}] 之间。"
        if limits is not None else ""
    )
    return (
        "如果答案涉及屏幕上某个具体位置，可以在句中插入 [POINT x,y] 标记，"
        f"界面会在那个位置画出指示箭头。{where}"
        "不确定位置时不要写这个标记——指错地方比不指更糟。"
    )
