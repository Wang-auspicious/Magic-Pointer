
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


def _result_text(result) -> str:
    value = result.value
    return str(value.value if hasattr(value, "value") else value)




def test_registers_the_coding_tool_surface(registry: ToolRegistry) -> None:
    names = _names(registry)
    assert {"Read", "Write", "Edit", "Glob", "Grep", "Bash"} <= names


def test_model_visible_coding_text_uses_canonical_names_while_aliases_still_route(
    registry: ToolRegistry,
) -> None:
    import json

    visible = json.dumps(registry.schemas_for_model(), ensure_ascii=False)
    aliases = {
        "read_file": "Read",
        "write_file": "Write",
        "edit_file": "Edit",
        "apply_patch": "Patch",
        "run_command": "Bash",
        "restore_files": "Rewind",
    }
    for alias, canonical in aliases.items():
        assert alias not in visible
        assert registry.get(alias) is registry.get(canonical)


def test_effects_follow_the_permission_ladder(registry: ToolRegistry) -> None:
    assert registry.get("Read").effect.value == "read"
    assert registry.get("Grep").effect.value == "read"
    assert registry.get("Glob").effect.value == "read"
    assert registry.get("Write").effect.value == "reversible_write"
    assert registry.get("Edit").effect.value == "reversible_write"
    assert registry.get("Bash").effect.value == "local_irreversible"




def test_read_file_returns_numbered_lines(registry: ToolRegistry, ws: Path) -> None:
    (ws / "app.py").write_text("def main():\n    return 42\n", encoding="utf-8")
    result = registry.execute_tool("Read", {"path": "app.py"})
    assert result.is_error is False
    text = str(result.value.value if hasattr(result.value, "value") else result.value)
    assert "1\tdef main():" in text or "1 def main():" in text or "def main():" in text


def test_read_file_offset_and_limit(registry: ToolRegistry, ws: Path) -> None:
    (ws / "big.txt").write_text(
        "\n".join(f"line {i}" for i in range(1, 101)), encoding="utf-8"
    )
    result = registry.execute_tool(
        "Read", {"path": "big.txt", "offset": 10, "limit": 5}
    )
    text = str(result.value.value if hasattr(result.value, "value") else result.value)
    assert "line 10" in text and "line 14" in text and "line 15" not in text


def test_read_file_missing_is_an_honest_error(registry: ToolRegistry) -> None:
    result = registry.execute_tool("Read", {"path": "nope.py"})
    assert result.is_error is True


def test_paths_outside_workspace_are_refused(registry: ToolRegistry, tmp_path: Path) -> None:
    outside = tmp_path / "outside.txt"
    outside.write_text("secret", encoding="utf-8")
    result = registry.execute_tool("Read", {"path": str(outside)})
    assert result.is_error is True
    assert "workspace" in str(result.error_message or "").casefold()




def test_write_file_creates_and_reports_bytes(registry: ToolRegistry, ws: Path) -> None:
    result = registry.execute_tool(
        "Write", {"path": "src/new.py", "content": "x = 1\n"}
    )
    assert result.is_error is False
    assert (ws / "src" / "new.py").read_text(encoding="utf-8") == "x = 1\n"


def test_edit_file_requires_exact_unique_match(registry: ToolRegistry, ws: Path) -> None:
    (ws / "a.py").write_text("x = 1\ny = 2\n", encoding="utf-8")
    registry.execute_tool("Read", {"path": "a.py"})
    ok = registry.execute_tool(
        "Edit",
        {"path": "a.py", "old_string": "y = 2", "new_string": "y = 3"},
    )
    assert ok.is_error is False
    assert (ws / "a.py").read_text(encoding="utf-8") == "x = 1\ny = 3\n"

    missing = registry.execute_tool(
        "Edit",
        {"path": "a.py", "old_string": "z = 9", "new_string": "z = 0"},
    )
    assert missing.is_error is True
    assert "not found" in str(missing.error_message or "").casefold()

    registry.execute_tool(
        "Write", {"path": "a.py", "content": "y = 3\ny = 3\n"}
    )
    dup = registry.execute_tool(
        "Edit",
        {"path": "a.py", "old_string": "y = 3", "new_string": "z = 9", "replace_all": False},
    )
    assert dup.is_error is True
    assert "unique" in str(dup.error_message or "").casefold()




def test_glob_finds_files_by_pattern(registry: ToolRegistry, ws: Path) -> None:
    (ws / "pkg").mkdir()
    (ws / "pkg" / "mod.py").write_text("a = 1\n", encoding="utf-8")
    (ws / "readme.md").write_text("hi\n", encoding="utf-8")
    result = registry.execute_tool("Glob", {"pattern": "**/*.py"})
    text = str(result.value.value if hasattr(result.value, "value") else result.value)
    assert "mod.py" in text and "readme.md" not in text


