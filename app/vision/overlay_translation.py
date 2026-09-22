
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

MIN_FONT_PX = 11

CJK_WIDTH_RATIO = 1.0
LATIN_WIDTH_RATIO = 0.56

MAX_OVERLAY_BLOCKS = 60


def _rect(value: Any) -> list[int] | None:
    if not isinstance(value, (list, tuple)) or len(value) != 4:
        return None
    try:
        left, top, width, height = (int(round(float(item))) for item in value)
    except (TypeError, ValueError):
        return None
    if width <= 0 or height <= 0:
        return None
    return [left, top, width, height]


def _is_cjk(character: str) -> bool:
    code = ord(character)
    return (
        0x4E00 <= code <= 0x9FFF
        or 0x3400 <= code <= 0x4DBF
        or 0x3040 <= code <= 0x30FF
        or 0xAC00 <= code <= 0xD7AF
        or 0xFF00 <= code <= 0xFF60
    )


def measure_width(text: str, font_px: float) -> float:
    total = 0.0
    for character in text:
        total += CJK_WIDTH_RATIO if _is_cjk(character) else LATIN_WIDTH_RATIO
    return total * float(font_px)


def _wrap(text: str, font_px: float, width: int) -> list[str]:
    lines: list[str] = []
    current = ""
    for character in text:
        if character == "\n":
            lines.append(current)
            current = ""
            continue
        candidate = current + character
        if current and measure_width(candidate, font_px) > width:
            lines.append(current)
            current = character
        else:
            current = candidate
    if current:
        lines.append(current)
    return lines or [""]


@dataclass(frozen=True)
class OverlayBlock:
    rect: list[int]
    text: str
    font_px: int
    lines: tuple[str, ...]
    truncated: bool

    def to_dict(self) -> dict[str, Any]:
        return {
            "rect": list(self.rect),
            "text": self.text,
            "fontPx": self.font_px,
            "lines": list(self.lines),
            "truncated": self.truncated,
        }


def fit_block(rect: list[int], text: str) -> OverlayBlock | None:
    value = str(text or "").strip()
    if not value:
        return None
    width, height = rect[2], rect[3]
    start = max(MIN_FONT_PX, min(int(height * 0.78), 48))
    for font_px in range(start, MIN_FONT_PX - 1, -1):
        lines = _wrap(value, font_px, width)
        if len(lines) * font_px * 1.25 <= height:
            return OverlayBlock(rect, value, font_px, tuple(lines), False)
    lines = _wrap(value, MIN_FONT_PX, width)
    allowed = max(1, int(height // (MIN_FONT_PX * 1.25)))
    return OverlayBlock(rect, value, MIN_FONT_PX, tuple(lines[:allowed]), len(lines) > allowed)


def plan_overlay(
    blocks: list[dict[str, Any]] | None,
    translations: list[str] | None,
) -> list[OverlayBlock]:
    items = list(blocks or [])
    replies = list(translations or [])
    planned: list[OverlayBlock] = []
    for index, block in enumerate(items):
        if len(planned) >= MAX_OVERLAY_BLOCKS:
            break
        if not isinstance(block, dict):
            continue
        rect = _rect(block.get("rect"))
        source = str(block.get("text") or "").strip()
        if rect is None or not source:
            continue
        if index >= len(replies):
            continue
        translated = str(replies[index] or "").strip()
        if not translated or translated == source:
            continue
        fitted = fit_block(rect, translated)
        if fitted is not None:
            planned.append(fitted)
    return planned


def coverage_summary(blocks: list[dict[str, Any]] | None, planned: list[OverlayBlock]) -> str:
    total = len([
        block for block in list(blocks or [])
        if isinstance(block, dict) and str(block.get("text") or "").strip() and _rect(block.get("rect"))
    ])
    if total == 0:
        return "这块区域里没有读到文字。"
    if not planned:
        return "这块区域里的文字看起来已经是目标语言了，没有覆盖任何内容。"
    truncated = sum(1 for block in planned if block.truncated)
    line = f"已就地翻译 {len(planned)} / {total} 块"
    if truncated:
        line += f"，其中 {truncated} 块原位放不下，已截断显示"
    return line + "。"
