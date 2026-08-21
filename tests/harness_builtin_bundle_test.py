"""Builtin bundle tests (plugin-kernel batch, plan T4).

Pins the composed plugin tree inventory (perception + local actions +
Kimi CU 13 desktop tools + capability tools), the plugin-contributed
services, legacy env knobs, and isolation of a broken user plugin.
"""

from __future__ import annotations

import json
import os

from app.agent_runtime.types import ORIGIN_DATA, AgentMessage, Role
from app.harness.builtin_bundle import LoopHarnessHost, boot_loop_context

# 5 perception tools + look + 3 local actions + 13 desktop CU tools
# + ask_user_question/todo_write + 16 capability tools + find_capability.
EXPECTED_TOOLS = [
    "activate_window", "agent_handoff", "ask_user_question", "canvas_transform",
    "click", "clipboard_text",
    "compare_objects", "copy_selected_text", "data_export",
    "describe_capabilities", "drag", "dump_subtree", "find_capability",
    "find_in_window", "get_app_state", "get_focused", "image_ops", "launch_app",
    "list_apps", "list_windows", "look",
    "perform_secondary_action", "place_route", "press_key", "read_around",
    "recipe_scale", "research_card",
    "save_screenshot", "screen_help", "scroll", "select_text", "set_value",
    "show_source", "table_merge",
    "task_route", "text_transform", "todo_write", "turn_ended", "type_text",
    "vision_bridge",
]
WRITE_TOOLS = {
    "activate_window", "click", "copy_selected_text", "drag", "launch_app",
    "perform_secondary_action", "press_key", "save_screenshot", "scroll",
    "select_text", "set_value", "type_text",
}


class _FakePerception:
    def read_around(self, anchor, radius):
        return []

    def find_in_window(self, query, limit=10):
        return []

    def dump_subtree(self, path=None):
        return {}

    def list_windows(self):
        return []

    def get_focused(self):
        return None


class _FakeProbe:
    def resolve_anchor(self, anchor):
        return None

    def is_focused(self, anchor):
        return False

    def content_hash_at(self, anchor):
        return None

    def modal_seen_since(self, anchor):
        return None


def _runtime(**overrides):
    runtime = {
        "perception_backend": _FakePerception(),
        "vision_backend": None,
        "frame_crop": None,
        "guard_probe": _FakeProbe(),
        "selection_anchor": None,
        "propose": lambda recipe_id, args: {"ok": True, "plan": {}},
        "execute_plan": None,
        "enabled_recipes": None,
        "summarize": lambda text: "",
        "content": "",
        "capture_path": "",
        "target_window": {"title": "Test", "process_name": "test.exe"},
        "command": "test",
    }
    runtime.update(overrides)
    return runtime


def test_composed_tree_registers_the_old_inventory():
    report = boot_loop_context(_runtime())
    registry = report.ctx.get("tools")
    names = sorted(spec.name for spec in registry.list())
    assert names == EXPECTED_TOOLS
    effects = {spec.name: spec.effect.value for spec in registry.list()}
    assert effects["copy_selected_text"] == "reversible_write"
    assert effects["save_screenshot"] == "reversible_write"
    assert effects["click"] == "reversible_write"
    assert effects["show_source"] == "read"
    assert effects["list_apps"] == "read"
    assert effects["get_app_state"] == "read"
    assert effects["turn_ended"] == "read"
    assert all(
        effect == "read"
        for name, effect in effects.items()
        if name not in WRITE_TOOLS
    )
    report.ctx.unload()


def test_unload_removes_plugin_tools_and_prompt_sections() -> None:
    report = boot_loop_context(_runtime())
    registry = report.ctx.get("tools")
    prompt = report.ctx.get("prompt")
    assert registry.list()
    assert prompt.build({"permission_mode": "default", "language": "中文"})

    report.ctx.unload()

    assert registry.list() == ()
    assert prompt.build({"permission_mode": "default", "language": "中文"}) == ""


