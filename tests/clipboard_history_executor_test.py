"""剪贴板历史接到 fabric 上：查是只读的，恢复才是写。

回看历史绝不能顺手改掉你此刻剪贴板里的东西——那是"查一下"变成"覆盖了"，
是这类功能最容易出的事故。所以只有明确指名某一条时才写回。
"""

from __future__ import annotations

import pytest

from app.actions.clipboard_history import ClipboardHistory
from app.fabric.executors import FabricExecutors
from app.fabric.schema import OperationPlan, RiskLevel


@pytest.fixture(autouse=True)
def _isolated_store(tmp_path, monkeypatch):
    monkeypatch.setenv("MAGIC_POINTER_USER_DATA_DIR", str(tmp_path))
    yield


def _plan(provider="clipboard.history", recipe="clipboard.history", **parameters):
    return OperationPlan(
        id="plan-1",
        recipe_id=recipe,
        command=str(parameters.pop("command", "刚才复制的")),
        risk=RiskLevel.READ,
        provider=provider,
        object_ids=("obj-1",),
        idempotency_key="abcdef0123456789",
        parameters=parameters,
    )


def test_history_lists_what_was_copied(tmp_path) -> None:
    ClipboardHistory().record("第一段", now=1000.0)
    ClipboardHistory().record("第二段", now=1001.0)
    receipt = FabricExecutors(root=tmp_path).execute(_plan(command=""))
    assert receipt.status == "succeeded"
    assert [item["excerpt"] for item in receipt.output["entries"]] == ["第二段", "第一段"]


def test_an_empty_history_says_so_rather_than_failing(tmp_path) -> None:
    receipt = FabricExecutors(root=tmp_path).execute(_plan(command=""))
    assert receipt.status == "succeeded"
    assert receipt.output["entries"] == []
    assert "还没有记录" in receipt.output["coverage"]


def test_looking_at_history_never_touches_the_clipboard(tmp_path) -> None:
    """查一下不能变成覆盖了。"""
    ClipboardHistory().record("历史内容", now=1000.0)
    writes = []
    executors = FabricExecutors(root=tmp_path, clipboard_writer=writes.append)
    executors.execute(_plan(command=""))
    assert writes == []


def test_naming_an_entry_restores_it(tmp_path) -> None:
    entry = ClipboardHistory().record("要恢复的内容", now=1000.0)
    writes = []
    executors = FabricExecutors(
        root=tmp_path,
        clipboard_writer=writes.append,
        clipboard_reader=lambda: writes[-1] if writes else "",
    )
    receipt = executors.execute(_plan(digest=entry.digest))
    assert receipt.status == "succeeded"
    assert receipt.verified is True
    assert writes == ["要恢复的内容"]
    assert receipt.output["restored"] is True


def test_restoring_an_expired_entry_fails_honestly(tmp_path) -> None:
    receipt = FabricExecutors(root=tmp_path, clipboard_writer=lambda _v: None).execute(_plan(digest="gone"))
    assert receipt.status == "failed"
    assert receipt.error == "clipboard_entry_expired"


def test_search_narrows_the_list(tmp_path) -> None:
    ClipboardHistory().record("Magic Pointer 文档", now=1000.0)
    ClipboardHistory().record("无关内容", now=1001.0)
    receipt = FabricExecutors(root=tmp_path).execute(_plan(query="magic"))
    assert [item["excerpt"] for item in receipt.output["entries"]] == ["Magic Pointer 文档"]


def test_a_successful_copy_is_recorded_once_it_is_known_to_have_landed(tmp_path) -> None:
    writes = []
    executors = FabricExecutors(
        root=tmp_path,
        clipboard_writer=writes.append,
        clipboard_reader=lambda: writes[-1] if writes else "",
    )
    plan = _plan(
        provider="clipboard",
        recipe="text.ocr_copy",
        objects=[{"id": "obj-1", "content": "被复制的文字"}],
    )
    assert executors.execute(plan).status == "succeeded"
    assert [entry.text for entry in ClipboardHistory().recent()] == ["被复制的文字"]


def test_a_copy_that_failed_readback_is_not_remembered(tmp_path) -> None:
    """没真的落到剪贴板的东西，不该出现在"我复制过什么"里。"""
    executors = FabricExecutors(
        root=tmp_path,
        clipboard_writer=lambda _v: None,
        clipboard_reader=lambda: "别的东西",
    )
    plan = _plan(
        provider="clipboard",
        recipe="text.ocr_copy",
        objects=[{"id": "obj-1", "content": "没落地的文字"}],
    )
    assert executors.execute(plan).status == "verification_failed"
    assert ClipboardHistory().recent() == []
