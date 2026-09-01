"""Builtin bundle tests (plugin-kernel batch, plan T4).

Pins the composed plugin tree inventory (perception + local actions +
Kimi CU 13 desktop tools + capability tools), the plugin-contributed
services, legacy env knobs, and isolation of a broken user plugin.
"""

from __future__ import annotations

import json
import os
import platform
from datetime import datetime
from pathlib import Path

from app.agent_runtime.types import ORIGIN_DATA, AgentMessage, Role
from app.harness.builtin_bundle import LoopHarnessHost, _git_branch, boot_loop_context
from app.agent_runtime.system_prompt import default_builder, default_sections

# 5 perception tools + Look + 3 local actions + 13 desktop CU tools
# + AskUser/Todo + Search/Fetch/SaveSkill
# + Recall (BashRead only mounts with a workspace)
# + 16 capability tools + Tools.
EXPECTED_TOOLS = [
    "Act", "Around", "AskUser", "Capabilities",
    "Click", "Drag", "Fetch", "Find",
    "Focus", "GetFocus", "Key", "Launch",
    "ListApps", "ListWindows", "Look", "Observe",
    "Recall", "SaveSkill", "Scroll", "Search",
    "Select", "SetValue", "Todo", "Tools",
    "Tree", "Type", "agent_handoff", "canvas_transform",
    "clipboard_text", "compare_objects", "copy_selected_text", "data_export",
    "image_ops", "place_route", "recipe_scale", "research_card",
    "save_screenshot", "screen_help", "show_source", "table_merge",
    "task_route", "text_transform", "turn_ended", "vision_bridge",
    "wait",
]
WRITE_TOOLS = {
    "Focus", "Click", "copy_selected_text", "Drag", "Launch",
    "Act", "Key", "save_screenshot", "SaveSkill",
    "Scroll", "Select", "SetValue", "Type",
}


