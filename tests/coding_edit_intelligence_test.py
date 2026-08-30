"""B2 Edit/Read 智能：readFileState 门、读去重、模糊匹配阶梯、批量 edits。

对照 CC FileReadTool/FileEditTool 与 Hermes fuzzy_match：
- 未读先写门 + 读后修改检测（CC errorCode 6/7）
- 读去重 stub（CC file_unchanged，18% Read 是同文件碰撞）+ force 逃生
- 连读熔断（Hermes 3 警 4 断的 MP 变体）
- 弯引号归一化已有；新增 line-trimmed / whitespace-normalized /
  indentation-flexible 阶梯（Hermes 策略 2/3/4）
- preserveQuoteStyle（CC：new_string 引号跟随文件花引号风格）
- BOM 剥离还原（Pi）
- 批量 edits[]（Pi：全部对原文件匹配、重叠拒绝、倒序应用）
- 空 new_string 删行（CC applyEditToFile）
- 相似文件建议（CC findSimilarFile）
- 二进制/设备文件诚实拒绝（CC validateInput / Hermes blocked devices）
"""

from __future__ import annotations

from pathlib import Path

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


def _read(registry: ToolRegistry, path: str, **kw):
    return registry.execute_tool("read_file", {"path": path, **kw})


def _edit(registry: ToolRegistry, path: str, old: str, new: str, **kw):
    return registry.execute_tool(
        "edit_file", {"path": path, "old_string": old, "new_string": new, **kw}
    )


def _write(registry: ToolRegistry, path: str, content: str):
    return registry.execute_tool("write_file", {"path": path, "content": content})


# --- 未读先写门 ---------------------------------------------------------------


def test_edit_file_requires_read_first(registry: ToolRegistry, ws: Path) -> None:
    (ws / "a.py").write_text("x = 1\n", encoding="utf-8")
    result = _edit(registry, "a.py", "x = 1", "x = 2")
    assert result.is_error is True
    message = str(result.error_message or "")
    assert "read" in message.casefold()
    assert (ws / "a.py").read_text(encoding="utf-8") == "x = 1\n", "被拒后文件不得变化"


def test_edit_allowed_after_read(registry: ToolRegistry, ws: Path) -> None:
    (ws / "a.py").write_text("x = 1\n", encoding="utf-8")
    _read(registry, "a.py")
    ok = _edit(registry, "a.py", "x = 1", "x = 2")
    assert ok.is_error is False, ok.error_message
    assert (ws / "a.py").read_text(encoding="utf-8") == "x = 2\n"


def test_edit_rejected_when_modified_since_read(registry: ToolRegistry, ws: Path) -> None:
    (ws / "a.py").write_text("x = 1\n", encoding="utf-8")
    _read(registry, "a.py")
    (ws / "a.py").write_text("x = 999\n", encoding="utf-8")  # 外部修改
    result = _edit(registry, "a.py", "x = 1", "x = 2")
    assert result.is_error is True
    assert "modified since read" in str(result.error_message or "")


def test_edit_accepts_when_mtime_churned_but_content_identical(
    registry: ToolRegistry, ws: Path
) -> None:
    """云同步/杀软会拨 mtime：内容逐字节相同就放行（CC content fallback）。"""
    import os

    (ws / "a.py").write_text("x = 1\n", encoding="utf-8")
    _read(registry, "a.py")
    st = ws / "a.py"
    os.utime(st, ns=(st.stat().st_atime_ns, st.stat().st_mtime_ns + 5_000_000))
    ok = _edit(registry, "a.py", "x = 1", "x = 2")
    assert ok.is_error is False, ok.error_message


def test_edit_after_offset_read_is_allowed_with_note(
    registry: ToolRegistry, ws: Path
) -> None:
    """CC 语义：分页读（offset/limit）不阻止编辑，帽截断才硬拒。"""
    content = "\n".join(f"line {i}" for i in range(1, 51)) + "\n"
    (ws / "big.txt").write_text(content, encoding="utf-8")
    _read(registry, "big.txt", offset=10, limit=5)
    result = _edit(registry, "big.txt", "line 30", "line 30 edited")
    assert result.is_error is False, result.error_message


