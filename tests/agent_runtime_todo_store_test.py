"""Task list that survives context compaction.

The failure this prevents: a long job compacts its history, the summary model
paraphrases away "90 of 137 done", and the agent redoes or skips work. Progress
must not live in a summary — it lives here and is re-injected verbatim.
"""

from __future__ import annotations

from app.agent_runtime.todo_store import MAX_TODO_ITEMS, TodoStore


def test_written_items_read_back():
    store = TodoStore()
    store.write([
        {"content": "读取 137 条记录", "status": "completed"},
        {"content": "处理第 91-137 条", "status": "in_progress"},
    ])
    assert [item["status"] for item in store.read()] == ["completed", "in_progress"]


def test_injection_carries_unfinished_work_only():
    store = TodoStore()
    store.write([
        {"content": "已经导出前 90 条", "status": "completed"},
        {"content": "继续处理第 91 条起", "status": "in_progress"},
        {"content": "最后核对总数", "status": "pending"},
    ])
    block = store.format_for_injection()
    # Re-injecting finished work makes the model redo it.
    assert "已经导出前 90 条" not in block
    assert "继续处理第 91 条起" in block
    assert "最后核对总数" in block


def test_no_injection_when_nothing_is_outstanding():
    store = TodoStore()
    assert store.format_for_injection() is None
    store.write([{"content": "干完了", "status": "completed"}])
    assert store.format_for_injection() is None


def test_writing_replaces_the_previous_plan():
    store = TodoStore()
    store.write([{"content": "旧计划", "status": "pending"}])
    store.write([{"content": "新计划", "status": "pending"}])
    assert [item["content"] for item in store.read()] == ["新计划"]


def test_unknown_status_falls_back_to_pending():
    store = TodoStore()
    store.write([{"content": "状态写错了", "status": "banana"}])
    assert store.read()[0]["status"] == "pending"


def test_oversized_plan_is_bounded():
    store = TodoStore()
    store.write([
        {"content": f"步骤 {index}", "status": "pending"}
        for index in range(MAX_TODO_ITEMS + 50)
    ])
    assert len(store.read()) == MAX_TODO_ITEMS

    store.write([{"content": "x" * 10_000, "status": "pending"}])
    assert len(store.read()[0]["content"]) < 10_000


def test_items_without_content_are_dropped():
    store = TodoStore()
    store.write([{"content": "  ", "status": "pending"}, {"status": "pending"}])
    assert store.read() == []
