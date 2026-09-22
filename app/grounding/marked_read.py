
from __future__ import annotations

from dataclasses import dataclass

CONTAINER_WINDOW_HEIGHT_RATIO = 0.5
CONTAINER_MARK_HEIGHT_RATIO = 6.0


@dataclass(frozen=True)
class MarkCoverage:

    covers: bool
    reason: str


def _rect(value: object) -> tuple[int, int, int, int] | None:
    if not isinstance(value, (list, tuple)) or len(value) != 4:
        return None
    try:
        left, top, width, height = (int(round(float(item))) for item in value)
    except (TypeError, ValueError):
        return None
    if width <= 0 or height <= 0:
        return None
    return left, top, width, height


def _intersects(a: tuple[int, int, int, int], b: tuple[int, int, int, int]) -> bool:
    return (
        a[0] < b[0] + b[2]
        and b[0] < a[0] + a[2]
        and a[1] < b[1] + b[3]
        and b[1] < a[1] + a[3]
    )


def _window_height(window: dict | None) -> int:
    bbox = (window or {}).get("bbox")
    if not isinstance(bbox, (list, tuple)) or len(bbox) != 4:
        return 0
    try:
        top, bottom = float(bbox[1]), float(bbox[3])
    except (TypeError, ValueError):
        return 0
    return max(0, int(round(bottom - top)))


def _looks_like_an_executable_path(text: str) -> bool:
    compact = text.strip().replace("\\", "/")
    if "\n" in compact or len(compact) > 260 or "/" not in compact:
        return False
    return compact.casefold().endswith((".exe", ".app", ".dll"))


def _is_identity(content: str, window: dict | None) -> bool:
    text = content.strip()
    if _looks_like_an_executable_path(text):
        return True
    folded = text.casefold()
    for key in ("title", "app", "process_name", "processName"):
        value = str((window or {}).get(key) or "").strip().casefold()
        if value and folded == value:
            return True
    return False


def rect_is_container(rect: object, *, window: dict | None = None, mark_bbox: object = None) -> bool:
    box = _rect(rect)
    mark = _rect(mark_bbox)
    if box is None or mark is None:
        return False
    window_height = _window_height(window)
    if window_height <= 0:
        return False
    return (
        box[3] > window_height * CONTAINER_WINDOW_HEIGHT_RATIO
        and box[3] > mark[3] * CONTAINER_MARK_HEIGHT_RATIO
    )


def structured_read_covers_mark(
    *,
    content: str,
    window: dict | None = None,
    element_rects: object = (),
    mark_bbox: object = None,
    has_explicit_binding: bool | None = None,
) -> MarkCoverage:
    if not str(content or "").strip():
        return MarkCoverage(False, "no_structured_text")
    if _is_identity(str(content), window):
        return MarkCoverage(False, "identity_only")

    mark = _rect(mark_bbox)
    rects = [rect for rect in (_rect(item) for item in list(element_rects or [])) if rect]
    if mark is None or not rects:
        if mark is not None and has_explicit_binding is False:
            return MarkCoverage(False, "unbound_text")
        return MarkCoverage(True, "structured_text")

    crossed = [rect for rect in rects if _intersects(rect, mark)]
    if not crossed:
        return MarkCoverage(False, "mark_crossed_no_element")

    tallest = max(crossed, key=lambda rect: rect[3])
    if rect_is_container(list(tallest), window=window, mark_bbox=list(mark)):
        return MarkCoverage(False, "container_not_selection")
    return MarkCoverage(True, "structured_text")
