"""语义句柄文法：把结构化元素变成模型和人都读得懂的稳定地址。

Hermes「Preview 标注」机制的移植（跨应用版）：圈选完成后，把结构化读取
真的拿到的元素以「框 + 句柄标签」回放在目标应用上。句柄文法三级降级：

1. 元素自带 automation_id → ``A#<id>``（应用自己给的锚点，最稳；
   Chromium 会把 DOM id 原样暴露在 UIA AutomationId 上）；
2. 否则 ``<TYPE>-<文本slug>``（内容寻址：文本不变句柄就有效，且模型
   不查表就能猜到指的是谁）；
3. slug 冲突 → 同组追加序号 ``-2``、``-3``（组内计数，不是全局索引）。

幻觉后果的改变：模型编造 ``LNK-NONEXISTENT`` 会查找失败、显式报错；
编造坐标则会安静地点错——这是最难 debug 的一类失败。
"""

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
    """可见文本 → 小写 slug（非字母数字折叠成连字符，CJK 保留）。"""
    lowered = str(value or "").strip().casefold()
    slug = _SLUG_CLEAN.sub("-", lowered).strip("-")
    return slug[:cap].rstrip("-")


def element_ref(element: dict[str, Any]) -> str:
    """单个元素的句柄（不含冲突序号——序号在批量分配时追加）。"""
    # automation id 是应用自己给的锚点：保持原样（含下划线），只去空白。
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
    """给结构化元素批量发句柄。

    没有合法 rect 的元素直接丢弃（画不出框的不发号）；ref 冲突按同组
    追加序号；budget 封顶（屏幕回放不需要全量，Hermes 也只回放采样）。
    """
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
