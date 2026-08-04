"""Did the structured layer read what the user actually marked?

A non-empty string is not the same thing as an answer. On 2026-08-04 a stroke
drawn across one line of a PowerShell console produced a UIA read whose content
was ``C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`` — the
container's accessible name. Because that string was non-empty, the pipeline
recorded a successful structured read, switched off the pixel fallback, and told
the user it could see which window they were pointing at but not what they had
underlined. The pixels were on disk the whole time; OCR run against that same
capture afterwards picked the underlined line out of 53 candidate blocks exactly.

This module answers one narrow question so that the two bridges can agree on it:
given what the structured layer returned, is it plausibly *the marked content*?
Everything here is pure — no UIA, no files, no IPC — so the rule can be argued
with in a test rather than on a live desktop.
"""

from __future__ import annotations

from dataclasses import dataclass

# An element taller than this fraction of the window is the surface the mark sits
# on, not the thing that was marked — a chat transcript, a console buffer, a page.
CONTAINER_WINDOW_HEIGHT_RATIO = 0.5
# ...and it has to be substantially taller than the mark itself. A paragraph that
# is a few lines taller than one underline is a perfectly ordinary read.
CONTAINER_MARK_HEIGHT_RATIO = 6.0


@dataclass(frozen=True)
class MarkCoverage:
    """Whether the structured read covers the mark, and why not when it does not.

    ``reason`` is carried to the diagnostics page and the perception trace, so it
    is a stable identifier rather than a sentence.
    """

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
    """A path to the program is the app telling us its own name, not content."""
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
    """Is this rectangle the surface the mark sits on rather than the marked thing?

    Shared by the coverage judgement and by gesture grounding, which must not
    report "you selected this" about a rectangle covering the whole window just
    because the stroke happened to pass through it. Height is the discriminator:
    an underline is horizontal by nature, so what separates a line from its
    container is how many rows it spans.
    """
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
) -> MarkCoverage:
    """Judge a structured read against the region the user marked.

    ``element_rects`` and ``mark_bbox`` are ``[x, y, w, h]`` in physical screen
    pixels. Both are optional: adapters like Word COM and the DOM reader return
    real text with no geometry, and refusing those would trade one wrong answer
    for another. Geometry only ever *removes* confidence, never adds it.
    """
    if not str(content or "").strip():
        return MarkCoverage(False, "no_structured_text")
    if _is_identity(str(content), window):
        return MarkCoverage(False, "identity_only")

    mark = _rect(mark_bbox)
    rects = [rect for rect in (_rect(item) for item in list(element_rects or [])) if rect]
    if mark is None or not rects:
        return MarkCoverage(True, "structured_text")

    crossed = [rect for rect in rects if _intersects(rect, mark)]
    if not crossed:
        # The stroke landed between elements. There is text on this window, but
        # not the text this line was drawn through.
        return MarkCoverage(False, "mark_crossed_no_element")

    tallest = max(crossed, key=lambda rect: rect[3])
    if rect_is_container(list(tallest), window=window, mark_bbox=list(mark)):
        return MarkCoverage(False, "container_not_selection")
    return MarkCoverage(True, "structured_text")
