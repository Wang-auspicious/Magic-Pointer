"""The task list a long job carries across context compaction.

Ported from HermesAgent ``tools/todo_tool.py`` (MIT, Copyright (c) 2025 Nous
Research), reduced to Magic Pointer's ``todo_write`` contract.

Why this exists: compaction replaces the model's visible history with a
summary. If "90 of 137 records done" only ever existed as a sentence in that
history, whether the agent resumes correctly depends on how well a summariser
paraphrased it. Progress is not a thing to paraphrase. It lives here, and
:meth:`TodoStore.format_for_injection` re-attaches it verbatim after every
compaction.

Two rules carried over from Hermes:

- **Only unfinished work is re-injected.** Replaying completed items makes the
  model redo them.
- **The plan is bounded.** It rides through every compaction, so one oversized
  item would defeat the compaction it rides through.

Magic Pointer's ``todo_write`` sends the whole plan each call and has no item
ids, so this is replace-only; Hermes' merge-by-id branch is not ported.
"""

from __future__ import annotations

from typing import Any

__all__ = [
    "TodoStore",
    "VALID_STATUSES",
    "MAX_TODO_ITEMS",
    "MAX_TODO_CONTENT_CHARS",
]

VALID_STATUSES = frozenset({"pending", "in_progress", "completed", "cancelled"})
_ACTIVE_STATUSES = frozenset({"pending", "in_progress"})

MAX_TODO_ITEMS = 256
MAX_TODO_CONTENT_CHARS = 4000
_TRUNCATION_MARKER = "… [truncated]"

_STATUS_MARKERS = {
    "completed": "[x]",
    "in_progress": "[>]",
    "pending": "[ ]",
    "cancelled": "[~]",
}

_INJECTION_HEADER = "[以下是你这次任务尚未完成的步骤，已跨上下文压缩保留]"


class TodoStore:
    """The current plan for one session. List order is priority."""

    def __init__(self) -> None:
        self._items: list[dict[str, str]] = []

    def write(self, todos: list[dict[str, Any]]) -> list[dict[str, str]]:
        """Replace the plan. Returns the stored list."""
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
        """Render outstanding steps for re-attachment after compaction."""
        active = [item for item in self._items if item["status"] in _ACTIVE_STATUSES]
        if not active:
            return None
        lines = [_INJECTION_HEADER]
        for index, item in enumerate(active, start=1):
            marker = _STATUS_MARKERS.get(item["status"], "[?]")
            lines.append(f"- {marker} {index}. {item['content']}（{item['status']}）")
        return "\n".join(lines)


def _cap_content(content: str) -> str:
    if len(content) <= MAX_TODO_CONTENT_CHARS:
        return content
    keep = MAX_TODO_CONTENT_CHARS - len(_TRUNCATION_MARKER)
    return content[:keep] + _TRUNCATION_MARKER
