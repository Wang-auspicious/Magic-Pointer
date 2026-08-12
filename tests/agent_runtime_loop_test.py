"""Tests for the agent runtime loop interpreter (plan T2.4a + guards batch).

Covers the loop skeleton, main flow, concurrency-safe batching, withheld-turn
recovery, truncation invalidation, stop-hook gateway, interrupt checks and
compact-callback wiring:

1. Single-turn direct answer: 1 turn, natural Terminal reason
2. Two tools executed serially, results fed back, second turn answers:
   message order user -> tool -> tool -> assistant
3. ActionFailure(timeout) -> is_error=True fed back, error text visible
   in the tool message
4. validate_input failure -> is_error result without executing the tool
5. max_turns ceiling -> Terminal(max_turns) with results preserved
6. budget exhaustion (fake clock) -> Terminal(budget_exhausted), no new
   model calls after the budget blows
7. cancel_all mid-turn -> CancelledError propagates, no new model/tool
   calls afterwards
8. transition sequence across consecutive turns is recorded correctly
9. tool_limit truncation: 20 registered tools -> <= 12 schemas,
   trajectory-recommended tools preserved
10. trajectory: first turn uses the template message ({input} replaced)
11. concurrency-safe tools run on a worker thread pool: two 150 ms tools
    finish well under the 300 ms serial floor; events stay in call order
12. sequential (unsafe) tools keep input order, main-thread execution and
    the serial time floor
13. mixed round: the parallel batch runs first, sequential tools after
14. ActionFailure inside a parallel batch keeps execute_tool semantics
15. withheld x3 recovers and completes; recovery message and counter
    transitions are recorded
16. withheld x4 terminates with reason=max_output_tokens_recovered
17. last_truncated invalidates the round's tool calls (0 executions), one
    "输出被截断，重新生成" tool message is fed back, next round completes
18. stop hook prevent_continuation -> Terminal(stop_hook)
19. a raising stop hook does not kill the loop; stop_hook_active is set
    True then skipped/reset next round
20. interrupt_check True on round 2 -> Terminal(user_interrupt) before any
    second model call
21. compact_callback fires exactly once across repeated withheld rounds
22. full chain: truncation -> tool round -> completion

All tests inject fake model backends, fake clocks and fake pure-function
tools; nothing real is touched, no network, no desktop.
"""

from __future__ import annotations

import asyncio
import sys
import threading
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.agent_runtime.errors import ActionFailure, FailureType  # noqa: E402
from app.agent_runtime.loop import (  # noqa: E402
    LoopParams,
    LoopStopped,
    StopDecision,
    ToolCallFinished,
    ToolCallStarted,
    TurnFinished,
    TurnStarted,
    run_agent_loop,
)
from app.agent_runtime.model_client import (  # noqa: E402
    LoopModelClient,
    MessageDelta,
    ToolCallArrived,
    TurnDone,
    TurnWithheld,
)
from app.agent_runtime.tool_registry import Effect, ToolRegistry, ToolSpec  # noqa: E402
from app.agent_runtime.types import (  # noqa: E402
    Role,
    Terminal,
    ToolCall,
    Trajectory,
    TransitionReason,
)
from app.governance.cancellation import (  # noqa: E402
    CancellationRegistry,
    CancelledError,
)

EMPTY_SCHEMA = {"type": "object", "properties": {}, "required": []}


class ScriptedBackend:
    """Injected ModelBackend: replays one canned event scene per turn."""

    def __init__(self, *scenes) -> None:
        self._scenes = list(scenes)
        self.received: list[tuple] = []

    def generate(self, messages, tools, budget_ms=None, cancel_scope=None):
        self.received.append((list(messages), list(tools), budget_ms, cancel_scope))
        if self._scenes:
            yield from self._scenes.pop(0)
        else:
            yield TurnDone(usage=None, raw_text=None)


class FakeClock:
    """Callable fake clock: manual elapsed-ms advance."""

    def __init__(self) -> None:
        self.elapsed = 0.0

    def __call__(self) -> float:
        return self.elapsed

    def advance(self, ms: float) -> None:
        self.elapsed += ms