def test_edit_rejected_after_truncated_read(registry: ToolRegistry, ws: Path) -> None:
    """帽截断的读（模型没看全）硬拒编辑，要求重读目标区域（CC isPartialView）。"""
    (ws / "huge.txt").write_text("x" * 60_000 + "\n" + "tail = 1\n", encoding="utf-8")
    _read(registry, "huge.txt")
    result = _edit(registry, "huge.txt", "tail = 1", "tail = 2")
    assert result.is_error is True
    assert "truncated" in str(result.error_message or "").casefold()


def test_write_file_requires_read_for_existing_file(registry: ToolRegistry, ws: Path) -> None:
    (ws / "a.txt").write_text("old\n", encoding="utf-8")
    result = _write(registry, "a.txt", "new\n")
    assert result.is_error is True
    assert "read" in str(result.error_message or "").casefold()
    # 新文件不受门限制
    ok = _write(registry, "brand-new.txt", "new\n")
    assert ok.is_error is False


def test_edit_updates_read_state_no_reread_needed(registry: ToolRegistry, ws: Path) -> None:
    (ws / "a.py").write_text("x = 1\n", encoding="utf-8")
    _read(registry, "a.py")
    _edit(registry, "a.py", "x = 1", "x = 2")
    ok = _edit(registry, "a.py", "x = 2", "x = 3")
    assert ok.is_error is False, "edit 自身更新读状态，第二次编辑不需要重读"


def test_restore_files_invalidates_read_state(registry: ToolRegistry, ws: Path) -> None:
    (ws / "a.py").write_text("x = 1\n", encoding="utf-8")
    _read(registry, "a.py")
    _edit(registry, "a.py", "x = 1", "x = 2")
    registry.execute_tool("restore_files", {"steps": 1})
    result = _edit(registry, "a.py", "x = 2", "x = 3")
    assert result.is_error is True, "回滚后必须重读（内容已被 harness 改回）"


# --- 读去重 + 连读熔断 ---------------------------------------------------------


def test_read_dedup_returns_stub_same_range(registry: ToolRegistry, ws: Path) -> None:
    (ws / "a.txt").write_text("hello\n", encoding="utf-8")
    first = _read(registry, "a.txt")
    assert first.is_error is False
    second = _read(registry, "a.txt")
    value = str(second.value or "")
    assert "unchanged" in value.casefold(), "同区间重读且未变化应返回 stub"
    assert "hello" not in value, "stub 不携带文件内容(省 token 是去重的目的)"


def test_read_dedup_bypassed_by_force(registry: ToolRegistry, ws: Path) -> None:
    (ws / "a.txt").write_text("hello\n", encoding="utf-8")
    _read(registry, "a.txt")
    forced = registry.execute_tool(
        "read_file", {"path": "a.txt", "force": True}
    )
    assert "hello" in str(forced.value or ""), "force=true 必须返回真实内容"


def test_read_dedup_cleared_when_file_changes(registry: ToolRegistry, ws: Path) -> None:
    (ws / "a.txt").write_text("hello\n", encoding="utf-8")
    _read(registry, "a.txt")
    _write(registry, "a.txt", "changed\n")
    again = _read(registry, "a.txt")
    assert "changed" in str(again.value or ""), "文件变了必须真读"


def test_consecutive_read_loop_breaker(registry: ToolRegistry, ws: Path) -> None:
    """同一区间连读：3 次警告、5 次硬阻断（force 可逃生）。"""
    (ws / "a.txt").write_text("hello\n", encoding="utf-8")
    _read(registry, "a.txt")
    _read(registry, "a.txt")
    third = _read(registry, "a.txt")
    assert "already read" in str(third.value or "").casefold(), "第 3 次要警告"
    for _ in range(2):
        _read(registry, "a.txt")
    blocked = _read(registry, "a.txt")
    assert blocked.is_error is True, "第 6 次硬阻断"
    assert "STOP" in str(blocked.error_message or "").upper()
    escaped = registry.execute_tool("read_file", {"path": "a.txt", "force": True})
    assert escaped.is_error is False, "force 是逃生门"


