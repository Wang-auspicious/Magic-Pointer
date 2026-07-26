from __future__ import annotations

from pathlib import Path

from scripts.install_agent_hooks import merged_settings


def test_claude_hook_merge_preserves_existing_and_is_idempotent(tmp_path: Path) -> None:
    existing = {"hooks": {"PreToolUse": [{"matcher": "Bash", "hooks": []}]}, "theme": "dark"}
    once = merged_settings("claude", existing, python=Path("C:/Python/python.exe"), data_root=tmp_path)
    twice = merged_settings("claude", once, python=Path("C:/Python/python.exe"), data_root=tmp_path)
    assert once["theme"] == "dark"
    assert once["hooks"]["PreToolUse"] == existing["hooks"]["PreToolUse"]
    assert len(twice["hooks"]["UserPromptSubmit"]) == 1
    command = twice["hooks"]["UserPromptSubmit"][0]["hooks"][0]
    assert command["args"][-2:] == ["--root", str(tmp_path.resolve())]


def test_gemini_hook_uses_before_agent_not_mcp(tmp_path: Path) -> None:
    value = merged_settings("gemini", {}, python=Path("C:/Python/python.exe"), data_root=tmp_path)
    assert set(value["hooks"]) == {"BeforeAgent"}
    command = value["hooks"]["BeforeAgent"][0]["hooks"][0]
    assert command["name"] == "magic-pointer-context"
    assert command["timeout"] == 5000
    assert "mcp" not in str(value).casefold()