def test_plugin_contributed_services_exist():
    report = boot_loop_context(_runtime())
    ctx = report.ctx
    assert ctx.has("precondition_factory")
    assert ctx.has("model_client")
    assert ctx.has("compactor")
    assert ctx.has("token_estimator")
    assert ctx.has("llm")
    assert ctx.has("sessions")
    assert ctx.has("model_request_header")
    assert ctx.has("learning_review")
    assert ctx.has("computer_agent")
    assert ctx.has("hooks")
    assert ctx.has("prompt")
    report.ctx.unload()


def test_windows_native_computer_operator_is_available_from_the_harness():
    report = boot_loop_context(_runtime())

    names = report.ctx.get("computer_operators").list_names()

    assert ("windows-native" in names) is (os.name == "nt")
    report.ctx.unload()


def test_resident_loop_host_reuses_globals_and_unwinds_request_tools(tmp_path) -> None:
    host = LoopHarnessHost(root=tmp_path, plugin_dir=tmp_path / "plugins")
    global_registry = host.report.ctx.get("tools")
    assert sorted(spec.name for spec in global_registry.list()) == [
        "ask_user_question",
        "todo_write",
    ]

    first = host.open(_runtime(content="first"))
    assert sorted(spec.name for spec in first.ctx.get("tools").list()) == EXPECTED_TOOLS
    assert first.ctx.has("model_client")
    first.close()
    assert sorted(spec.name for spec in global_registry.list()) == [
        "ask_user_question",
        "todo_write",
    ]

    second = host.open(_runtime(content="second"))
    copy = second.ctx.get("tools").get("copy_selected_text")
    assert copy.resource_keys == ("clipboard",)
    second.close()
    host.close()


def test_copy_tool_refuses_to_report_success_when_clipboard_readback_differs(
    monkeypatch,
) -> None:
    import sys
    import types

    monkeypatch.setitem(
        sys.modules,
        "pyperclip",
        types.SimpleNamespace(
            copy=lambda _text: None,
            paste=lambda: "different clipboard value",
        ),
    )
    report = boot_loop_context(_runtime(content="expected selection"))

    result = report.ctx.get("tools").execute_tool("copy_selected_text", {})

    assert result.is_error is True
    assert "clipboard verification failed" in str(result.error_message)
    report.ctx.unload()


def test_screenshot_tool_does_not_claim_a_missing_capture_was_saved() -> None:
    import uuid
    from pathlib import Path

    missing = (
        Path(__file__).resolve().parents[1]
        / f"missing-selection-{uuid.uuid4().hex}.png"
    )
    report = boot_loop_context(_runtime(capture_path=str(missing)))

    result = report.ctx.get("tools").execute_tool("save_screenshot", {})

    assert result.is_error is True
    assert "capture file is missing" in str(result.error_message)
    report.ctx.unload()


def test_resident_host_picks_up_user_plugin_on_next_request(tmp_path) -> None:
    plugin_root = tmp_path / "plugins"
    host = LoopHarnessHost(root=tmp_path, plugin_dir=plugin_root)

    plugin = plugin_root / "late_plugin"
    plugin.mkdir(parents=True)
    (plugin / "plugin.py").write_text(
        "\n".join([
            "from app.agent_runtime.tool_registry import Effect, ToolSpec",
            "name = 'late_plugin'",
            "inject = ('tools',)",
            "scopes = ('agent',)",
            "def apply(ctx, config):",
            "    ctx.get('tools').register(ToolSpec(",
            "        name='late_tool', description='late',",
            "        input_schema={'type':'object','properties':{},'required':[]},",
            "        execute=lambda scope=None: 'ok', effect=Effect.READ,",
            "    ))",
        ]),
        encoding="utf-8",
    )

    scope = host.open(_runtime())
    assert scope.ctx.get("tools").get("late_tool").execute() == "ok"
    scope.close()
    assert "late_tool" not in [spec.name for spec in host.report.ctx.get("tools").list()]
    host.close()


