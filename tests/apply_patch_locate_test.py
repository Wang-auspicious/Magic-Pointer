"""apply_patch 失败信息带位置、命中不唯一时报出其它位置。

取自 MiniMax Code（Pi edit 工具）的一条经验：补丁能不能贴上去，取决于失败那
一轮模型拿到的反馈里有没有「现在文件里是哪一行」。MP 原来只回：
    Failed to find expected lines in notes.md:
    -gone line
模型得重新把整个文件读一遍才能改对。现在失败信息带最近似行号、成功信息带
「同一段在别处也匹配」的位置，一轮就能改对。
"""

from __future__ import annotations

from pathlib import Path

import pytest

from app.agent_runtime.apply_patch import ApplyPatchError, apply_patch_text
from app.agent_runtime.coding_tools import register_coding_tools
from app.agent_runtime.tool_registry import ToolRegistry


def _write(tmp_path: Path, name: str, body: str) -> Path:
    target = tmp_path / name
    target.write_text(body, encoding="utf-8", newline="\n")
    return target


def test_missing_context_reports_the_closest_line(tmp_path: Path) -> None:
    # "@@ beta" refers to text the file no longer has; the failure must point at
    # the line that is actually there now.
    _write(tmp_path, "notes.md", "alpha\nbetta\ngamma\ndelta\n")
    patch = (
        "*** Begin Patch\n"
        "*** Update File: notes.md\n"
        "@@ beta\n"
        "-betta\n"
        "+beta\n"
        "*** End Patch"
    )
    with pytest.raises(ApplyPatchError) as error:
        apply_patch_text(patch, tmp_path)
    message = str(error.value)
    assert "chunk 1/1" in message
    assert "Closest lines in the current file:" in message
    assert "line 2: betta" in message, message


def test_missing_chunk_lines_report_line_numbers(tmp_path: Path) -> None:
    _write(
        tmp_path,
        "code.py",
        "def one():\n    return 1\n\n\ndef two():\n    return 1\n",
    )
    patch = (
        "*** Begin Patch\n"
        "*** Update File: code.py\n"
        "-    return 1\n"
        "+    return 99\n"
        "*** End Patch"
    )
    # The same block appears twice: the edit still applies to the first (cursor
    # order is the Codex contract), and the summary has to say the other one
    # exists so the caller can confirm the region was the intended one.
    result = apply_patch_text(patch, tmp_path)
    assert "Success." in result
    assert "also matches at line(s) 6" in result, result
    assert "applied at line 2" in result, result


def test_unambiguous_chunk_stays_quiet(tmp_path: Path) -> None:
    _write(tmp_path, "only.py", "value = 1\n")
    patch = (
        "*** Begin Patch\n"
        "*** Update File: only.py\n"
        "-value = 1\n"
        "+value = 2\n"
        "*** End Patch"
    )
    result = apply_patch_text(patch, tmp_path)
    assert result.startswith("Success.")
    assert "Ambiguous placement" not in result
    assert (tmp_path / "only.py").read_text(encoding="utf-8") == "value = 2\n"


def test_tool_result_carries_the_ambiguity_note(tmp_path: Path) -> None:
    """The note has to reach the model through the tool result.

    ``apply_patch_text`` returning it is not enough: the coding tool used to
    ignore the return value and answer with its own "applied N patch block(s)",
    which swallowed the only signal that the edit might have landed in the
    wrong one of several identical regions.
    """
    (tmp_path / "dup.py").write_text(
        "def one():\n    return 1\n\n\ndef two():\n    return 1\n",
        encoding="utf-8",
    )
    registry = ToolRegistry()
    register_coding_tools(registry, workspace_root=str(tmp_path))
    result = registry.execute_tool(
        "apply_patch",
        {
            "patch": (
                "*** Begin Patch\n"
                "*** Update File: dup.py\n"
                "-    return 1\n"
                "+    return 99\n"
                "*** End Patch"
            )
        },
    )
    assert not result.is_error, result.value
    assert "also matches at line(s) 6" in str(result.value), result.value
    assert "applied 1 patch block(s)" in str(result.value), result.value


def test_unknown_text_names_the_chunk_and_offers_noise_free_hint(tmp_path: Path) -> None:
    _write(tmp_path, "doc.md", "# Title\n\nbody\n")
    patch = (
        "*** Begin Patch\n"
        "*** Update File: doc.md\n"
        "-zzzz completely absent\n"
        "+zzzz replaced\n"
        "*** End Patch"
    )
    with pytest.raises(ApplyPatchError) as error:
        apply_patch_text(patch, tmp_path)
    message = str(error.value)
    assert "chunk 1/1" in message
    assert "No similar lines in the current file" in message, message
