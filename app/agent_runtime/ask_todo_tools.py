"""AskUserQuestion + TodoWrite tools (CC patterns ported).

CC's AskUserQuestion lets the model ask a multi-choice question instead of
guessing; TodoWrite keeps an explicit plan the user can see. Here both are
harness-owned READ tools whose answers come from the injected bridge
callbacks (real UI wiring lands with the renderer), so the model can
clarify and plan inside the loop instead of silently choosing.
"""

from __future__ import annotations

import json
from typing import Any, Callable

from app.agent_runtime.tool_registry import Effect, ToolRegistry, ToolSpec

__all__ = ["register_ask_user_question", "register_todo_write"]

AskQuestionFn = Callable[[dict[str, Any]], dict[str, Any]]


def register_ask_user_question(
    registry: ToolRegistry,
    ask: AskQuestionFn | None = None,
) -> ToolSpec:
    """Register the CC-style clarification tool; ``ask`` is the UI bridge."""

    def execute(
        question: str,
        options: list,
        kind: str = None,
        tool: str = None,
        scope: object = None,
    ) -> str:
        normalized_question = str(question or "").strip()[:1000]
        normalized_options = [
            str(option).strip()[:200]
            for option in list(options or [])[:4]
            if str(option).strip()
        ]
        if not normalized_question:
            raise ValueError("question must not be empty")
        if len(normalized_options) < 2:
            raise ValueError("options must contain at least two non-empty choices")
        # Structured permission question (CC canUseTool): the granted tool
        # rides as data so the renderer can map a chip click onto a real
        # grant instead of regexing Chinese option text.
        payload = {
            "asked": True,
            "awaitingUserInput": True,
            "question": normalized_question,
            "options": normalized_options,
        }
        if str(kind or "").strip() == "permission" and str(tool or "").strip():
            payload["kind"] = "permission"
            payload["tool"] = str(tool).strip()[:64]
        if ask is None:
            return json.dumps(payload, ensure_ascii=False)
        answer = ask({
            "question": normalized_question,
            "options": normalized_options,
        })
        return json.dumps(dict(answer), ensure_ascii=False)

    return registry.register(ToolSpec(
        name="ask_user_question",
        description=(
            "不确定用户的意图或需要用户在几个选项中选择时，向用户提问。"
            "options 是 2-4 个中文选项。返回用户的选择。"
            "工具被拒需要授权时用 kind=\"permission\" 且 tool=被拒工具名，"
            "options 固定为 [仅这一次允许， 本会话总是允许， 拒绝]。"
        ),
        input_schema={
            "type": "object",
            "properties": {
                "question": {"type": "string", "description": "要问用户的问题"},
                "options": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "2-4 个选项，用户只能选一个",
                },
                "kind": {
                    "type": "string",
                    "description": "权限提问固定填 permission，其他提问不填",
                },
                "tool": {
                    "type": "string",
                    "description": "kind=permission 时填被拒的工具名",
                },
            },
            "required": ["question", "options"],
        },
        execute=execute,
        effect=Effect.READ,
        is_concurrency_safe=True,
        used_backend="ask_user_bridge",
        timeout_ms=120000,
        suspends_for_user_input=True,
    ))


def register_todo_write(
    registry: ToolRegistry,
    sink: Callable[[list[dict[str, Any]]], None] | None = None,
) -> ToolSpec:
    """Register the CC-style plan tool; ``sink`` persists the plan (UI/log)."""

    def execute(todos: list, scope: object = None) -> str:
        entries = [
            {"content": str(item.get("content") or ""), "status": str(item.get("status") or "pending")}
            for item in todos
            if isinstance(item, dict)
        ]
        if sink is not None:
            try:
                sink(entries)
            except Exception:  # noqa: BLE001 - plan sink is best effort
                pass
        return json.dumps({"plan": entries}, ensure_ascii=False)

    return registry.register(ToolSpec(
        name="todo_write",
        description=(
            "维护本次任务的步骤清单。todos 是 [{content, status}]，"
            "status 为 pending/in_progress/completed。用于多步任务时保持计划可见。"
        ),
        input_schema={
            "type": "object",
            "properties": {
                "todos": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "content": {"type": "string"},
                            "status": {"type": "string"},
                        },
                        "required": ["content", "status"],
                    },
                },
            },
            "required": ["todos"],
        },
        execute=execute,
        effect=Effect.READ,
        is_concurrency_safe=True,
        used_backend="todo_store",
        timeout_ms=5000,
    ))
