"""Event-sourced agent session contract, adapted from DSH (MIT).

These are behavioral invariants, not coverage padding: every model-visible
message must come from the durable surface and raw history must survive
compaction, resume, repair, and fork.
"""

from __future__ import annotations

import json
import threading
from pathlib import Path

import pytest

from app.agent_runtime.session import (
    FileSessionStore,
    ModelSurfaceMismatch,
    SessionCorruptionError,
    SessionForkError,
)
from app.agent_runtime.types import (
    AgentMessage,
    ORIGIN_DATA,
    ORIGIN_INSTRUCTION,
    Role,
)
from app.run_kernel import OperationOutcome, project_operations


def _message(
    role: Role,
    content: str,
    *,
    call_id: str | None = None,
    name: str | None = None,
    tool_calls: tuple[dict, ...] = (),
) -> AgentMessage:
    return AgentMessage(
        role=role,
        content=content,
        tool_call_id=call_id,
        name=name,
        origin=ORIGIN_INSTRUCTION if role is Role.USER else ORIGIN_DATA,
        tool_calls=tool_calls,
    )


def test_model_messages_are_derived_from_the_append_only_surface(tmp_path: Path) -> None:
    store = FileSessionStore(tmp_path)
    session = store.create("s1")
    user = _message(Role.USER, "分析这个")
    assistant = _message(Role.ASSISTANT, "完成")

    session.start_turn()
    session.append_message(user)
    session.append_message(assistant)

    assert session.derive_messages() == [user, assistant]
    first_snapshot = session.derive_messages()
    first_snapshot.clear()
    assert session.derive_messages() == [user, assistant]
    assert [event.seq for event in session.events] == list(range(len(session.events)))


def test_derived_messages_detach_nested_tool_call_arguments(tmp_path: Path) -> None:
    store = FileSessionStore(tmp_path)
    session = store.create("nested-snapshot")
    session.append_message(_message(
        Role.ASSISTANT,
        "",
        tool_calls=({
            "id": "call-1",
            "name": "write_file",
            "arguments": {"path": "safe.txt", "options": {"mode": "create"}},
        },),
    ))

    leaked = session.derive_messages()
    leaked[0].tool_calls[0]["arguments"]["path"] = "wrong.txt"
    leaked[0].tool_calls[0]["arguments"]["options"]["mode"] = "overwrite"

    durable = session.derive_messages()[0].tool_calls[0]["arguments"]
    assert durable == {"path": "safe.txt", "options": {"mode": "create"}}
    assert store.resume("nested-snapshot").derive_messages()[0].tool_calls[0][
        "arguments"
    ] == durable


def test_public_event_snapshots_cannot_mutate_session_history(tmp_path: Path) -> None:
    session = FileSessionStore(tmp_path).create("event-snapshot")

    exposed = session.events
    exposed[0].data["sessionId"] = "forged"

    assert session.events[0].data["sessionId"] == "event-snapshot"
    assert session.header.session_id == "event-snapshot"


def test_non_finite_model_usage_is_ignored_before_durable_json(tmp_path: Path) -> None:
    session = FileSessionStore(tmp_path).create("non-finite-usage")
    turn = session.start_turn()

    event = session.record_model_response(
        step=1,
        outcome="completed",
        usage={"input_tokens": float("nan"), "output_tokens": float("inf")},
        output_text_chars=2,
        tool_call_count=0,
    )

    assert event.data["usage"] == {}
    session.end_turn(turn, reason="completed")


def test_independent_session_handles_cannot_fork_the_hash_chain(tmp_path: Path) -> None:
    store = FileSessionStore(tmp_path)
    store.create("shared")
    left = store.resume("shared")
    right = store.resume("shared")
    barrier = threading.Barrier(3)
    errors: list[BaseException] = []

    def append_many(session, label: str) -> None:
        try:
            barrier.wait()
            for index in range(20):
                session.append("audit/test", {"writer": label, "index": index})
        except BaseException as exc:  # surfaced on the main test thread below
            errors.append(exc)

    threads = [
        threading.Thread(target=append_many, args=(left, "left")),
        threading.Thread(target=append_many, args=(right, "right")),
    ]
    for thread in threads:
        thread.start()
    barrier.wait()
    for thread in threads:
        thread.join(timeout=1)

    assert not errors
    resumed = store.resume("shared")
    assert len(resumed.events) == 41
    assert [event.seq for event in resumed.events] == list(range(41))


