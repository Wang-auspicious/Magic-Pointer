
from __future__ import annotations

import sys
import threading
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.agent_runtime.inbox import Inbox  # noqa: E402
from app.agent_runtime.loop import (  # noqa: E402
    FollowupContinued,
    LoopParams,
    LoopStopped,
    Steered,
    run_agent_loop,
)
from app.agent_runtime.model_client import MessageDelta, TurnDone  # noqa: E402
from app.agent_runtime.tool_registry import Effect, ToolRegistry, ToolSpec  # noqa: E402
from app.agent_runtime.types import ToolCall  # noqa: E402

import importlib.util as _ilu
_spec = _ilu.spec_from_file_location(
    "_loop_test_fakes", Path(__file__).resolve().parent / "agent_runtime_loop_test.py")
_mod = _ilu.module_from_spec(_spec)
_spec.loader.exec_module(_mod)
EMPTY_SCHEMA = _mod.EMPTY_SCHEMA
ScriptedBackend = _mod.ScriptedBackend
make_params = _mod.make_params




def test_inbox_fifo_per_target() -> None:
    inbox = Inbox()
    inbox.put("一", "next-step")
    inbox.put("二", "next-step")
    inbox.put("后续", "next-turn")
    assert inbox.drain("next-step") == ["一", "二"]
    assert inbox.drain("next-step") == []
    assert inbox.drain("next-turn") == ["后续"]


def test_inbox_rejects_empty_and_caps_overflow() -> None:
    inbox = Inbox(capacity=3)
    assert inbox.put("", "next-step") is False
    assert inbox.put("   ", "next-turn") is False
    for i in range(5):
        inbox.put(f"消息{i}", "next-step")
    drained = inbox.drain("next-step")
    assert drained == ["消息2", "消息3", "消息4"]


def test_structured_inbox_refuses_overflow_without_dropping_a_reference() -> None:
    inbox = Inbox(capacity=1)
    assert inbox.put("先做这个", "next-step") is True
    payload = {
        "inputId": "input-ref-only",
        "taskId": "task-1",
        "target": "next-step",
        "instruction": "",
        "referenceUpdates": [{"operation": "remove", "binding": {"referenceId": "ref-a"}}],
        "sourceIds": [],
        "timeline": [],
        "capturedAtMs": 1,
    }

    assert inbox.put("", "next-step", payload=payload) is False
    assert inbox.drain("next-step") == ["先做这个"]
    assert inbox.dropped == 0


def test_inbox_thread_safe_concurrent_put() -> None:
    inbox = Inbox(capacity=1000)

    def worker(n: int) -> None:
        for i in range(50):
            inbox.put(f"w{n}-{i}", "next-step")

    threads = [threading.Thread(target=worker, args=(n,)) for n in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(inbox.drain("next-step")) == 200




def answer_scene(text: str):
    return [MessageDelta(text=text), TurnDone(usage=None, raw_text=None)]


def test_steer_injected_into_next_model_round() -> None:
    inbox = Inbox()

    def execute(**kwargs):
        inbox.put("别用那个工具了，直接回答", "next-step")
        return "ok"

    registry = ToolRegistry()
    registry.register(ToolSpec(
        name="probe", description="p", input_schema=EMPTY_SCHEMA,
        execute=execute, effect=Effect.READ,
    ))

    from app.agent_runtime.model_client import LoopModelClient, ToolCallArrived

    backend = ScriptedBackend(
        [ToolCallArrived(call=ToolCall(id="c1", name="probe", arguments={})), TurnDone(usage=None, raw_text=None)],
        answer_scene("好的，直接回答。"),
    )
    client = LoopModelClient(backend)
    params = make_params("查一下", registry=registry, client=client, inbox=inbox)
    events = asyncio_run(params)

    steered = [e for e in events if isinstance(e, Steered)]
    assert len(steered) == 1
    assert "别用那个工具了" in steered[0].texts[0]
    second_round_text = " ".join(m.content or "" for m in backend.received[1][0])
    assert "别用那个工具了" in second_round_text
    terminal = events[-1].terminal
    assert terminal.reason.value == "completed"


def test_followup_continues_after_model_stops() -> None:
    inbox = Inbox()

    def execute(**kwargs):
        inbox.put("再把结果总结成一句话", "next-turn")
        return "ok"

    registry = ToolRegistry()
    registry.register(ToolSpec(
        name="probe", description="p", input_schema=EMPTY_SCHEMA,
        execute=execute, effect=Effect.READ,
    ))

    from app.agent_runtime.model_client import LoopModelClient, ToolCallArrived

    backend = ScriptedBackend(
        [ToolCallArrived(call=ToolCall(id="c1", name="probe", arguments={})), TurnDone(usage=None, raw_text=None)],
        answer_scene("第一步完成。"),
        answer_scene("总结：一切正常。"),
    )
    client = LoopModelClient(backend)
    params = make_params("做第一步", registry=registry, client=client, inbox=inbox)
    events = asyncio_run(params)

    followups = [e for e in events if isinstance(e, FollowupContinued)]
    assert len(followups) == 1
    assert "总结成一句话" in followups[0].texts[0]
    terminal = events[-1].terminal
    assert terminal.reason.value == "completed"
    assert terminal.message == "总结：一切正常。"
    third_round_text = " ".join(m.content or "" for m in backend.received[2][0])
    assert "总结成一句话" in third_round_text


def test_empty_inbox_changes_nothing() -> None:
    registry = ToolRegistry()
    from app.agent_runtime.model_client import LoopModelClient

    backend = ScriptedBackend(answer_scene("完成。"))
    params = make_params("你好", registry=registry, client=LoopModelClient(backend), inbox=Inbox())
    events = asyncio_run(params)
    assert not [e for e in events if isinstance(e, (Steered, FollowupContinued))]
    assert events[-1].terminal.reason.value == "completed"


def asyncio_run(params: LoopParams):
    import asyncio

    async def collect():
        out = []
        async for event in run_agent_loop(params):
            out.append(event)
        return out

    return asyncio.run(collect())
