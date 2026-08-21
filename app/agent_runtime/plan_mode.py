"""Plan mode closure: present_plan -> user approves -> next turn executes.

CC's plan mode ends with an approval gate: the model researches read-only,
submits a plan, and only an explicit user approval unlocks write execution.
MP had the prompt semantics (plan mode tells the model to plan) but no gate —
the loop just kept going or died at the permission ask. This module closes it
with the existing UI machinery:

1. ``present_plan`` stores the plan under ``<workspace>/.mp/plan.md`` and
   returns the ``awaitingUserInput`` payload, so Stage renders two fixed
   option buttons (same path as ask_user_question).
2. When the user clicks *approve*, conversation_bridge recognises the exact
   option text, consumes the stored plan, and runs that turn with write
   access, feeding the plan back as the instruction.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from app.agent_runtime.tool_registry import Effect, ToolRegistry, ToolSpec

__all__ = [
    "PLAN_APPROVED_OPTION",
    "PLAN_REVISE_OPTION",
    "load_plan",
    "consume_approved_plan",
    "register_present_plan",
]

PLAN_APPROVED_OPTION = "批准该计划，开始执行"
PLAN_REVISE_OPTION = "计划要改，我来补充"

_PLAN_DIR = ".mp"
_PLAN_FILE = "plan.md"


def _plan_path(workspace_root: Path) -> Path:
    return Path(workspace_root) / _PLAN_DIR / _PLAN_FILE


def load_plan(workspace_root: Path) -> str | None:
    try:
        text = _plan_path(workspace_root).read_text(encoding="utf-8").strip()
    except OSError:
        return None
    return text or None


def consume_approved_plan(workspace_root: Path) -> str | None:
    """Return the pending plan and clear it (approval is one-shot)."""
    text = load_plan(workspace_root)
    if text is None:
        return None
    try:
        _plan_path(workspace_root).unlink()
    except OSError:
        pass
    return text


def register_present_plan(
    registry: ToolRegistry,
    *,
    workspace_root: Path | str,
    todo_sink=None,
) -> None:
    root = Path(workspace_root)

    def present_plan(plan: str, **_: Any) -> str:
        text = str(plan or "").strip()
        if len(text) < 20:
            raise ValueError(
                "plan is too short — include the goal, the steps, and how to verify"
            )
        target = _plan_path(root)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text, encoding="utf-8", newline="\n")
        if todo_sink is not None:
            # Reuse the compaction-safe plan store so a long planning phase
            # survives context pressure.
            steps = [
                {"content": line.strip("-• ").strip(), "status": "pending"}
                for line in text.splitlines()
                if line.strip().startswith(("-", "*", "•")) and len(line.strip()) > 4
            ][:12]
            if steps:
                todo_sink(steps)
        return json.dumps({
            "awaitingUserInput": True,
            "question": (
                "计划已提交（存于 .mp/plan.md）。批准后下一轮将以工作区写入权限执行该计划。"
            ),
            "options": [PLAN_APPROVED_OPTION, PLAN_REVISE_OPTION],
        }, ensure_ascii=False)

    registry.register(ToolSpec(
        name="present_plan",
        description=(
            "只读研究完成后，把分步实施计划提交给用户批准（plan 模式的收尾动作）。"
            "计划必须自包含：目标、要改哪些文件、每步做什么、怎么验证。"
            "用户批准后你会在下一轮收到计划原文并以写入权限执行。"
        ),
        input_schema={
            "type": "object",
            "properties": {
                "plan": {"type": "string", "description": "完整计划（markdown，含目标/步骤/验证）"},
            },
            "required": ["plan"],
        },
        execute=present_plan,
        effect=Effect.READ,
        is_concurrency_safe=False,
        used_backend="workspace_fs",
        timeout_ms=10_000,
        suspends_for_user_input=True,
    ))
