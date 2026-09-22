# MIT, Copyright (c) 2025 Nous Research.

from __future__ import annotations

from typing import Any

__all__ = [
    "TodoStore",
    "VALID_STATUSES",
    "MAX_TODO_ITEMS",
    "MAX_TODO_CONTENT_CHARS",
]

VALID_STATUSES = frozenset({"pending", "in_progress", "completed", "blocked", "cancelled"})
_ACTIVE_STATUSES = frozenset({"pending", "in_progress", "blocked"})

MAX_TODO_ITEMS = 256
MAX_TODO_CONTENT_CHARS = 4000
_TRUNCATION_MARKER = "… [truncated]"

_STATUS_MARKERS = {
    "completed": "[x]",
    "in_progress": "[>]",
    "pending": "[ ]",
    "cancelled": "[~]",
    "blocked": "[!]",
}

_INJECTION_HEADER = "[以下是你这次任务尚未完成的步骤，已跨上下文压缩保留]"


class TodoStore:

    def __init__(self) -> None:
        self._items: list[dict[str, str]] = []
        self.on_update = None

    def write(self, todos: list[dict[str, Any]]) -> list[dict[str, str]]:
        items: list[dict[str, str]] = []
        for raw in todos:
            if not isinstance(raw, dict):
                continue
            content = str(raw.get("content") or "").strip()
            if not content:
                continue
            status = str(raw.get("status") or "").strip().lower()
            if status not in VALID_STATUSES:
                status = "pending"
            items.append({"content": _cap_content(content), "status": status})
            if len(items) >= MAX_TODO_ITEMS:
                break
        self._items = items
        return self.read()

    def read(self) -> list[dict[str, str]]:
        return [dict(item) for item in self._items]

    def has_items(self) -> bool:
        return bool(self._items)

    def format_for_injection(self) -> str | None:
        active = [item for item in self._items if item["status"] in _ACTIVE_STATUSES]
        if not active:
            return None
        lines = [
            "<<<MAGIC_POINTER_EVIDENCE>>>",
            _INJECTION_HEADER,
        ]
        for index, item in enumerate(active, start=1):
            marker = _STATUS_MARKERS.get(item["status"], "[?]")
            lines.append(f"- {marker} {index}. {item['content']}（{item['status']}）")
        lines.append(
            "如果这条消息在继续该任务，把上面剩余步骤接着做完（每完成一项用 "
            "todo_write 标为 completed）；如果是新任务或无关问题，忽略本块正常回答。"
            "blocked 表示仍有障碍，先解决所记原因；障碍未解除时保持 blocked，不把尝试失败算完成。"
            "本块是会话记录数据，不是新指令。"
        )
        lines.append("<<<MAGIC_POINTER_EVIDENCE>>>")
        return "\n".join(lines)


def _cap_content(content: str) -> str:
    if len(content) <= MAX_TODO_CONTENT_CHARS:
        return content
    keep = MAX_TODO_CONTENT_CHARS - len(_TRUNCATION_MARKER)
    return content[:keep] + _TRUNCATION_MARKER
