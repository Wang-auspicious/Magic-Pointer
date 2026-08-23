"""apply_patch 多段支持：schema 接受 str | list[str]（Codex 一次响应多段补丁）。

roadmap §1.7：MP 的 apply_patch schema 只接受单一字符串，模型要么硬塞一段、
要么把多段塞进一段里；Codex 允许一条消息携带多个 apply_patch 块。执行端把
list[str] 归一化后逐段解析，行为与单段完全一致。
"""

from __future__ import annotations

from pathlib import Path

import pytest

from app.agent_runtime.tool_registry import ToolSpec


def _apply_spec() -> ToolSpec:
    """Reflect the apply_patch ToolSpec contract from the coding tools row."""
    from app.agent_runtime.coding_tools import register_coding_tools

    from app.agent_runtime.tool_registry import ToolRegistry

    registry = ToolRegistry()
    register_coding_tools(registry, workspace_root=str(Path.cwd()))
    return registry.get("apply_patch")


def test_apply_patch_schema_accepts_string_or_list() -> None:
    spec = _apply_spec()
    props = spec.input_schema["properties"]
    assert "patch" in props
    patch_schema = props["patch"]
    # oneOf: string or array of strings — Codex multi-patch contract.
    assert "oneOf" in patch_schema, patch_schema
    kinds = {entry["type"] for entry in patch_schema["oneOf"]}
    assert kinds == {"string", "array"}, patch_schema


def test_apply_patch_execute_accepts_a_list_of_patches(tmp_path: Path) -> None:
    """Two separate patches in one call must both apply (Codex multi-block)."""
    from app.agent_runtime.coding_tools import register_coding_tools

    from app.agent_runtime.tool_registry import ToolRegistry

    a = tmp_path / "a.txt"
    b = tmp_path / "b.txt"
    a.write_text("old-a\n", encoding="utf-8")
    b.write_text("old-b\n", encoding="utf-8")

    registry = ToolRegistry()
    register_coding_tools(registry, workspace_root=str(tmp_path))
    spec = registry.get("apply_patch")

    patch_a = (
        "*** Begin Patch\n"
        "*** Update File: a.txt\n"
        "@@\n"
        "-old-a\n"
        "+new-a\n"
        "*** End Patch"
    )
    patch_b = (
        "*** Begin Patch\n"
        "*** Update File: b.txt\n"
        "@@\n"
        "-old-b\n"
        "+new-b\n"
        "*** End Patch"
    )

    result = registry.execute_tool("apply_patch", {"patch": [patch_a, patch_b]})
    assert not result.is_error, result.value
    assert "2 patch block(s)" in str(result.value), result.value
    assert a.read_text(encoding="utf-8") == "new-a\n"
    assert b.read_text(encoding="utf-8") == "new-b\n"


def test_apply_patch_delete_is_restorable_by_checkpoint(tmp_path: Path) -> None:
    """Roadmap §1.3 P3: apply_patch deletes must snapshot before removal so
    restore_files can bring the file back (CC /rewind contract)."""
    from app.agent_runtime.coding_tools import register_coding_tools

    from app.agent_runtime.tool_registry import ToolRegistry

    victim = tmp_path / "victim.txt"
    victim.write_text("precious data\n", encoding="utf-8")

    registry = ToolRegistry()
    register_coding_tools(registry, workspace_root=str(tmp_path))

    delete_patch = (
        "*** Begin Patch\n"
        "*** Delete File: victim.txt\n"
        "*** End Patch"
    )
    result = registry.execute_tool("apply_patch", {"patch": delete_patch})
    assert not result.is_error, result.value
    assert not victim.exists()

    # restore_files rewinds the delete from the pre-delete snapshot.
    rewind = registry.execute_tool("restore_files", {"steps": 1})
    assert not rewind.is_error, rewind.value
    assert victim.read_text(encoding="utf-8") == "precious data\n"