def test_only_one_independent_handle_can_open_the_next_turn(tmp_path: Path) -> None:
    store = FileSessionStore(tmp_path)
    store.create("one-turn")
    sessions = [store.resume("one-turn"), store.resume("one-turn")]
    barrier = threading.Barrier(3)
    outcomes: list[str] = []

    def start(session) -> None:
        barrier.wait()
        try:
            session.start_turn()
        except RuntimeError:
            outcomes.append("busy")
        else:
            outcomes.append("started")

    threads = [threading.Thread(target=start, args=(session,)) for session in sessions]
    for thread in threads:
        thread.start()
    barrier.wait()
    for thread in threads:
        thread.join(timeout=1)

    assert sorted(outcomes) == ["busy", "started"]
    resumed = store.resume("one-turn")
    assert resumed.open_turn == 1


def test_repair_waits_for_a_live_turn_lease_instead_of_corrupting_it(tmp_path: Path) -> None:
    store = FileSessionStore(tmp_path)
    active = store.create("live-turn")
    turn = active.start_turn(hold_lease=True)
    active.append_message(_message(Role.USER, "still running"))
    repair_started = threading.Event()
    repair_finished = threading.Event()
    repaired: list[int] = []

    def attempt_repair() -> None:
        repair_started.set()
        repaired.append(store.resume("live-turn", repair=True).open_turn or 0)
        repair_finished.set()

    thread = threading.Thread(target=attempt_repair)
    thread.start()
    assert repair_started.wait(0.5)
    assert not repair_finished.wait(0.05)

    active.end_turn(turn, reason="completed")
    thread.join(timeout=0.5)

    assert repair_finished.is_set()
    assert repaired == [0]
    assert store.resume("live-turn").events[-1].data["reason"] == "completed"


def test_open_or_create_recovers_when_another_process_wins_creation(tmp_path: Path) -> None:
    store = FileSessionStore(tmp_path)
    real_resume = store.resume
    first_resume = True

    def raced_resume(session_id: str, *, repair: bool = False):
        nonlocal first_resume
        if first_resume:
            first_resume = False
            raise FileNotFoundError(session_id)
        return real_resume(session_id, repair=repair)

    def raced_create(session_id: str):
        FileSessionStore(tmp_path).create(session_id)
        raise FileExistsError(session_id)

    store.resume = raced_resume  # type: ignore[method-assign]
    store.create = raced_create  # type: ignore[method-assign]

    opened = store.open_or_create("creation-race", repair=True)

    assert opened.id == "creation-race"
    assert len(opened.events) == 1


def test_request_rejects_any_message_that_was_not_logged(tmp_path: Path) -> None:
    session = FileSessionStore(tmp_path).create("s1")
    logged = _message(Role.USER, "真实输入")
    session.start_turn()
    session.append_message(logged)

    with pytest.raises(ModelSurfaceMismatch):
        session.record_model_request(
            [logged, _message(Role.ASSISTANT, "内存里偷偷加的")],
            tools=[{"name": "look", "parameters": {"type": "object"}}],
            header={"systemPrompt": "system", "usedBackend": "fake"},
            step=1,
        )

    event = session.record_model_request(
        session.derive_messages(),
        tools=[{"name": "look", "parameters": {"type": "object"}}],
        header={"systemPrompt": "system", "usedBackend": "fake"},
        step=1,
    )
    assert event.type == "model/request"
    assert event.data["messageCount"] == 1
    assert event.data["tools"][0]["name"] == "look"
    assert event.data["header"]["systemPrompt"] == "system"


def test_compaction_replaces_surface_without_deleting_raw_history(tmp_path: Path) -> None:
    session = FileSessionStore(tmp_path).create("s1")
    session.start_turn()
    original = [_message(Role.USER, f"m-{index}") for index in range(4)]
    for message in original:
        session.append_message(message)
    before = tuple(session.events)
    compacted = [_message(Role.USER, "此前四条消息摘要")]

    session.replace_messages(compacted, reason="context_compaction")

    assert session.derive_messages() == compacted
    assert tuple(session.events[: len(before)]) == before
    assert session.events[-1].type == "surface/replace"
    assert len(session.events[-1].data["messages"]) == 1


