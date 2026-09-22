#!/usr/bin/env python3

from __future__ import annotations

import json
import sys
import time
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.adapters.uia_text_adapter import _run_uia_selection_probe
from app.system_context import enable_dpi_awareness, list_visible_windows

enable_dpi_awareness()

MAGIC_WINDOW_TITLES = {"Magic Pointer Overlay", "Magic Pointer Panel", "Magic Pointer Stage"}

PROBE_TIMEOUT_S = 2.5


def _window_at(x: int, y: int, preferred_hwnd: int = 0) -> dict[str, Any] | None:
    if preferred_hwnd:
        rect = _window_rect(preferred_hwnd)
        if rect is not None:
            return {"hwnd": preferred_hwnd, "title": _window_title(preferred_hwnd), "bbox": list(rect)}

    windows = [
        dict(item)
        for item in list_visible_windows()
        if str(item.get("title") or "") not in MAGIC_WINDOW_TITLES
    ]
    for item in windows:
        bbox = item.get("bbox")
        if not isinstance(bbox, (list, tuple)) or len(bbox) != 4:
            continue
        left, top, right, bottom = (int(value) for value in bbox)
        if left <= x < right and top <= y < bottom:
            return item
    return None


def _window_rect(hwnd: int) -> tuple[int, int, int, int] | None:
    try:
        import ctypes
        import ctypes.wintypes as wintypes

        rect = wintypes.RECT()
        if not ctypes.windll.user32.GetWindowRect(wintypes.HWND(int(hwnd)), ctypes.byref(rect)):
            return None
        if rect.right <= rect.left or rect.bottom <= rect.top:
            return None
        if rect.left < -30000 or rect.top < -30000:
            return None
        return rect.left, rect.top, rect.right, rect.bottom
    except Exception:
        return None


def _window_title(hwnd: int) -> str:
    try:
        import ctypes
        import ctypes.wintypes as wintypes

        buffer = ctypes.create_unicode_buffer(256)
        ctypes.windll.user32.GetWindowTextW(wintypes.HWND(int(hwnd)), buffer, 256)
        return buffer.value
    except Exception:
        return ""


WINDOW_COVERAGE_LIMIT = 0.92


def _covers_window(rect: dict[str, int], window_bbox: Any) -> bool:
    if not isinstance(window_bbox, (list, tuple)) or len(window_bbox) != 4:
        return False
    left, top, right, bottom = (int(value) for value in window_bbox)
    window_area = max(1, (right - left) * (bottom - top))
    return (rect["width"] * rect["height"]) / window_area >= WINDOW_COVERAGE_LIMIT


def _rect_from(value: Any) -> dict[str, int] | None:
    if not isinstance(value, (list, tuple)) or len(value) != 4:
        return None
    try:
        x, y, width, height = (int(round(float(item))) for item in value)
    except (TypeError, ValueError):
        return None
    if width <= 0 or height <= 0:
        return None
    return {"x": x, "y": y, "width": width, "height": height}


def _visual_element_at(window: dict[str, Any], x: int, y: int) -> dict[str, Any] | None:
    from app.vision.visual_element_cache import read_cached, write_cached
    from app.vision.visual_elements import VisualElement, element_at_point, group_blocks_into_elements

    hwnd = int(window.get("hwnd") or 0)
    bbox = window.get("bbox")
    image = _capture_visual_image(window)
    if image is None:
        return None
    import hashlib

    content_key = hashlib.sha256(image.convert("RGB").tobytes()).hexdigest()
    cached = read_cached(hwnd, bbox, content_key=content_key)
    if cached is None:
        blocks = _ocr_window_blocks(window, image=image)
        if blocks is None:
            return None
        elements = group_blocks_into_elements(blocks, window_bbox=bbox)
        cached = [
            {"rect": element.rect, "text": element.text[:200], "lineCount": element.line_count}
            for element in elements
        ]
        write_cached(hwnd, bbox, cached, content_key=content_key)
    restored = [
        VisualElement(
            rect=list(item.get("rect") or []),
            text=str(item.get("text") or ""),
            line_count=int(item.get("lineCount") or 1),
        )
        for item in cached
        if isinstance(item, dict) and isinstance(item.get("rect"), list) and len(item["rect"]) == 4
    ]
    hit = element_at_point(restored, {"x": x, "y": y})
    if hit is None:
        return None
    return {
        "rect": {"x": hit.rect[0], "y": hit.rect[1], "width": hit.rect[2], "height": hit.rect[3]},
        "label": hit.text.splitlines()[0][:120] if hit.text else "",
    }