def make_counting_tool(
    name,
    value="ok",
    *,
    used_backend="fake",
    fail=None,
    on_call=None,
    schema=None,
    effect=Effect.READ,
    concurrency_safe=False,
    delay=0.0,
):
    """ToolSpec whose execute is a counter; ``fail`` is a raised exception.

    ``concurrency_safe`` declares the tool for the parallel batch;
    ``delay`` sleeps real wall time at the start of ``execute`` (used by
    the concurrency timing tests; the injected fake clock is untouched).
    """

    state = {"calls": 0}

    def execute(**kwargs):
        if delay > 0.0:
            time.sleep(delay)
        state["calls"] += 1
        if on_call is not None:
            on_call()
        if fail is not None:
            raise fail
        return value

    spec = ToolSpec(
        name=name,
        description=f"fake tool {name}",
        input_schema=schema or EMPTY_SCHEMA,
        execute=execute,
        effect=effect,
        used_backend=used_backend,
        is_concurrency_safe=concurrency_safe,
    )
    return spec, state


def withheld_scene(reason="max_output_tokens"):
    """One model round that is withheld (CC withhold-until-recover)."""

    return [TurnWithheld(reason=reason), TurnDone(usage=None, raw_text=None)]


def make_params(
    user_input="hello",
    *,
    registry=None,
    client=None,
    clock=None,
    **overrides,
) -> LoopParams:
    registry = registry if registry is not None else ToolRegistry()
    if client is None:
        client = LoopModelClient(
            ScriptedBackend([TurnDone(usage=None, raw_text="hi")])
        )
    return LoopParams(
        user_input=user_input,
        registry=registry,
        client=client,
        clock=clock,
        **overrides,
    )


async def collect(params: LoopParams) -> tuple[list, Terminal]:
    """Consume the async generator; return (events, terminal).

    PEP 525 forbids ``return value`` in async generators, so the Terminal
    arrives as the final LoopStopped event (the CC dual-channel return
    value is emulated by the event).
    """

    events = []
    generator = run_agent_loop(params)
    while True:
        try:
            events.append(await generator.__anext__())
        except StopAsyncIteration:
            break
    assert isinstance(events[-1], LoopStopped), "loop must end with LoopStopped"
    return events, events[-1].terminal


def test_single_turn_direct_answer_terminates():
    backend = ScriptedBackend([TurnDone(usage=None, raw_text="hello!")])
    client = LoopModelClient(backend)

    events, terminal = asyncio.run(collect(make_params(client=client)))

    assert [type(e).__name__ for e in events] == [
        "LoopStart",
        "TurnStarted",
        "ModelChunk",
        "TurnFinished",
        "LoopStopped",
    ]
    assert events[1].turn == 1
    assert events[2].text == "hello!"
    assert terminal.reason is TransitionReason.TOOL_RESULT
    assert terminal.message == "hello!"
    assert terminal.turns == 1
    assert terminal.results == ()
    assert isinstance(events[-1], LoopStopped)
    assert events[-1].terminal == terminal
    assert len(backend.received) == 1