def test_jsonl_reload_repairs_only_a_truncated_last_record(tmp_path: Path) -> None:
    store = FileSessionStore(tmp_path)
    session = store.create("s1")
    session.start_turn()
    session.append_message(_message(Role.USER, "保留"))
    clean_count = len(session.events)
    with session.path.open("ab") as handle:
        handle.write(b'{"seq":999,"type":"partial')

    resumed = store.resume("s1")

    assert len(resumed.events) == clean_count
    assert resumed.derive_messages()[0].content == "保留"
    assert resumed.repaired_tail_bytes > 0
    assert session.path.read_bytes().endswith(b"\n")


def test_reload_rejects_hash_tampering_or_invalid_middle_record(tmp_path: Path) -> None:
    store = FileSessionStore(tmp_path)
    session = store.create("tampered")
    session.start_turn()
    session.append_message(_message(Role.USER, "original"))
    rows = session.path.read_text(encoding="utf-8").splitlines()
    payload = json.loads(rows[1])
    payload["data"]["turn"] = 99
    rows[1] = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    session.path.write_text("\n".join(rows) + "\n", encoding="utf-8")

    with pytest.raises(SessionCorruptionError, match="hash"):
        store.resume("tampered")

    broken = store.create("broken")
    broken.start_turn()
    broken.append_message(_message(Role.USER, "x"))
    broken_rows = broken.path.read_text(encoding="utf-8").splitlines()
    broken_rows.insert(1, "not-json")
    broken.path.write_text("\n".join(broken_rows) + "\n", encoding="utf-8")
    with pytest.raises(SessionCorruptionError, match="line 2"):
        store.resume("broken")


def test_resume_repairs_interrupted_tool_calls_by_side_effect_uncertainty(tmp_path: Path) -> None:
    store = FileSessionStore(tmp_path)

    before_start = store.create("before-start")
    before_start.start_turn()
    before_start.append_message(_message(Role.USER, "读"))
    before_start.append_message(
        _message(
            Role.ASSISTANT,
            "",
            tool_calls=({"id": "c1", "name": "look", "arguments": {}},),
        )
    )
    repaired_before = store.resume("before-start", repair=True)
    assert repaired_before.derive_messages()[-1].tool_call_id == "c1"
    assert "TOOL_NOT_STARTED" in (repaired_before.derive_messages()[-1].content or "")

    after_start = store.create("after-start")
    after_start.start_turn()
    after_start.append_message(_message(Role.USER, "写"))
    after_start.append_message(
        _message(
            Role.ASSISTANT,
            "",
            tool_calls=({"id": "c2", "name": "write", "arguments": {}},),
        )
    )
    after_start.record_tool_call("c2", "write", {}, step=1)
    repaired_after = store.resume("after-start", repair=True)
    assert repaired_after.derive_messages()[-1].tool_call_id == "c2"
    assert "TOOL_OUTCOME_UNKNOWN" in (repaired_after.derive_messages()[-1].content or "")
    assert repaired_after.open_turn is None

    # A prepared-but-never-dispatched call is recorded as not_started. The text
    # the model reads has to say the same thing, or it will refuse to retry a
    # call the durable record says is safe to replay.
    never_dispatched = store.create("never-dispatched")
    never_dispatched.start_turn()
    never_dispatched.append_message(_message(Role.USER, "发"))
    never_dispatched.append_message(
        _message(
            Role.ASSISTANT,
            "",
            tool_calls=({"id": "c3", "name": "send", "arguments": {}},),
        )
    )
    never_dispatched.record_tool_call("c3", "send", {}, step=1, dispatched=False)
    repaired_skipped = store.resume("never-dispatched", repair=True)
    repaired_operation = project_operations(repaired_skipped.events)[0]
    assert repaired_operation.outcome is OperationOutcome.NOT_STARTED
    assert "TOOL_NOT_STARTED" in (repaired_skipped.derive_messages()[-1].content or "")


