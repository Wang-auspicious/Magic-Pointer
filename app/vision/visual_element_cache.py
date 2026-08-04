"""Pointable rectangles for windows that publish none.

Measured 2026-08-05: WeChat 4.x exposes eight UI Automation nodes for its whole
window and its chat area is one opaque render surface. Pick mode had nothing to
outline there, and WeChat is not unusual — Qt, Flutter, GPU-composited Electron
and games all look like this.

`app.vision.visual_elements` can rebuild pointable objects out of OCR lines, but
OCR costs on the order of a second and pick mode asks its question at hover rate.
So the answer is computed once per window and cached here.

The cache is on disk rather than in memory because `element_probe_bridge` is a
fresh process per pick; an in-process cache would never be read. It holds
geometry and short labels, lives for seconds, and sits with the other runtime
scratch data so the existing retention story covers it.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]

# Long enough that moving the pointer around one window is instant, short enough
# that a chat which just scrolled does not answer with where things used to be.
CACHE_TTL_S = 8.0

# Windows move and resize; a cached layout for a different geometry is wrong in
# the way that matters most (it outlines the wrong thing confidently).
_CACHE_VERSION = 1


def _cache_path() -> Path:
    root = Path(os.environ.get("MAGIC_POINTER_USER_DATA_DIR") or ROOT / "data" / "runtime")
    return root / "visual-elements-cache.json"


def _key(hwnd: int, window_bbox: Any) -> str:
    bbox = list(window_bbox or [])
    return f"{_CACHE_VERSION}:{int(hwnd)}:{','.join(str(int(v)) for v in bbox)}" if bbox else f"{_CACHE_VERSION}:{int(hwnd)}"


def read_cached(hwnd: int, window_bbox: Any, *, now: float | None = None) -> list[dict[str, Any]] | None:
    """Elements for this window if they were computed recently, else None."""
    moment = time.time() if now is None else now
    try:
        raw = json.loads(_cache_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    entry = raw.get(_key(hwnd, window_bbox)) if isinstance(raw, dict) else None
    if not isinstance(entry, dict):
        return None
    try:
        if moment - float(entry.get("at") or 0) > CACHE_TTL_S:
            return None
    except (TypeError, ValueError):
        return None
    elements = entry.get("elements")
    return elements if isinstance(elements, list) else None


def write_cached(hwnd: int, window_bbox: Any, elements: list[dict[str, Any]], *, now: float | None = None) -> None:
    """Record this window's elements. Failure to cache is never fatal."""
    moment = time.time() if now is None else now
    path = _cache_path()
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            raw = {}
    except (OSError, ValueError):
        raw = {}
    # Drop everything stale on the way past, so this never grows without bound.
    raw = {
        key: value
        for key, value in raw.items()
        if isinstance(value, dict) and moment - float(value.get("at") or 0) <= CACHE_TTL_S
    }
    raw[_key(hwnd, window_bbox)] = {"at": moment, "elements": elements[:60]}
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        temp = path.with_suffix(".json.tmp")
        temp.write_text(json.dumps(raw, ensure_ascii=False), encoding="utf-8")
        os.replace(temp, path)
    except OSError:
        pass