def test_two_tools_serial_then_answer_message_order():
    order: list[str] = []
    add_schema = {
        "type": "object",
        "properties": {"a": {"type": "integer"}, "b": {"type": "integer"}},
        "required": ["a", "b"],
    }
    add, add_state = make_counting_tool(
        "add", value=3, schema=add_schema, on_call=lambda: order.append("add")
    )
    mul, mul_state = make_counting_tool(
        "mul", value=12, schema=add_schema, on_call=lambda: order.append("mul")
    )
    registry = ToolRegistry()
    registry.register(add)
    registry.register(mul)
    backend = ScriptedBackend(
        [
            ToolCallArrived(call=ToolCall(id="c1", name="add", arguments={"a": 1, "b": 2})),
            ToolCallArrived(call=ToolCall(id="c2", name="mul", arguments={"a": 3, "b": 4})),
            TurnDone(usage=None, raw_text=None),
        ],
        [TurnDone(usage=None, raw_text="final answer")],
    )
    client = LoopModelClient(backend)

    events, terminal = asyncio.run(collect(make_params(client=client, registry=registry)))

    assert order == ["add", "mul"]
    assert add_state["calls"] == 1
    assert mul_state["calls"] == 1
    first_messages = backend.received[0][0]
    second_messages = backend.received[1][0]
    assert [m.role for m in first_messages] == [Role.USER]
    assert [m.role for m in second_messages] == [Role.USER, Role.TOOL, Role.TOOL]
    assert [m.tool_call_id for m in second_messages[1:]] == ["c1", "c2"]
    assert [m.name for m in second_messages[1:]] == ["add", "mul"]
    finished = [e for e in events if isinstance(e, TurnFinished)]
    final_roles = [m.role for m in finished[-1].state.messages]
    assert final_roles == [Role.USER, Role.TOOL, Role.TOOL, Role.ASSISTANT]
    assert finished[-1].state.messages[-1].content == "final answer"
    assert terminal.reason is TransitionReason.TOOL_RESULT
    assert terminal.turns == 2
    assert terminal.message == "final answer"
    assert len(terminal.results) == 2
    assert terminal.results[0].value == "3"
    assert terminal.results[0].used_backend == "fake"
    tool_results = [e.result for e in events if isinstance(e, ToolCallFinished)]
    assert len(tool_results) == 2
    assert [r.tool_call_id for r in tool_results] == ["c1", "c2"]


def test_action_failure_timeout_is_error_fed_back():
    flaky, flaky_state = make_counting_tool(
        "flaky",
        fail=ActionFailure(FailureType.TIMEOUT, "worker busy", recovery_hint="retry"),
    )
    registry = ToolRegistry()
    registry.register(flaky)
    backend = ScriptedBackend(
        [
            ToolCallArrived(call=ToolCall(id="c1", name="flaky", arguments={})),
            TurnDone(usage=None, raw_text=None),
        ],
        [TurnDone(usage=None, raw_text="retried differently")],
    )
    client = LoopModelClient(backend)

    events, terminal = asyncio.run(collect(make_params(client=client, registry=registry)))

    assert flaky_state["calls"] == 1
    finished = [e for e in events if isinstance(e, TurnFinished)]
    tool_msg = finished[0].state.messages[1]
    assert tool_msg.role is Role.TOOL
    assert tool_msg.is_error is True
    assert "worker busy" in tool_msg.content
    result = terminal.results[0]
    assert result.is_error is True
    assert result.failure_type is FailureType.TIMEOUT
    assert "Error calling tool (flaky)" in result.value
    assert terminal.reason is TransitionReason.TOOL_ERROR


def test_validate_input_failure_skips_execute():
    tool, state = make_counting_tool(
        "typed_tool",
        schema={
            "type": "object",
            "properties": {"text": {"type": "string"}},
            "required": ["text"],
        },
    )
    registry = ToolRegistry()
    registry.register(tool)
    backend = ScriptedBackend(
        [
            ToolCallArrived(
                call=ToolCall(id="c1", name="typed_tool", arguments={"nope": 1})
            ),
            TurnDone(usage=None, raw_text=None),
        ],
        [TurnDone(usage=None, raw_text="ok")],
    )
    client = LoopModelClient(backend)

    events, terminal = asyncio.run(collect(make_params(client=client, registry=registry)))

    assert state["calls"] == 0
    assert len(terminal.results) == 1
    result = terminal.results[0]
    assert result.is_error is True
    assert result.failure_type is FailureType.TOOL_ERROR
    assert "unexpected field 'nope'" in result.value
    assert "missing required field 'text'" in result.value
    finished = [e for e in events if isinstance(e, TurnFinished)]
    tool_msg = finished[0].state.messages[1]
    assert tool_msg.is_error is True
    assert "unexpected field 'nope'" in tool_msg.content
    assert terminal.reason is TransitionReason.TOOL_ERROR