def test_other_tool_resets_read_streak(registry: ToolRegistry, ws: Path) -> None:
    (ws / "a.txt").write_text("hello\n", encoding="utf-8")
    (ws / "b.txt").write_text("world\n", encoding="utf-8")
    for _ in range(2):
        _read(registry, "a.txt")
    _read(registry, "b.txt")  # 换了工具调用目标
    again = _read(registry, "a.txt")
    assert again.is_error is False
    assert "already read" not in str(again.value or "").casefold()


# --- 二进制 / 设备 / 相似文件 ----------------------------------------------------


def test_read_binary_file_is_honest_error(registry: ToolRegistry, ws: Path) -> None:
    (ws / "blob.bin").write_bytes(b"abc\x00def" * 100)
    result = _read(registry, "blob.bin")
    assert result.is_error is True
    message = str(result.error_message or "")
    assert "binary" in message.casefold()


def test_read_office_document_suggests_extraction(registry: ToolRegistry, ws: Path) -> None:
    (ws / "doc.docx").write_bytes(b"PK\x03\x04" + b"\x00" * 64)
    result = _read(registry, "doc.docx")
    assert result.is_error is True
    assert "python" in str(result.error_message or "").casefold()


def test_read_windows_device_name_is_blocked(registry: ToolRegistry) -> None:
    result = _read(registry, "CON")
    assert result.is_error is True
    assert "device" in str(result.error_message or "").casefold()


def test_read_missing_file_suggests_similar(registry: ToolRegistry, ws: Path) -> None:
    (ws / "handler.py").write_text("x = 1\n", encoding="utf-8")
    result = _read(registry, "hadler.py")
    assert result.is_error is True
    assert "handler.py" in str(result.error_message or ""), "拼错文件名要给 Did you mean"


# --- 模糊匹配阶梯 --------------------------------------------------------------


def test_edit_line_trimmed_strategy_matches_trailing_whitespace(
    registry: ToolRegistry, ws: Path
) -> None:
    (ws / "a.py").write_text("def f():\n    return 1   \n", encoding="utf-8")
    _read(registry, "a.py")
    # 模型发的 old_string 没有行尾空格；文件里有
    ok = _edit(registry, "a.py", "return 1", "return 2")
    assert ok.is_error is False, ok.error_message
    assert (ws / "a.py").read_text(encoding="utf-8") == "def f():\n    return 2   \n"


def test_edit_whitespace_normalized_strategy(registry: ToolRegistry, ws: Path) -> None:
    (ws / "a.py").write_text("x = 1\n", encoding="utf-8")
    _read(registry, "a.py")
    ok = _edit(registry, "a.py", "x  =  1", "x = 2")
    assert ok.is_error is False, ok.error_message
    assert (ws / "a.py").read_text(encoding="utf-8") == "x = 2\n"


def test_edit_indent_flexible_strategy(registry: ToolRegistry, ws: Path) -> None:
    (ws / "a.py").write_text("if a:\n        return 1\n", encoding="utf-8")
    _read(registry, "a.py")
    ok = _edit(registry, "a.py", "if a:\n    return 1", "if a:\n    return 2")
    assert ok.is_error is False, ok.error_message
    body = (ws / "a.py").read_text(encoding="utf-8")
    assert "return 2" in body


def test_fuzzy_match_reports_strategy_and_uniqueness_still_applies(
    registry: ToolRegistry, ws: Path
) -> None:
    (ws / "a.txt").write_text("alpha  1\nalpha  1\n", encoding="utf-8")
    _read(registry, "a.txt")
    dup = _edit(registry, "a.txt", "alpha 1", "alpha 2")
    assert dup.is_error is True
    assert "matches" in str(dup.error_message or "")


