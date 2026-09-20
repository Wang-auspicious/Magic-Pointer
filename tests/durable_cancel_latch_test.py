"""A consumed durable Stop request remains active for its entire running loop."""

from __future__ import annotations

import asyncio

import pytest

from app.agent_runtime.loop import LoopParams, run_agent_loop
from app.agent_runtime.model_client import LoopModelClient, ToolCallArrived, TurnDone
from app.agent_runtime.session import FileSessionStore, cancel_interrupt_check
from app.agent_runtime.tool_registry import Effect, ToolRegistry, ToolSpec
from app.agent_runtime.types import ToolCall, TransitionReason
from app.receipts.projection import project_receipts
from app.receipts.schema import ReceiptStatus


class _CancelAfterModel:
    def __init__(self, session, call_count):
        self.session = session
        self.call_count = call_count
        self.requests = 0

    def generate(self, messages, tools, budget_ms=None, cancel_scope=None):
        self.requests += 1
        if self.requests == 1:
            for value in range(self.call_count):
                yield ToolCallArrived(call=ToolCall(id=f"call-{value}", name="Action", arguments={"value": value}))
            self.session.request_cancel(reason="user pressed Stop")
            yield TurnDone(usage=None, raw_text=None)
        else:
            yield TurnDone(usage=None, raw_text="没有遵守停止请求。")


async def _collect(params):
    return [event async for event in run_agent_loop(params)]


@pytest.mark.parametrize("parallel", [False, True])
@pytest.mark.parametrize("call_count", [2, 8])
def test_consumed_stop_blocks_siblings_and_next_model_request(tmp_path, parallel, call_count):
    session = FileSessionStore(tmp_path).create("durable-cancel")
    executed = []
    registry = ToolRegistry()
    registry.register(ToolSpec(
        name="Action",
        description="Read or write one value",
        input_schema={"type": "object", "properties": {"value": {"type": "integer"}}, "required": ["value"]},
        execute=lambda value, **kwargs: executed.append(value) or "done",
        effect=Effect.READ if parallel else Effect.REVERSIBLE_WRITE,
        is_concurrency_safe=parallel,
    ))
    backend = _CancelAfterModel(session, call_count)
    params = LoopParams(
        user_input="处理两个值",
        registry=registry,
        client=LoopModelClient(backend),
        session=session,
        interrupt_check=cancel_interrupt_check(session),
    )
    events = asyncio.run(_collect(params))

    assert executed == []
    assert backend.requests == 1
    assert events[-1].terminal.reason is TransitionReason.USER_INTERRUPT
    assert project_receipts(session.events)[-1].status is ReceiptStatus.INTERRUPTED
    assert sum(event.type == "cancel/consumed" for event in session.events) == 1
    assert session.open_turn is None

    # Consumption stays durable; the latch belongs only to this completed run.
    events = asyncio.run(_collect(params))
    assert events[-1].terminal.reason is TransitionReason.COMPLETED
    assert backend.requests == 2