def test_max_turns_ceiling_keeps_results():
    tool, _ = make_counting_tool("loop_tool", value="x")
    registry = ToolRegistry()
    registry.register(tool)
    backend = ScriptedBackend(
        [ToolCallArrived(call=ToolCall(id="c1", name="loop_tool", arguments={})), TurnDone(usage=None, raw_text=None)],
        [ToolCallArrived(call=ToolCall(id="c2", name="loop_tool", arguments={})), TurnDone(usage=None, raw_text=None)],
    )
    client = LoopModelClient(backend)

    events, terminal = asyncio.run(
        collect(make_params(client=client, registry=registry, max_turns=2))
    )

    assert len(backend.received) == 2
    assert terminal.reason is TransitionReason.MAX_TURNS
    assert terminal.turns == 2
    assert len(terminal.results) == 2
    assert [r.tool_call_id for r in terminal.results] == ["c1", "c2"]
    assert isinstance(events[-1], LoopStopped)
    assert events[-1].terminal == terminal


def test_budget_exhaustion_stops_model_calls():
    clock = FakeClock()
    registry = CancellationRegistry()
    slow, _ = make_counting_tool(
        "slow_tool", value="x", on_call=lambda: clock.advance(10_000)
    )
    tools = ToolRegistry()
    tools.register(slow)
    backend = ScriptedBackend(
        [ToolCallArrived(call=ToolCall(id="c1", name="slow_tool", arguments={})), TurnDone(usage=None, raw_text=None)],
        [TurnDone(usage=None, raw_text="too late")],
    )
    client = LoopModelClient(backend)

    events, terminal = asyncio.run(
        collect(
            make_params(
                client=client,
                registry=tools,
                clock=clock,
                cancel_registry=registry,
            )
        )
    )

    assert len(backend.received) == 1
    assert terminal.reason is TransitionReason.BUDGET_EXHAUSTED
    assert terminal.turns == 1
    assert len(terminal.results) == 1
    assert isinstance(events[-1], LoopStopped)


def test_cancel_all_mid_turn_raises_cancelled_error():
    cancel_registry = CancellationRegistry()
    cancelled_tool, tool_state = make_counting_tool(
        "cancel_me", value="x", on_call=cancel_registry.cancel_all
    )
    tools = ToolRegistry()
    tools.register(cancelled_tool)
    backend = ScriptedBackend(
        [ToolCallArrived(call=ToolCall(id="c1", name="cancel_me", arguments={})), TurnDone(usage=None, raw_text=None)],
        [TurnDone(usage=None, raw_text="never reached")],
    )
    client = LoopModelClient(backend)

    with pytest.raises(CancelledError):
        asyncio.run(
            collect(
                make_params(
                    client=client,
                    registry=tools,
                    cancel_registry=cancel_registry,
                )
            )
        )

    assert len(backend.received) == 1
    assert tool_state["calls"] == 1


def test_transition_sequence_across_turns():
    good, _ = make_counting_tool("good_tool", value="ok")
    bad, _ = make_counting_tool(
        "bad_tool", fail=ActionFailure(FailureType.TOOL_ERROR, "boom")
    )
    registry = ToolRegistry()
    registry.register(good)
    registry.register(bad)
    backend = ScriptedBackend(
        [ToolCallArrived(call=ToolCall(id="c1", name="good_tool", arguments={})), TurnDone(usage=None, raw_text=None)],
        [ToolCallArrived(call=ToolCall(id="c2", name="bad_tool", arguments={})), TurnDone(usage=None, raw_text=None)],
        [TurnDone(usage=None, raw_text="done")],
    )
    client = LoopModelClient(backend)

    events, terminal = asyncio.run(collect(make_params(client=client, registry=registry)))

    starts = [e for e in events if isinstance(e, TurnStarted)]
    assert [e.turn for e in starts] == [1, 2, 3]
    finished = [e for e in events if isinstance(e, TurnFinished)]
    assert [e.state.turn_count for e in finished] == [1, 2, 3]
    assert [e.state.transition for e in finished] == [
        TransitionReason.TOOL_RESULT,
        TransitionReason.TOOL_ERROR,
        TransitionReason.TOOL_ERROR,
    ]
    assert terminal.reason is TransitionReason.TOOL_ERROR
    assert terminal.turns == 3


