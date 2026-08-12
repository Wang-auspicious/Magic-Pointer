"""Target-conditioned capability hints (harness gap review L16).

"我在这儿能干嘛" — the data layer behind the per-target hint chips. Hints
are derived from a target-type -> actions catalog, reference trajectories by
id keyword, and are filtered by the tool registry so the UI only surfaces
capabilities that exist in this install.

Pure Python, stdlib-only. No I/O, no Electron coupling.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

__all__ = [
    "Hint",
    "HintSpec",
    "MIN_HINTS",
    "MAX_HINTS",
    "hints_for",
]

MIN_HINTS = 3
MAX_HINTS = 8


@dataclass(frozen=True, slots=True)
class Hint:
    """One capability chip: action label, description, and trigger trajectory."""

    action: str
    description: str
    trajectory_id: str | None = None


@dataclass(frozen=True, slots=True)
class HintSpec:
    """Catalog entry: display action + registry/trajectory match keyword."""

    action: str
    keyword: str
    description: str


_TARGET_ACTIONS: dict[str, tuple[HintSpec, ...]] = {
    "text_selection": (
        HintSpec("翻译", "translate", "把这段文字翻译成其他语言"),
        HintSpec("解释", "explain", "解释这段文字的意思"),
        HintSpec("改写", "rewrite", "换一种说法改写这段文字"),
        HintSpec("扩写", "expand", "展开这段文字，补充细节"),
        HintSpec("压缩", "compress", "把这段文字压缩成要点"),
    ),
    "table_region": (
        HintSpec("转表格", "markdown", "把表格区域转为 Markdown 表格"),
        HintSpec("求和", "sum", "对表格里的数字求和"),
        HintSpec("排序", "sort", "按某列排序表格"),
    ),
    "file_line": (
        HintSpec("打开", "open", "打开这个文件"),
        HintSpec("重命名", "rename", "重命名这个文件"),
        HintSpec("发给", "send", "把这个文件发给别人"),
    ),
    "image": (
        HintSpec("图转提示词", "image_prompt", "把图片转成提示词"),
        HintSpec("描述", "describe", "描述图片内容"),
        HintSpec("OCR 复制", "ocr", "识别图片文字并复制"),
    ),
    "url": (
        HintSpec("打开链接", "open", "打开这个链接"),
        HintSpec("发邮件", "email", "把链接内容发给别人"),
        HintSpec("拨号", "dial", "拨打这个号码"),
    ),
    "email": (
        HintSpec("打开链接", "open", "打开这个链接"),
        HintSpec("发邮件", "email", "把链接内容发给别人"),
        HintSpec("拨号", "dial", "拨打这个号码"),
    ),
    "phone": (
        HintSpec("打开链接", "open", "打开这个链接"),
        HintSpec("发邮件", "email", "把链接内容发给别人"),
        HintSpec("拨号", "dial", "拨打这个号码"),
    ),
}

_DEFAULT_ACTIONS: tuple[HintSpec, ...] = (
    HintSpec("解释", "explain", "解释这个位置的内容"),
    HintSpec("翻译", "translate", "把内容翻译成其他语言"),
    HintSpec("总结", "summarize", "总结这个位置的内容"),
)


def _trajectory_ids(trajectories: Sequence) -> list[str]:
    """Extract candidate id strings from heterogeneous trajectory objects."""
    ids: list[str] = []
    for item in trajectories:
        if isinstance(item, str):
            ids.append(item)
            continue
        for attr in ("id", "recipe_id", "name"):
            value = getattr(item, attr, None)
            if value is not None:
                ids.append(str(value))
                break
        else:
            ids.append(str(item))
    return ids


def _make_hint(spec: HintSpec, ids: Sequence[str]) -> Hint:
    trajectory_id = next((i for i in ids if spec.keyword in i.lower()), None)
    return Hint(action=spec.action, description=spec.description, trajectory_id=trajectory_id)


def _available(spec: HintSpec, tools: Sequence[str]) -> bool:
    return any(spec.keyword in tool for tool in tools)


def hints_for(
    target_type: str,
    trajectories: Sequence,
    registry_tools: Sequence[str],
) -> tuple[Hint, ...]:
    """Derive 3-8 capability hints for a target.

    - ``target_type`` selects the action catalog; unknown types get defaults.
    - Specs whose keyword matches no registry tool are skipped; if every spec
      is skipped the default catalog is returned (the floor is never zero).
    - Results are truncated to MAX_HINTS and padded with defaults up to
      MIN_HINTS, without duplicating an action.
    """
    specs = _TARGET_ACTIONS.get(target_type, _DEFAULT_ACTIONS)
    tools = [tool.lower() for tool in registry_tools]
    ids = _trajectory_ids(trajectories)

    chosen = [spec for spec in specs if _available(spec, tools)]
    if not chosen:
        chosen = list(_DEFAULT_ACTIONS)

    hints = [_make_hint(spec, ids) for spec in chosen[:MAX_HINTS]]
    if len(hints) < MIN_HINTS:
        existing = {hint.action for hint in hints}
        for spec in _DEFAULT_ACTIONS:
            if spec.action in existing:
                continue
            hints.append(_make_hint(spec, ids))
            existing.add(spec.action)
            if len(hints) >= MIN_HINTS:
                break
    return tuple(hints[:MAX_HINTS])