def test_repair_scopes_duplicate_tool_ids_to_the_interrupted_turn(tmp_path: Path) -> None:
    store = FileSessionStore(tmp_path)
    session = store.create("duplicate-call-id")

    first = session.start_turn()
    session.append_message(_message(Role.USER, "第一次"))
    session.append_message(_message(
        Role.ASSISTANT,
        "",
        tool_calls=({"id": "call_0", "name": "read", "arguments": {}},),
    ))
    session.record_tool_call("call_0", "read", {}, step=1)
    session.append_message(_message(
        Role.TOOL,
        "old result",
        call_id="call_0",
        name="read",
    ))
    session.end_turn(first, reason="completed")

    session.start_turn()
    session.append_message(_message(Role.USER, "第二次"))
    session.append_message(_message(
        Role.ASSISTANT,
        "",
        tool_calls=({"id": "call_0", "name": "write", "arguments": {}},),
    ))
    session.record_tool_call("call_0", "write", {}, step=1)

    repaired = store.resume("duplicate-call-id", repair=True)

    latest = repaired.derive_messages()[-1]
    assert latest.role is Role.TOOL
    assert latest.name == "write"
    assert "TOOL_OUTCOME_UNKNOWN" in (latest.content or "")


def test_fork_requires_a_completed_turn_and_preserves_lineage(tmp_path: Path) -> None:
    store = FileSessionStore(tmp_path)
    parent = store.create("parent")
    turn = parent.start_turn()
    parent.append_message(_message(Role.USER, "question"))

    with pytest.raises(SessionForkError, match="open turn"):
        store.fork("parent", "child-bad")

    parent.end_turn(turn, reason="completed")
    child = store.fork("parent", "child")

    assert child.header.parent_session_id == "parent"
    assert child.header.seed_length == len(parent.events)
    assert child.derive_messages() == parent.derive_messages()
    child_turn = child.start_turn()
    assert child_turn == 2
    child.end_turn(child_turn, reason="completed")
    assert len(parent.events) < len(child.events)


def test_agent_loop_uses_session_surface_for_every_model_request(tmp_path: Path) -> None:
    import asyncio

    from app.agent_runtime.loop import LoopParams, LoopStopped, run_agent_loop
    from app.agent_runtime.model_client import LoopModelClient, ToolCallArrived, TurnDone
    from app.agent_runtime.tool_registry import ToolRegistry, ToolSpec
    from app.agent_runtime.types import ToolCall

    class Backend:
        def __init__(self) -> None:
            self.received: list[list[AgentMessage]] = []
            self.scenes = [
                [
                    ToolCallArrived(
                        call=ToolCall(id="c1", name="read_value", arguments={})
                    ),
                    TurnDone(usage=None, raw_text=None),
                ],
                [TurnDone(usage=None, raw_text="答案")],
            ]

        def generate(self, messages, tools, budget_ms=None, cancel_scope=None):
            self.received.append(list(messages))
            yield from self.scenes.pop(0)

    registry = ToolRegistry()
    registry.register(
        ToolSpec(
            name="read_value",
            description="read",
            input_schema={"type": "object", "properties": {}, "required": []},
            execute=lambda: "42",
        )
    )
    backend = Backend()
    session = FileSessionStore(tmp_path).create("loop")

    async def collect():
        return [
            event
            async for event in run_agent_loop(
                LoopParams(
                    user_input="读取",
                    registry=registry,
                    client=LoopModelClient(backend),
                    session=session,
                    request_header={
                        "systemPrompt": "system",
                        "usedBackend": "fake",
                    },
                )
            )
        ]

    events = asyncio.run(collect())

    assert isinstance(events[-1], LoopStopped)
    assert [len(messages) for messages in backend.received] == [1, 3]
    requests = [event for event in session.events if event.type == "model/request"]
    assert [event.data["messageCount"] for event in requests] == [1, 3]
    responses = [event for event in session.events if event.type == "model/response"]
    assert [event.data["toolCallCount"] for event in responses] == [1, 0]
    assert [event.data["outcome"] for event in responses] == ["completed", "completed"]
    assert session.open_turn is None
    assert session.events[-1].type == "turn/end"
    assert session.events[-1].data["reason"] == "completed"
    resumed = FileSessionStore(tmp_path).resume("loop")
    assert [message.role for message in resumed.derive_messages()] == [
        Role.USER,
        Role.ASSISTANT,
        Role.TOOL,
        Role.ASSISTANT,
    ]