def test_tool_limit_truncation_keeps_recommended():
    registry = ToolRegistry()
    for index in range(20):
        tool, _ = make_counting_tool(f"t{index:02d}")
        registry.register(tool)
    trajectory = Trajectory(
        recipe_id="tr",
        first_user_message="start",
        recommended_tools=("t19", "t01"),
    )
    backend = ScriptedBackend([TurnDone(usage=None, raw_text="done")])
    client = LoopModelClient(backend)

    events, terminal = asyncio.run(
        collect(
            make_params(
                client=client,
                registry=registry,
                trajectory=trajectory,
                tool_limit=12,
            )
        )
    )

    assert len(backend.received) == 1
    schemas = backend.received[0][1]
    assert len(schemas) == 12
    names = [s["name"] for s in schemas]
    assert names[0] == "t19"
    assert names[1] == "t01"
    assert set(("t19", "t01")).issubset(set(names))
    assert names == ["t19", "t01", "t00", "t02", "t03", "t04", "t05", "t06", "t07", "t08", "t09", "t10"]
    assert terminal.reason is TransitionReason.TOOL_RESULT


def test_trajectory_first_message_template_replaces_input():
    tool, _ = make_counting_tool("read_tool")
    registry = ToolRegistry()
    registry.register(tool)
    trajectory = Trajectory(
        recipe_id="tr",
        first_user_message="Read the {input} selection",
        recommended_tools=("read_tool",),
    )
    backend = ScriptedBackend([TurnDone(usage=None, raw_text="ok")])
    client = LoopModelClient(backend)

    events, terminal = asyncio.run(
        collect(
            make_params(
                user_input="second paragraph",
                client=client,
                registry=registry,
                trajectory=trajectory,
            )
        )
    )

    assert len(backend.received) == 1
    first_messages = backend.received[0][0]
    assert len(first_messages) == 1
    assert first_messages[0].role is Role.USER
    assert first_messages[0].content == "Read the second paragraph selection"
    assert terminal.reason is TransitionReason.TOOL_RESULT


def test_parallel_safe_slow_tools_total_wall_time_below_serial():
    slow_a, state_a = make_counting_tool(
        "slow_a", delay=0.15, concurrency_safe=True
    )
    slow_b, state_b = make_counting_tool(
        "slow_b", delay=0.15, concurrency_safe=True
    )
    registry = ToolRegistry()
    registry.register(slow_a)
    registry.register(slow_b)
    backend = ScriptedBackend(
        [
            ToolCallArrived(call=ToolCall(id="c1", name="slow_a", arguments={})),
            ToolCallArrived(call=ToolCall(id="c2", name="slow_b", arguments={})),
            TurnDone(usage=None, raw_text=None),
        ],
        [TurnDone(usage=None, raw_text="done")],
    )
    client = LoopModelClient(backend)

    started = time.perf_counter()
    events, terminal = asyncio.run(
        collect(make_params(client=client, registry=registry))
    )
    elapsed = time.perf_counter() - started

    assert elapsed < 0.30, (
        f"parallel batch took {elapsed:.3f}s (serial would be >= 0.30)"
    )
    assert state_a["calls"] == 1
    assert state_b["calls"] == 1
    starts = [e for e in events if isinstance(e, ToolCallStarted)]
    assert [e.name for e in starts] == ["slow_a", "slow_b"]
    assert [e.id for e in starts] == ["c1", "c2"]
    finishes = [e for e in events if isinstance(e, ToolCallFinished)]
    assert [e.result.tool_call_id for e in finishes] == ["c1", "c2"]
    assert terminal.turns == 2
    assert terminal.reason is TransitionReason.TOOL_RESULT