def test_grep_returns_file_line_matches(registry: ToolRegistry, ws: Path) -> None:
    (ws / "a.py").write_text("alpha = 1\nbeta = 2\n", encoding="utf-8")
    (ws / "b.py").write_text("gamma alpha\n", encoding="utf-8")
    result = registry.execute_tool("Grep", {"pattern": "alpha"})
    text = str(result.value.value if hasattr(result.value, "value") else result.value)
    assert "a.py:1" in text.replace("\\", "/") or "a.py" in text
    assert "b.py" in text


def test_grep_bounds_results(registry: ToolRegistry, ws: Path) -> None:
    (ws / "many.txt").write_text("hit\n" * 500, encoding="utf-8")
    result = registry.execute_tool("Grep", {"pattern": "hit", "max_results": 10})
    text = str(result.value.value if hasattr(result.value, "value") else result.value)
    assert text.count("hit") <= 12


def test_grep_case_sensitive_identifier_search(registry: ToolRegistry, ws: Path) -> None:
    (ws / "symbols.py").write_text("Read\nread\nREAD\n", encoding="utf-8")

    insensitive = registry.execute_tool(
        "Grep", {"pattern": "Read", "case_sensitive": False}
    )
    sensitive = registry.execute_tool(
        "Grep", {"pattern": "Read", "case_sensitive": True}
    )

    assert insensitive.is_error is False
    assert sensitive.is_error is False
    insensitive_text = _result_text(insensitive)
    sensitive_text = _result_text(sensitive)
    assert insensitive_text.count("symbols.py:") == 3
    assert sensitive_text.count("symbols.py:") == 1


def test_grep_output_modes_page_by_unique_file(registry: ToolRegistry, ws: Path) -> None:
    (ws / "a.txt").write_text("needle\nneedle\n", encoding="utf-8")
    (ws / "b.txt").write_text("needle\n", encoding="utf-8")
    (ws / "c.txt").write_text("nothing\n", encoding="utf-8")

    content = registry.execute_tool(
        "Grep", {"pattern": "needle", "output_mode": "content"}
    )
    files = registry.execute_tool(
        "Grep", {"pattern": "needle", "output_mode": "files_with_matches"}
    )
    paged_files = registry.execute_tool(
        "Grep",
        {
            "pattern": "needle",
            "output_mode": "files_with_matches",
            "offset": 1,
            "max_results": 1,
        },
    )
    exhausted_files = registry.execute_tool(
        "Grep",
        {
            "pattern": "needle",
            "output_mode": "files_with_matches",
            "offset": 2,
            "max_results": 1,
        },
    )
    exhausted_content = registry.execute_tool(
        "Grep",
        {
            "pattern": "needle",
            "output_mode": "content",
            "offset": 3,
            "max_results": 1,
        },
    )
    counts = registry.execute_tool(
        "Grep", {"pattern": "needle", "output_mode": "count"}
    )
    exhausted_counts = registry.execute_tool(
        "Grep",
        {
            "pattern": "needle",
            "output_mode": "count",
            "offset": 2,
            "max_results": 1,
        },
    )

    assert content.is_error is False
    assert "a.txt:1:" in _result_text(content)
    assert files.is_error is False
    assert _result_text(files).splitlines() == ["a.txt", "b.txt"]
    assert _result_text(paged_files) == "b.txt"
    assert "page exhausted" in _result_text(exhausted_files)
    assert "offset=2" in _result_text(exhausted_files)
    assert "total=2 files" in _result_text(exhausted_files)
    assert "page exhausted" in _result_text(exhausted_content)
    assert "offset=3" in _result_text(exhausted_content)
    assert "total=3 results" in _result_text(exhausted_content)
    assert counts.is_error is False
    assert _result_text(counts).splitlines() == ["a.txt: 2", "b.txt: 1"]
    assert "page exhausted" in _result_text(exhausted_counts)
    assert "offset=2" in _result_text(exhausted_counts)
    assert "total=2 files" in _result_text(exhausted_counts)


