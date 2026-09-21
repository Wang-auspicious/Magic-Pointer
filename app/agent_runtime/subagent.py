"""Delegate tool: spawn a coding subagent with isolated context (Hermes port).

Contract ported from HermesAgent ``tools/delegate_tool.py`` (MIT):
each child gets a fresh conversation (no parent history), a restricted
toolset (coding tools only — no desktop actions, no user interaction, no
recursive delegation), a focused system prompt, and its own budget cap.
The parent sees one tool call and one summary result, never the child's
intermediate rounds. The GUI receives bounded progress snapshots independently.
Readonly children may run concurrently; editing children use the exclusive lane.
"""

from __future__ import annotations

import json
import time
import uuid
from pathlib import Path
from typing import Any, Callable

from app.agent_runtime.errors import ActionFailure, DEFAULT_MAX_OUTPUT_TOKENS, FailureType
from app.agent_runtime.tool_registry import Effect, ToolRegistry, ToolSpec, current_tool_call_id

__all__ = ["register_delegate_tool"]

#: Tool schemas offered to a child turn. Matches the ceiling both production
#: bridges pass (selection_bridge / conversation_bridge): high enough that the
#: registry is never silently truncated, while still bounded so a runaway
#: plugin cannot flood the model's context with schemas.
_CHILD_TOOL_SCHEMA_LIMIT = 128

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
    effort: str = "high",
    max_tool_calls: int = 60,
    max_tokens: int = DEFAULT_MAX_OUTPUT_TOKENS,
    subagent_event_sink: Callable[[dict[str, Any]], None] | None = None,
    id_factory: Callable[[], str] | None = None,
    parent_session_getter: Callable[[], Any] | None = None,
) -> None:
    """Register ``delegate_task``; the child runs the same loop kernel."""
    # 旧名别名（一个版本）：历史授权/旧调用仍路由到规范工具；别名不进 schema。
    registry.register_alias("delegate_task", "Agent")
    from app.fabric.engine import run_agent_turn

    root = Path(workspace_root)
    from app.agent_runtime.effort import EFFORT_LEVELS, normalize_effort
    inherited_effort = normalize_effort(effort)

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

    def delegate_task(task: str, context: str = "", readonly: bool | None = None, resume_id: str = "", effort: str | None = None, scope: Any = None, **_: Any) -> str:
        prompt = str(task or "").strip()
        if not prompt:
            raise ValueError("task is required")
        extra = str(context or "").strip()
        if extra:
            prompt = f"{prompt}\n\n背景上下文：\n{extra}"

        from app.agent_runtime.session import FileSessionStore, cancel_interrupt_check
        from app.agent_runtime.memory import compact_messages
        from app.agent_runtime.compaction_prompt import summarize_history_text
        from app.agent_runtime.token_estimate import estimate_request_tokens
        from app.ai_client import get_ai_context_window
        from app.governance import BudgetPolicy, Stage, TimeoutAction

        parent = parent_session_getter() if parent_session_getter else None
        from app.agent_runtime.plan_mode import current_mode
        child_mode = current_mode(parent, permission_mode)
        from app.agent_runtime.permission_decisions import PermissionDecisions, current_permission_decisions
        child_permissions = PermissionDecisions.inherited(parent, current_permission_decisions.get())
        requested_readonly = readonly
        readonly = bool(readonly) or child_mode == 'plan'
        store = FileSessionStore(parent.path.parent if parent else root / ".mp" / "agent-sessions")
        child_id = str(resume_id or (id_factory or (lambda: uuid.uuid4().hex[:12]))())
        child_effort = normalize_effort(effort) if effort is not None else inherited_effort
        if resume_id:
            child_session = store.resume(child_id, repair=True)
            if child_session.header.parent_session_id != (parent.id if parent else None):
                raise ValueError("resume_id does not belong to this parent task")
            saved = next((e.data for e in child_session.events if e.type == "subagent/configured"), {})
            if effort is None:
                child_effort = normalize_effort(next((event.data['effort'] for event in reversed(child_session.events)
                    if event.type == 'runtime/effort'), saved.get('effort') or inherited_effort))
            else:
                child_session.append('runtime/effort', {'effort': child_effort})
            if requested_readonly is None:
                readonly = readonly or bool(saved.get('readonly'))
            if bool(saved.get("readonly")) and not readonly:
                raise ValueError("a readonly child must resume with readonly=true")
        else:
            child_session = store.create(child_id, parent_session_id=parent.id if parent else None)
            child_session.append("subagent/configured", {"task": prompt, "readonly": bool(readonly), "effort": child_effort})
            if parent:
                parent.append("subagent/created", {"childSessionId": child_id, "task": prompt, "readonly": bool(readonly)})

        child_cancelled = cancel_interrupt_check(child_session)

        def interrupted() -> bool:
            return bool(child_cancelled() or (scope is not None and scope.is_cancelled()) or (parent is not None and parent.pending_cancel_request()))

        if interrupted():
            raise ActionFailure(FailureType.TOOL_ERROR, f"subagent {child_id} stopped before dispatch")
        steps: list[dict[str, Any]] = []
        active_steps: dict[str, dict[str, Any]] = {}
        parent_call_id = current_tool_call_id.get()
        started_at = time.time() * 1000
        started_clock = time.perf_counter()
        last_publish = 0.0
        phase = "starting"
        reasoning = ""
        answer = ""
        turn = 0

        def publish(status: str, *, summary: str = "") -> None:
            nonlocal last_publish
            last_publish = time.perf_counter()
            payload: dict[str, Any] = {
                "id": child_id,
                "parentCallId": parent_call_id,
                "description": str(task or "").strip(),
                "readonly": bool(readonly),
                "status": status,
                "phase": phase if status == "running" else status,
                "turn": turn,
                "reasoning": reasoning,
                "answer": answer,
                "startedAt": started_at,
                "elapsedMs": round((last_publish - started_clock) * 1000),
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
            if status != "running":
                payload["completedAt"] = time.time() * 1000
            emit(payload)

        def child_event(event: Any) -> None:
            nonlocal phase, reasoning, answer, turn
            kind = str(getattr(event, "kind", "") or "")
            if kind == "turn_started":
                turn = int(getattr(event, "turn", 0) or 0)
                phase, reasoning, answer = "thinking", "", ""
                publish("running")
                return
            if kind in {"reasoning_chunk", "model_chunk"}:
                text = str(getattr(event, "text", "") or "")
                if not text:
                    return
                next_phase = "thinking" if kind == "reasoning_chunk" else "writing"
                first = not (reasoning if kind == "reasoning_chunk" else answer)
                changed = phase != next_phase
                phase = next_phase
                if kind == "reasoning_chunk":
                    reasoning = (reasoning + text)[-6000:]
                else:
                    answer = (answer + text)[-6000:]
                # First content and phase transitions paint immediately; bursts
                # share one snapshot, with an unconditional final flush below.
                if first or changed or time.perf_counter() - last_publish >= 0.12:
                    publish("running")
                return
            if kind == "tool_call_started":
                phase = "tool"
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
            phase = "tool" if active_steps else "thinking"
            publish("running")

        child_registry = ToolRegistry()
        from app.agent_runtime.coding_tools import register_coding_tools

        register_coding_tools(child_registry, workspace_root=root, session_id=child_id,
                              session_getter=lambda: child_session)
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
            effort=child_effort,
        )
        publish("running")
        try:
            terminal = run_agent_turn(
                prompt,
                registry=child_registry,
                client=child_client,
                allowed_effects=child_effects,
                permission_mode=child_mode,
                permission_decisions=child_permissions,
                # Two different quantities, kept apart on purpose. The child's
                # visible tool surface is the same ceiling both production
                # bridges use; its *work* budget is the turn fuse below.
                # Passing the work budget as `tool_limit` truncated the child's
                # schemas by registration order, and the tool registered last
                # is `Tools` (FIND_CAPABILITY_TOOL) — the only route to
                # everything past the limit. A child on a small budget lost its
                # tools and its way of asking for them.
                tool_limit=_CHILD_TOOL_SCHEMA_LIMIT,
                # The loop counts turns, not individual calls (a turn may carry
                # up to eight parallel ones), so this is the honest place to
                # spend a call budget. It bounds a runaway child; it is not an
                # exact call count, and the name should not promise one.
                emergency_turn_fuse=max(1, int(max_tool_calls)),
                lang="zh",
                event_sink=child_event,
                session=child_session,
                budgets={Stage.FULL_ANSWER: BudgetPolicy(stage=Stage.FULL_ANSWER, budget_ms=3_600_000, on_timeout=TimeoutAction.STASH_BACKGROUND)},
                compactor=lambda messages: compact_messages(messages, summarize_history_text),
                context_budget_tokens=get_ai_context_window(),
                token_estimator=lambda messages: estimate_request_tokens(messages, system_prompt=_SUBAGENT_SYSTEM_PROMPT),
                tool_result_dir=str(root / ".mp" / "tool-results" / child_id),
                interrupt_check=interrupted,
            )
        except Exception as exc:
            publish("failed", summary=str(exc))
            raise
        summary = str(terminal.message or "").strip()
        if parent:
            parent.append("subagent/finished", {"childSessionId": child_id, "status": terminal.reason.value, "summary": summary})
        publish(terminal.reason.value, summary=summary)
        header = (
            f"[subagent id={child_id} status={terminal.reason.value} "
            f"steps={len(steps)}]"
        )
        result = f"{header}\n{summary or '(no summary)'}"
        if terminal.reason.value not in {"completed", "stop_hook", "local_action"}:
            raise ActionFailure(FailureType.TOOL_ERROR, result)
        return result

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
                "resume_id": {"type": "string", "description": "继续未完成子任务的持久 session id；沿用其历史和检查点"},
                "effort": {"type": "string", "enum": list(EFFORT_LEVELS), "description": "默认继承父任务；恢复时沿用子任务档位，可显式覆盖"},
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
