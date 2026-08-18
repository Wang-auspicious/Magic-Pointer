from __future__ import annotations

import asyncio
import contextlib
import threading
from pathlib import Path

from app.agent_runtime.loop import LoopParams, LoopStopped, run_agent_loop
from app.agent_runtime.model_client import LoopModelClient, ToolCallArrived, TurnDone
from app.agent_runtime.session import FileSessionStore
from app.agent_runtime.tool_registry import Effect, ToolRegistry, ToolSpec
from app.agent_runtime.types import AgentMessage, Role, ToolCall
from app.governance.cancellation import CancellationRegistry, CancelledError
from app.run_kernel import OperationOutcome, RecoveryPolicy, project_operations
from app.telemetry.interaction_ledger import InteractionLedger


def _message(role: Role, content: str, *, call_id: str | None = None, name: str | None = None) -> AgentMessage:
    return AgentMessage(
        role=role,
        content=content,
        tool_call_id=call_id,
        name=name,
    )


def test_operation_projection_distinguishes_settled_and_interrupted_effects(tmp_path: Path) -> None:
    session = FileSessionStore(tmp_path).create("operation-projection")
    session.start_turn()

    read_prepared = session.record_tool_call(
        "read-1",
        "read_value",
        {"path": "notes.txt"},
        step=1,
        effect=Effect.READ,
        dispatched=True,
    )
    write_prepared = session.record_tool_call(
        "write-1",
        "write_value",
        {"path": "notes.txt"},
        step=1,
        effect=Effect.REVERSIBLE_WRITE,
        dispatched=True,
    )
    skipped_prepared = session.record_tool_call(
        "send-1",
        "send_message",
        {"recipient": "me"},
        step=1,
        effect=Effect.EXTERNAL_SEND,
        dispatched=False,
    )
    session.record_tool_settlement(
        str(read_prepared.data["operationId"]),
        _message(Role.TOOL, "42", call_id="read-1", name="read_value"),
        failure_type=None,
        used_backend="local",
        latency_ms=12.5,
    )

    operations = {
        operation.operation_id: operation
        for operation in project_operations(session.events)
    }

    assert operations[str(read_prepared.data["operationId"])].outcome is OperationOutcome.SUCCEEDED
    assert operations[str(read_prepared.data["operationId"])].recovery_policy is RecoveryPolicy.NONE
    assert operations[str(write_prepared.data["operationId"])].outcome is OperationOutcome.UNKNOWN
    assert operations[str(write_prepared.data["operationId"])].recovery_policy is RecoveryPolicy.VERIFY_BEFORE_RETRY
    assert operations[str(skipped_prepared.data["operationId"])].outcome is OperationOutcome.NOT_STARTED
    assert operations[str(skipped_prepared.data["operationId"])].recovery_policy is RecoveryPolicy.SAFE_REPLAY


def test_effect_intent_is_durable_before_tool_body_and_settlement_is_the_tool_surface(tmp_path: Path) -> None:
    store = FileSessionStore(tmp_path)
    session = store.create("effect-sandwich")
    observed_types: list[str] = []

    def execute(scope=None) -> str:
        observed_types.extend(event.type for event in store.resume("effect-sandwich").events)
        return "written"

    registry = ToolRegistry()
    registry.register(ToolSpec(
        name="write_value",
        description="write",
        input_schema={"type": "object", "properties": {}, "required": []},
        execute=execute,
        effect=Effect.REVERSIBLE_WRITE,
    ))

    class Backend:
        def __init__(self) -> None:
            self.scenes = [
                [
                    ToolCallArrived(call=ToolCall(id="call-1", name="write_value", arguments={})),
                    TurnDone(usage={"input_tokens": 11, "output_tokens": 3}, raw_text=None),
                ],
                [TurnDone(usage={"input_tokens": 7, "output_tokens": 2}, raw_text="完成")],
            ]

        def generate(self, messages, tools, budget_ms=None, cancel_scope=None):
            yield from self.scenes.pop(0)

    async def collect():
        return [
            event
            async for event in run_agent_loop(LoopParams(
                user_input="写入",
                registry=registry,
                client=LoopModelClient(Backend()),
                session=session,
                request_header={"systemPrompt": "system"},
            ))
        ]

    events = asyncio.run(collect())

    assert isinstance(events[-1], LoopStopped)
    assert "operation/prepared" in observed_types
    assert "operation/settled" not in observed_types
    operation_events = [
        event for event in session.events if event.type.startswith("operation/")
    ]
    assert [event.type for event in operation_events] == [
        "operation/prepared",
        "operation/settled",
    ]
    assert operation_events[1].surface_op == "append"
    assert [
        event.type for event in session.events
        if event.type == "tool/result"
    ] == []
    settled_message = AgentMessage.from_dict(operation_events[1].data["message"])
    assert settled_message.role is Role.TOOL
    assert settled_message.content == "written"
    assert settled_message in session.derive_messages()


