"""Failure repair dialogue data (harness gap review L15).

Every failure resolves to a :class:`RepairSuggestion` carrying an attributed
title (never a bare "出错了" followed by a spinner), a UI-facing message, and
1-4 suggested repair actions. Callers pass the raw failure type and evidence
status strings; the mapping table owns the wording.

Pure Python, stdlib-only. No I/O, no Electron coupling.
"""

from __future__ import annotations

import enum
from dataclasses import dataclass
from typing import Any

__all__ = [
    "RepairAction",
    "RepairSuggestion",
    "build_repair",
    "to_dict",
]


class RepairAction(enum.StrEnum):
    """A user-facing repair action suggested after a failure."""

    USE_LOOK = "use_look"
    REPICK = "repick"
    RECHOOSE_CANDIDATE = "rechoose_candidate"
    RETRY = "retry"
    EXPLAIN_WHAT_FAILED = "explain_what_failed"
    ASK_USER = "ask_user"


_BARE_TITLES = frozenset({"出错了", "出错", "失败", "失败啦", "出问题"})


@dataclass(frozen=True, slots=True)
class RepairSuggestion:
    """One repair dialogue entry: attribution + actions for the UI."""

    title: str
    message: str
    actions: tuple[RepairAction, ...]
    evidence_status: str | None = None

    def __post_init__(self) -> None:
        if not self.title.strip():
            raise ValueError("title must not be empty")
        if self.title.strip() in _BARE_TITLES:
            raise ValueError("title must carry an attribution, not a bare failure phrase")
        if not self.message.strip():
            raise ValueError("message must not be empty")
        if not 1 <= len(self.actions) <= 4:
            raise ValueError("actions must contain 1..4 items")


_TARGET_LABELS = {
    "text_selection": "文本选区",
    "table_region": "表格区域",
    "file_line": "文件行",
    "image": "图片",
    "url": "链接",
    "email": "邮件",
    "phone": "号码",
}


def _target_phrase(target_type: str | None) -> str:
    if target_type:
        return f"这个{_TARGET_LABELS.get(target_type, target_type)}"
    return "这里"


def _suggest(
    title_template: str,
    message: str,
    actions: tuple[RepairAction, ...],
    target_type: str | None,
    evidence_status: str | None,
) -> RepairSuggestion:
    return RepairSuggestion(
        title=title_template.format(target=_target_phrase(target_type)),
        message=message,
        actions=actions,
        evidence_status=evidence_status,
    )


def build_repair(
    failure_type: str | None,
    evidence_status: str | None,
    target_type: str | None = None,
) -> RepairSuggestion:
    """Map a failure/evidence pair to an attributed :class:`RepairSuggestion`.

    Rules are evaluated in order; the first matching row wins:
    1. timeout (failure or evidence busy/timeout) -> use_look + retry
    2. empty_confirmed -> repick + ask_user
    3. stale anchor (stale_anchor failure, or error evidence without a
       specific failure type) -> repick + rechoose_candidate
    4. ambiguous -> rechoose_candidate + ask_user
    5. unsupported (failure or evidence) -> explain_what_failed + use_look
    6. permission_denied -> explain_what_failed + ask_user
    7. anything else -> ask_user + use_look

    ``target_type`` is woven into the title when provided.
    """
    if failure_type == "timeout" or evidence_status in ("busy", "timeout"):
        return _suggest(
            "{target}读取超时，可能还在忙",
            "这个位置我读不清楚。要我启用视觉看一眼（约 1 秒），或者重试一次？",
            (RepairAction.USE_LOOK, RepairAction.RETRY),
            target_type,
            evidence_status,
        )
    if evidence_status == "empty_confirmed":
        return _suggest(
            "{target}已确认没有内容",
            "已确认这个位置没有内容。换个位置指一下，或告诉我下一步怎么做。",
            (RepairAction.REPICK, RepairAction.ASK_USER),
            target_type,
            evidence_status,
        )
    if failure_type == "stale_anchor" or (evidence_status == "error" and failure_type is None):
        return _suggest(
            "{target}目标已变化，可能已失效",
            "目标已变化或失效，之前的定位不成立了。重新指一下，或从候选里选一个。",
            (RepairAction.REPICK, RepairAction.RECHOOSE_CANDIDATE),
            target_type,
            evidence_status,
        )
    if evidence_status == "ambiguous":
        return _suggest(
            "{target}有多个候选，不确定你指哪个",
            "这里有多个候选，我读到的不止一个。选一个候选，或告诉我你想要哪个。",
            (RepairAction.RECHOOSE_CANDIDATE, RepairAction.ASK_USER),
            target_type,
            evidence_status,
        )
    if failure_type == "unsupported" or evidence_status == "unsupported":
        return _suggest(
            "对{target}的操作不支持或未配置",
            "这个目标不支持该操作或尚未配置。要我解释失败详情，或改用视觉看一眼？",
            (RepairAction.EXPLAIN_WHAT_FAILED, RepairAction.USE_LOOK),
            target_type,
            evidence_status,
        )
    if failure_type == "permission_denied":
        return _suggest(
            "权限不足，无法读取{target}",
            "没有读取这个位置的权限。要我解释失败详情，或告诉我换一种方式？",
            (RepairAction.EXPLAIN_WHAT_FAILED, RepairAction.ASK_USER),
            target_type,
            evidence_status,
        )
    return _suggest(
        "无法确定{target}失败的原因",
        "无法确定失败原因。告诉我换个方式指一下，或让我用视觉看一眼？",
        (RepairAction.ASK_USER, RepairAction.USE_LOOK),
        target_type,
        evidence_status,
    )


def to_dict(suggestion: RepairSuggestion) -> dict[str, Any]:
    """Serialize a suggestion for UI consumption."""
    return {
        "title": suggestion.title,
        "message": suggestion.message,
        "actions": [action.value for action in suggestion.actions],
        "evidence_status": suggestion.evidence_status,
    }
