"""B5 工具改名：CC 风格命名（Read/Edit/Bash/Observe…）+ 旧名别名兼容。

别名契约：旧名在 get/execute/权限解析里路由到规范工具，但绝不进 schema；
一个版本后别名可移除。
"""

from __future__ import annotations

from pathlib import Path

from app.agent_runtime.tool_registry import ToolRegistry


def test_registry_alias_routes_but_never_in_schema() -> None:
    from app.agent_runtime.tool_registry import ToolSpec

    registry = ToolRegistry()
    registry.register(ToolSpec(
        name="Read",
        description="读",
        input_schema={"type": "object", "properties": {}, "required": []},
        execute=lambda **kw: "ok",
    ))
    registry.register_alias("read_file", "Read")
    assert registry.get("read_file").name == "Read"
    assert registry.execute_tool("read_file", {}).value == "ok"
    schema_names = [entry["name"] for entry in registry.schemas_for_model()]
    assert schema_names == ["Read"], "别名绝不进 schema"


def test_coding_tools_register_new_names_with_old_aliases() -> None:
    from app.agent_runtime.coding_tools import register_coding_tools

    registry = ToolRegistry()
    register_coding_tools(registry, workspace_root=Path("."))
    names = {spec.name for spec in registry.list()}
    for new_name in ("Read", "Write", "Edit", "Patch", "Glob", "Grep",
                     "Bash", "BashRead", "Rewind"):
        assert new_name in names, f"{new_name} 缺席"
    for old_name in ("read_file", "write_file", "edit_file", "apply_patch",
                     "glob", "grep", "run_command", "read_background", "restore_files"):
        assert registry.get(old_name).name != old_name, "旧名必须只作别名"
        assert old_name not in names
    assert {entry["name"] for entry in registry.schemas_for_model()} <= names


def test_desktop_and_meta_tools_renamed() -> None:
    from app.agent_runtime.ask_todo_tools import register_ask_user_question
    from app.agent_runtime.ask_todo_tools import register_todo_write
    from app.agent_runtime.subagent import register_delegate_tool
    from app.agent_runtime.web_tools import register_web_tools
    from app.agent_runtime.memory_tools import register_history_search
    from app.agent_runtime.skill_writer import register_skill_writer
    from types import SimpleNamespace

    registry = ToolRegistry()
    register_ask_user_question(registry)
    register_todo_write(registry)
    register_delegate_tool(
        registry,
        llm_provider=SimpleNamespace(create_client=lambda **k: object()),
        workspace_root=Path("."),
    )
    register_web_tools(registry)
    register_history_search(registry, sessions_root=Path("."))
    register_skill_writer(registry, skills_root=Path("."))
    names = {spec.name for spec in registry.list()}
    for new_name in ("AskUser", "Todo", "Agent", "Search", "Fetch", "Recall", "SaveSkill"):
        assert new_name in names, f"{new_name} 缺席"
    for old_name in ("ask_user_question", "todo_write", "delegate_task",
                     "web_search", "web_fetch", "search_history", "save_skill"):
        assert old_name not in names


def _fake_session():
    import sys
    sys.path.insert(0, "tests")
    from desktop_action_tools_test import _session

    return _session()


def test_desktop_tools_renamed_with_aliases() -> None:
    from app.desktop_actions import register_desktop_action_tools

    registry = ToolRegistry()
    register_desktop_action_tools(registry, _fake_session())
    names = {spec.name for spec in registry.list()}
    for new_name in ("ListApps", "Launch", "Focus", "Observe", "Click", "Type",
                     "Key", "Scroll", "SetValue", "Act", "Select", "Drag",
                     "turn_ended"):
        assert new_name in names, f"{new_name} 缺席"
    assert registry.get("get_app_state").name == "Observe"
    assert registry.get("click").name == "Click"