def _capture_visual_image(window: dict[str, Any]):
    from app.capture import capture_window

    try:
        image = capture_window(int(window.get("hwnd") or 0))
        bbox = window.get("bbox") or []
        if len(bbox) == 4:
            image = image.resize((int(bbox[2]) - int(bbox[0]), int(bbox[3]) - int(bbox[1])))
        return image
    except (OSError, ValueError, TypeError):
        return None


def _ocr_window_blocks(window: dict[str, Any], *, image: Any = None) -> list[dict[str, Any]] | None:
    import tempfile

    bbox = window.get("bbox")
    if not isinstance(bbox, (list, tuple)) or len(bbox) != 4:
        return None
    region = (int(bbox[0]), int(bbox[1]), int(bbox[2]), int(bbox[3]))
    path = None
    try:
        image = image if image is not None else _capture_visual_image(window)
        if image is None:
            return None
        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as handle:
            path = Path(handle.name)
        image.convert("RGB").save(path, format="PNG")
        from scripts.selection_bridge import _read_local_ocr_boxes

        read = _read_local_ocr_boxes(path, strokes_local=None, selection_local=None)
        if not read:
            return None
        blocks, _engine = read
        return [
            {
                "text": block.get("text"),
                "rect": [
                    int(block["rect"][0]) + region[0],
                    int(block["rect"][1]) + region[1],
                    int(block["rect"][2]),
                    int(block["rect"][3]),
                ],
            }
            for block in blocks
            if isinstance(block.get("rect"), (list, tuple)) and len(block["rect"]) == 4
        ]
    except Exception:
        return None
    finally:
        if path is not None:
            try:
                path.unlink(missing_ok=True)
            except OSError:
                pass


def main() -> int:
    started = time.monotonic()
    try:
        raw = sys.stdin.read().strip()
        payload = json.loads(raw) if raw else {}
        x = int(payload["x"])
        y = int(payload["y"])
    except (KeyError, TypeError, ValueError):
        print(json.dumps({"ok": False, "error": "a physical screen point is required"}, ensure_ascii=False))
        return 2

    window = _window_at(x, y, int(payload.get("hwnd") or 0))
    if window is None:
        print(json.dumps({"ok": False, "error": "no_window_at_point"}, ensure_ascii=False))
        return 1

    result = _run_uia_selection_probe(
        int(window.get("hwnd") or 0),
        target_point={"x": x, "y": y},
        timeout=PROBE_TIMEOUT_S,
    )
    data = result.data or {}
    candidates = [
        candidate
        for candidate in (
            _rect_from(data.get("element_rect")),
            *(_rect_from(item) for item in (data.get("rectangles") or [])),
        )
        if candidate is not None and not _covers_window(candidate, window.get("bbox"))
    ]
    rect = min(candidates, key=lambda item: item["width"] * item["height"]) if candidates else None
    source = "structured"
    label = str(data.get("element_name") or "")[:120]
    if rect is None:
        visual = _visual_element_at(window, x, y)
        if visual is not None:
            rect, label, source = visual["rect"], visual["label"], "pixel"
    if rect is None:
        print(json.dumps({
            "ok": False,
            "error": "no_element_at_point",
            "window": {"hwnd": int(window.get("hwnd") or 0), "title": str(window.get("title") or "")},
            "elapsedMs": round((time.monotonic() - started) * 1000, 1),
        }, ensure_ascii=False))
        return 1

    print(json.dumps({
        "ok": True,
        "rect": rect,
        "source": source,
        "label": label,
        "controlType": str(data.get("control_type") or "")[:80],
        "resultKind": str(data.get("result_kind") or ""),
        "window": {
            "hwnd": int(window.get("hwnd") or 0),
            "title": str(window.get("title") or "")[:200],
        },
        "elapsedMs": round((time.monotonic() - started) * 1000, 1),
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
