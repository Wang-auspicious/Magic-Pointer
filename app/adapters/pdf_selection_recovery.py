from __future__ import annotations

import ctypes
import difflib
import math
import re
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import unquote, urlparse

from PIL import Image, ImageGrab

JsonDict = dict[str, Any]
RectTuple = tuple[float, float, float, float]


@dataclass(frozen=True)
class PdfSelectionRecovery:
    ok: bool
    text: str = ""
    context: str = ""
    rectangles: tuple[RectTuple, ...] = ()
    document_path: str | None = None
    page_number: int | None = None
    uia_matching_core: str = ""
    dropped_uia_rectangle_count: int = 0
    error: str | None = None


@dataclass(frozen=True)
class _RawSelection:
    text: str
    block_index: int


def _normalize_text(value: str) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def _rect(value: Any) -> RectTuple | None:
    if not isinstance(value, (list, tuple)) or len(value) != 4:
        return None
    try:
        x, y, width, height = (float(part) for part in value)
    except (TypeError, ValueError):
        return None
    if not all(math.isfinite(part) for part in (x, y, width, height)):
        return None
    if width <= 0 or height <= 0:
        return None
    return x, y, width, height


def _local_pdf_path(location: Any) -> Path | None:
    raw = unquote(str(location or "").strip())
    if not raw:
        return None
    if raw.lower().startswith("file:"):
        parsed = urlparse(raw)
        raw = unquote(parsed.path or "")
        if parsed.netloc:
            raw = f"//{parsed.netloc}{raw}"
        if re.match(r"^/[A-Za-z]:/", raw):
            raw = raw[1:]
    path = Path(raw)
    if path.suffix.lower() != ".pdf" or not path.is_file():
        return None
    return path


def _virtual_screen_origin() -> tuple[int, int]:
    try:
        user32 = ctypes.windll.user32
        return int(user32.GetSystemMetrics(76)), int(user32.GetSystemMetrics(77))
    except Exception:
        return 0, 0


def _foreground_window_handle() -> int:
    try:
        return int(ctypes.windll.user32.GetForegroundWindow())
    except Exception:
        return 0


def _capture_screen() -> tuple[Image.Image, tuple[int, int]]:
    return ImageGrab.grab(all_screens=True).convert("RGB"), _virtual_screen_origin()


def _clip_box(
    rect: RectTuple,
    image: Image.Image,
    origin: tuple[int, int],
) -> tuple[int, int, int, int] | None:
    x, y, width, height = rect
    left = max(0, int(math.floor(x - origin[0])))
    top = max(0, int(math.floor(y - origin[1])))
    right = min(image.width, int(math.ceil(x + width - origin[0])))
    bottom = min(image.height, int(math.ceil(y + height - origin[1])))
    if right <= left or bottom <= top:
        return None
    return left, top, right, bottom


