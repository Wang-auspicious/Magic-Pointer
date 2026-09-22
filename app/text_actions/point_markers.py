
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

_MARKER = re.compile(
    r"\[\s*point\s*[:\s]\s*(-?\d{1,5})\s*[,\s]\s*(-?\d{1,5})\s*\]",
    re.IGNORECASE,
)

MAX_POINTS = 6


@dataclass(frozen=True)
class ScreenPoint:
    x: int
    y: int
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
                return ""
        points.append(ScreenPoint(x=x, y=y, order=len(points) + 1))
        return ""

    cleaned = _MARKER.sub(take, text)
    cleaned = re.sub(r"[ \t]{2,}", " ", cleaned)
    cleaned = re.sub(r"[ \t]+([，。、；：,.;:!?！？）)])", r"\1", cleaned)
    cleaned = re.sub(r"([（(])[ \t]+", r"\1", cleaned)
    cleaned = re.sub(r"[ \t]+$", "", cleaned, flags=re.MULTILINE)
    return cleaned.strip(), points


def instruction_for_model(bounds: Any = None) -> str:
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