def test_sequential_unsafe_tools_preserve_order_and_serial_time():
    main = threading.current_thread()
    order: list[bool] = []
    seq_a, _ = make_counting_tool(
        "seq_a",
        delay=0.15,
        on_call=lambda: order.append(threading.current_thread() is main),
    )
    seq_b, _ = make_counting_tool(
        "seq_b",
        delay=0.15,
        on_call=lambda: order.append(threading.current_thread() is main),
    )
    registry = ToolRegistry()
    registry.register(seq_a)
    registry.register(seq_b)
    backend = ScriptedBackend(
        [
            ToolCallArrived(call=ToolCall(id="c1", name="seq_a", arguments={})),
            ToolCallArrived(call=ToolCall(id="c2", name="seq_b", arguments={})),
            TurnDone(usage=None, raw_text=None),
        ],
        [TurnDone(usage=None, raw_text="done")],
    )
    client = LoopModelClient(backend)

    started = time.perf_counter()
    events, terminal = asyncio.run(
        collect(make_params(client=client, registry=registry))
    )
    elapsed = time.perf_counter() - started

    assert order == [True, True], "unsafe tools must run serially on the loop thread"
    assert elapsed >= 0.30, (
        f"sequential pair took {elapsed:.3f}s (two 150 ms sleeps must not "
        "be parallelized)"
    )
    assert [r.tool_call_id for r in terminal.results] == ["c1", "c2"]
    assert terminal.turns == 2


def test_mixed_partition_runs_parallel_batch_then_sequential():
    main = threading.current_thread()
    order: list[str] = []

    def safe_execute(**kwargs):
        tag = "worker" if threading.current_thread() is not main else "main"
        order.append(f"safe:{tag}")
        return "ok"

    def seq_execute(**kwargs):
        tag = "worker" if threading.current_thread() is not main else "main"
        order.append(f"seq:{tag}")
        return "ok"

    safe = ToolSpec(
        name="safe_go",
        description="concurrency-safe fake",
        input_schema=EMPTY_SCHEMA,
        execute=safe_execute,
        is_concurrency_safe=True,
    )
    seq = ToolSpec(
        name="seq_go",
        description="sequential fake",
        input_schema=EMPTY_SCHEMA,
        execute=seq_execute,
        is_concurrency_safe=False,
    )
    registry = ToolRegistry()
    registry.register(safe)
    registry.register(seq)
    backend = ScriptedBackend(
        [
            ToolCallArrived(call=ToolCall(id="c1", name="safe_go", arguments={})),
            ToolCallArrived(call=ToolCall(id="c2", name="seq_go", arguments={})),
            TurnDone(usage=None, raw_text=None),
        ],
        [TurnDone(usage=None, raw_text="done")],
    )
    client = LoopModelClient(backend)

    events, terminal = asyncio.run(
        collect(make_params(client=client, registry=registry))
    )

    assert order == ["safe:worker", "seq:main"]
    starts = [e for e in events if isinstance(e, ToolCallStarted)]
    assert [e.name for e in starts] == ["safe_go", "seq_go"]
    assert [r.tool_call_id for r in terminal.results] == ["c1", "c2"]
    assert terminal.turns == 2


def test_parallel_action_failure_matches_execute_tool_semantics():
    bad, _ = make_counting_tool(
        "bad_p",
        concurrency_safe=True,
        fail=ActionFailure(FailureType.FOCUS_LOST, "lost the element"),
    )
    good, _ = make_counting_tool("good_p", value="ok", concurrency_safe=True)
    registry = ToolRegistry()
    registry.register(bad)
    registry.register(good)
    backend = ScriptedBackend(
        [
            ToolCallArrived(call=ToolCall(id="c1", name="good_p", arguments={})),
            ToolCallArrived(call=ToolCall(id="c2", name="bad_p", arguments={})),
            TurnDone(usage=None, raw_text=None),
        ],
        [TurnDone(usage=None, raw_text="done")],
    )
    client = LoopModelClient(backend)

    events, terminal = asyncio.run(
        collect(make_params(client=client, registry=registry))
    )

    assert len(terminal.results) == 2
    assert terminal.results[0].is_error is False
    assert terminal.results[0].value == "ok"
    assert terminal.results[1].is_error is True
    assert terminal.results[1].failure_type is FailureType.FOCUS_LOST
    assert "lost the element" in terminal.results[1].value
    finished = [e for e in events if isinstance(e, TurnFinished)]
    assert finished[0].state.transition is TransitionReason.TOOL_ERROR
    assert terminal.turns == 2
    assert terminal.reason is TransitionReason.TOOL_ERROR


