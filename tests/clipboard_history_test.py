"""剪贴板历史：你复制过的东西，回头找得回来。

三条决定形态的规矩，都不是随手定的：

1. **不该留的绝不留。** 剪贴板是密码待三十秒的地方。标记为敏感的条目直接丢弃，
   而不是截断后保存——半个密码仍然是密码。
2. **按内容去重，不按时间。** 同一段复制五次是一条上浮，不是五条；否则列表会被
   你正在用的东西塞满，把真正丢掉的那条挤下去。
3. **有界并自我清理。** 条数和天数双重上限，写入时检查。一个会无限增长的本地
   记录，是没人记得自己同意过的负担。
"""

from __future__ import annotations

import json

import pytest

from app.actions.clipboard_history import (
    MAX_ENTRIES,
    MAX_TEXT_CHARS,
    ClipboardHistory,
)


@pytest.fixture()
def history(tmp_path):
    return ClipboardHistory(tmp_path / "clipboard-history.json")


def test_what_was_copied_comes_back(history) -> None:
    history.record("一段被复制的文字", app="Word", formats=["CF_UNICODETEXT"])
    [entry] = history.recent()
    assert entry.text == "一段被复制的文字"
    assert entry.app == "Word"
    assert entry.formats == ("CF_UNICODETEXT",)


def test_the_newest_entry_is_first(history) -> None:
    history.record("先复制的", now=1000.0)
    history.record("后复制的", now=1001.0)
    assert [entry.text for entry in history.recent()] == ["后复制的", "先复制的"]


def test_copying_the_same_thing_again_moves_it_up_rather_than_duplicating(history) -> None:
    history.record("A", now=1000.0)
    history.record("B", now=1001.0)
    history.record("A", now=1002.0)
    assert [entry.text for entry in history.recent()] == ["A", "B"]


def test_a_secret_is_dropped_not_truncated(history) -> None:
    """半个密码仍然是密码。"""
    assert history.record("hunter2-correct-horse", secret=True) is None
    assert history.recent() == []


def test_blank_copies_are_ignored(history) -> None:
    assert history.record("") is None
    assert history.record("   \n\t ") is None
    assert history.recent() == []


def test_a_huge_copy_is_truncated_and_says_so(history) -> None:
    history.record("字" * (MAX_TEXT_CHARS + 500))
    [entry] = history.recent()
    assert len(entry.text) == MAX_TEXT_CHARS
    assert entry.truncated is True


def test_the_list_is_bounded_by_count(history) -> None:
    for index in range(MAX_ENTRIES + 30):
        history.record(f"第{index}条", now=1000.0 + index)
    assert len(history.recent(limit=1000)) == MAX_ENTRIES


def test_entries_older_than_the_retention_window_fall_off(history) -> None:
    history.record("很久以前", now=1000.0)
    history.record("刚刚", now=1000.0 + (8 * 86400))
    assert [entry.text for entry in history.recent()] == ["刚刚"]


def test_search_finds_by_substring_case_folded(history) -> None:
    history.record("Magic Pointer 的设计文档", now=1000.0)
    history.record("另一段无关内容", now=1001.0)
    assert [entry.text for entry in history.search("magic")] == ["Magic Pointer 的设计文档"]
    assert history.search("不存在的东西") == []


def test_an_empty_query_returns_the_recent_list(history) -> None:
    history.record("A", now=1000.0)
    assert len(history.search("  ")) == 1


def test_an_entry_can_be_fetched_by_digest_to_restore_it(history) -> None:
    entry = history.record("要恢复的内容")
    assert history.get(entry.digest).text == "要恢复的内容"
    assert history.get("nope") is None


def test_clearing_reports_how_much_it_removed(history) -> None:
    history.record("A", now=1000.0)
    history.record("B", now=1001.0)
    assert history.clear() == 2
    assert history.recent() == []


def test_a_corrupt_store_does_not_take_copying_down(tmp_path) -> None:
    path = tmp_path / "clipboard-history.json"
    path.write_text("{not json", encoding="utf-8")
    history = ClipboardHistory(path)
    assert history.recent() == []
    history.record("之后复制的还是要能存下")
    assert [entry.text for entry in history.recent()] == ["之后复制的还是要能存下"]


def test_the_store_stays_readable_json(tmp_path) -> None:
    history = ClipboardHistory(tmp_path / "clipboard-history.json")
    history.record("内容", now=1000.0)
    stored = json.loads((tmp_path / "clipboard-history.json").read_text(encoding="utf-8"))
    assert stored["version"] == 1
    assert stored["entries"][0]["text"] == "内容"
