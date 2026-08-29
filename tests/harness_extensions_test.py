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
    def test_reply_style_section_omitted_when_normal(self) -> None:
        """Default (normal) reply style injects no directive at all."""
        from app.agent_runtime.system_prompt import default_sections

        builder = SystemPromptBuilder()
        for section in default_sections():
            builder.add(section)
        text = builder.build({"language": "中文", "reply_style": "normal"})
        assert "# Style" not in text
        assert "# Language" in text

    def test_reply_style_section_injects_verbosity_directive(self) -> None:
        """compact/ultra styles add a real Style directive; normal does not."""
        from app.agent_runtime.system_prompt import default_sections

        builder = SystemPromptBuilder()
        for section in default_sections():
            builder.add(section)

        compact_text = builder.build({"language": "中文", "reply_style": "compact"})
        assert "# Style" in compact_text
        assert "简洁" in compact_text

        ultra_text = builder.build({"language": "中文", "reply_style": "ultra"})
        assert "# Style" in ultra_text
        assert "极简" in ultra_text

    def test_reply_style_section_unknown_value_behaves_like_normal(self) -> None:
        """An unregistered style must not crash or inject a directive."""
        from app.agent_runtime.system_prompt import default_sections

        builder = SystemPromptBuilder()
        for section in default_sections():
            builder.add(section)
        text = builder.build({"language": "中文", "reply_style": "galactic"})
        assert "# Style" not in text

    def test_identity_claims_screen_selection_only_when_evidence_exists(self) -> None:
        """普通文本对话不得谎称用户圈选了屏幕对象——那是 Stage 流才会
        用的身份，写进普通对话会让模型去全桌面找并不存在的选区对象
        （真机事故："回复你好" 跑了 17 轮桌面工具空转）。"""
        from app.agent_runtime.system_prompt import default_sections

        builder = SystemPromptBuilder()
        for section in default_sections():
            builder.add(section)

        plain = builder.build({"language": "中文", "has_selection": False})
        selected = builder.build({"language": "中文", "has_selection": True})
        assert "圈选" not in plain
        assert "圈选" in selected
        assert "没有屏幕选区对象" in plain

    def test_frozen_frame_rule_skipped_without_selection_evidence(self) -> None:
        """look/read_around 的冻结帧规则只在有圈选证据时注入；普通对话
        没有 visual_anchor，写这些只会诱导模型去 "look" 并不存在的屏幕。"""
        from app.agent_runtime.system_prompt import default_sections

        builder = SystemPromptBuilder()
        for section in default_sections():
            builder.add(section)

        plain = builder.build({"language": "中文", "has_selection": False})
        selected = builder.build({"language": "中文", "has_selection": True})
        assert "冻结帧" not in plain
        assert "visual_anchor" not in plain
        assert "冻结帧" in selected
        assert "visual_anchor" in selected

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


class TestVoiceSection:
    def test_voice_section_gives_the_model_a_persona(self) -> None:
        """「回话生硬」的提示词层根因：全部规则都是操作纪律（禁令/工具
        纪律），没有一条教模型怎么说话。Voice section 是静态人格层：
        先结论后有细节、不写套话、语气跟用户走、给下一步建议。"""
        from app.agent_runtime.system_prompt import default_sections

        builder = SystemPromptBuilder()
        for section in default_sections():
            builder.add(section)

        text = builder.build({"language": "中文", "has_selection": False})
        assert "# Voice" in text
        assert "结论" in text
        assert "套话" in text
        # 与无选区身份约束一致：人格层不得重新引入「圈选」身份。
        assert "圈选" not in text
        # 静态 section：不随 ctx 变化，保住 system prompt 前缀缓存。
        again = builder.build({"language": "英文", "has_selection": False})
        assert "# Voice" in again
