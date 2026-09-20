"""Renamed tool schemas must keep the durable interrupted-action barrier."""

from __future__ import annotations

import asyncio

import pytest

from app.agent_runtime.loop import LoopParams, run_agent_loop
from app.agent_runtime.model_client import LoopModelClient, ToolCallArrived, TurnDone
from app.agent_runtime.session import FileSessionStore
from app.agent_runtime.tool_registry import Effect, ToolRegistry, ToolSpec
from app.agent_runtime.types import AgentMessage, Role, ToolCall
from app.run_kernel import RecoveryPolicy, project_operations


class _Replay:
    def __init__(self, name, arguments):
        self.name = name
        self.arguments = arguments
        self.called = False

    def generate(self, messages, tools, budget_ms=None, cancel_scope=None):
        if not self.called:
            self.called = True
            yield ToolCallArrived(call=ToolCall(id="retry", name=self.name, arguments=self.arguments))
            yield TurnDone(usage=None, raw_text=None)
        else:
            yield TurnDone(usage=None, raw_text="请先核对上一轮操作是否已生效。")


@pytest.mark.parametrize("effect", [Effect.REVERSIBLE_WRITE, Effect.EXTERNAL_SEND])
@pytest.mark.parametrize("recorded,replayed", [("old_write", "Write"), ("Write", "old_write")])
def test_repaired_action_rejects_identical_replay_through_tool_alias(tmp_path, effect, recorded, replayed):
    store = FileSessionStore(tmp_path)
    session = store.create("alias-recovery")
    session.start_turn()
    arguments = {"text": "same accepted action"}
    session.append_message(AgentMessage(role=Role.USER, content="执行这次操作", tool_call_id=None, name=None))
    session.append_message(AgentMessage(role=Role.ASSISTANT, content="", tool_call_id=None, name=None, tool_calls=({
        "id": "interrupted",
        "name": recorded,
        "arguments": arguments,
    },)))
    session.record_tool_call("interrupted", recorded, arguments, step=1, effect=effect, dispatched=True)
    resumed = store.resume(session.id, repair=True)
    interrupted = project_operations(resumed.events)[-1]
    expected_policy = (
        RecoveryPolicy.VERIFY_BEFORE_RETRY
        if effect is Effect.REVERSIBLE_WRITE
        else RecoveryPolicy.NEVER_REPLAY
    )
    assert interrupted.recovery_policy is expected_policy

    executed = []
    registry = ToolRegistry()
    registry.register(ToolSpec(
        name="Write",
        description="Perform the accepted action",
        input_schema={"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]},
        execute=lambda **kwargs: executed.append(kwargs) or "written",
        effect=effect,
    ))
    registry.register_alias("old_write", "Write")
    params = LoopParams(
        user_input="继续",
        registry=registry,
        client=LoopModelClient(_Replay(replayed, arguments)),
        session=resumed,
        permission_mode="bypass",
        allowed_effects=(Effect.READ, effect),
    )

    async def collect():
        return [event async for event in run_agent_loop(params)]

    events = asyncio.run(collect())
    assert executed == []
    assert "RECOVERY_RETRY_BLOCKED" in events[-1].terminal.results[-1].value
    assert project_operations(resumed.events)[-1].dispatched is False