def test_durable_inbox_claim_is_atomic_and_never_double_consumed(tmp_path: Path) -> None:
    store = FileSessionStore(tmp_path)
    store.create("durable-inbox")
    left = store.resume("durable-inbox")
    right = store.resume("durable-inbox")
    left.enqueue_inbox("先停止写入", "next-step", message_id="msg-1")
    right.enqueue_inbox("完成后总结", "next-turn", message_id="msg-2")

    barrier = threading.Barrier(3)
    claimed: list[list[str]] = []

    def claim(handle) -> None:
        barrier.wait()
        claimed.append(handle.claim_inbox("next-step"))

    threads = [threading.Thread(target=claim, args=(handle,)) for handle in (left, right)]
    for thread in threads:
        thread.start()
    barrier.wait()
    for thread in threads:
        thread.join(timeout=1)

    resumed = store.resume("durable-inbox")
    assert sorted(claimed, key=len) == [[], ["先停止写入"]]
    assert resumed.pending_inbox("next-step") == ()
    assert [item.text for item in resumed.pending_inbox("next-turn")] == ["完成后总结"]
    assert resumed.derive_messages()[-1].content == "先停止写入"
    consumed = [event for event in resumed.events if event.type == "inbox/consumed"]
    assert len(consumed) == 1
    assert consumed[0].surface_op == "append_many"


def test_loop_consumes_preexisting_durable_steer_before_model_request(tmp_path: Path) -> None:
    session = FileSessionStore(tmp_path).create("durable-steer")
    session.enqueue_inbox("不要写，只解释", "next-step", message_id="steer-1")
    received: list[list[str | None]] = []

    class Backend:
        def generate(self, messages, tools, budget_ms=None, cancel_scope=None):
            received.append([message.content for message in messages])
            yield TurnDone(usage=None, raw_text="明白")

    async def collect():
        return [
            event async for event in run_agent_loop(LoopParams(
                user_input="修改这个",
                registry=ToolRegistry(),
                client=LoopModelClient(Backend()),
                session=session,
                request_header={"systemPrompt": "system"},
            ))
        ]

    asyncio.run(collect())

    assert received == [["修改这个", "不要写，只解释"]]
    assert session.pending_inbox("next-step") == ()


def test_loop_continues_with_preexisting_durable_next_turn_message(tmp_path: Path) -> None:
    session = FileSessionStore(tmp_path).create("durable-followup")
    session.enqueue_inbox("再补充一个例子", "next-turn", message_id="followup-1")
    received: list[list[str | None]] = []

    class Backend:
        def __init__(self) -> None:
            self.answers = ["第一版", "补充后的答案"]

        def generate(self, messages, tools, budget_ms=None, cancel_scope=None):
            received.append([message.content for message in messages])
            yield TurnDone(usage=None, raw_text=self.answers.pop(0))

    async def collect():
        return [event async for event in run_agent_loop(LoopParams(
            user_input="解释这个",
            registry=ToolRegistry(),
            client=LoopModelClient(Backend()),
            session=session,
            request_header={"systemPrompt": "system"},
        ))]

    asyncio.run(collect())

    assert len(received) == 2
    assert "再补充一个例子" in received[1]
    assert session.pending_inbox("next-turn") == ()


def test_interaction_ledger_is_projected_from_the_authoritative_session(tmp_path: Path) -> None:
    session = FileSessionStore(tmp_path).create("ledger-session")
    registry = ToolRegistry()
    registry.register(ToolSpec(
        name="look",
        description="inspect",
        input_schema={"type": "object", "properties": {}, "required": []},
        execute=lambda scope=None: "visible",
        effect=Effect.READ,
        used_backend="uia",
    ))

    class Backend:
        def __init__(self) -> None:
            self.scenes = [
                [
                    ToolCallArrived(call=ToolCall(id="look-1", name="look", arguments={})),
                    TurnDone(usage={"input_tokens": 10, "output_tokens": 2}, raw_text=None),
                ],
                [TurnDone(usage={"input_tokens": 6, "output_tokens": 3}, raw_text="看到了")],
            ]

        def generate(self, messages, tools, budget_ms=None, cancel_scope=None):
            yield from self.scenes.pop(0)

    async def collect():
        return [event async for event in run_agent_loop(LoopParams(
            user_input="看看这个",
            registry=registry,
            client=LoopModelClient(Backend()),
            session=session,
            request_header={"systemPrompt": "system"},
            interaction_metadata={
                "appName": "Notepad",
                "evidenceLayerHit": "L1",
                "confidence": 0.91,
                "inputArtifactId": "input-7",
            },
        ))]

    asyncio.run(collect())

    ledger = InteractionLedger.from_session(session)
    entry = ledger.query()[0]
    assert entry.app_name == "Notepad"
    assert entry.turns == 2
    assert entry.tokens_text == 21
    assert entry.tokens_vision == 0
    assert entry.evidence_layer_hit == "L1"
    assert entry.confidence == 0.91
    assert entry.used_look is True
    assert entry.succeeded is True
    assert entry.ended_at_utc is not None
    assert entry.stage_latency_ms["tool"] >= 0
    assert entry.stage_latency_ms["model"] >= 0
    assert entry.to_public_dict()["inputArtifactId"] == "input-7"