def test_quote_style_preserved_into_new_string(registry: ToolRegistry, ws: Path) -> None:
    """文件用弯引号、模型发直引号：替换文本的引号跟随文件风格（CC preserveQuoteStyle）。"""
    (ws / "story.md").write_text("他说：“你好”\n", encoding="utf-8")
    _read(registry, "story.md")
    ok = _edit(registry, "story.md", '他说："你好"', "他说：\"再见\"")
    assert ok.is_error is False, ok.error_message
    body = (ws / "story.md").read_text(encoding="utf-8")
    assert "“再见”" in body, f"new_string 引号应转成文件的花引号风格: {body!r}"
    assert '"再见"' not in body


def test_bom_is_preserved_through_edit(registry: ToolRegistry, ws: Path) -> None:
    (ws / "bom.txt").write_bytes(b"\xef\xbb\xbfname = 1\n")
    _read(registry, "bom.txt")
    ok = _edit(registry, "bom.txt", "name = 1", "name = 2")
    assert ok.is_error is False, ok.error_message
    raw = (ws / "bom.txt").read_bytes()
    assert raw.startswith(b"\xef\xbb\xbf"), "BOM 必须原样保留"
    assert raw.endswith(b"name = 2\n")


def test_empty_new_string_deletes_whole_line(registry: ToolRegistry, ws: Path) -> None:
    (ws / "a.txt").write_text("keep\nremove me\nkeep2\n", encoding="utf-8")
    _read(registry, "a.txt")
    ok = _edit(registry, "a.txt", "remove me", "")
    assert ok.is_error is False, ok.error_message
    assert (ws / "a.txt").read_text(encoding="utf-8") == "keep\nkeep2\n"


# --- 批量 edits ----------------------------------------------------------------


def test_edit_batch_edits_single_call(registry: ToolRegistry, ws: Path) -> None:
    (ws / "a.py").write_text("a = 1\nb = 2\nc = 3\n", encoding="utf-8")
    _read(registry, "a.py")
    ok = registry.execute_tool("edit_file", {
        "path": "a.py",
        "edits": [
            {"old_string": "a = 1", "new_string": "a = 10"},
            {"old_string": "c = 3", "new_string": "c = 30"},
        ],
    })
    assert ok.is_error is False, ok.error_message
    assert (ws / "a.py").read_text(encoding="utf-8") == "a = 10\nb = 2\nc = 30\n"


def test_edit_batch_all_matched_against_original(registry: ToolRegistry, ws: Path) -> None:
    """两个 edit 针对同一原文的不同位置（第二个的 old 在第一个的 new 里也出现，
    仍按原文匹配）。"""
    (ws / "a.txt").write_text("x\ny\n", encoding="utf-8")
    _read(registry, "a.txt")
    ok = registry.execute_tool("edit_file", {
        "path": "a.txt",
        "edits": [
            {"old_string": "x", "new_string": "x"},
            {"old_string": "y", "new_string": "z"},
        ],
    })
    assert ok.is_error is False, "no-op edit + 正常 edit 应按原文匹配成功"
    assert (ws / "a.txt").read_text(encoding="utf-8") == "x\nz\n"


def test_edit_batch_rejects_overlaps(registry: ToolRegistry, ws: Path) -> None:
    (ws / "a.txt").write_text("abcdef\n", encoding="utf-8")
    _read(registry, "a.txt")
    result = registry.execute_tool("edit_file", {
        "path": "a.txt",
        "edits": [
            {"old_string": "abcd", "new_string": "x"},
            {"old_string": "cdef", "new_string": "y"},
        ],
    })
    assert result.is_error is True
    assert "overlap" in str(result.error_message or "").casefold()
    assert (ws / "a.txt").read_text(encoding="utf-8") == "abcdef\n", "拒绝时零写入"


def test_edit_batch_reports_failing_index(registry: ToolRegistry, ws: Path) -> None:
    (ws / "a.txt").write_text("a\nb\n", encoding="utf-8")
    _read(registry, "a.txt")
    result = registry.execute_tool("edit_file", {
        "path": "a.txt",
        "edits": [
            {"old_string": "a", "new_string": "A"},
            {"old_string": "nope", "new_string": "B"},
        ],
    })
    assert result.is_error is True
    assert "edits[1]" in str(result.error_message or "")