def test_resident_host_exposes_lazy_mcp_search_when_configured(tmp_path, monkeypatch) -> None:
    config = tmp_path / "mcp.json"
    config.write_text(
        json.dumps({"mcpServers": {"figma": {"command": "fake-server"}}}),
        encoding="utf-8",
    )
    monkeypatch.setenv("MAGIC_POINTER_MCP_CONFIG", str(config))

    host = LoopHarnessHost(root=tmp_path, plugin_dir=tmp_path / "plugins")

    assert host.report.ctx.has("mcp")
    assert host.report.ctx.get("tools").get("mcp_search").used_backend == "mcp.discovery"
    host.close()


def test_system_prompt_stops_gathering_evidence_without_stopping_multi_step_jobs():
    report = boot_loop_context(_runtime())
    prompt = report.ctx.get("model_client")._backend.system_prompt
    # 问答形态：证据够了就别再翻，避免为显得勤奋而空转。
    assert "不要为了显得勤奋" in prompt
    # 多步作业形态：证据够 ≠ 活干完，不得中途收工（任务时长不是边界）。
    assert "做完全部步骤" in prompt
    assert "勿重复 look" in prompt
    assert "冻结帧" in prompt
    assert "不得据此点击" in prompt
    assert "ask_user_question" in prompt
    assert "再 get_app_state" in prompt
    assert "get_app_state" in prompt
    assert "turn_ended" in prompt
    report.ctx.unload()


def _bulky_history() -> list[AgentMessage]:
    """History heavy enough to cross the production tail-token budget."""
    return [
        AgentMessage(
            role=Role.USER if index % 2 else Role.ASSISTANT,
            content=f"第 {index} 轮：" + "证据正文" * 200,
            tool_call_id=None,
            name=None,
            origin=ORIGIN_DATA,
        )
        for index in range(12)
    ]


def test_the_unfinished_plan_survives_compaction():
    # A long job's progress must not depend on the summariser remembering it.
    report = boot_loop_context(_runtime(summarize=lambda text: "早期步骤的摘要"))
    report.ctx.get("tools").get("todo_write").execute(todos=[
        {"content": "已导出前 90 条", "status": "completed"},
        {"content": "继续处理第 91 条起", "status": "in_progress"},
    ])
    history = _bulky_history()
    compacted = report.ctx.get("compactor")(history)

    def weight(messages):
        return sum(len(m.content or "") for m in messages)

    assert weight(compacted) < weight(history)
    carried = "\n".join(message.content or "" for message in compacted)
    assert "继续处理第 91 条起" in carried
    # Re-injecting finished work would make the model redo it.
    assert "已导出前 90 条" not in carried
    report.ctx.unload()


def test_compaction_without_a_plan_adds_nothing():
    report = boot_loop_context(_runtime(summarize=lambda text: "摘要"))
    history = _bulky_history()
    compacted = report.ctx.get("compactor")(history)
    assert sum(len(m.content or "") for m in compacted) < sum(
        len(m.content or "") for m in history
    )
    assert not any("尚未完成的步骤" in (m.content or "") for m in compacted)
    report.ctx.unload()


def test_model_client_allows_multi_step_desktop_tokens():
    report = boot_loop_context(_runtime())
    model_cfg = next(
        row.resolved_config for row in report.rows if row.id == "model-client"
    )
    assert int(model_cfg["max_tokens"]) == 4096
    report.ctx.unload()


def test_rows_report_active_and_dump_is_complete():
    report = boot_loop_context(_runtime())
    assert [row.status for row in report.rows] == ["active"] * 13
    dump = report.dump_config()
    assert {row["id"] for row in dump} == {
        "harness-tools", "computer-agent", "perception-tools", "look-tool",
        "local-action-tools", "desktop-action-tools",
        "capability-tools", "guard", "system-prompt", "llm-provider",
        "session-store", "learning-review", "model-client",
    }
    assert all(row["status"] == "active" for row in dump)
    report.ctx.unload()


