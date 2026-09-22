
from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]

CACHE_TTL_S = 8.0

_CACHE_VERSION = 1


def _cache_path() -> Path:
    root = Path(os.environ.get("MAGIC_POINTER_USER_DATA_DIR") or ROOT / "data" / "runtime")
    return root / "visual-elements-cache.json"


def _key(hwnd: int, window_bbox: Any) -> str:
    bbox = list(window_bbox or [])
    return f"{_CACHE_VERSION}:{int(hwnd)}:{','.join(str(int(v)) for v in bbox)}" if bbox else f"{_CACHE_VERSION}:{int(hwnd)}"


def read_cached(hwnd: int, window_bbox: Any, *, now: float | None = None, content_key: str = "") -> list[dict[str, Any]] | None:
    moment = time.time() if now is None else now
    try:
        raw = json.loads(_cache_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    entry = raw.get(_key(hwnd, window_bbox)) if isinstance(raw, dict) else None
    if not isinstance(entry, dict):
        return None
    if str(entry.get("contentKey") or "") != content_key:
        return None
    try:
        if moment - float(entry.get("at") or 0) > CACHE_TTL_S:
            return None
    except (TypeError, ValueError):
        return None
    elements = entry.get("elements")
    return elements if isinstance(elements, list) else None


def write_cached(hwnd: int, window_bbox: Any, elements: list[dict[str, Any]], *, now: float | None = None, content_key: str = "") -> None:
    moment = time.time() if now is None else now
    path = _cache_path()
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            raw = {}
    except (OSError, ValueError):
        raw = {}
    raw = {
        key: value
        for key, value in raw.items()
        if isinstance(value, dict) and moment - float(value.get("at") or 0) <= CACHE_TTL_S
    }
    raw[_key(hwnd, window_bbox)] = {"at": moment, "elements": elements[:60], "contentKey": content_key}
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        temp = path.with_suffix(".json.tmp")
        temp.write_text(json.dumps(raw, ensure_ascii=False), encoding="utf-8")
        os.replace(temp, path)
    except OSError:
        pass
