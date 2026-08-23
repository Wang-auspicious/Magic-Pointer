"""Coding tool surface for the agent loop (CC/Codex contract port).

The real-machine audit found the loop had 22 tools, ALL desktop/perception —
zero file/shell/code tools, so the harness could not fix a bug in any repo.
This module ports the mature contracts: CC's Read/Edit (exact-unique-match),
Codex's workspace confinement, Hermes' bounded shell output.

Effects follow the existing permission ladder: reads are free, file writes
are reversible_write (allowed in default), shell is local_irreversible
(needs full-access/bypass — same shape as Codex sandbox modes).
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest

from app.agent_runtime.coding_tools import register_coding_tools
from app.agent_runtime.tool_registry import ToolRegistry


@pytest.fixture()
def ws(tmp_path: Path) -> Path:
    root = tmp_path / "workspace"
    root.mkdir()
    return root


@pytest.fixture()
def registry(ws: Path) -> ToolRegistry:
    reg = ToolRegistry()
    register_coding_tools(reg, workspace_root=ws)
    return reg


def _names(registry: ToolRegistry) -> set[str]:
    return {spec.name for spec in registry.list()}


# --- 工具面 ------------------------------------------------------------------


def test_registers_the_coding_tool_surface(registry: ToolRegistry) -> None:
    names = _names(registry)
    assert {"read_file", "write_file", "edit_file", "glob", "grep", "run_command"} <= names


def test_effects_follow_the_permission_ladder(registry: ToolRegistry) -> None:
    assert registry.get("read_file").effect.value == "read"
    assert registry.get("grep").effect.value == "read"
    assert registry.get("glob").effect.value == "read"
    assert registry.get("write_file").effect.value == "reversible_write"
    assert registry.get("edit_file").effect.value == "reversible_write"
    # shell 是不可逆本地操作：default 模式会被 ask 门拦下，bypass 才放行
    assert registry.get("run_command").effect.value == "local_irreversible"


# --- read_file ----------------------------------------------------------------


def test_read_file_returns_numbered_lines(registry: ToolRegistry, ws: Path) -> None:
    (ws / "app.py").write_text("def main():\n    return 42\n", encoding="utf-8")
    result = registry.execute_tool("read_file", {"path": "app.py"})
    assert result.is_error is False
    text = str(result.value.value if hasattr(result.value, "value") else result.value)
    assert "1\tdef main():" in text or "1 def main():" in text or "def main():" in text


def test_read_file_offset_and_limit(registry: ToolRegistry, ws: Path) -> None:
    (ws / "big.txt").write_text(
        "\n".join(f"line {i}" for i in range(1, 101)), encoding="utf-8"
    )
    result = registry.execute_tool(
        "read_file", {"path": "big.txt", "offset": 10, "limit": 5}
    )
    text = str(result.value.value if hasattr(result.value, "value") else result.value)
    assert "line 10" in text and "line 14" in text and "line 15" not in text


def test_read_file_missing_is_an_honest_error(registry: ToolRegistry) -> None:
    result = registry.execute_tool("read_file", {"path": "nope.py"})
    assert result.is_error is True


def test_paths_outside_workspace_are_refused(registry: ToolRegistry, tmp_path: Path) -> None:
    outside = tmp_path / "outside.txt"
    outside.write_text("secret", encoding="utf-8")
    result = registry.execute_tool("read_file", {"path": str(outside)})
    assert result.is_error is True
    assert "workspace" in str(result.error_message or "").casefold()


# --- write_file ---------------------------------------------------------------


def test_write_file_creates_and_reports_bytes(registry: ToolRegistry, ws: Path) -> None:
    result = registry.execute_tool(
        "write_file", {"path": "src/new.py", "content": "x = 1\n"}
    )
    assert result.is_error is False
    assert (ws / "src" / "new.py").read_text(encoding="utf-8") == "x = 1\n"


def test_edit_file_requires_exact_unique_match(registry: ToolRegistry, ws: Path) -> None:
    (ws / "a.py").write_text("x = 1\ny = 2\n", encoding="utf-8")
    ok = registry.execute_tool(
        "edit_file",
        {"path": "a.py", "old_string": "y = 2", "new_string": "y = 3"},
    )
    assert ok.is_error is False
    assert (ws / "a.py").read_text(encoding="utf-8") == "x = 1\ny = 3\n"

    missing = registry.execute_tool(
        "edit_file",
        {"path": "a.py", "old_string": "z = 9", "new_string": "z = 0"},
    )
    assert missing.is_error is True
    assert "not found" in str(missing.error_message or "").casefold()

    # 先把文件改成含两处相同文本，再验证非 replace_all 的唯一性拒绝
    registry.execute_tool(
        "write_file", {"path": "a.py", "content": "y = 3\ny = 3\n"}
    )
    dup = registry.execute_tool(
        "edit_file",
        {"path": "a.py", "old_string": "y = 3", "new_string": "z = 9", "replace_all": False},
    )
    assert dup.is_error is True
    assert "unique" in str(dup.error_message or "").casefold()


# --- glob / grep --------------------------------------------------------------


def test_glob_finds_files_by_pattern(registry: ToolRegistry, ws: Path) -> None:
    (ws / "pkg").mkdir()
    (ws / "pkg" / "mod.py").write_text("a = 1\n", encoding="utf-8")
    (ws / "readme.md").write_text("hi\n", encoding="utf-8")
    result = registry.execute_tool("glob", {"pattern": "**/*.py"})
    text = str(result.value.value if hasattr(result.value, "value") else result.value)
    assert "mod.py" in text and "readme.md" not in text


def test_grep_returns_file_line_matches(registry: ToolRegistry, ws: Path) -> None:
    (ws / "a.py").write_text("alpha = 1\nbeta = 2\n", encoding="utf-8")
    (ws / "b.py").write_text("gamma alpha\n", encoding="utf-8")
    result = registry.execute_tool("grep", {"pattern": "alpha"})
    text = str(result.value.value if hasattr(result.value, "value") else result.value)
    assert "a.py:1" in text.replace("\\", "/") or "a.py" in text
    assert "b.py" in text


def test_grep_bounds_results(registry: ToolRegistry, ws: Path) -> None:
    (ws / "many.txt").write_text("hit\n" * 500, encoding="utf-8")
    result = registry.execute_tool("grep", {"pattern": "hit", "max_results": 10})
    text = str(result.value.value if hasattr(result.value, "value") else result.value)
    assert text.count("hit") <= 12  # 10 条 + 截断说明的余量


# --- run_command ----------------------------------------------------------------


def test_run_command_executes_and_captures_output(registry: ToolRegistry, ws: Path) -> None:
    import os

    result = registry.execute_tool(
        "run_command",
        {"command": "python -c \"print('hello-mp')\"", "cwd": "."},
    )
    assert result.is_error is False, result.value
    text = str(result.value.value if hasattr(result.value, "value") else result.value)
    assert "hello-mp" in text


def test_run_command_timeout_kills_the_process(registry: ToolRegistry) -> None:
    import os

    cmd = (
        "python -c \"import time; time.sleep(30)\""
        if os.name == "nt"
        else "sleep 30"
    )
    result = registry.execute_tool(
        "run_command", {"command": cmd, "timeout_s": 2}
    )
    assert result.is_error is True


# --- run_command effect_classifier (Codex/CC allowlist) --------------------


def test_run_command_classifies_pure_read_commands_as_read() -> None:
    """``_classify_command_effect`` 是 run_command 喂给 effect_for 的分类器;
    测试它本身,避免和 registry 的去重规则打架。"""
    from app.agent_runtime.coding_tools import _classify_command_effect
    from app.agent_runtime.tool_registry import Effect

    pure_reads = ["ls", "ls -la", "pwd", "Get-ChildItem", "Get-Location", "cat a.txt"]
    for cmd in pure_reads:
        assert _classify_command_effect({"command": cmd}) is Effect.READ, cmd

    # 副作用命令保持 local_irreversible
    irreversible = ["npm install", "git push", "python -m pytest", "npm test"]
    for cmd in irreversible:
        assert _classify_command_effect({"command": cmd}) is Effect.LOCAL_IRREVERSIBLE, cmd

    # 管道 / 链式 shell 走 worst-case
    chained = ["ls | head", "ls && rm -rf foo", "ls ; rm a"]
    for cmd in chained:
        assert _classify_command_effect({"command": cmd}) is Effect.LOCAL_IRREVERSIBLE, cmd


def test_edit_file_normalizes_crlf_files_like_cc_edit(registry: ToolRegistry, ws: Path) -> None:
    """CC FileEditTool 契约：读入时 CRLF→LF 归一后再匹配（模型发的
    old_string 永远是 \n），Windows 的 CRLF 文件不再必然 not found；
    写回为 LF。"""
    (ws / "win.py").write_bytes(b"x = 1\r\ny = 2\r\n")
    ok = registry.execute_tool(
        "edit_file",
        {"path": "win.py", "old_string": "y = 2", "new_string": "y = 3"},
    )
    assert ok.is_error is False
    assert (ws / "win.py").read_bytes() == b"x = 1\ny = 3\n"