def test_session_store_row_uses_runtime_data_directory(tmp_path) -> None:
    from app.agent_runtime.session import FileSessionStore

    report = boot_loop_context(_runtime(), root=tmp_path, plugin_dir=tmp_path / "plugins")

    sessions = report.ctx.get("sessions")
    assert isinstance(sessions, FileSessionStore)
    assert sessions.root == tmp_path / "data" / "runtime" / "agent-sessions"
    header = report.ctx.get("model_request_header")
    assert header["systemPrompt"]
    assert header["usedBackend"].startswith("magic_pointer.")
    learning = report.ctx.get("learning_review")
    assert learning.session_root == sessions.root
    assert learning.user_root == tmp_path / "data"
    report.ctx.unload()


def test_background_review_can_be_disabled_without_changing_the_loop(monkeypatch) -> None:
    monkeypatch.setenv("MAGIC_POINTER_BACKGROUND_REVIEW", "0")
    report = boot_loop_context(_runtime())

    assert report.ctx.get("learning_review").enabled is False
    assert report.ctx.has("model_client")
    report.ctx.unload()


def test_streaming_env_flag_selects_backend(monkeypatch):
    from app.agent_runtime.model_client import (
        AiClientMessagesBackend,
        StreamingMessagesBackend,
    )

    monkeypatch.setenv("MAGIC_POINTER_STREAMING", "0")
    report = boot_loop_context(_runtime())
    client = report.ctx.get("model_client")
    assert isinstance(client._backend, AiClientMessagesBackend)
    report.ctx.unload()

    monkeypatch.setenv("MAGIC_POINTER_STREAMING", "1")
    report = boot_loop_context(_runtime())
    client = report.ctx.get("model_client")
    assert isinstance(client._backend, StreamingMessagesBackend)
    report.ctx.unload()


def test_env_knobs_flow_into_resolved_config(monkeypatch):
    monkeypatch.setenv("MAGIC_POINTER_PERMISSION_MODE", "plan")
    monkeypatch.setenv("MAGIC_POINTER_CONTEXT_TOKENS", "9999")
    monkeypatch.setenv("MAGIC_POINTER_INLOOP_REVERSIBLE", "1")
    report = boot_loop_context(_runtime())
    model_row = next(row for row in report.rows if row.id == "model-client")
    assert model_row.resolved_config["permission_mode"] == "plan"
    assert model_row.resolved_config["context_budget_tokens"] == 9999
    llm_row = next(row for row in report.rows if row.id == "llm-provider")
    assert llm_row.resolved_config["streaming"] is True
    cap_row = next(row for row in report.rows if row.id == "capability-tools")
    assert cap_row.resolved_config["inloop_reversible"] is True
    report.ctx.unload()


def test_disabling_llm_provider_leaves_model_client_honestly_waiting() -> None:
    report = boot_loop_context(
        _runtime(),
        patch={"llm-provider": {"disabled": True}},
    )
    dump = {row["id"]: row for row in report.dump_config()}

    assert dump["llm-provider"]["status"] == "disabled"
    assert dump["model-client"]["status"] == "waiting"
    assert dump["model-client"]["missingDeps"] == ["llm"]
    assert report.ctx.has("model_client") is False
    report.ctx.unload()