def test_grep_rg_and_python_fallback_share_output_semantics(
    registry: ToolRegistry, ws: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import app.agent_runtime.coding_tools as coding_tools

    rg_path = coding_tools.shutil.which("rg")
    if rg_path is None:
        pytest.skip("ripgrep is not installed on this test host")
    (ws / "a.py").write_text("Token\ntoken\nToken\n", encoding="utf-8")
    (ws / "b.py").write_text("Token\n", encoding="utf-8")

    for output_mode in ("content", "files_with_matches", "count"):
        arguments = {
            "pattern": "Token",
            "case_sensitive": True,
            "output_mode": output_mode,
        }
        monkeypatch.setattr(coding_tools.shutil, "which", lambda _name: rg_path)
        rg_result = registry.execute_tool("Grep", arguments)
        monkeypatch.setattr(coding_tools.shutil, "which", lambda _name: None)
        python_result = registry.execute_tool("Grep", arguments)

        assert rg_result.is_error is False
        assert python_result.is_error is False
        assert _result_text(rg_result) == _result_text(python_result)




def test_run_command_executes_and_captures_output(registry: ToolRegistry, ws: Path) -> None:
    import os

    result = registry.execute_tool(
        "Bash",
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
        "Bash", {"command": cmd, "timeout_s": 2}
    )
    assert result.is_error is True




def test_run_command_classifies_pure_read_commands_as_read() -> None:
    from app.agent_runtime.coding_tools import _classify_command_effect
    from app.agent_runtime.tool_registry import Effect

    pure_reads = ["ls", "ls -la", "pwd", "Get-ChildItem", "Get-Location", "cat a.txt"]
    for cmd in pure_reads:
        assert _classify_command_effect({"command": cmd}) is Effect.READ, cmd

    irreversible = ["npm install", "git push", "python -m pytest", "npm test"]
    for cmd in irreversible:
        assert _classify_command_effect({"command": cmd}) is Effect.LOCAL_IRREVERSIBLE, cmd

    chained = ["ls | head", "ls && rm -rf foo", "ls ; rm a"]
    for cmd in chained:
        assert _classify_command_effect({"command": cmd}) is Effect.LOCAL_IRREVERSIBLE, cmd


def test_edit_file_preserves_crlf_but_matches_lf(registry: ToolRegistry, ws: Path) -> None:
    from app.agent_runtime.coding_tools import _detect_newline

    (ws / "win.py").write_bytes(b"x = 1\r\ny = 2\r\n")
    registry.execute_tool("Read", {"path": "win.py"})
    ok = registry.execute_tool(
        "Edit",
        {"path": "win.py", "old_string": "y = 2", "new_string": "y = 3"},
    )
    assert ok.is_error is False
    assert (ws / "win.py").read_bytes() == b"x = 1\r\ny = 3\r\n"




def test_edit_file_normalizes_curly_quotes_to_match(registry: ToolRegistry, ws: Path) -> None:
    (ws / "a.py").write_text('msg = "hello"\n', encoding="utf-8")
    registry.execute_tool("Read", {"path": "a.py"})
    ok = registry.execute_tool(
        "Edit",
        {"path": "a.py", "old_string": "msg = \u201chello\u201d", "new_string": 'msg = "hi"'},
    )
    assert ok.is_error is False, ok.error_message
    assert (ws / "a.py").read_text(encoding="utf-8") == 'msg = "hi"\n'


def test_edit_file_curly_quotes_match_keeps_actual_quotes_in_new_content_position(
    registry: ToolRegistry, ws: Path
) -> None:
    (ws / "b.md").write_text("say \u201cfoo\u201d now\n", encoding="utf-8")
    registry.execute_tool("Read", {"path": "b.md"})
    ok = registry.execute_tool(
        "Edit",
        {"path": "b.md", "old_string": 'say "foo" now', "new_string": 'say "bar" now'},
    )
    assert ok.is_error is False, ok.error_message
    assert (ws / "b.md").read_text(encoding="utf-8") == "say \u201cbar\u201d now\n"


def test_edit_file_curly_quote_match_still_requires_uniqueness(
    registry: ToolRegistry, ws: Path
) -> None:
    (ws / "c.txt").write_text("a = 'x'\na = 'x'\n", encoding="utf-8")
    registry.execute_tool("Read", {"path": "c.txt"})
    dup = registry.execute_tool(
        "Edit",
        {"path": "c.txt", "old_string": "a = \u2018x\u2019", "new_string": "a = 'y'"},
    )
    assert dup.is_error is True
    assert "unique" in str(dup.error_message or "").casefold()


def test_edit_file_genuinely_missing_text_still_fails(
    registry: ToolRegistry, ws: Path
) -> None:
    (ws / "d.txt").write_text("nothing here\n", encoding="utf-8")
    registry.execute_tool("Read", {"path": "d.txt"})
    miss = registry.execute_tool(
        "Edit",
        {"path": "d.txt", "old_string": "\u201cnope\u201d", "new_string": "x"},
    )
    assert miss.is_error is True
    assert "not found" in str(miss.error_message or "").casefold()




def test_run_command_grep_no_match_is_annotated_not_an_error(registry: ToolRegistry, ws: Path) -> None:
    (ws / "a.txt").write_text("hello\n", encoding="utf-8")
    result = registry.execute_tool(
        "Bash",
        {"command": "Grep missing a.txt", "cwd": "."},
    )
    value = str(result.value or "")
    assert "exit=1" in value
    assert "no matches" in value.casefold() or "not an execution error" in value.casefold()


def test_run_command_plain_failure_keeps_no_semantics_note(registry: ToolRegistry) -> None:
    result = registry.execute_tool(
        "Bash",
        {"command": 'python -c "import sys; sys.exit(1)"', "cwd": "."},
    )
    assert result.is_error
    value = str(result.error_message or "")
    assert "exit=1" in value
    assert "no matches" not in value.casefold()