def test_resumed_loop_continues_history_and_turn_number(tmp_path: Path) -> None:
    import asyncio

    from app.agent_runtime.loop import LoopParams, run_agent_loop
    from app.agent_runtime.model_client import LoopModelClient, TurnDone
    from app.agent_runtime.tool_registry import ToolRegistry

    class Backend:
        def __init__(self, answer: str) -> None:
            self.answer = answer
            self.received: list[list[AgentMessage]] = []

        def generate(self, messages, tools, budget_ms=None, cancel_scope=None):
            self.received.append(list(messages))
            yield TurnDone(usage=None, raw_text=self.answer)

    async def run(session, backend, prompt):
        return [
            event
            async for event in run_agent_loop(
                LoopParams(
                    user_input=prompt,
                    registry=ToolRegistry(),
                    client=LoopModelClient(backend),
                    session=session,
                    request_header={"systemPrompt": "system"},
                )
            )
        ]

    store = FileSessionStore(tmp_path)
    first = store.create("resume-loop")
    first_backend = Backend("第一次")
    asyncio.run(run(first, first_backend, "问题一"))
    resumed = store.resume("resume-loop", repair=True)
    second_backend = Backend("第二次")
    asyncio.run(run(resumed, second_backend, "问题二"))

    assert [message.content for message in second_backend.received[0]] == [
        "问题一",
        "第一次",
        "问题二",
    ]
    assert [
        event.data["turn"]
        for event in resumed.events
        if event.type == "turn/start"
    ] == [1, 2]


def test_answer_to_clarification_resumes_the_exact_logged_surface(tmp_path: Path) -> None:
    import asyncio
    import json

    from app.agent_runtime.loop import LoopParams, run_agent_loop
    from app.agent_runtime.model_client import LoopModelClient, ToolCallArrived, TurnDone
    from app.agent_runtime.tool_registry import ToolRegistry, ToolSpec
    from app.agent_runtime.types import ToolCall

    class Backend:
        def __init__(self, scene) -> None:
            self.scene = scene
            self.received: list[list[AgentMessage]] = []

        def generate(self, messages, tools, budget_ms=None, cancel_scope=None):
            self.received.append(list(messages))
            yield from self.scene

    registry = ToolRegistry()
    registry.register(ToolSpec(
        name="ask_user_question",
        description="ask",
        input_schema={
            "type": "object",
            "properties": {
                "question": {"type": "string"},
                "options": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["question", "options"],
        },
        execute=lambda question, options, scope=None: json.dumps({
            "awaitingUserInput": True,
            "question": question,
            "options": options,
        }, ensure_ascii=False),
        suspends_for_user_input=True,
    ))

    async def run(session, backend, prompt):
        return [
            event async for event in run_agent_loop(LoopParams(
                user_input=prompt,
                registry=registry,
                client=LoopModelClient(backend),
                session=session,
                request_header={"systemPrompt": "system"},
            ))
        ]

    first_backend = Backend([
        ToolCallArrived(call=ToolCall(
            id="ask-1",
            name="ask_user_question",
            arguments={"question": "选 A 还是 B？", "options": ["A", "B"]},
        )),
        TurnDone(usage=None, raw_text=None),
    ])
    store = FileSessionStore(tmp_path)
    asyncio.run(run(store.create("clarify"), first_backend, "替我选一个"))

    resumed = store.resume("clarify", repair=True)
    second_backend = Backend([TurnDone(usage=None, raw_text="已按 B 继续")])
    asyncio.run(run(resumed, second_backend, "B"))

    surface = second_backend.received[0]
    assert [message.role for message in surface] == [
        Role.USER,
        Role.ASSISTANT,
        Role.TOOL,
        Role.USER,
    ]
    assert surface[-1].content == "B"
    assert json.loads(surface[2].content or "")["question"] == "选 A 还是 B？"
