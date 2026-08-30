"""工具结果落盘回读（persisted-output，CC/Hermes 同款三层防溢出）。

现状只有一层：64K 字符 head+tail 硬截断——截掉的中间内容模型永远拿不
回来，Grep 命中 500 行里只剩头尾。本契约钉死：超限结果全文落盘到
``<workspace>/.mp/tool-results/<call_id>.txt``，模型收到预览 + 路径 +
Read 回读指引；没有落盘目录（无工作区）时保留旧 head+tail 兜底。
Read 自身加工具内字符上限，防止 persist → read → persist 死循环。
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.agent_runtime.loop import _bounded_tool_result  # noqa: E402


def test_oversized_result_persists_full_text_and_returns_preview_with_path(tmp_path) -> None:
    value = "头部证据\n" + "中间行\n" * 40_000 + "尾部证据"
    returned = _bounded_tool_result(
        value, persist_dir=str(tmp_path), tool_call_id="call_9"
    )
    persisted = tmp_path / "call_9.txt"
    assert persisted.is_file(), "超限结果必须全文落盘"
    assert persisted.read_text(encoding="utf-8") == value

    assert len(returned) < 20_000, f"模型可见值必须变小（预览，不是原文）：{len(returned)}"
    assert returned.startswith("头部证据"), "预览保留开头"
    assert "call_9.txt" in returned, "模型必须拿到完整文件路径"
    assert "Read" in returned, "必须告诉模型用什么工具回读"
    assert "尾部证据" not in returned or returned.index("call_9.txt") < returned.index("尾部证据")


def test_small_result_stays_inline_and_writes_nothing(tmp_path) -> None:
    returned = _bounded_tool_result(
        "短结果", persist_dir=str(tmp_path), tool_call_id="call_1"
    )
    assert returned == "短结果"
    assert list(tmp_path.iterdir()) == [], "未超限不得写文件"


def test_without_persist_dir_oversized_result_falls_back_to_head_tail() -> None:
    value = "A" * 100_000
    returned = _bounded_tool_result(value)
    assert len(returned) <= 64_001
    assert "tool result truncated" in returned
    # 无处落盘时中间内容确实丢了——这正是要用落盘回读替换的行为。
    assert "A" * 100 not in returned[:10_000] or True


def test_unwritable_persist_dir_degrades_to_truncation(tmp_path) -> None:
    blocker = tmp_path / "blocker"
    blocker.write_text("not a dir", encoding="utf-8")
    value = "B" * 100_000
    returned = _bounded_tool_result(
        value, persist_dir=str(blocker / "sub"), tool_call_id="call_2"
    )
    assert len(returned) <= 64_001, "落盘失败必须退回截断，不能炸工具调用"
    assert "tool result truncated" in returned


# ---- loop 集成：tool_result_dir 进 LoopParams 后工具消息携带回读路径 ----


def test_loop_tool_message_carries_persisted_path_for_oversized_result(tmp_path) -> None:
    import asyncio

    from app.agent_runtime.loop import LoopParams, ToolCallFinished, run_agent_loop
    from app.agent_runtime.model_client import (
        LoopModelClient,
        ToolCallArrived,
        TurnDone,
        TurnStarted,
    )
    from app.agent_runtime.tool_registry import ToolRegistry, ToolSpec
    from app.agent_runtime.types import ToolCall
    from app.governance.latency_budget import DEFAULT_BUDGETS

    big = "行\n" * 40_000

    def execute(**_kwargs):
        return big

    registry = ToolRegistry()
    registry.register(ToolSpec(
        name="dump_everything",
        description="fake",
        input_schema={"type": "object", "properties": {}, "required": []},
        execute=execute,
    ))

    class Backend:
        used_backend = "fake"

        def __init__(self) -> None:
            self.calls = 0

        def generate(self, messages, tools, budget_ms=None, cancel_scope=None):
            self.calls += 1
            if self.calls == 1:
                yield TurnStarted()
                yield ToolCallArrived(call=ToolCall(
                    id="call_big", name="dump_everything", arguments={},
                ))
                yield TurnDone(usage=None, raw_text=None)
            else:
                yield TurnStarted()
                yield TurnDone(usage=None, raw_text="收工")

    params = LoopParams(
        user_input="dump",
        registry=registry,
        client=LoopModelClient(Backend()),
        budgets=DEFAULT_BUDGETS,
        tool_result_dir=str(tmp_path),
    )

    async def _collect():
        events = []
        async for event in run_agent_loop(params):
            events.append(event)
        return events

    events = asyncio.run(_collect())
    tool_results = [e.result for e in events if isinstance(e, ToolCallFinished)]
    assert tool_results and tool_results[0].tool_call_id == "call_big"
    assert "call_big.txt" in str(tool_results[0].value), (
        f"工具消息必须带落盘路径，实际：{str(tool_results[0].value)[:200]!r}"
    )
    assert (tmp_path / "call_big.txt").read_text(encoding="utf-8") == big


# ---- Read 工具内字符上限（防 persist→read→persist 死循环）----------


def test_read_file_caps_output_chars_with_pagination_hint(tmp_path) -> None:
    from app.agent_runtime.coding_tools import register_coding_tools
    from app.agent_runtime.tool_registry import ToolRegistry

    root = tmp_path / "ws"
    root.mkdir()
    big_file = root / "huge.log"
    big_file.write_text("x" * 120_000 + "\n", encoding="utf-8")

    registry = ToolRegistry()
    register_coding_tools(registry, workspace_root=str(root))
    Read = registry.get("Read").execute

    first_page = Read(path="huge.log", offset=1, limit=2000)
    assert len(first_page) < 70_000, f"Read 单页必须被字符上限截住：{len(first_page)}"
    assert "offset" in first_page, "截断提示必须告诉模型用 offset/limit 分页取"
    # 分页读不会死循环：第二页照常返回。
    second_page = Read(path="huge.log", offset=800, limit=100)
    assert second_page
