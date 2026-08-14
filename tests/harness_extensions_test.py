"""Harness extension tests: hooks (CC PreToolUse/PostToolUse), ask/todo tools."""

from __future__ import annotations

import json
import sys
import threading
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.agent_runtime.ask_todo_tools import (  # noqa: E402
    register_ask_user_question,
    register_todo_write,
)
from app.agent_runtime.hooks import HookManager  # noqa: E402
from app.agent_runtime.system_prompt import Section, SystemPromptBuilder  # noqa: E402
from app.agent_runtime.tool_registry import Effect, ToolRegistry, ToolSpec  # noqa: E402


def _empty_schema() -> dict:
    return {"type": "object", "properties": {}, "required": []}


def _tool(name: str, value: str = "ok") -> ToolSpec:
    return ToolSpec(
        name=name,
        description=f"fake {name}",
        input_schema=_empty_schema(),
        execute=lambda **kwargs: value,
        effect=Effect.READ,
        used_backend="fake",
    )


class TestHooks:
    def test_pre_tool_block_refuses_with_reason(self) -> None:
        manager = HookManager(pre_tool_use=[
            lambda payload: {"decision": "block", "reason": "用户配置禁止在夜间运行"},
        ])
        outcome = manager.run_pre_tool_use("bash", {"cmd": "rm -rf /"})
        assert outcome.allowed is False
        assert "夜间" in outcome.reason

    def test_pre_tool_approve_short_circuits_and_mutates_input(self) -> None:
        calls: list = []

        def first(payload):
            calls.append("first")
            return {"decision": "approve", "input": {**payload["input"], "extra": 1}}

        def second(payload):
            calls.append("second")
            return None

        manager = HookManager(pre_tool_use=[first, second])
        outcome = manager.run_pre_tool_use("t", {"a": 1})
        assert outcome.allowed is True
        assert outcome.input == {"a": 1, "extra": 1}
        assert calls == ["first"]

    def test_raising_hook_is_recorded_not_fatal(self) -> None:
        manager = HookManager(pre_tool_use=[lambda p: (_ for _ in ()).throw(RuntimeError("boom"))])
        outcome = manager.run_pre_tool_use("t", {})
        assert outcome.allowed is True
        assert "RuntimeError" in outcome.decisions[0]["error"]

    def test_post_tool_extra_context_is_collected(self) -> None:
        manager = HookManager(post_tool_use=[
            lambda p: {"extraContext": "注意：结果来自缓存"},
        ])
        outcome = manager.run_post_tool_use("read_around", {}, "text")
        assert outcome.allowed is True
        assert "缓存" in outcome.extra_context

    def test_plugin_scoped_hook_registration_unwinds(self) -> None:
        from app.harness.context import Context

        root = Context()
        manager = HookManager()
        root.provide("hooks", manager)
        root.inject(
            ["hooks"],
            lambda plugin_ctx: plugin_ctx.get("hooks").register_pre_tool_use(
                lambda _payload: {"decision": "block", "reason": "scoped"}
            ),
        )
        assert manager.run_pre_tool_use("read", {}).allowed is False

        root.unload()

        assert manager.run_pre_tool_use("read", {}).allowed is True

    def test_plugin_unload_waits_for_inflight_hook(self) -> None:
        from app.harness.context import Context

        entered = threading.Event()
        release = threading.Event()
        unloaded = threading.Event()

        def slow(_payload):
            entered.set()
            assert release.wait(timeout=2)
            return None

        root = Context()
        manager = HookManager()
        root.provide("hooks", manager)
        root.inject(
            ["hooks"],
            lambda plugin_ctx: plugin_ctx.get("hooks").register_pre_tool_use(slow),
        )
        running = threading.Thread(
            target=lambda: manager.run_pre_tool_use("read", {}),
            daemon=True,
        )
        running.start()
        assert entered.wait(timeout=1)
        unloading = threading.Thread(
            target=lambda: (root.unload(), unloaded.set()),
            daemon=True,
        )
        unloading.start()

        assert not unloaded.wait(timeout=0.05)
        release.set()
        running.join(timeout=1)
        unloading.join(timeout=1)

        assert unloaded.is_set()


class TestPromptSections:
    def test_plugin_unload_waits_for_inflight_section_render(self) -> None:
        from app.harness.context import Context

        entered = threading.Event()
        release = threading.Event()
        unloaded = threading.Event()

        def slow(_context):
            entered.set()
            assert release.wait(timeout=2)
            return "ready"

        root = Context()
        builder = SystemPromptBuilder()
        root.provide("prompt", builder)
        root.inject(
            ["prompt"],
            lambda plugin_ctx: plugin_ctx.get("prompt").add(
                Section("slow", "Slow", slow)
            ),
        )
        rendering = threading.Thread(
            target=lambda: builder.build({}),
            daemon=True,
        )
        rendering.start()
        assert entered.wait(timeout=1)
        unloading = threading.Thread(
            target=lambda: (root.unload(), unloaded.set()),
            daemon=True,
        )
        unloading.start()

        assert not unloaded.wait(timeout=0.05)
        release.set()
        rendering.join(timeout=1)
        unloading.join(timeout=1)

        assert unloaded.is_set()


class TestAskTodoTools:
    def test_ask_user_question_without_blocking_bridge_suspends_the_turn(self) -> None:
        registry = ToolRegistry()
        spec = register_ask_user_question(registry, ask=None)
        result = json.loads(spec.execute(question="选哪个？", options=["A", "B"]))
        assert result == {
            "asked": True,
            "awaitingUserInput": True,
            "question": "选哪个？",
            "options": ["A", "B"],
        }
        assert spec.suspends_for_user_input is True

    def test_ask_user_question_forwards_to_bridge(self) -> None:
        registry = ToolRegistry()
        spec = register_ask_user_question(
            registry,
            ask=lambda payload: {"asked": True, "answer": "B", "question": payload["question"]},
        )
        result = json.loads(spec.execute(question="选哪个？", options=["A", "B"]))
        assert result["answer"] == "B"
        assert result["asked"] is True

    def test_todo_write_returns_the_plan(self) -> None:
        registry = ToolRegistry()
        spec = register_todo_write(registry)
        result = json.loads(spec.execute(todos=[
            {"content": "读取选区", "status": "completed"},
            {"content": "总结", "status": "in_progress"},
        ]))
        assert result["plan"][0]["content"] == "读取选区"
        assert result["plan"][1]["status"] == "in_progress"
