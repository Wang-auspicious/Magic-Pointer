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

import json
import uuid
from pathlib import Path
from typing import Any, Callable

from app.agent_runtime.tool_registry import Effect, ToolRegistry, ToolSpec

__all__ = ["register_delegate_tool"]

_SUBAGENT_SYSTEM_PROMPT = (
    "你是 Magic Pointer 的编码子代理，独立完成父代理委派的一个具体任务。\n"
    "规则：\n"
    "1. 只做委派的任务本身，不要扩大范围；不要向用户提问。\n"
    "2. 先用 Glob/Grep/Read 定位证据再改代码；小改动用 Edit，"
    "跨文件改动用 Patch；改完用 Bash 跑测试/构建验证。\n"
    "3. 测试红了就继续修，绿了才算完成；方向错了用 Rewind 回滚。\n"
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
    subagent_event_sink: Callable[[dict[str, Any]], None] | None = None,
    id_factory: Callable[[], str] | None = None,
) -> None:
    """Register ``delegate_task``; the child runs the same loop kernel."""
    # 旧名别名（一个版本）：历史授权/旧调用仍路由到规范工具；别名不进 schema。
    registry.register_alias("delegate_task", "Agent")
    from app.fabric.engine import run_agent_turn

    root = Path(workspace_root)

    def emit(payload: dict[str, Any]) -> None:
        if subagent_event_sink is None:
            return
        try:
            subagent_event_sink(payload)
        except Exception:
            # A visual progress consumer can disappear with its window; it may
            # never be able to abort or alter the child loop.
            return

    def bounded(value: Any, limit: int = 1600) -> str:
        if value is None:
            return ""
        if isinstance(value, str):
            text = value
        else:
            try:
                text = json.dumps(
                    value,
                    ensure_ascii=False,
                    separators=(",", ":"),
                    sort_keys=True,
                )
            except (TypeError, ValueError):
                text = str(value)
        return text if len(text) <= limit else f"{text[:limit]}…"

    def delegate_task(task: str, context: str = "", readonly: bool = False, **_: Any) -> str:
        prompt = str(task or "").strip()
        if not prompt:
            raise ValueError("task is required")
        extra = str(context or "").strip()
        if extra:
            prompt = f"{prompt}\n\n背景上下文：\n{extra}"

        child_id = str((id_factory or (lambda: uuid.uuid4().hex[:12]))())
        steps: list[dict[str, Any]] = []
        active_steps: dict[str, dict[str, Any]] = {}

        def publish(status: str, *, summary: str = "") -> None:
            payload: dict[str, Any] = {
                "id": child_id,
                "description": str(task or "").strip(),
                "readonly": bool(readonly),
                "status": status,
                "stepCount": len(steps),
                "currentTool": next(
                    (
                        str(step.get("tool") or "")
                        for step in reversed(steps)
                        if step.get("status") == "running"
                    ),
                    "",
                ),
                "steps": [dict(step) for step in steps],
            }
            if summary:
                payload["summary"] = summary
            emit(payload)

        def child_event(event: Any) -> None:
            kind = str(getattr(event, "kind", "") or "")
            if kind == "tool_call_started":
                call_id = str(getattr(event, "id", "") or f"step-{len(steps) + 1}")
                step = {
                    "index": len(steps) + 1,
                    "callId": call_id,
                    "tool": str(getattr(event, "name", "") or "Tool"),
                    "status": "running",
                }
                steps.append(step)
                active_steps[call_id] = step
                publish("running")
                return
            if kind != "tool_call_finished":
                return
            result = getattr(event, "result", None)
            call_id = str(getattr(result, "tool_call_id", "") or "")
            step = active_steps.pop(call_id, None)
            if step is None:
                step = {
                    "index": len(steps) + 1,
                    "callId": call_id or f"step-{len(steps) + 1}",
                    "tool": str(getattr(result, "tool_name", "") or "Tool"),
                }
                steps.append(step)
            failed = bool(getattr(result, "is_error", False))
            step.update(
                {
                    "status": "failed" if failed else "completed",
                    "input": bounded(getattr(result, "arguments", None)),
                    "output": bounded(
                        getattr(result, "error_message", None)
                        if failed
                        else getattr(result, "value", None)
                    ),
                    "usedBackend": str(getattr(result, "used_backend", "") or ""),
                    "latencyMs": float(getattr(result, "latency_ms", 0.0) or 0.0),
                }
            )
            publish("running")

        child_registry = ToolRegistry()
        from app.agent_runtime.coding_tools import register_coding_tools

        register_coding_tools(child_registry, workspace_root=root)
        child_effects = (
            Effect.READ,
            Effect.REVERSIBLE_WRITE,
            Effect.LOCAL_IRREVERSIBLE,
        )
        if readonly:
            # 只读子代理：写工具从 schema 里摘掉（不只是权限挡），调研类
            # 委派 is_concurrency_safe_for=True 可进并行车道。
            for write_tool in (
                "Write", "Edit", "Patch", "Bash", "Rewind",
            ):
                try:
                    child_registry.unregister(write_tool)
                except KeyError:
                    pass
            child_effects = (Effect.READ,)
        child_client = llm_provider.create_client(
            system_prompt=_SUBAGENT_SYSTEM_PROMPT,
            max_tokens=max_tokens,
        )
        publish("running")
        try:
            terminal = run_agent_turn(
                prompt,
                registry=child_registry,
                client=child_client,
                allowed_effects=child_effects,
                permission_mode=permission_mode,
                tool_limit=max_tool_calls,
                lang="zh",
                event_sink=child_event,
            )
        except Exception as exc:
            publish("failed", summary=str(exc))
            raise
        summary = str(terminal.message or "").strip()
        publish(terminal.reason.value, summary=summary)
        header = (
            f"[subagent id={child_id} status={terminal.reason.value} "
            f"steps={len(steps)}]"
        )
        return f"{header}\n{summary or '(no summary)'}"

    registry.register(ToolSpec(
        name="Agent",
        description=(
            "把一个独立子任务委派给编码子代理（全新上下文，只有文件/shell 工具，"
            "不能操作桌面、不能反问用户）。适合可以独立交代的调研、定位、"
            "批量重构、写测试这类活；父对话只收结果摘要。"
            "一次委派一件事，任务描述要自包含。"
            "readonly=true 的调研委派只有读工具，可与其它任务并行。"
        ),
        input_schema={
            "type": "object",
            "properties": {
                "task": {"type": "string", "description": "自包含的任务描述"},
                "context": {"type": "string", "description": "可选背景（已知线索、文件路径等）"},
                "readonly": {
                    "type": "boolean",
                    "description": "true=只读子代理（无写工具），可并行",
                },
            },
            "required": ["task"],
        },
        execute=delegate_task,
        effect=Effect.REVERSIBLE_WRITE,
        effect_for=lambda args: Effect.READ if args.get("readonly") else Effect.REVERSIBLE_WRITE,
        is_concurrency_safe=False,
        is_concurrency_safe_for=lambda args: bool(args.get("readonly")),
        used_backend="subagent_loop",
        timeout_ms=1_800_000,
    ))
