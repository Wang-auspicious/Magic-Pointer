"""记忆层：「我上午看的那篇论文叫什么」。

真正被问的从来不是"把我看过的都列出来"，而是**某一件半记得的事 + 一个大概的时间**。
所以只存能回答这个问题的最小信息：时间、哪个应用、哪个窗口、读到的一小段。

**刻意不存截图。** 屏幕滚动录制是另一个产品、另一场知情同意，而且回答"那篇论文叫什么"
根本用不着它——标题和几个字就够了。

按失败严重程度排的三条：关就是关（不写，而不是写了再过滤）、敏感应用绝不进入、
有界且可一键清空。
"""

from __future__ import annotations

import json

import pytest

from app.context_pack.screen_memory import MAX_ENTRIES, ScreenMemory


@pytest.fixture()
def memory(tmp_path):
    return ScreenMemory(tmp_path / "screen-memory.json")


def test_what_was_on_screen_can_be_found_again(memory) -> None:
    memory.record(app="Edge", window_title="Attention Is All You Need - arXiv", excerpt="Transformer 架构", now=1000.0)
    [entry] = memory.recall("attention", now=1001.0)
    assert entry.window_title.startswith("Attention Is All You Need")
    assert entry.app == "Edge"


def test_recall_matches_the_excerpt_too_not_just_the_title(memory) -> None:
    memory.record(window_title="某个窗口", excerpt="生命周期评估 LCA 方法", now=1000.0)
    assert len(memory.recall("lca", now=1001.0)) == 1


def test_recall_can_be_narrowed_to_this_morning(memory) -> None:
    """「我上午看的」——时间是这个问题的一半。"""
    memory.record(window_title="上午看的", now=1000.0)
    memory.record(window_title="下午看的", now=5000.0)
    found = memory.recall(since=900.0, until=2000.0, now=5001.0)
    assert [entry.window_title for entry in found] == ["上午看的"]


def test_off_means_nothing_is_written(tmp_path) -> None:
    """关掉之后不能是"写了但读的时候过滤掉"。"""
    path = tmp_path / "screen-memory.json"
    disabled = ScreenMemory(path, enabled=False)
    assert disabled.record(window_title="不该被记住", excerpt="内容") is None
    assert not path.exists()


def test_a_sensitive_window_never_enters_the_log(memory) -> None:
    assert memory.record(window_title="1Password", excerpt="主密码", sensitive=True) is None
    assert memory.recall() == []


def test_nothing_worth_remembering_is_not_remembered(memory) -> None:
    assert memory.record() is None
    assert memory.record(window_title="   ", excerpt="  ") is None
    assert memory.recall() == []


def test_rereading_the_same_thing_updates_when_rather_than_piling_up(memory) -> None:
    memory.record(window_title="同一篇", excerpt="同一段", now=1000.0)
    memory.record(window_title="同一篇", excerpt="同一段", now=1500.0)
    entries = memory.recall(now=1501.0)
    assert len(entries) == 1
    assert entries[0].at == 1500.0


def test_yesterday_falls_out_of_a_24h_memory(memory) -> None:
    memory.record(window_title="昨天的", now=1000.0)
    memory.record(window_title="刚才的", now=1000.0 + (25 * 3600))
    assert [entry.window_title for entry in memory.recall(now=1000.0 + (25 * 3600))] == ["刚才的"]


def test_the_log_is_bounded_by_count(memory) -> None:
    for index in range(MAX_ENTRIES + 50):
        memory.record(window_title=f"窗口{index}", now=1000.0 + index)
    assert len(memory.recall(limit=10000, now=1000.0 + MAX_ENTRIES + 50)) == MAX_ENTRIES


def test_a_long_excerpt_is_trimmed(memory) -> None:
    memory.record(window_title="长文", excerpt="字" * 5000, now=1000.0)
    [entry] = memory.recall(now=1001.0)
    assert len(entry.excerpt) <= 400


def test_it_can_be_emptied_and_says_how_much(memory) -> None:
    memory.record(window_title="A", now=1000.0)
    memory.record(window_title="B", now=1001.0)
    assert memory.clear() == 2
    assert memory.recall(now=1002.0) == []


def test_a_corrupt_store_does_not_take_the_feature_down(tmp_path) -> None:
    path = tmp_path / "screen-memory.json"
    path.write_text("{not json", encoding="utf-8")
    memory = ScreenMemory(path)
    assert memory.recall() == []
    memory.record(window_title="之后的还要能记", now=1000.0)
    assert len(memory.recall(now=1001.0)) == 1


def test_no_screenshots_are_stored(tmp_path) -> None:
    """存截图是另一个产品、另一场知情同意。"""
    memory = ScreenMemory(tmp_path / "screen-memory.json")
    memory.record(window_title="某窗口", excerpt="某内容", now=1000.0)
    stored = json.loads((tmp_path / "screen-memory.json").read_text(encoding="utf-8"))
    text = json.dumps(stored)
    for forbidden in ("capture_path", "screenshot", ".png", "image"):
        assert forbidden not in text, f"记忆层里出现了 {forbidden}"
