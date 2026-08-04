"""记忆层接到 fabric 上：空也是答案，不是失败。

「上午看的那篇论文叫什么」问不到东西时，正确的回答是"那段时间我这里没有记录"，
而不是报错——后者让用户以为功能坏了，前者告诉他真相。
"""

from __future__ import annotations

import pytest

from app.context_pack.screen_memory import ScreenMemory
from app.fabric.executors import FabricExecutors
from app.fabric.schema import OperationPlan, RiskLevel


@pytest.fixture(autouse=True)
def _isolated_store(tmp_path, monkeypatch):
    monkeypatch.setenv("MAGIC_POINTER_USER_DATA_DIR", str(tmp_path))
    yield


def _plan(command="上午看的", **parameters):
    return OperationPlan(
        id="plan-1",
        recipe_id="memory.recall",
        command=command,
        risk=RiskLevel.READ,
        provider="local.memory",
        object_ids=(),
        idempotency_key="abcdef0123456789",
        parameters=parameters,
    )


def test_recall_finds_what_was_read(tmp_path) -> None:
    ScreenMemory().record(app="Edge", window_title="Attention Is All You Need", excerpt="Transformer")
    receipt = FabricExecutors(root=tmp_path).execute(_plan(command="attention"))
    assert receipt.status == "succeeded"
    assert receipt.output["entries"][0]["windowTitle"].startswith("Attention")


def test_nothing_found_is_an_answer_not_a_failure(tmp_path) -> None:
    receipt = FabricExecutors(root=tmp_path).execute(_plan(command="从没看过的东西"))
    assert receipt.status == "succeeded"
    assert receipt.output["entries"] == []
    assert "没有找到" in receipt.output["coverage"]


def test_recall_is_read_only(tmp_path) -> None:
    ScreenMemory().record(window_title="某窗口", excerpt="内容")
    receipt = FabricExecutors(root=tmp_path).execute(_plan())
    assert receipt.verification["mode"] == "read_only"
    # 回想之后记录还在。
    assert len(ScreenMemory().recall()) == 1


def test_a_time_window_narrows_the_answer(tmp_path) -> None:
    # Relative to real now: the store keeps 24 hours, so fixed 1970 timestamps
    # are correctly pruned before any query sees them.
    import time

    now = time.time()
    ScreenMemory().record(window_title="上午的", now=now - (5 * 3600))
    ScreenMemory().record(window_title="刚才的", now=now - 60)
    receipt = FabricExecutors(root=tmp_path).execute(
        _plan(command="", since=now - (6 * 3600), until=now - (4 * 3600))
    )
    assert [item["windowTitle"] for item in receipt.output["entries"]] == ["上午的"]


def test_the_recipe_is_a_real_capability_now(tmp_path) -> None:
    from app.fabric.catalog import get_recipe

    recipe = get_recipe("memory.recall")
    assert recipe is not None
    assert not str(recipe.provider or "").startswith("unavailable:") if hasattr(recipe, "provider") else True