def test_user_llm_provider_replaces_builtin_by_configuration() -> None:
    import shutil
    import uuid
    from pathlib import Path

    root = Path(__file__).resolve().parents[1]
    plugin_dir = root / f"pytest-sandbox-{uuid.uuid4().hex[:12]}"
    os.mkdir(plugin_dir)
    try:
        (plugin_dir / "fake_llm").mkdir()
        (plugin_dir / "fake_llm" / "plugin.py").write_text(
            """
name = "fake_llm"
inject = ()

class Client:
    used_backend = "fake.plugin.llm"

class Provider:
    used_backend = "fake.plugin.llm"
    def create_client(self, *, system_prompt, max_tokens):
        assert system_prompt
        assert max_tokens > 0
        return Client()

def apply(ctx, config):
    ctx.provide_up("llm", Provider())
""".strip(),
            encoding="utf-8",
        )
        report = boot_loop_context(
            _runtime(),
            plugin_dir=plugin_dir,
            patch={"llm-provider": {"disabled": True}},
        )

        assert report.ctx.get("model_client").used_backend == "fake.plugin.llm"
        dump = {row["id"]: row for row in report.dump_config()}
        assert dump["model-client"]["status"] == "active"
        assert dump["user:fake_llm"]["status"] == "active"
        report.ctx.unload()
    finally:
        shutil.rmtree(plugin_dir, ignore_errors=True)


def test_explicit_patch_overrides_env_knobs(monkeypatch):
    monkeypatch.setenv("MAGIC_POINTER_PERMISSION_MODE", "plan")
    report = boot_loop_context(
        _runtime(),
        patch={"model-client": {"config": {"permission_mode": "accept_reversible"}}},
    )
    model_row = next(row for row in report.rows if row.id == "model-client")
    assert model_row.resolved_config["permission_mode"] == "accept_reversible"
    report.ctx.unload()


def test_user_harness_patch_file_controls_plugin_rows(monkeypatch, tmp_path) -> None:
    import json

    config_path = tmp_path / "harness.patch.json"
    config_path.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "patch": {"local-action-tools": {"disabled": True}},
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("MAGIC_POINTER_HARNESS_CONFIG", str(config_path))

    report = boot_loop_context(_runtime())

    assert next(row for row in report.rows if row.id == "local-action-tools").status == "disabled"
    names = {spec.name for spec in report.ctx.get("tools").list()}
    assert "copy_selected_text" not in names
    report.ctx.unload()


def test_explicit_patch_layer_wins_over_user_patch_file(monkeypatch, tmp_path) -> None:
    import json

    config_path = tmp_path / "harness.patch.json"
    config_path.write_text(
        json.dumps({"patch": {"local-action-tools": {"disabled": True}}}),
        encoding="utf-8",
    )
    monkeypatch.setenv("MAGIC_POINTER_HARNESS_CONFIG", str(config_path))

    report = boot_loop_context(
        _runtime(),
        patch={"local-action-tools": {"disabled": False}},
    )

    assert next(row for row in report.rows if row.id == "local-action-tools").status == "active"
    assert report.ctx.get("tools").get("copy_selected_text").name == "copy_selected_text"
    report.ctx.unload()


def test_broken_user_plugin_is_isolated_with_warning():
    import shutil
    import uuid
    from pathlib import Path

    root = Path(__file__).resolve().parents[1]
    plugin_dir = root / f"pytest-sandbox-{uuid.uuid4().hex[:12]}"
    os.mkdir(plugin_dir)
    try:
        (plugin_dir / "boom").mkdir()
        (plugin_dir / "boom" / "plugin.py").write_text(
            "import not_a_real_module_xyz\n", encoding="utf-8"
        )
        report = boot_loop_context(_runtime(), plugin_dir=plugin_dir)
        names = sorted(spec.name for spec in report.ctx.get("tools").list())
        assert names == EXPECTED_TOOLS  # tree fully booted
        assert any("boom" in warning for warning in report.warnings)
        report.ctx.unload()
    finally:
        shutil.rmtree(plugin_dir, ignore_errors=True)


def test_disabled_row_skips_its_registration():
    report = boot_loop_context(
        _runtime(),
        patch={"local-action-tools": {"disabled": True}},
    )
    registry = report.ctx.get("tools")
    names = {spec.name for spec in registry.list()}
    assert "copy_selected_text" not in names
    assert "save_screenshot" not in names
    assert "show_source" not in names
    assert "look" in names
    status = {row.id: row.status for row in report.rows}
    assert status["local-action-tools"] == "disabled"
    report.ctx.unload()