def test_withheld_three_rounds_then_recovers():
    backend = ScriptedBackend(
        withheld_scene(),
        withheld_scene(),
        withheld_scene(),
        [TurnDone(usage=None, raw_text="recovered answer")],
    )
    client = LoopModelClient(backend)

    events, terminal = asyncio.run(collect(make_params(client=client)))

    assert len(backend.received) == 4
    assert terminal.turns == 4
    assert terminal.message == "recovered answer"
    assert terminal.reason is TransitionReason.MAX_OUTPUT_TOKENS_RECOVERED
    finished = [e for e in events if isinstance(e, TurnFinished)]
    assert [e.state.transition for e in finished] == [
        TransitionReason.MAX_OUTPUT_TOKENS_RECOVERED,
        TransitionReason.MAX_OUTPUT_TOKENS_RECOVERED,
        TransitionReason.MAX_OUTPUT_TOKENS_RECOVERED,
        TransitionReason.MAX_OUTPUT_TOKENS_RECOVERED,
    ]
    assert [e.state.max_output_tokens_recovery_count for e in finished] == [
        1,
        2,
        3,
        3,
    ]
    recovery_message = backend.received[1][0][-1]
    assert recovery_message.role is Role.USER
    assert "Output token limit hit" in recovery_message.content


def test_withheld_fourth_round_terminates():
    backend = ScriptedBackend(
        withheld_scene(),
        withheld_scene(),
        withheld_scene(),
        withheld_scene(),
    )
    client = LoopModelClient(backend)

    events, terminal = asyncio.run(collect(make_params(client=client)))

    assert len(backend.received) == 4
    assert terminal.reason is TransitionReason.MAX_OUTPUT_TOKENS_RECOVERED
    assert terminal.message == "max output tokens recovery limit exceeded"
    assert terminal.turns == 4
    assert isinstance(events[-1], LoopStopped)


def test_truncation_invalidates_tool_calls_and_feeds_back():
    trunc_tool, state = make_counting_tool("trunc_tool")
    registry = ToolRegistry()
    registry.register(trunc_tool)
    backend = ScriptedBackend(
        [
            MessageDelta("analyzing…"),
            ToolCallArrived(call=ToolCall(id="c1", name="trunc_tool", arguments={})),
            TurnDone(usage=None, raw_text="analyzing…"),
        ],
        [TurnDone(usage=None, raw_text="final answer")],
    )
    client = LoopModelClient(backend)

    events, terminal = asyncio.run(
        collect(make_params(client=client, registry=registry))
    )

    assert state["calls"] == 0
    assert terminal.results == ()
    assert not any(isinstance(e, ToolCallStarted) for e in events)
    assert not any(isinstance(e, ToolCallFinished) for e in events)
    second_messages = backend.received[1][0]
    assert [m.role for m in second_messages] == [Role.USER, Role.TOOL]
    assert second_messages[1].content == "输出被截断，重新生成"
    assert second_messages[1].is_error is False
    assert second_messages[1].tool_call_id == "c1"
    assert terminal.turns == 2
    assert terminal.message == "final answer"
    assert terminal.reason is TransitionReason.TOOL_RESULT


