"""Put the translation back where the original words are.

The point of overlay translation is that you keep reading the interface you were
reading. The answer does not move into a bubble; it lands on the sentence. That
only works if each translated block sits on its own block, which means the hard
part is not translating — it is fitting a different-length string into a
rectangle someone else chose.

Three ways that goes wrong, and what is done about each:

  too long    Shrink toward a floor, then wrap, then truncate — in that order,
              and say so when truncated. Silently cutting a sentence in half
              produces a confident-looking mistranslation on screen.
  unchanged   If the translation equals the source, draw nothing. Covering text
              with identical text is pure noise and hides the real thing behind
              a panel that might be misaligned.
  no text     A block OCR read as empty translates to nothing; it is dropped
              rather than rendered as an empty box.

Pure — no OCR, no model, no DOM. Blocks and strings in, overlay items out.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

# Below this the overlay is unreadable and we are lying about having translated
# anything the user can act on.
MIN_FONT_PX = 11

# A CJK glyph is about one em wide; Latin averages nearer half. Overlay text is
# measured, not rendered, so this only has to be close enough to decide between
# shrink, wrap and truncate.
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
    """Approximate rendered width, in pixels, of one line at this size."""
    total = 0.0
    for character in text:
        total += CJK_WIDTH_RATIO if _is_cjk(character) else LATIN_WIDTH_RATIO
    return total * float(font_px)


def _wrap(text: str, font_px: float, width: int) -> list[str]:
    """Greedy wrap by measured width. Works for CJK, which has no spaces."""
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
    """Choose a size and wrapping that puts `text` inside `rect`.

    Starts from the height of the original line — the translation should read at
    the same visual weight as what it replaces — and shrinks only as far as
    MIN_FONT_PX before admitting the text does not fit.
    """
    value = str(text or "").strip()
    if not value:
        return None
    width, height = rect[2], rect[3]
    start = max(MIN_FONT_PX, min(int(height * 0.78), 48))
    for font_px in range(start, MIN_FONT_PX - 1, -1):
        lines = _wrap(value, font_px, width)
        if len(lines) * font_px * 1.25 <= height:
            return OverlayBlock(rect, value, font_px, tuple(lines), False)
    # Does not fit even at the floor: keep as many whole lines as the box holds
    # and mark it, so the surface can show that there is more than it is showing.
    lines = _wrap(value, MIN_FONT_PX, width)
    allowed = max(1, int(height // (MIN_FONT_PX * 1.25)))
    return OverlayBlock(rect, value, MIN_FONT_PX, tuple(lines[:allowed]), len(lines) > allowed)


def plan_overlay(
    blocks: list[dict[str, Any]] | None,
    translations: list[str] | None,
) -> list[OverlayBlock]:
    """Pair OCR blocks with their translations and lay them out in place.

    `translations` is positional: the model is asked for one line per block and
    the pairing is by index, so a short reply leaves later blocks untranslated
    rather than shifting every translation onto the wrong sentence.
    """
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
            # Already in the target language, or nothing came back. Leaving the
            # original visible is the honest render.
            continue
        fitted = fit_block(rect, translated)
        if fitted is not None:
            planned.append(fitted)
    return planned


def coverage_summary(blocks: list[dict[str, Any]] | None, planned: list[OverlayBlock]) -> str:
    """One line for the bubble, in the user's terms."""
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