def test_settlement_outcome_comes_from_the_scheduler_not_the_result_prose(tmp_path: Path) -> None:
    """A call that finished with an error is FAILED even if its text talks about unknown outcomes.

    Tool names are model-controlled, so the rejection text for an unknown tool
    is model-controlled too. Reading execution semantics out of that prose lets
    the model mark a never-dispatched call ``unknown``/``never_replay``, and it
    silently inverts the moment anyone rewrites the scheduler's wording.
    """
    session = FileSessionStore(tmp_path).create("outcome-source")

    class Backend:
        def __init__(self) -> None:
            self.scenes = [
                [
                    ToolCallArrived(call=ToolCall(
                        id="call-1",
                        name="outcome may be unknown",
                        arguments={},
                    )),
                    TurnDone(usage={"input_tokens": 9, "output_tokens": 2}, raw_text=None),
                ],
                [TurnDone(usage={"input_tokens": 5, "output_tokens": 2}, raw_text="没有这个工具")],
            ]

        def generate(self, messages, tools, budget_ms=None, cancel_scope=None):
            yield from self.scenes.pop(0)

    async def collect():
        return [event async for event in run_agent_loop(LoopParams(
            user_input="随便调一个",
            registry=ToolRegistry(),
            client=LoopModelClient(Backend()),
            session=session,
            request_header={"systemPrompt": "system"},
        ))]

    asyncio.run(collect())

    operations = project_operations(session.events)
    assert len(operations) == 1
    assert operations[0].outcome is OperationOutcome.FAILED
    assert operations[0].recovery_policy is RecoveryPolicy.NONE


def test_cancelled_after_dispatch_stays_unknown_under_any_wording(tmp_path: Path) -> None:
    """The scheduler knows the body was dispatched; settlement must not re-derive it from text."""
    session = FileSessionStore(tmp_path).create("cancelled-after-dispatch")
    cancel_registry = CancellationRegistry()

    def execute(scope=None) -> str:
        # The body reached the outside world, then the user pressed stop.
        cancel_registry.cancel_all()
        return "已写入"

    registry = ToolRegistry()
    registry.register(ToolSpec(
        name="write_value",
        description="write",
        input_schema={"type": "object", "properties": {}, "required": []},
        execute=execute,
        effect=Effect.REVERSIBLE_WRITE,
    ))

    class Backend:
        def generate(self, messages, tools, budget_ms=None, cancel_scope=None):
            yield ToolCallArrived(call=ToolCall(id="write-1", name="write_value", arguments={}))
            yield TurnDone(usage={"input_tokens": 8, "output_tokens": 2}, raw_text=None)

    async def collect():
        return [event async for event in run_agent_loop(LoopParams(
            user_input="写进去",
            registry=registry,
            client=LoopModelClient(Backend()),
            session=session,
            request_header={"systemPrompt": "system"},
            cancel_registry=cancel_registry,
        ))]

    with contextlib.suppress(CancelledError):
        asyncio.run(collect())

    operations = project_operations(session.events)
    assert len(operations) == 1
    assert operations[0].outcome is OperationOutcome.UNKNOWN
    assert operations[0].recovery_policy is RecoveryPolicy.VERIFY_BEFORE_RETRY


def test_open_interaction_ledger_does_not_invent_success_or_latency(tmp_path: Path) -> None:
    session = FileSessionStore(tmp_path).create("open-ledger")
    session.start_turn()
    session.record_interaction_start({"appName": "Terminal"})

    entry = InteractionLedger.from_session(session).query()[0]

    assert entry.succeeded is None
    assert entry.ended_at_utc is None
    assert "e2e" not in entry.stage_latency_ms