def test_stop_hook_prevent_continuation_terminates():
    calls = {"n": 0}

    def prevent_hook(state):
        calls["n"] += 1
        return StopDecision(
            reason=TransitionReason.STOP_HOOK, prevent_continuation=True
        )

    backend = ScriptedBackend([TurnDone(usage=None, raw_text="answer")])
    client = LoopModelClient(backend)

    events, terminal = asyncio.run(
        collect(make_params(client=client, stop_hooks=[prevent_hook]))
    )

    assert calls["n"] == 1
    assert terminal.reason is TransitionReason.STOP_HOOK
    assert terminal.message == "stop hook prevented continuation"
    assert terminal.turns == 1
    assert isinstance(events[-1], LoopStopped)


def test_stop_hook_raising_keeps_loop_running():
    def bad_hook(state):
        raise RuntimeError("hook blew up")

    backend = ScriptedBackend(
        [TurnDone(usage=None, raw_text="first")],
        [TurnDone(usage=None, raw_text="second")],
    )
    client = LoopModelClient(backend)

    events, terminal = asyncio.run(
        collect(make_params(client=client, stop_hooks=[bad_hook]))
    )

    assert terminal.turns == 2
    assert terminal.message == "second"
    assert terminal.reason is TransitionReason.TOOL_RESULT
    finished = [e for e in events if isinstance(e, TurnFinished)]
    assert finished[0].state.stop_hook_active is True
    assert finished[1].state.stop_hook_active is False


def test_interrupt_check_stops_before_model_call():
    tool, _ = make_counting_tool("itool")
    registry = ToolRegistry()
    registry.register(tool)
    checks = {"n": 0}

    def interrupt_check():
        checks["n"] += 1
        return checks["n"] >= 2

    backend = ScriptedBackend(
        [
            ToolCallArrived(call=ToolCall(id="c1", name="itool", arguments={})),
            TurnDone(usage=None, raw_text=None),
        ],
        [TurnDone(usage=None, raw_text="never reached")],
    )
    client = LoopModelClient(backend)

    events, terminal = asyncio.run(
        collect(
            make_params(
                client=client,
                registry=registry,
                interrupt_check=interrupt_check,
            )
        )
    )

    assert checks["n"] == 2
    assert len(backend.received) == 1
    assert terminal.reason is TransitionReason.USER_INTERRUPT
    assert terminal.message == "user interrupt"
    assert terminal.turns == 2
    assert isinstance(events[-1], LoopStopped)


def test_compact_callback_called_exactly_once_on_withheld():
    calls = {"n": 0}

    def compact(state):
        calls["n"] += 1

    backend = ScriptedBackend(
        withheld_scene(),
        withheld_scene(),
        [TurnDone(usage=None, raw_text="ok")],
    )
    client = LoopModelClient(backend)

    events, terminal = asyncio.run(
        collect(make_params(client=client, compact_callback=compact))
    )

    assert calls["n"] == 1
    finished = [e for e in events if isinstance(e, TurnFinished)]
    assert finished[0].state.has_attempted_reactive_compact is True
    assert finished[1].state.has_attempted_reactive_compact is True
    assert terminal.turns == 3
    assert terminal.message == "ok"


def test_truncation_then_tool_round_then_complete():
    chain_tool, state = make_counting_tool("chain_tool")
    registry = ToolRegistry()
    registry.register(chain_tool)
    backend = ScriptedBackend(
        [
            MessageDelta("cut…"),
            ToolCallArrived(call=ToolCall(id="c1", name="chain_tool", arguments={})),
            TurnDone(usage=None, raw_text="cut…"),
        ],
        [
            ToolCallArrived(call=ToolCall(id="c2", name="chain_tool", arguments={})),
            TurnDone(usage=None, raw_text=None),
        ],
        [TurnDone(usage=None, raw_text="done")],
    )
    client = LoopModelClient(backend)

    events, terminal = asyncio.run(
        collect(make_params(client=client, registry=registry))
    )

    assert state["calls"] == 1
    assert [r.tool_call_id for r in terminal.results] == ["c2"]
    assert terminal.turns == 3
    assert terminal.message == "done"
    assert terminal.reason is TransitionReason.TOOL_RESULT
