"""Delegate tool: spawn a coding subagent with isolated context (Hermes port).

Contract ported from HermesAgent ``tools/delegate_tool.py`` (MIT):
each child gets a fresh conversation (no parent history), a restricted
toolset (coding tools only — no desktop actions, no user interaction, no
recursive delegation), a focused system prompt, and its own budget cap.
The parent sees one tool call and one summary result, never the child's
intermediate rounds. Children run sequentially through the loop's exclusive
tool lane: parallel children editing one workspace is a conflict MP refuses
by construction rather than by hope.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from app.agent_runtime.tool_registry import Effect, ToolRegistry, ToolSpec

__all__ = ["register_delegate_tool"]

_SUBAGENT_SYSTEM_PROMPT = (
    "你是 Magic Pointer 的编码子代理，独立完成父代理委派的一个具体任务。\n"
    "规则：\n"
    "1. 只做委派的任务本身，不要扩大范围；不要向用户提问。\n"
    "2. 先用 glob/grep/read_file 定位证据再改代码；小改动用 edit_file，"
    "跨文件改动用 apply_patch；改完用 run_command 跑测试/构建验证。\n"
    "3. 测试红了就继续修，绿了才算完成；方向错了用 restore_files 回滚。\n"
    "4. 最终输出结果摘要：做了什么、改了哪些文件、验证命令与结果。"
)


def register_delegate_tool(
    registry: ToolRegistry,
    *,
    llm_provider: Any,
    workspace_root: Path | str,
    permission_mode: str = "bypass",
    max_tool_calls: int = 60,
    max_tokens: int = 4096,
) -> None:
    """Register ``delegate_task``; the child runs the same loop kernel."""
    from app.fabric.engine import run_agent_turn

    root = Path(workspace_root)

    def delegate_task(task: str, context: str = "", **_: Any) -> str:
        prompt = str(task or "").strip()
        if not prompt:
            raise ValueError("task is required")
        extra = str(context or "").strip()
        if extra:
            prompt = f"{prompt}\n\n背景上下文：\n{extra}"

        child_registry = ToolRegistry()
        from app.agent_runtime.coding_tools import register_coding_tools

        register_coding_tools(child_registry, workspace_root=root)
        child_client = llm_provider.create_client(
            system_prompt=_SUBAGENT_SYSTEM_PROMPT,
            max_tokens=max_tokens,
        )
        terminal = run_agent_turn(
            prompt,
            registry=child_registry,
            client=child_client,
            allowed_effects=(
                Effect.READ,
                Effect.REVERSIBLE_WRITE,
                Effect.LOCAL_IRREVERSIBLE,
            ),
            permission_mode=permission_mode,
            tool_limit=max_tool_calls,
            lang="zh",
        )
        summary = str(terminal.message or "").strip()
        header = f"[subagent {terminal.reason.value}]"
        return f"{header}\n{summary or '(no summary)'}"

    registry.register(ToolSpec(
        name="delegate_task",
        description=(
            "把一个独立子任务委派给编码子代理（全新上下文，只有文件/shell 工具，"
            "不能操作桌面、不能反问用户）。适合可以独立交代的调研、定位、"
            "批量重构、写测试这类活；父对话只收结果摘要。"
            "一次委派一件事，任务描述要自包含。"
        ),
        input_schema={
            "type": "object",
            "properties": {
                "task": {"type": "string", "description": "自包含的任务描述"},
                "context": {"type": "string", "description": "可选背景（已知线索、文件路径等）"},
            },
            "required": ["task"],
        },
        execute=delegate_task,
        effect=Effect.REVERSIBLE_WRITE,
        is_concurrency_safe=False,
        used_backend="subagent_loop",
        timeout_ms=1_800_000,
    ))