class _FakePerception:
    def Around(self, anchor, radius):
        return []

    def Find(self, query, limit=10):
        return []

    def Tree(self, path=None):
        return {}

    def ListWindows(self):
        return []

    def GetFocus(self):
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
    assert effects["Click"] == "reversible_write"
    assert effects["show_source"] == "read"
    assert effects["ListApps"] == "read"
    assert effects["Observe"] == "read"
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
        "AskUser",
        "Fetch",
        "Recall",
        "SaveSkill",
        "Search",
        "Todo",
    ]

    first = host.open(_runtime(content="first"))
    assert sorted(spec.name for spec in first.ctx.get("tools").list()) == EXPECTED_TOOLS
    assert first.ctx.has("model_client")
    first.close()
    assert sorted(spec.name for spec in global_registry.list()) == [
        "AskUser",
        "Fetch",
        "Recall",
        "SaveSkill",
        "Search",
        "Todo",
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
    report = boot_loop_context(_runtime(selection_anchor={"kind": "test"}))
    prompt = report.ctx.get("model_client")._backend.system_prompt
    # 问答形态：证据够了就别再翻，避免为显得勤奋而空转。
    assert "不要为了显得勤奋" in prompt
    # 多步作业形态：证据够 ≠ 活干完，不得中途收工（任务时长不是边界）。
    assert "做完全部步骤" in prompt
    assert "勿重复 Look" in prompt
    assert "冻结帧" in prompt
    assert "不得据此点击" in prompt
    assert "AskUser" in prompt
    assert "再 Observe" in prompt
    assert "Observe" in prompt
    assert "turn_ended" in prompt
    report.ctx.unload()


def test_system_prompt_without_selection_evidence_does_not_claim_circled_object():
    report = boot_loop_context(_runtime())
    prompt = report.ctx.get("model_client")._backend.system_prompt
    # 普通文本对话：摘掉"用户圈选了对象"的谎言，模型才不会被骗去
    # 全桌面找并不存在的选区（真机事故：17 轮桌面工具空转）。
    assert "圈选" not in prompt
    assert "visual_anchor" not in prompt
    assert "冻结帧" not in prompt
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
    report.ctx.get("tools").get("Todo").execute(todos=[
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
    assert [row.status for row in report.rows] == ["active"] * 18
    dump = report.dump_config()
    assert {row["id"] for row in dump} == {
        "harness-tools", "web-tools", "skill-writer", "memory-tools", "computer-agent",
        "perception-tools", "look-tool",
        "local-action-tools", "desktop-action-tools", "coding-tools",
        "delegate-tool", "capability-tools", "guard", "system-prompt",
        "llm-provider", "session-store", "learning-review", "model-client",
    }
    assert all(row["status"] == "active" for row in dump)
    report.ctx.unload()


def test_coding_tools_absent_without_workspace_and_present_with_one(tmp_path):
    report = boot_loop_context(_runtime())
    names = {tool.name for tool in report.ctx.get("tools").list()}
    assert "Bash" not in names
    assert "Agent" not in names
    report.ctx.unload()

    report = boot_loop_context(_runtime(workspace_root=str(tmp_path)))
    names = {tool.name for tool in report.ctx.get("tools").list()}
    assert {
        "Read", "Write", "Edit", "Glob", "Grep",
        "Bash", "Patch", "Rewind", "Agent",
    } <= names
    model_cfg = next(
        row.resolved_config for row in report.rows if row.id == "model-client"
    )
    assert model_cfg["workspace_root"] == str(tmp_path)
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


def test_user_llm_provider_replaces_builtin_by_configuration(monkeypatch) -> None:
    import shutil
    import uuid
    from pathlib import Path

    root = Path(__file__).resolve().parents[1]
    monkeypatch.delenv("MAGIC_POINTER_PROMPT_CACHE", raising=False)
    monkeypatch.setattr(
        "app.ai_client.get_ai_config",
        lambda: ("key", "https://api.example/anthropic/v1", "claude-sonnet-5"),
    )
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
        assert report.ctx.get("model_request_header")["promptCache"] is False
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
    assert "Look" in names
    status = {row.id: row.status for row in report.rows}
    assert status["local-action-tools"] == "disabled"
    report.ctx.unload()


def test_reply_style_reaches_the_prompt_context() -> None:
    """作曲家的语量芯片必须真的改系统提示。

    reply_style 一路从 renderer 传到 model-client 的 resolved_config，然后
    ``_apply_model_client`` 建 prompt context 时把它丢了——五档芯片对模型
    完全不可见（Style section 的三个单测只测 builder，测不到这段接线）。
    """
    report = boot_loop_context(_runtime(command="随便问问", reply_style="ultra"))
    prompt = report.ctx.get("model_request_header")["systemPrompt"]
    assert "# Style" in prompt, "ultra 档必须注入 Style section"
    assert "极简" in prompt
    report.ctx.unload()

    normal = boot_loop_context(_runtime(command="随便问问", reply_style="normal"))
    assert "# Style" not in normal.ctx.get("model_request_header")["systemPrompt"]
    normal.ctx.unload()


def test_pointing_instruction_reaches_prompt_only_when_requested() -> None:
    report = boot_loop_context(_runtime(
        command="这个按钮在哪里",
        pointing_instruction="在句中插入 [POINT x,y] 指向已确认的位置。",
    ))
    prompt = report.ctx.get("model_request_header")["systemPrompt"]
    assert "# Pointing" in prompt
    assert "[POINT x,y]" in prompt
    report.ctx.unload()

    normal = boot_loop_context(_runtime(command="总结这段话", pointing_instruction=""))
    assert "# Pointing" not in normal.ctx.get("model_request_header")["systemPrompt"]
    normal.ctx.unload()


def test_model_request_header_reports_prompt_cache_request(monkeypatch) -> None:
    monkeypatch.setattr(
        "app.ai_client.get_ai_config",
        lambda: ("key", "https://api.example/anthropic/v1", "claude-sonnet-5"),
    )
    monkeypatch.delenv("MAGIC_POINTER_PROMPT_CACHE", raising=False)
    report = boot_loop_context(_runtime())
    assert report.ctx.get("model_request_header")["promptCache"] is True
    report.ctx.unload()

    monkeypatch.setenv("MAGIC_POINTER_PROMPT_CACHE", "0")
    report = boot_loop_context(_runtime())
    assert report.ctx.get("model_request_header")["promptCache"] is False
    report.ctx.unload()

    monkeypatch.delenv("MAGIC_POINTER_PROMPT_CACHE", raising=False)
    monkeypatch.setattr(
        "app.ai_client.get_ai_config",
        lambda: ("key", "https://gateway.example/v1", "gpt-5.6-sol"),
    )
    report = boot_loop_context(_runtime())
    assert report.ctx.get("model_request_header")["promptCache"] is False
    report.ctx.unload()


def test_environment_section_is_dynamic_and_precedes_coding() -> None:
    sections = default_sections()
    ids = [section.id for section in sections]
    assert "environment" in ids
    assert ids.index("environment") < ids.index("coding")

    prompt = default_builder().build({
        "today": "2026-09-01（Tuesday）",
        "platform": "Windows 11",
        "workspace_root": r"D:\work\project",
        "git_branch": "codex/harness-reconstruction",
    })
    assert "# Environment" in prompt
    assert "2026-09-01（Tuesday）" in prompt
    assert "Windows 11" in prompt
    assert r"D:\work\project" in prompt
    assert "codex/harness-reconstruction" in prompt
    assert prompt.count(r"D:\work\project") == 1
    assert "# Environment" not in default_builder().build({})


def test_git_branch_reads_symbolic_head_and_ignores_detached_head(tmp_path: Path) -> None:
    git_dir = tmp_path / ".git"
    git_dir.mkdir()
    (git_dir / "HEAD").write_text(
        "ref: refs/heads/codex/harness-reconstruction\n",
        encoding="utf-8",
    )
    assert _git_branch(str(tmp_path)) == "codex/harness-reconstruction"

    (git_dir / "HEAD").write_text("a" * 40 + "\n", encoding="utf-8")
    assert _git_branch(str(tmp_path)) == ""


def test_bound_workspace_memory_and_environment_reach_the_prompt(tmp_path: Path) -> None:
    workspace = tmp_path / "project"
    workspace.mkdir()
    (workspace / "MAGIC_POINTER.md").write_text(
        "项目唯一规则：回答前写 MP_WORKSPACE_MEMORY_OK。",
        encoding="utf-8",
    )
    git_dir = workspace / ".git"
    git_dir.mkdir()
    (git_dir / "HEAD").write_text("ref: refs/heads/main\n", encoding="utf-8")

    report = boot_loop_context(
        _runtime(workspace_root=str(workspace)),
        root=tmp_path,
        plugin_dir=tmp_path / "plugins",
    )
    prompt = report.ctx.get("model_request_header")["systemPrompt"]
    assert "MP_WORKSPACE_MEMORY_OK" in prompt
    assert datetime.now().astimezone().date().isoformat() in prompt
    assert platform.system() in prompt
    assert "当前 git 分支：main" in prompt
    report.ctx.unload()


def test_coding_prompt_uses_only_canonical_tool_names(tmp_path: Path) -> None:
    report = boot_loop_context(_runtime(workspace_root=str(tmp_path)))
    prompt = report.ctx.get("model_request_header")["systemPrompt"]
    for stale in (
        "read_file", "write_file", "edit_file", "apply_patch",
        "run_command", "restore_files",
    ):
        assert stale not in prompt
    assert "Rewind" in prompt
    report.ctx.unload()


def test_permission_mode_in_prompt_matches_the_mode_the_loop_enforces() -> None:
    """提示里的权限模式必须是本回合真正执行的那个。

    两座桥都把用户选的预设写进 ``runtime['permission_mode']``，但 model-client
    行只读 ``MAGIC_POINTER_PERMISSION_MODE`` 环境变量（生产从不设置），所以
    提示恒为 default：用户选 read-only 时模型仍被告知可逆写可直接执行，
    连着一轮工具拒绝。
    """
    report = boot_loop_context(_runtime(permission_mode="safe"))
    model_row = next(row for row in report.rows if row.id == "model-client")
    assert model_row.resolved_config["permission_mode"] == "safe"
    assert "safe" in report.ctx.get("model_request_header")["systemPrompt"]
    report.ctx.unload()


def test_env_permission_mode_still_overrides_when_runtime_says_nothing(monkeypatch) -> None:
    """回滚开关保持有效：runtime 不带模式时环境变量仍然说话。"""
    monkeypatch.setenv("MAGIC_POINTER_PERMISSION_MODE", "plan")
    runtime = _runtime()
    runtime.pop("permission_mode", None)
    report = boot_loop_context(runtime)
    model_row = next(row for row in report.rows if row.id == "model-client")
    assert model_row.resolved_config["permission_mode"] == "plan"
    report.ctx.unload()


def test_resident_host_stage_path_passes_selection_anchor_to_model_client(tmp_path):
    """Stage 常驻 worker 的 model-client 行必须带上 selection_anchor。

    boot_loop_context（conversation 一次性路径）修了 ``has_selection`` 恒
    False 的骗局，但 Stage 生产路径走 LoopHarnessHost._run_loop_rows——
    那条 model-client 行没传 anchor，划线任务仍然被提示词告知
    「本任务没有屏幕选区对象」，冻结帧 / Look 规则全部失效。
    """
    host = LoopHarnessHost(root=tmp_path, plugin_dir=tmp_path / "plugins")
    report = host.open(_runtime(selection_anchor={"kind": "test"}))
    assert "圈选" in report.ctx.get("model_request_header")["systemPrompt"]
    host.close()

    host = LoopHarnessHost(root=tmp_path, plugin_dir=tmp_path / "plugins")
    report = host.open(_runtime())
    assert "圈选" not in report.ctx.get("model_request_header")["systemPrompt"]
    assert "冻结帧" not in report.ctx.get("model_request_header")["systemPrompt"]
    host.close()


def test_system_prompt_bans_raw_output_dumps_in_answers():
    """回答是写给用户的对话，不是工具输出的倾倒。

    真机（图3）：用户问「项目里有什么」，模型把 search 的原始输出抄成
    ASCII 目录树——完全不想沟通。五源码共同的输出契约：先直接回答问题
    本身，工具输出是证据不是答案；清单/树/原始输出只在用户明确要时给。
    """
    report = boot_loop_context(_runtime(command="项目里有什么", workspace_root="D:/x"))
    prompt = report.ctx.get("model_request_header")["systemPrompt"]
    assert "倾倒" in prompt
    assert "项目里有什么" in prompt
    assert "证据" in prompt
    report.ctx.unload()
