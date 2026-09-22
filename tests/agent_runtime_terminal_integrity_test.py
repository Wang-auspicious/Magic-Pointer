
from __future__ import annotations

import asyncio

import pytest

from app.agent_runtime.loop import LoopParams, ModelChunk, run_agent_loop
from app.agent_runtime.model_client import LoopModelClient, MessageDelta, TurnDone
from app.agent_runtime.session import FileSessionStore, cancel_interrupt_check
from app.agent_runtime.tool_registry import ToolRegistry
from app.agent_runtime.types import Role, TransitionReason
from app.fabric.loop_answer import terminal_to_answer
from app.receipts.projection import project_receipts
from app.receipts.schema import ReceiptStatus


async def _collect(params):
    return [event async for event in run_agent_loop(params)]


class _StopDuringAnswer:
    def __init__(self, session, stop_at):
        self.session = session
        self.stop_at = stop_at
        self.requests = 0
        self.closed = False
        self.continued_after_stop = False

    def generate(self, messages, tools, budget_ms=None, cancel_scope=None):
        self.requests += 1
        try:
            yield MessageDelta("已有部分回答")
            self.session.request_cancel(reason="user pressed Stop")
            if self.stop_at == "text":
                yield MessageDelta("不该继续显示的回答")
                self.continued_after_stop = True
            if self.stop_at != "eof":
                yield TurnDone(usage=None, raw_text="不该落盘的最终答案")
        finally:
            self.closed = True


@pytest.mark.parametrize("stop_at", ["text", "done", "eof"])
def test_durable_stop_during_final_answer_prevents_completion(tmp_path, stop_at):
    session = FileSessionStore(tmp_path).create(f"answer-stop-{stop_at}")
    backend = _StopDuringAnswer(session, stop_at)
    events = asyncio.run(_collect(LoopParams(
        user_input="解释这个概念",
        registry=ToolRegistry(),
        client=LoopModelClient(backend),
        session=session,
        interrupt_check=cancel_interrupt_check(session),
    )))

    terminal = events[-1].terminal
    assert terminal.reason is TransitionReason.USER_INTERRUPT
    assert backend.requests == 1
    assert backend.closed is True
    assert backend.continued_after_stop is False
    assert [event.text for event in events if isinstance(event, ModelChunk)] == ["已有部分回答"]
    assert not any(message.role is Role.ASSISTANT for message in session.derive_messages())
    assert not any(event.type == "artifact/generated" for event in session.events)
    assert sum(event.type == "cancel/consumed" for event in session.events) == 1
    assert project_receipts(session.events)[-1].status is ReceiptStatus.INTERRUPTED
    assert session.open_turn is None


class _EmptyAnswers:
    def __init__(self, text, recover=False):
        self.text = text
        self.recover = recover
        self.requests = 0

    def generate(self, messages, tools, budget_ms=None, cancel_scope=None):
        self.requests += 1
        text = "恢复后给出答案" if self.recover and self.requests == 2 else self.text
        if text:
            yield MessageDelta(text)
        yield TurnDone(usage=None, raw_text=text)


@pytest.mark.parametrize("text", [None, "", " \n\t"])
def test_exhausted_empty_answers_fail_with_a_receipt(tmp_path, text):
    session = FileSessionStore(tmp_path).create("empty-answer")
    backend = _EmptyAnswers(text)
    events = asyncio.run(_collect(LoopParams(
        user_input="解释这个概念",
        registry=ToolRegistry(),
        client=LoopModelClient(backend),
        session=session,
    )))

    terminal = events[-1].terminal
    assert backend.requests == 4
    assert terminal.reason is TransitionReason.PROVIDER_UNAVAILABLE
    assert terminal.message == "backend_error:empty_response"
    answer = terminal_to_answer(terminal, "解释这个概念")
    assert answer["ok"] is False
    assert answer["loopTerminatedReason"] == "provider_unavailable"
    assert not any(event.type == "artifact/generated" for event in session.events)
    assert project_receipts(session.events)[-1].status is ReceiptStatus.FAILED
    assert session.open_turn is None


def test_empty_answer_can_still_recover_on_the_next_request(tmp_path):
    session = FileSessionStore(tmp_path).create("recovered-answer")
    backend = _EmptyAnswers(None, recover=True)
    events = asyncio.run(_collect(LoopParams(
        user_input="解释这个概念",
        registry=ToolRegistry(),
        client=LoopModelClient(backend),
        session=session,
    )))

    assert backend.requests == 2
    assert events[-1].terminal.reason is TransitionReason.COMPLETED
    assert events[-1].terminal.message == "恢复后给出答案"
    assert project_receipts(session.events)[-1].status is ReceiptStatus.SUCCEEDED
