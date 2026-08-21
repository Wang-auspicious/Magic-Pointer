"""Receipt is the stop proof: the model saying done is not enough.

Gate 2: a completed loop must issue a Receipt. Unverified writes are
unverified, not succeeded. JSON verification.matched from a write tool
counts as evidence so the 13 desktop tools can satisfy the gate.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

from app.agent_runtime.loop import LoopParams, LoopStopped, VerificationNudged, run_agent_loop
from app.agent_runtime.model_client import LoopModelClient, MessageDelta, ToolCallArrived, TurnDone
from app.agent_runtime.session import FileSessionStore
from app.agent_runtime.tool_registry import Effect, ToolRegistry, ToolSpec
from app.agent_runtime.types import ToolCall
from app.receipts.projection import project_receipts
from app.receipts.schema import ReceiptStatus


EMPTY = {"type": "object", "properties": {}, "required": []}


class _Scripted:
    def __init__(self, *rounds):
        self._rounds = list(rounds)
        self.received = []

    def generate(self, messages, tools, budget_ms=None, cancel_scope=None):
        self.received.append((messages, tools))
        for event in self._rounds.pop(0):
            yield event


def _params(tmp_path: Path, registry: ToolRegistry, backend, prompt="做完") -> LoopParams:
    session = FileSessionStore(tmp_path).create("receipt-run")
    return LoopParams(
        user_input=prompt,
        registry=registry,
        client=LoopModelClient(backend),
        session=session,
        request_header={"systemPrompt": "system"},
    )


def test_a_plain_answer_issues_a_succeeded_receipt_bound_to_the_draft(tmp_path: Path) -> None:
    registry = ToolRegistry()
    backend = _Scripted([TurnDone(usage=None, raw_text="这是终稿。")])
    params = _params(tmp_path, registry, backend)

    events = asyncio.run(_collect(params))
    assert isinstance(events[-1], LoopStopped)
    receipts = project_receipts(params.session.events)
    assert len(receipts) == 1
    receipt = receipts[0]
    assert receipt.status is ReceiptStatus.SUCCEEDED
    assert receipt.verification_method == "draft_generated"
    assert receipt.artifact_ids
    assert receipt.wrote is False


def test_unverified_write_completes_with_an_unverified_receipt(tmp_path: Path) -> None:
    registry = ToolRegistry()
    registry.register(ToolSpec(
        name="write_thing",
        description="w",
        input_schema=EMPTY,
        execute=lambda **kw: "written",
        effect=Effect.REVERSIBLE_WRITE,
    ))
    backend = _Scripted(
        [ToolCallArrived(call=ToolCall(id="c1", name="write_thing", arguments={})),
         TurnDone(usage=None, raw_text=None)],
        [MessageDelta(text="写完了。"), TurnDone(usage=None, raw_text=None)],
        [MessageDelta(text="已执行但未验证。"), TurnDone(usage=None, raw_text=None)],
    )
    params = _params(tmp_path, registry, backend, prompt="写进去")
    events = asyncio.run(_collect(params))
    assert any(isinstance(item, VerificationNudged) for item in events)
    receipts = project_receipts(params.session.events)
    assert receipts[-1].status is ReceiptStatus.UNVERIFIED
    assert receipts[-1].wrote is True
    assert receipts[-1].verified is False


def test_write_with_matched_verification_json_is_succeeded(tmp_path: Path) -> None:
    registry = ToolRegistry()
    registry.register(ToolSpec(
        name="set_value",
        description="native write",
        input_schema=EMPTY,
        execute=lambda **kw: json.dumps({
            "used_backend": "uia_value",
            "verification": {"matched": True, "status": "matched"},
        }),
        effect=Effect.REVERSIBLE_WRITE,
    ))
    backend = _Scripted(
        [ToolCallArrived(call=ToolCall(id="c1", name="set_value", arguments={})),
         TurnDone(usage=None, raw_text=None)],
        [MessageDelta(text="已写入。"), TurnDone(usage=None, raw_text=None)],
    )
    params = _params(tmp_path, registry, backend, prompt="填值")
    events = asyncio.run(_collect(params))
    assert not any(isinstance(item, VerificationNudged) for item in events)
    receipts = project_receipts(params.session.events)
    assert receipts[-1].status is ReceiptStatus.SUCCEEDED
    assert receipts[-1].verification_method == "write_verified"
    assert receipts[-1].wrote is True
    assert receipts[-1].verified is True


async def _collect(params: LoopParams):
    return [event async for event in run_agent_loop(params)]
