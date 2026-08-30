"""B1 工具面分层：deferred 工具不出现在默认 schema，经 find_capability 发现加载。

对照 CC ToolSearchTool / Hermes tool_search：低频工具不付每轮 schema token。
MP 的 loop 机制早已就位（``_select_tool_schemas`` 跳过 ``spec.deferred``、
find_capability 结果进下轮 extra_names）——本批把审计裁定的低频工具真正
标记为 deferred。
"""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

from app.agent_runtime.tool_registry import ToolRegistry


def _select(params) -> list[str]:
    from app.agent_runtime.loop import _select_tool_schemas

    return [entry["name"] for entry in _select_tool_schemas(params)]


def _params(registry: ToolRegistry, tool_limit: int = 64):
    return SimpleNamespace(registry=registry, trajectory=None, tool_limit=tool_limit)


# --- 各模块的 deferred 标记 ---------------------------------------------------


def test_frozen_frame_perception_trio_is_deferred() -> None:
    """冻帧三件套（Stage 手势路径专用）与 live 窗口枚举不再占对话 schema。"""
    from app.agent_runtime.perception_tools import PerceptionTools

    class _Backend:
        def read_around(self, anchor, radius):
            return []

        def dump_subtree(self, anchor, depth):
            return None

        def find_in_window(self, pattern):
            return []

        def list_windows(self):
            return []

        def get_focused(self):
            return None

    registry = ToolRegistry()
    PerceptionTools(_Backend()).register_all(registry)
    flags = {spec.name: spec.deferred for spec in registry.list()}
    assert flags == {
        "Around": True,
        "Tree": True,
        "Find": True,
        "ListWindows": True,
        "GetFocus": True,
    }


def test_look_is_visible_but_describe_capabilities_is_deferred() -> None:
    from app.agent_runtime.look_tool import LookTool

    registry = ToolRegistry()
    LookTool(backend=None).register(registry)
    flags = {spec.name: spec.deferred for spec in registry.list()}
    assert flags["Look"] is False, "Look 是冻结帧视觉主入口，保持可见"
    assert flags["Capabilities"] is True


def test_recall_and_save_skill_are_deferred() -> None:
    from pathlib import Path

    from app.agent_runtime.memory_tools import register_history_search
    from app.agent_runtime.skill_writer import register_skill_writer

    registry = ToolRegistry()
    register_history_search(registry, sessions_root=Path("."))
    register_skill_writer(registry, skills_root=Path("."))
    flags = {spec.name: spec.deferred for spec in registry.list()}
    assert flags["Recall"] is True
    assert flags["SaveSkill"] is True


def test_core_surface_stays_visible() -> None:
    """核心 25 件永不 defer：文件/shell、桌面 13 件套、元工具、web。"""
    from pathlib import Path

    from app.agent_runtime.coding_tools import register_coding_tools
    from app.agent_runtime.web_tools import register_web_tools
    from app.agent_runtime.ask_todo_tools import register_ask_user_question
    from app.agent_runtime.ask_todo_tools import register_todo_write
    from app.agent_runtime.subagent import register_delegate_tool

    registry = ToolRegistry()
    register_coding_tools(registry, workspace_root=Path("."))
    register_web_tools(registry)
    register_ask_user_question(registry)
    register_todo_write(registry)
    register_delegate_tool(
        registry,
        llm_provider=SimpleNamespace(create_client=lambda **k: object()),
        workspace_root=Path("."),
    )
    for spec in registry.list():
        assert spec.deferred is False, f"{spec.name} 属核心面，不得 defer"


# --- 分层机制集成 -------------------------------------------------------------


def test_select_tool_schemas_excludes_deferred_and_search_finds_them() -> None:
    """deferred 不进默认 schema；find_capability（registry.search）仍能发现。"""
    from app.agent_runtime.perception_tools import PerceptionTools
    from app.agent_runtime.coding_tools import register_coding_tools

    class _Backend:
        def read_around(self, anchor, radius):
            return []

        def dump_subtree(self, anchor, depth):
            return None

        def find_in_window(self, pattern):
            return []

        def list_windows(self):
            return []

        def get_focused(self):
            return None

    registry = ToolRegistry()
    register_coding_tools(registry, workspace_root=Path("."))
    PerceptionTools(_Backend()).register_all(registry)

    names = _select(_params(registry))
    assert "Read" in names and "Around" not in names

    hits = registry.search("frozen snapshot subtree")
    hit_names = {spec.name for spec in hits}
    assert "Tree" in hit_names, "deferred 工具必须仍可被 find_capability 搜到"
