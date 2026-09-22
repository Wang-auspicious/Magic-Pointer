
from __future__ import annotations

import re
from typing import Any

_SLUG_CAP = 28
_SLUG_CLEAN = re.compile(r"[^0-9a-z\u4e00-\u9fff]+")

_ROLE_TOKENS = {
    "link": "LNK",
    "hyperlink": "LNK",
    "button": "BTN",
    "text": "TXT",
    "edit": "EDT",
    "listitem": "ITM",
    "list_item": "ITM",
    "combobox": "CMB",
    "tabitem": "TAB",
    "tab_item": "TAB",
    "document": "DOC",
    "checkbox": "CHK",
    "image": "IMG",
    "table": "TBL",
    "list": "LST",
    "pane": "PNL",
    "group": "GRP",
    "menuitem": "MNU",
    "treeitem": "TRE",
}


def slugify_text(value: Any, cap: int = _SLUG_CAP) -> str:
    lowered = str(value or "").strip().casefold()
    slug = _SLUG_CLEAN.sub("-", lowered).strip("-")
    return slug[:cap].rstrip("-")


def element_ref(element: dict[str, Any]) -> str:
    automation_id = str(element.get("automation_id") or "").strip()
    if automation_id:
        return f"A#{automation_id[:64]}"
    control_type = str(element.get("control_type") or "").strip().casefold()
    token = _ROLE_TOKENS.get(control_type, "ELM")
    slug = slugify_text(element.get("text"))
    return f"{token}-{slug}" if slug else token


def assign_element_handles(
    elements: list[dict[str, Any]],
    *,
    budget: int = 24,
) -> list[dict[str, Any]]:
    handles: list[dict[str, Any]] = []
    used: dict[str, int] = {}
    for element in elements or []:
        if not isinstance(element, dict) or len(handles) >= max(0, int(budget)):
            break
        rect_raw = element.get("rect")
        if not isinstance(rect_raw, (list, tuple)) or len(rect_raw) != 4:
            continue
        try:
            rect = [int(round(float(value))) for value in rect_raw]
        except (TypeError, ValueError):
            continue
        name = str(element.get("text") or "").strip()
        ref = element_ref(element)
        ordinal = used.get(ref, 0) + 1
        used[ref] = ordinal
        if ordinal > 1:
            ref = f"{ref}-{ordinal}"
        role = str(element.get("control_type") or "").strip() or "Unknown"
        handles.append({
            "ref": ref,
            "role": role,
            "name": name[:120],
            "rect": rect,
        })
    return handles