def _dominant_highlight_color(
    image: Image.Image,
    rect: RectTuple,
    origin: tuple[int, int],
) -> tuple[int, int, int] | None:
    box = _clip_box(rect, image, origin)
    if box is None:
        return None
    crop = image.crop(box)
    pixel_source = (
        crop.get_flattened_data()
        if hasattr(crop, "get_flattened_data")
        else crop.getdata()
    )
    pixels = list(pixel_source)
    if not pixels:
        return None
    quantized = Counter(
        tuple((int(channel) // 8) * 8 for channel in pixel[:3])
        for pixel in pixels[:: max(1, len(pixels) // 12000)]
    )
    color, count = quantized.most_common(1)[0]
    if count < max(8, sum(quantized.values()) * 0.18):
        return None
    if max(color) >= 248 and min(color) >= 240:
        return None
    return color


def _color_matches(
    pixel: tuple[int, int, int],
    color: tuple[int, int, int],
    tolerance: int = 24,
) -> bool:
    return max(abs(int(pixel[index]) - int(color[index])) for index in range(3)) <= tolerance


def _highlight_column_score(
    image: Image.Image,
    screen_x: int,
    rect: RectTuple,
    color: tuple[int, int, int],
    origin: tuple[int, int],
) -> float:
    _, y, _, height = rect
    local_x = screen_x - origin[0]
    if local_x < 0 or local_x >= image.width:
        return 0.0
    top = max(0, int(math.floor(y - origin[1])))
    bottom = min(image.height, int(math.ceil(y + height - origin[1])))
    if bottom <= top:
        return 0.0
    inset = max(2, min(6, (bottom - top) // 10))
    rows = list(range(top + inset, bottom - inset))
    if not rows:
        rows = list(range(top, bottom))
    if not rows:
        return 0.0
    matches = sum(
        1
        for row in rows
        if _color_matches(image.getpixel((local_x, row))[:3], color)
    )
    return matches / len(rows)


def _highlight_runs(
    image: Image.Image,
    rect: RectTuple,
    page_rect: RectTuple,
    color: tuple[int, int, int],
    origin: tuple[int, int],
) -> list[tuple[int, int]]:
    page_left = int(math.floor(page_rect[0]))
    page_right = int(math.ceil(page_rect[0] + page_rect[2]))
    columns = [
        _highlight_column_score(image, x, rect, color, origin) >= 0.20
        for x in range(page_left, page_right)
    ]
    runs: list[tuple[int, int]] = []
    start: int | None = None
    last_match: int | None = None
    gap = 0
    for offset, matches in enumerate(columns):
        screen_x = page_left + offset
        if matches:
            if start is None:
                start = screen_x
            last_match = screen_x
            gap = 0
        elif start is not None:
            gap += 1
            if gap > 2:
                if last_match is not None and last_match >= start:
                    runs.append((start, last_match + 1))
                start = None
                last_match = None
                gap = 0
    if start is not None and last_match is not None:
        runs.append((start, last_match + 1))
    return runs


def _has_clear_vertical_highlight_boundary(
    image: Image.Image,
    rectangles: list[RectTuple],
    color: tuple[int, int, int],
    origin: tuple[int, int],
) -> bool:
    if not rectangles:
        return False
    left = int(math.floor(min(rect[0] for rect in rectangles)))
    right = int(math.ceil(max(rect[0] + rect[2] for rect in rectangles)))
    top = int(math.floor(min(rect[1] for rect in rectangles)))
    bottom = int(math.ceil(max(rect[1] + rect[3] for rect in rectangles)))
    if right <= left:
        return False
    step = max(1, (right - left) // 240)
    sample_x = list(range(left, right, step))
    if not sample_x:
        return False

    def row_coverage(screen_y: int) -> float:
        local_y = screen_y - origin[1]
        if local_y < 0 or local_y >= image.height:
            return 0.0
        matches = sum(
            1
            for screen_x in sample_x
            if (
                0 <= screen_x - origin[0] < image.width
                and _color_matches(
                    image.getpixel((screen_x - origin[0], local_y))[:3],
                    color,
                )
            )
        )
        return matches / len(sample_x)

    outside_rows = [
        *(top - offset for offset in range(2, 7)),
        *(bottom + offset for offset in range(2, 7)),
    ]
    return max((row_coverage(row) for row in outside_rows), default=1.0) < 0.20


def extend_highlight_rectangles(
    image: Image.Image,
    rectangles: Iterable[Any],
    page_rect: Any,
    *,
    origin: tuple[int, int] = (0, 0),
) -> list[RectTuple]:
    page = _rect(page_rect)
    if page is None:
        return []
    raw_rectangles = [
        rect
        for rect in (_rect(value) for value in rectangles)
        if rect is not None
    ]
    color_candidates = [
        (
            rect[2] * rect[3],
            color,
        )
        for rect in raw_rectangles
        if (color := _dominant_highlight_color(image, rect, origin)) is not None
    ]
    if not color_candidates:
        return []
    _, highlight_color = max(color_candidates, key=lambda item: item[0])
    if not _has_clear_vertical_highlight_boundary(
        image,
        raw_rectangles,
        highlight_color,
        origin,
    ):
        return []

    extended: list[RectTuple] = []
    for current in raw_rectangles:
        x, y, width, height = current
        raw_left = x
        raw_right = x + width
        candidates: list[tuple[float, int, int]] = []
        for left, right in _highlight_runs(
            image,
            current,
            page,
            highlight_color,
            origin,
        ):
            overlap = max(0.0, min(raw_right, right) - max(raw_left, left))
            if overlap < max(2.0, min(width, right - left) * 0.25):
                continue
            candidates.append((overlap, left, right))
        if not candidates:
            continue
        _, left, right = max(
            candidates,
            key=lambda item: (item[0], item[2] - item[1]),
        )
        extended.append((float(left), y, float(right - left), height))
    return extended


def _screen_to_pdf_rect(
    screen_rect: RectTuple,
    page_screen_rect: RectTuple,
    page_width: float,
    page_height: float,
) -> RectTuple:
    scale_x = page_screen_rect[2] / page_width
    scale_y = page_screen_rect[3] / page_height
    x, y, width, height = screen_rect
    return (
        (x - page_screen_rect[0]) / scale_x,
        (y - page_screen_rect[1]) / scale_y,
        width / scale_x,
        height / scale_y,
    )


def _intersects_char(char_bbox: Any, selection: RectTuple) -> bool:
    char = _rect((
        float(char_bbox[0]),
        float(char_bbox[1]),
        float(char_bbox[2]) - float(char_bbox[0]),
        float(char_bbox[3]) - float(char_bbox[1]),
    ))
    if char is None:
        return False
    center_x = char[0] + (char[2] / 2)
    center_y = char[1] + (char[3] / 2)
    return (
        selection[0] - 1 <= center_x <= selection[0] + selection[2] + 1
        and selection[1] - 1 <= center_y <= selection[1] + selection[3] + 1
    )


def _selection_from_rawdict(
    rawdict: JsonDict,
    selection_rectangles: list[RectTuple],
) -> _RawSelection | None:
    selected_blocks: list[tuple[int, str, list[int]]] = []
    rectangle_hits = [False] * len(selection_rectangles)
    for block_index, block in enumerate(rawdict.get("blocks") or []):
        if int(block.get("type") or 0) != 0:
            continue
        character_index = 0
        selected_indices: list[int] = []
        selected_lines: list[str] = []
        for line in block.get("lines") or []:
            selected_line: list[str] = []
            for span in line.get("spans") or []:
                for character in span.get("chars") or []:
                    matches = [
                        rect_index
                        for rect_index, selection in enumerate(selection_rectangles)
                        if _intersects_char(character.get("bbox"), selection)
                    ]
                    if matches:
                        selected_indices.append(character_index)
                        selected_line.append(str(character.get("c") or ""))
                        for rect_index in matches:
                            rectangle_hits[rect_index] = True
                    character_index += 1
            line_text = "".join(selected_line).strip()
            if line_text:
                selected_lines.append(line_text)
        if selected_indices:
            selected_blocks.append((
                block_index,
                "\n".join(selected_lines),
                selected_indices,
            ))

    if len(selected_blocks) != 1 or not all(rectangle_hits):
        return None
    block_index, text, indices = selected_blocks[0]
    if not text:
        return None
    if indices != list(range(indices[0], indices[-1] + 1)):
        return None
    return _RawSelection(text=text, block_index=block_index)


def selected_text_from_rawdict(
    rawdict: JsonDict,
    selection_rectangles: list[RectTuple],
) -> str:
    selection = _selection_from_rawdict(rawdict, selection_rectangles)
    return "" if selection is None else selection.text


def _block_text_from_rawdict(rawdict: JsonDict, block_index: int) -> str:
    blocks = rawdict.get("blocks") or []
    if block_index < 0 or block_index >= len(blocks):
        return ""
    block = blocks[block_index]
    lines: list[str] = []
    for line in block.get("lines") or []:
        text = "".join(
            str(character.get("c") or "")
            for span in line.get("spans") or []
            for character in span.get("chars") or []
        ).strip()
        if text:
            lines.append(text)
    return "\n".join(lines)[:4000]


def _rect_intersection_area(left: RectTuple, right: RectTuple) -> float:
    width = max(
        0.0,
        min(left[0] + left[2], right[0] + right[2]) - max(left[0], right[0]),
    )
    height = max(
        0.0,
        min(left[1] + left[3], right[1] + right[3]) - max(left[1], right[1]),
    )
    return width * height


def context_from_blocks(
    blocks: Iterable[Any],
    selection_rectangles: list[RectTuple],
) -> str:
    selected: list[tuple[float, str]] = []
    for block in blocks:
        if len(block) < 5:
            continue
        block_rect = _rect((
            float(block[0]),
            float(block[1]),
            float(block[2]) - float(block[0]),
            float(block[3]) - float(block[1]),
        ))
        text = str(block[4] or "").strip()
        if block_rect is None or not text:
            continue
        overlap = sum(
            _rect_intersection_area(block_rect, selection)
            for selection in selection_rectangles
        )
        if overlap > 0:
            selected.append((overlap, text))
    selected.sort(key=lambda item: item[0], reverse=True)
    return "\n\n".join(text for _, text in selected[:3])[:4000]


def _matching_core(uia_text: str, recovered_text: str) -> str:
    normalized_uia = _normalize_text(uia_text)
    normalized_recovered = _normalize_text(recovered_text)
    if not normalized_uia or not normalized_recovered:
        return ""
    if normalized_uia == normalized_recovered:
        return normalized_recovered

    matcher = difflib.SequenceMatcher(
        None,
        normalized_uia,
        normalized_recovered,
        autojunk=False,
    )
    match = matcher.find_longest_match()
    matching_blocks = [
        block
        for block in matcher.get_matching_blocks()
        if block.size > 0
    ]
    max_length = max(len(normalized_uia), len(normalized_recovered))
    difference_total = (
        len(normalized_uia)
        + len(normalized_recovered)
        - (2 * match.size)
    )
    difference_limit = max(4, int(math.ceil(max_length * 0.10)))
    if (
        match.size < 8
        or match.size / max_length < 0.85
        or difference_total > difference_limit
        or sum(block.size for block in matching_blocks) != match.size
    ):
        return ""
    return normalized_recovered[match.b:match.b + match.size].strip()


def recovery_is_consistent(uia_text: str, recovered_text: str, context: str) -> bool:
    normalized_recovered = _normalize_text(recovered_text)
    normalized_context = _normalize_text(context)
    if not _matching_core(uia_text, recovered_text):
        return False
    return not normalized_context or normalized_recovered in normalized_context


def recover_local_pdf_selection(
    data: JsonDict,
    *,
    screen_capture: tuple[Image.Image, tuple[int, int]] | None = None,
) -> PdfSelectionRecovery:
    path = _local_pdf_path(data.get("document_location"))
    try:
        reported_page_number = int(data.get("page_number") or 0)
    except (TypeError, ValueError):
        reported_page_number = 0
    try:
        ancestor_page_number = int(data.get("page_ancestor_number") or 0)
    except (TypeError, ValueError):
        ancestor_page_number = 0
    try:
        selector_page_number = int(data.get("page_selector_number") or 0)
    except (TypeError, ValueError):
        selector_page_number = 0
    page_number = ancestor_page_number or reported_page_number
    page_screen_rect = _rect(data.get("page_rect"))
    raw_rectangles = [
        rect
        for rect in (_rect(value) for value in data.get("rectangles") or [])
        if rect is not None
    ]
    uia_text = str(data.get("text") or "")
    if path is None:
        return PdfSelectionRecovery(False, error="The PDF location is not a readable local file.")
    if page_number <= 0 or page_screen_rect is None or not raw_rectangles:
        return PdfSelectionRecovery(False, error="The PDF page geometry is incomplete.")
    if (
        selector_page_number > 0
        and ancestor_page_number > 0
        and selector_page_number != ancestor_page_number
    ):
        return PdfSelectionRecovery(
            False,
            document_path=str(path),
            page_number=page_number,
            error=(
                "The PDF toolbar page and selected page geometry disagreed."
            ),
        )
    if (
        bool(data.get("truncated"))
        or bool(data.get("rectangles_truncated"))
        or int(data.get("range_count") or 1) != 1
    ):
        return PdfSelectionRecovery(
            False,
            document_path=str(path),
            page_number=page_number,
            error="The UI Automation selection range was incomplete or non-contiguous.",
        )

    try:
        import fitz
    except Exception as exc:
        return PdfSelectionRecovery(
            False,
            document_path=str(path),
            page_number=page_number,
            error=f"PyMuPDF is unavailable: {type(exc).__name__}: {exc}",
        )

    try:
        if screen_capture is None:
            expected_hwnd = int(data.get("hwnd") or 0)
            foreground_before = _foreground_window_handle()
            if expected_hwnd > 0 and foreground_before != expected_hwnd:
                raise ValueError(
                    "The PDF window was not foreground during visual verification."
                )
            image, origin = _capture_screen()
            foreground_after = _foreground_window_handle()
            if (
                expected_hwnd > 0
                and foreground_after != expected_hwnd
            ):
                raise ValueError(
                    "The foreground window changed during visual verification."
                )
        else:
            image, origin = screen_capture
        visual_rectangles = extend_highlight_rectangles(
            image,
            raw_rectangles,
            page_screen_rect,
            origin=origin,
        )
        if not visual_rectangles:
            raise ValueError("The visible selection highlight could not be measured.")

        with fitz.open(path) as document:
            if page_number > document.page_count:
                raise ValueError("The selected PDF page is outside the document.")
            page = document[page_number - 1]
            if int(page.rotation or 0) % 360 != 0:
                raise ValueError("Rotated PDF pages are not supported by verified recovery.")
            scale_x = page_screen_rect[2] / float(page.rect.width)
            scale_y = page_screen_rect[3] / float(page.rect.height)
            if scale_x <= 0 or scale_y <= 0 or abs(scale_x - scale_y) > max(scale_x, scale_y) * 0.04:
                raise ValueError("The PDF page mapping has inconsistent scale.")
            pdf_rectangles = [
                _screen_to_pdf_rect(
                    rectangle,
                    page_screen_rect,
                    float(page.rect.width),
                    float(page.rect.height),
                )
                for rectangle in visual_rectangles
            ]
            rawdict = page.get_text("rawdict")
            raw_selection = _selection_from_rawdict(rawdict, pdf_rectangles)
            if raw_selection is None:
                raise ValueError("The visible highlight did not map to one continuous PDF text run.")
            recovered_text = raw_selection.text
            context = _block_text_from_rawdict(
                rawdict,
                raw_selection.block_index,
            )
            if not recovery_is_consistent(uia_text, recovered_text, context):
                raise ValueError("The visual PDF selection did not match the UI Automation range.")
            matching_core = _matching_core(uia_text, recovered_text)
    except Exception as exc:
        return PdfSelectionRecovery(
            False,
            document_path=str(path),
            page_number=page_number,
            error=f"PDF visual selection recovery failed: {type(exc).__name__}: {exc}",
        )

    return PdfSelectionRecovery(
        True,
        text=recovered_text,
        context=context,
        rectangles=tuple(visual_rectangles),
        document_path=str(path),
        page_number=page_number,
        uia_matching_core=matching_core,
        dropped_uia_rectangle_count=len(raw_rectangles) - len(visual_rectangles),
    )
