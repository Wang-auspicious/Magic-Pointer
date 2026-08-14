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
5. emergency invariant fuse -> Terminal(invariant_failed), results preserved
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
from dataclasses import replace
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.agent_runtime.errors import ActionFailure, FailureType  # noqa: E402
from app.agent_runtime.hooks import HookManager  # noqa: E402
from app.agent_runtime.loop import (  # noqa: E402
    BudgetRenewed,
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
    AgentMessage,
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
from app.action_guard.preconditions import PreconditionContext  # noqa: E402

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
    assert terminal.reason is TransitionReason.COMPLETED
    assert terminal.message == "hello!"
    assert terminal.turns == 1
    assert terminal.results == ()
    assert isinstance(events[-1], LoopStopped)
    assert events[-1].terminal == terminal
    assert len(backend.received) == 1


@pytest.mark.parametrize(
    ("override", "message"),
    [
        ({"permission_mode": "typo"}, "permission_mode"),
        ({"emergency_turn_fuse": 0}, "emergency_turn_fuse"),
        ({"tool_limit": -1}, "tool_limit"),
        ({"max_parallel_tool_calls": 0}, "max_parallel_tool_calls"),
        ({"budget_renewals": -1}, "budget_renewals"),
        ({"context_budget_tokens": 0}, "context_budget_tokens"),
        ({"allowed_effects": ("read",)}, "allowed_effects"),
    ],
)
def test_invalid_loop_params_fail_before_model_call(override, message):
    backend = ScriptedBackend([TurnDone(usage=None, raw_text="must not run")])

    with pytest.raises(ValueError, match=message):
        asyncio.run(
            collect(
                make_params(
                    client=LoopModelClient(backend),
                    **override,
                )
            )
        )

    assert backend.received == []


def test_user_input_tool_suspends_without_another_model_round() -> None:
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
        execute=lambda question, options, scope=None: __import__("json").dumps({
            "asked": True,
            "awaitingUserInput": True,
            "question": question,
            "options": options,
        }, ensure_ascii=False),
        suspends_for_user_input=True,
    ))
    backend = ScriptedBackend([
        ToolCallArrived(call=ToolCall(
            id="ask-1",
            name="ask_user_question",
            arguments={"question": "选 A 还是 B？", "options": ["A", "B"]},
        )),
        TurnDone(usage=None, raw_text=None),
    ])

    _events, terminal = asyncio.run(collect(make_params(
        registry=registry,
        client=LoopModelClient(backend),
    )))

    assert terminal.reason is TransitionReason.AWAITING_USER
    assert terminal.pending_input == {
        "question": "选 A 还是 B？",
        "options": ["A", "B"],
    }
    assert len(backend.received) == 1


def test_model_usage_is_aggregated_across_agent_rounds() -> None:
    backend = ScriptedBackend(
        [TurnDone(usage={"prompt_tokens": 10, "completion_tokens": 3}, raw_text="one")],
    )

    _events, terminal = asyncio.run(collect(make_params(
        client=LoopModelClient(backend),
    )))

    assert terminal.model_usage == {
        "inputTokens": 10,
        "outputTokens": 3,
        "totalTokens": 13,
        "turnsReported": 1,
    }


def test_non_finite_provider_usage_cannot_crash_a_valid_answer() -> None:
    backend = ScriptedBackend([
        TurnDone(
            usage={
                "prompt_tokens": float("nan"),
                "completion_tokens": float("inf"),
                "total_tokens": float("-inf"),
            },
            raw_text="valid answer",
        )
    ])

    _events, terminal = asyncio.run(collect(make_params(
        client=LoopModelClient(backend),
    )))

    assert terminal.reason is TransitionReason.COMPLETED
    assert terminal.message == "valid answer"
    assert terminal.model_usage is None


def test_default_emergency_fuse_is_not_a_normal_task_limit() -> None:
    assert make_params().emergency_turn_fuse >= 90


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
    assert [m.role for m in second_messages] == [Role.USER, Role.ASSISTANT, Role.TOOL, Role.TOOL]
    assert [m.tool_call_id for m in second_messages[2:]] == ["c1", "c2"]
    assert [m.name for m in second_messages[2:]] == ["add", "mul"]
    finished = [e for e in events if isinstance(e, TurnFinished)]
    final_roles = [m.role for m in finished[-1].state.messages]
    assert final_roles == [Role.USER, Role.ASSISTANT, Role.TOOL, Role.TOOL, Role.ASSISTANT]
    assert finished[-1].state.messages[-1].content == "final answer"
    assert terminal.reason is TransitionReason.COMPLETED
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
    tool_msg = finished[0].state.messages[2]
    assert tool_msg.role is Role.TOOL
    assert tool_msg.is_error is True
    assert "worker busy" in tool_msg.content
    result = terminal.results[0]
    assert result.is_error is True
    assert result.failure_type is FailureType.TIMEOUT
    assert "Error calling tool (flaky)" in result.value
    assert terminal.reason is TransitionReason.COMPLETED


def test_oversized_tool_result_is_bounded_before_logging_and_model_replay():
    huge = "A" * 40_000 + "B" * 40_000
    tool, _state = make_counting_tool("huge_read", value=huge)
    registry = ToolRegistry()
    registry.register(tool)
    backend = ScriptedBackend(
        [
            ToolCallArrived(call=ToolCall(id="huge", name="huge_read", arguments={})),
            TurnDone(usage=None, raw_text=None),
        ],
        [TurnDone(usage=None, raw_text="done")],
    )

    _events, terminal = asyncio.run(collect(make_params(
        client=LoopModelClient(backend),
        registry=registry,
    )))

    result = terminal.results[0].value
    replayed = backend.received[1][0][2].content
    assert len(result) <= 64_000
    assert "[tool result truncated:" in result
    assert "sha256=" in result
    assert result.startswith("A") and result.endswith("B")
    assert replayed == result


def test_declared_tool_timeout_cancels_cooperatively_and_returns_timeout_result():
    observed = {"cancelled": False}

    def wait_for_cancel(scope=None):
        deadline = time.perf_counter() + 1.0
        while time.perf_counter() < deadline:
            if scope is not None and scope.is_cancelled():
                observed["cancelled"] = True
                return "provider stopped"
            time.sleep(0.001)
        return "provider ignored cancellation"

    registry = ToolRegistry()
    registry.register(ToolSpec(
        name="cooperative_wait",
        description="waits until its execution token is cancelled",
        input_schema=EMPTY_SCHEMA,
        execute=wait_for_cancel,
        timeout_ms=10,
    ))
    backend = ScriptedBackend(
        [
            ToolCallArrived(
                call=ToolCall(id="timeout", name="cooperative_wait", arguments={})
            ),
            TurnDone(usage=None, raw_text=None),
        ],
        [TurnDone(usage=None, raw_text="recovered")],
    )

    _, terminal = asyncio.run(collect(make_params(
        client=LoopModelClient(backend),
        registry=registry,
    )))

    result = terminal.results[0]
    assert observed["cancelled"] is True
    assert result.is_error is True
    assert result.failure_type is FailureType.TIMEOUT
    assert "timed out after 10ms" in result.value


def test_pre_tool_hook_mutation_is_revalidated_before_execute():
    tool, state = make_counting_tool(
        "edit_path",
        schema={
            "type": "object",
            "properties": {"path": {"type": "string"}},
            "required": ["path"],
        },
    )
    registry = ToolRegistry()
    registry.register(tool)
    hooks = HookManager(pre_tool_use=[
        lambda _payload: {"input": {"path": "other.txt", "extra": True}},
    ])
    backend = ScriptedBackend(
        [
            ToolCallArrived(call=ToolCall(
                id="edit",
                name="edit_path",
                arguments={"path": "safe.txt"},
            )),
            TurnDone(usage=None, raw_text=None),
        ],
        [TurnDone(usage=None, raw_text="refused")],
    )

    _events, terminal = asyncio.run(collect(make_params(
        client=LoopModelClient(backend),
        registry=registry,
        hook_manager=hooks,
    )))

    assert state["calls"] == 0
    assert terminal.results[0].is_error is True
    assert "unexpected field 'extra'" in terminal.results[0].value


def test_preconditions_are_built_from_post_hook_effective_arguments():
    seen: list[dict] = []

    class Pass:
        def check(self, _context):
            return None

    tool, state = make_counting_tool(
        "edit_path",
        schema={
            "type": "object",
            "properties": {"path": {"type": "string"}},
            "required": ["path"],
        },
    )
    tool = replace(tool, preconditions=(Pass(),))
    registry = ToolRegistry()
    registry.register(tool)
    hooks = HookManager(pre_tool_use=[
        lambda _payload: {"input": {"path": "effective.txt"}},
    ])
    backend = ScriptedBackend(
        [
            ToolCallArrived(call=ToolCall(
                id="edit",
                name="edit_path",
                arguments={"path": "original.txt"},
            )),
            TurnDone(usage=None, raw_text=None),
        ],
        [TurnDone(usage=None, raw_text="done")],
    )

    _events, terminal = asyncio.run(collect(make_params(
        client=LoopModelClient(backend),
        registry=registry,
        hook_manager=hooks,
        precondition_context_factory=lambda call: (
            seen.append(dict(call.arguments)) or PreconditionContext()
        ),
    )))

    assert state["calls"] == 1
    assert terminal.results[0].is_error is False
    assert seen == [{"path": "effective.txt"}]


def test_raising_precondition_probe_refuses_the_tool_without_crashing_loop():
    class Pass:
        def check(self, _context):
            return None

    tool, state = make_counting_tool("guarded_write")
    registry = ToolRegistry()
    registry.register(replace(tool, preconditions=(Pass(),)))
    backend = ScriptedBackend(
        [
            ToolCallArrived(call=ToolCall(
                id="guarded",
                name="guarded_write",
                arguments={},
            )),
            TurnDone(usage=None, raw_text=None),
        ],
        [TurnDone(usage=None, raw_text="refused safely")],
    )

    _events, terminal = asyncio.run(collect(make_params(
        client=LoopModelClient(backend),
        registry=registry,
        precondition_context_factory=lambda _call: (_ for _ in ()).throw(
            OSError("UIA probe unavailable")
        ),
    )))

    assert state["calls"] == 0
    assert terminal.reason is TransitionReason.COMPLETED
    assert terminal.results[0].failure_type is FailureType.PERMISSION_DENIED
    assert "precondition probe failed" in terminal.results[0].value


def test_post_tool_block_is_visible_as_non_retryable_error_after_execution():
    tool, state = make_counting_tool("read_sensitive", value="secret")
    registry = ToolRegistry()
    registry.register(tool)
    hooks = HookManager(post_tool_use=[
        lambda _payload: {
            "decision": "block",
            "reason": "policy rejected disclosure",
        },
    ])
    backend = ScriptedBackend(
        [
            ToolCallArrived(call=ToolCall(
                id="blocked-result",
                name="read_sensitive",
                arguments={},
            )),
            TurnDone(usage=None, raw_text=None),
        ],
        [TurnDone(usage=None, raw_text="handled")],
    )

    _events, terminal = asyncio.run(collect(make_params(
        client=LoopModelClient(backend),
        registry=registry,
        hook_manager=hooks,
    )))

    assert state["calls"] == 1
    result = terminal.results[0]
    assert result.is_error is True
    assert result.failure_type is FailureType.PERMISSION_DENIED
    assert "after tool execution" in result.value
    assert "policy rejected disclosure" in result.value


def test_pre_tool_hook_cannot_change_dynamic_resource_ownership():
    tool, state = make_counting_tool(
        "edit_path",
        schema={
            "type": "object",
            "properties": {"path": {"type": "string"}},
            "required": ["path"],
        },
    )
    tool = replace(tool, resource_keys=lambda args: (f"file:{args['path']}",))
    registry = ToolRegistry()
    registry.register(tool)
    hooks = HookManager(pre_tool_use=[
        lambda _payload: {"input": {"path": "other.txt"}},
    ])
    backend = ScriptedBackend(
        [
            ToolCallArrived(call=ToolCall(
                id="edit",
                name="edit_path",
                arguments={"path": "safe.txt"},
            )),
            TurnDone(usage=None, raw_text=None),
        ],
        [TurnDone(usage=None, raw_text="refused")],
    )

    _events, terminal = asyncio.run(collect(make_params(
        client=LoopModelClient(backend),
        registry=registry,
        hook_manager=hooks,
    )))

    assert state["calls"] == 0
    assert terminal.results[0].failure_type is FailureType.PERMISSION_DENIED
    assert "resource ownership" in terminal.results[0].value


def test_pre_tool_hook_nested_mutation_cannot_hide_resource_change():
    tool, state = make_counting_tool(
        "edit_nested_path",
        schema={
            "type": "object",
            "properties": {
                "target": {
                    "type": "object",
                    "properties": {"path": {"type": "string"}},
                    "required": ["path"],
                    "additionalProperties": False,
                },
            },
            "required": ["target"],
        },
    )
    tool = replace(
        tool,
        resource_keys=lambda args: (f"file:{args['target']['path']}",),
    )
    registry = ToolRegistry()
    registry.register(tool)

    def mutate_nested(payload):
        payload["input"]["target"]["path"] = "other.txt"
        return {"input": payload["input"]}

    hooks = HookManager(pre_tool_use=[mutate_nested])
    backend = ScriptedBackend(
        [
            ToolCallArrived(call=ToolCall(
                id="nested-edit",
                name="edit_nested_path",
                arguments={"target": {"path": "safe.txt"}},
            )),
            TurnDone(usage=None, raw_text=None),
        ],
        [TurnDone(usage=None, raw_text="refused")],
    )

    _events, terminal = asyncio.run(collect(make_params(
        client=LoopModelClient(backend),
        registry=registry,
        hook_manager=hooks,
    )))

    assert state["calls"] == 0
    assert terminal.results[0].failure_type is FailureType.PERMISSION_DENIED
    assert "resource ownership" in terminal.results[0].value


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
    tool_msg = finished[0].state.messages[2]
    assert tool_msg.is_error is True
    assert "unexpected field 'nope'" in tool_msg.content
    assert terminal.reason is TransitionReason.COMPLETED


def test_malformed_tool_arguments_are_fed_back_for_model_self_correction():
    tool, state = make_counting_tool("typed_tool")
    registry = ToolRegistry()
    registry.register(tool)
    backend = ScriptedBackend(
        [
            ToolCallArrived(
                call=ToolCall(
                    id="bad-json",
                    name="typed_tool",
                    arguments="{not-json",
                )
            ),
            TurnDone(usage=None, raw_text=None),
        ],
        [TurnDone(usage=None, raw_text="corrected")],
    )

    _, terminal = asyncio.run(collect(make_params(
        client=LoopModelClient(backend),
        registry=registry,
    )))

    assert state["calls"] == 0
    assert len(backend.received) == 2
    assert len(terminal.results) == 1
    assert terminal.results[0].is_error is True
    assert "malformed arguments JSON" in terminal.results[0].value
    second_messages = backend.received[1][0]
    assert second_messages[-1].role is Role.TOOL
    assert second_messages[-1].is_error is True


def test_emergency_turn_fuse_reports_invariant_failure_and_keeps_results():
    tool, _ = make_counting_tool("loop_tool", value="x")
    registry = ToolRegistry()
    registry.register(tool)
    backend = ScriptedBackend(
        [ToolCallArrived(call=ToolCall(id="c1", name="loop_tool", arguments={})), TurnDone(usage=None, raw_text=None)],
        [ToolCallArrived(call=ToolCall(id="c2", name="loop_tool", arguments={})), TurnDone(usage=None, raw_text=None)],
    )
    client = LoopModelClient(backend)

    events, terminal = asyncio.run(
        collect(
            make_params(
                client=client,
                registry=registry,
                emergency_turn_fuse=2,
            )
        )
    )

    assert len(backend.received) == 2
    assert terminal.reason is TransitionReason.INVARIANT_FAILED
    assert terminal.turns == 2
    assert len(terminal.results) == 2
    assert [r.tool_call_id for r in terminal.results] == ["c1", "c2"]
    assert isinstance(events[-1], LoopStopped)
    assert events[-1].terminal == terminal


def test_repeated_read_without_new_evidence_terminates_as_stalled():
    tool, state = make_counting_tool("read_same", value='{"value":"same"}')
    registry = ToolRegistry()
    registry.register(tool)
    backend = ScriptedBackend(
        *[
            [
                ToolCallArrived(
                    call=ToolCall(id=f"c{index}", name="read_same", arguments={})
                ),
                TurnDone(usage=None, raw_text=None),
            ]
            for index in range(1, 7)
        ]
    )

    events, terminal = asyncio.run(
        collect(make_params(client=LoopModelClient(backend), registry=registry))
    )

    assert terminal.reason is TransitionReason.STALLED
    assert terminal.turns == 4
    assert state["calls"] == 4
    assert len(backend.received) == 4
    third_request_messages = backend.received[2][0]
    assert any(
        "Tool loop warning" in (message.content or "")
        for message in third_request_messages
    )
    assert len([event for event in events if isinstance(event, ToolCallFinished)]) == 4


def test_fresh_read_evidence_can_continue_until_natural_completion():
    values = iter(("one", "two", "three", "four"))
    state = {"calls": 0}

    def execute_fresh(**_kwargs):
        state["calls"] += 1
        return next(values)

    tool = ToolSpec(
        name="read_fresh",
        description="returns new evidence on every call",
        input_schema=EMPTY_SCHEMA,
        execute=execute_fresh,
        effect=Effect.READ,
        used_backend="fake",
    )
    registry = ToolRegistry()
    registry.register(tool)
    backend = ScriptedBackend(
        *[
            [
                ToolCallArrived(
                    call=ToolCall(id=f"c{index}", name="read_fresh", arguments={})
                ),
                TurnDone(usage=None, raw_text=None),
            ]
            for index in range(1, 5)
        ],
        [TurnDone(usage=None, raw_text="done")],
    )

    _events, terminal = asyncio.run(
        collect(make_params(client=LoopModelClient(backend), registry=registry))
    )

    assert terminal.reason is TransitionReason.COMPLETED
    assert terminal.message == "done"
    assert terminal.turns == 5
    assert state["calls"] == 4


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
                budget_renewals=0,
            )
        )
    )

    assert len(backend.received) == 1
    assert terminal.reason is TransitionReason.BUDGET_EXHAUSTED
    assert terminal.turns == 1
    assert len(terminal.results) == 1
    assert isinstance(events[-1], LoopStopped)


def test_loop_default_clock_uses_milliseconds(monkeypatch):
    ticks = iter((1.0, 6.0))
    monkeypatch.setattr("app.agent_runtime.loop.time.perf_counter", lambda: next(ticks))
    backend = ScriptedBackend([TurnDone(usage=None, raw_text="must not run")])

    _events, terminal = asyncio.run(
        collect(
            make_params(
                client=LoopModelClient(backend),
                budget_renewals=0,
            )
        )
    )

    assert backend.received == []
    assert terminal.reason is TransitionReason.BUDGET_EXHAUSTED


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


def test_cancellation_during_model_call_cannot_commit_a_late_answer():
    cancel_registry = CancellationRegistry()

    class CancellingBackend:
        def generate(self, messages, tools, budget_ms=None, cancel_scope=None):
            assert cancel_scope is not None
            cancel_registry.cancel_all()
            yield TurnDone(usage=None, raw_text="late answer")

    with pytest.raises(CancelledError):
        asyncio.run(collect(make_params(
            client=LoopModelClient(CancellingBackend()),
            cancel_registry=cancel_registry,
        )))


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
        TransitionReason.COMPLETED,
    ]
    assert terminal.reason is TransitionReason.COMPLETED
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
    assert terminal.reason is TransitionReason.COMPLETED


def test_discovery_tool_loads_newly_registered_tools_for_next_model_turn():
    registry = ToolRegistry()

    def discover(scope=None):
        registry.register(ToolSpec(
            name="deferred_tool",
            description="registered only after provider discovery",
            input_schema=EMPTY_SCHEMA,
            execute=lambda scope=None: "done",
        ))
        return '{"tools":[{"name":"deferred_tool"}]}'

    registry.register(ToolSpec(
        name="provider_search",
        description="discover provider tools",
        input_schema=EMPTY_SCHEMA,
        execute=discover,
        discovers_tools=True,
    ))
    backend = ScriptedBackend(
        [
            ToolCallArrived(
                call=ToolCall(id="discover", name="provider_search", arguments={})
            ),
            TurnDone(usage=None, raw_text=None),
        ],
        [TurnDone(usage=None, raw_text="ready")],
    )

    _, terminal = asyncio.run(collect(make_params(
        client=LoopModelClient(backend),
        registry=registry,
        tool_limit=2,
    )))

    assert [schema["name"] for schema in backend.received[0][1]] == [
        "provider_search"
    ]
    assert [schema["name"] for schema in backend.received[1][1]] == [
        "deferred_tool",
        "provider_search",
    ]
    assert terminal.reason is TransitionReason.COMPLETED


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
    assert terminal.reason is TransitionReason.COMPLETED


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
    assert terminal.reason is TransitionReason.COMPLETED


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


def test_exclusive_tool_is_a_model_order_barrier_between_parallel_calls():
    order: list[str] = []

    def execute(call_id: str):
        def run(**_kwargs):
            order.append(call_id)
            return call_id

        return run

    registry = ToolRegistry()
    registry.register(
        ToolSpec(
            name="parallel_a",
            description="parallel a",
            input_schema=EMPTY_SCHEMA,
            execute=execute("c1"),
            is_concurrency_safe=True,
        )
    )
    registry.register(
        ToolSpec(
            name="exclusive",
            description="exclusive barrier",
            input_schema=EMPTY_SCHEMA,
            execute=execute("c2"),
            is_concurrency_safe=False,
        )
    )
    registry.register(
        ToolSpec(
            name="parallel_b",
            description="parallel b",
            input_schema=EMPTY_SCHEMA,
            execute=execute("c3"),
            is_concurrency_safe=True,
        )
    )
    backend = ScriptedBackend(
        [
            ToolCallArrived(call=ToolCall(id="c1", name="parallel_a", arguments={})),
            ToolCallArrived(call=ToolCall(id="c2", name="exclusive", arguments={})),
            ToolCallArrived(call=ToolCall(id="c3", name="parallel_b", arguments={})),
            TurnDone(usage=None, raw_text=None),
        ],
        [TurnDone(usage=None, raw_text="done")],
    )

    _events, terminal = asyncio.run(
        collect(make_params(client=LoopModelClient(backend), registry=registry))
    )

    assert order == ["c1", "c2", "c3"]
    assert [result.tool_call_id for result in terminal.results] == ["c1", "c2", "c3"]


def test_loop_parallel_pool_honors_configured_cap():
    lock = threading.Lock()
    active = 0
    peak = 0

    def execute(**_kwargs):
        nonlocal active, peak
        with lock:
            active += 1
            peak = max(peak, active)
        time.sleep(0.02)
        with lock:
            active -= 1
        return "ok"

    registry = ToolRegistry()
    calls = []
    for index in range(5):
        name = f"parallel_{index}"
        registry.register(
            ToolSpec(
                name=name,
                description=name,
                input_schema=EMPTY_SCHEMA,
                execute=execute,
                is_concurrency_safe=True,
            )
        )
        calls.append(ToolCallArrived(call=ToolCall(id=f"c{index}", name=name, arguments={})))
    backend = ScriptedBackend(
        [*calls, TurnDone(usage=None, raw_text=None)],
        [TurnDone(usage=None, raw_text="done")],
    )

    _events, terminal = asyncio.run(
        collect(
            make_params(
                client=LoopModelClient(backend),
                registry=registry,
                max_parallel_tool_calls=2,
            )
        )
    )

    assert peak == 2
    assert [result.tool_call_id for result in terminal.results] == [
        "c0",
        "c1",
        "c2",
        "c3",
        "c4",
    ]


def test_external_send_tool_denied_by_default_permission_gate():
    send, send_state = make_counting_tool("send_it", effect=Effect.EXTERNAL_SEND)
    registry = ToolRegistry()
    registry.register(send)
    backend = ScriptedBackend(
        [
            ToolCallArrived(call=ToolCall(id="c1", name="send_it", arguments={})),
            TurnDone(usage=None, raw_text=None),
        ],
        [TurnDone(usage=None, raw_text="cannot send, answering from here")],
    )
    client = LoopModelClient(backend)

    events, terminal = asyncio.run(collect(make_params(client=client, registry=registry)))

    assert send_state["calls"] == 0
    assert len(terminal.results) == 1
    result = terminal.results[0]
    assert result.is_error is True
    assert result.failure_type is FailureType.PERMISSION_DENIED
    assert "permission" in result.value
    assert "external_send" in result.value
    finished = [e for e in events if isinstance(e, TurnFinished)]
    tool_msg = finished[0].state.messages[2]
    assert tool_msg.is_error is True
    assert "permission" in tool_msg.content


def test_allowed_effects_expansion_permits_external_send():
    send, send_state = make_counting_tool(
        "send_it", value="sent", effect=Effect.EXTERNAL_SEND
    )
    registry = ToolRegistry()
    registry.register(send)
    backend = ScriptedBackend(
        [
            ToolCallArrived(call=ToolCall(id="c1", name="send_it", arguments={})),
            TurnDone(usage=None, raw_text=None),
        ],
        [TurnDone(usage=None, raw_text="sent!")],
    )
    client = LoopModelClient(backend)

    events, terminal = asyncio.run(
        collect(
            make_params(
                client=client,
                registry=registry,
                allowed_effects=(
                    Effect.READ,
                    Effect.REVERSIBLE_WRITE,
                    Effect.EXTERNAL_SEND,
                ),
                permission_mode="bypass",
            )
        )
    )

    assert send_state["calls"] == 1
    assert len(terminal.results) == 1
    assert terminal.results[0].is_error is False
    assert terminal.results[0].value == "sent"
    assert terminal.reason is TransitionReason.COMPLETED


def test_permission_mode_default_asks_external_send_even_when_effects_permit():
    send, send_state = make_counting_tool(
        "send_it", value="sent", effect=Effect.EXTERNAL_SEND
    )
    registry = ToolRegistry()
    registry.register(send)
    backend = ScriptedBackend(
        [
            ToolCallArrived(call=ToolCall(id="c1", name="send_it", arguments={})),
            TurnDone(usage=None, raw_text=None),
        ],
        [TurnDone(usage=None, raw_text="ok")],
    )
    client = LoopModelClient(backend)

    events, terminal = asyncio.run(
        collect(
            make_params(
                client=client,
                registry=registry,
                allowed_effects=(
                    Effect.READ,
                    Effect.REVERSIBLE_WRITE,
                    Effect.EXTERNAL_SEND,
                ),
                permission_mode="default",
            )
        )
    )

    assert send_state["calls"] == 0
    assert len(terminal.results) == 1
    assert terminal.results[0].is_error is True
    assert terminal.results[0].failure_type == FailureType.PERMISSION_DENIED
    assert "needs user confirmation" in terminal.results[0].value


def test_permission_mode_plan_denies_destructive():
    nuke, nuke_state = make_counting_tool(
        "nuke_it", value="gone", effect=Effect.DESTRUCTIVE
    )
    registry = ToolRegistry()
    registry.register(nuke)
    backend = ScriptedBackend(
        [
            ToolCallArrived(call=ToolCall(id="c1", name="nuke_it", arguments={})),
            TurnDone(usage=None, raw_text=None),
        ],
        [TurnDone(usage=None, raw_text="ok")],
    )
    client = LoopModelClient(backend)

    events, terminal = asyncio.run(
        collect(
            make_params(
                client=client,
                registry=registry,
                allowed_effects=(Effect.READ, Effect.DESTRUCTIVE),
                permission_mode="plan",
            )
        )
    )

    assert nuke_state["calls"] == 0
    assert terminal.results[0].is_error is True
    assert "denied in permission mode plan" in terminal.results[0].value


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
    assert terminal.reason is TransitionReason.COMPLETED


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
    assert terminal.reason is TransitionReason.COMPLETED
    finished = [e for e in events if isinstance(e, TurnFinished)]
    assert [e.state.transition for e in finished] == [
        TransitionReason.MAX_OUTPUT_TOKENS_RECOVERED,
        TransitionReason.MAX_OUTPUT_TOKENS_RECOVERED,
        TransitionReason.MAX_OUTPUT_TOKENS_RECOVERED,
        TransitionReason.COMPLETED,
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


def test_retryable_backend_error_retries_below_agent_loop_without_fake_messages():
    backend = ScriptedBackend(
        withheld_scene(reason="backend_error:model_request_timeout"),
        [TurnDone(usage=None, raw_text="recovered answer")],
    )
    client = LoopModelClient(backend)

    events, terminal = asyncio.run(collect(make_params(client=client)))

    assert len(backend.received) == 2
    assert terminal.reason is TransitionReason.COMPLETED
    assert terminal.message == "recovered answer"
    assert terminal.turns == 1
    assert backend.received[0][0] == backend.received[1][0]
    assert not any(
        message.injected
        for received in backend.received
        for message in received[0]
    )


def test_provider_retry_never_outlives_the_model_call_budget():
    clock = FakeClock()

    class SlowFailingBackend(ScriptedBackend):
        def generate(self, messages, tools, budget_ms=None, cancel_scope=None):
            self.received.append((list(messages), list(tools), budget_ms, cancel_scope))
            clock.advance(3_900)
            yield from withheld_scene(reason="backend_error:model_request_timeout")

    backend = SlowFailingBackend()
    client = LoopModelClient(
        backend,
        retry_sleeper=lambda seconds: clock.advance(seconds * 1000),
        retry_clock=lambda: clock() / 1000.0,
    )

    events = client.generate_turn([], [], budget_ms=4_000)

    assert len(backend.received) == 1
    assert any(isinstance(event, TurnWithheld) for event in events)


def test_exhausted_model_call_budget_never_enters_provider() -> None:
    backend = ScriptedBackend([TurnDone(usage=None, raw_text="too late")])
    client = LoopModelClient(backend, retry_clock=lambda: 10.0)

    events = client.generate_turn([], [], budget_ms=0)

    assert backend.received == []
    assert events == [
        TurnWithheld(reason="backend_error:model_request_timeout"),
        TurnDone(usage=None, raw_text=None),
    ]


def test_raising_model_adapter_is_retried_without_crashing_the_agent():
    class RaisingOnceBackend:
        def __init__(self) -> None:
            self.calls = 0

        def generate(self, messages, tools, budget_ms=None, cancel_scope=None):
            self.calls += 1
            if self.calls == 1:
                raise OSError("temporary transport failure")
            yield TurnDone(usage=None, raw_text="recovered")

    backend = RaisingOnceBackend()
    client = LoopModelClient(backend, retry_sleeper=lambda _seconds: None)

    _events, terminal = asyncio.run(collect(make_params(client=client)))

    assert backend.calls == 2
    assert terminal.reason is TransitionReason.COMPLETED
    assert terminal.message == "recovered"


def test_duplicate_provider_call_id_is_rewritten_against_resumed_history():
    history = [AgentMessage(
        role=Role.ASSISTANT,
        content=None,
        tool_call_id=None,
        name=None,
        origin="data",
        tool_calls=({"id": "call_0", "name": "old_tool", "arguments": {}},),
    )]
    backend = ScriptedBackend([
        ToolCallArrived(call=ToolCall(id="call_0", name="new_tool", arguments={})),
        TurnDone(usage=None, raw_text=None),
    ])
    client = LoopModelClient(backend)

    events = client.generate_turn(history, [])
    calls, _text = client.parse_tool_calls(events)

    assert len(calls) == 1
    assert calls[0].id != "call_0"
    assert calls[0].id.startswith("mp_call_")


def test_persistent_backend_errors_terminate_as_provider_unavailable():
    """Provider retries are bounded below the loop and never become turns."""
    scenes = [
        withheld_scene(reason=f"backend_error:stuck_{index}")
        for index in range(12)
    ]
    backend = ScriptedBackend(*scenes)
    client = LoopModelClient(backend)

    events, terminal = asyncio.run(collect(make_params(client=client)))

    assert len(backend.received) == 3
    assert terminal.reason is TransitionReason.PROVIDER_UNAVAILABLE
    assert terminal.turns == 1
    assert "stuck_2" in terminal.message
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
    assert [m.role for m in second_messages] == [
        Role.USER,
        Role.ASSISTANT,
        Role.TOOL,
    ]
    assert second_messages[1].tool_calls[0]["id"] == "c1"
    assert second_messages[2].content == "输出被截断，重新生成"
    assert second_messages[2].is_error is False
    assert second_messages[2].tool_call_id == "c1"
    assert terminal.turns == 2
    assert terminal.message == "final answer"
    assert terminal.reason is TransitionReason.COMPLETED


def test_truncation_closes_every_tool_call_before_next_model_request():
    backend = ScriptedBackend(
        [
            MessageDelta("partial…"),
            ToolCallArrived(call=ToolCall(id="c1", name="first", arguments={})),
            ToolCallArrived(call=ToolCall(id="c2", name="second", arguments={})),
            TurnDone(usage=None, raw_text="partial…"),
        ],
        [TurnDone(usage=None, raw_text="regenerated")],
    )

    _events, terminal = asyncio.run(
        collect(make_params(client=LoopModelClient(backend)))
    )

    second_messages = backend.received[1][0]
    assistant = second_messages[1]
    results = second_messages[2:]
    assert [call["id"] for call in assistant.tool_calls] == ["c1", "c2"]
    assert [message.tool_call_id for message in results] == ["c1", "c2"]
    assert all(message.content == "输出被截断，重新生成" for message in results)
    assert terminal.message == "regenerated"


def test_stop_hooks_see_latest_state_with_tool_results_once_per_round():
    tool, _ = make_counting_tool("seen_tool")
    registry = ToolRegistry()
    registry.register(tool)
    seen: list[tuple] = []

    def hook(state):
        seen.append((tuple(m.role for m in state.messages), state.messages[-1].content))
        return StopDecision(reason=None, prevent_continuation=False)

    backend = ScriptedBackend(
        [
            ToolCallArrived(call=ToolCall(id="c1", name="seen_tool", arguments={})),
            TurnDone(usage=None, raw_text=None),
        ],
        [TurnDone(usage=None, raw_text="final")],
    )
    client = LoopModelClient(backend)

    events, terminal = asyncio.run(
        collect(make_params(client=client, registry=registry, stop_hooks=[hook]))
    )

    assert terminal.reason is TransitionReason.COMPLETED
    assert len(seen) == 1, "hooks must evaluate once per round, at the answer boundary"
    assert seen[0][0] == (Role.USER, Role.ASSISTANT, Role.TOOL, Role.ASSISTANT)
    assert seen[0][1] == "final"
    assert [e.state.transition for e in events if isinstance(e, TurnFinished)] == [
        TransitionReason.TOOL_RESULT,
        TransitionReason.COMPLETED,
    ]


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
    assert terminal.reason is TransitionReason.COMPLETED
    finished = [e for e in events if isinstance(e, TurnFinished)]
    assert finished[0].state.transition is TransitionReason.STOP_HOOK
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


def test_compactor_replaces_messages_exactly_once_on_withheld():
    calls = {"n": 0}

    def compact(messages):
        calls["n"] += 1
        return messages[:-1] if len(messages) > 1 else list(messages)

    backend = ScriptedBackend(
        withheld_scene(),
        withheld_scene(),
        [TurnDone(usage=None, raw_text="ok")],
    )
    client = LoopModelClient(backend)

    events, terminal = asyncio.run(
        collect(make_params(client=client, compactor=compact))
    )

    assert calls["n"] == 1
    finished = [e for e in events if isinstance(e, TurnFinished)]
    assert finished[0].state.transition is TransitionReason.COMPACT_TRIGGERED
    assert finished[0].state.has_attempted_reactive_compact is True
    assert finished[1].state.transition is TransitionReason.MAX_OUTPUT_TOKENS_RECOVERED
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
    assert terminal.reason is TransitionReason.COMPLETED


def test_budget_renews_after_productive_round_and_emits_event():
    """T1: a productive round renews the deadline; BudgetRenewed is emitted."""
    clock = FakeClock()
    tool, _ = make_counting_tool(
        "work_tool", value="ok", on_call=lambda: clock.advance(10_000)
    )
    registry = ToolRegistry()
    registry.register(tool)
    backend = ScriptedBackend(
        [
            ToolCallArrived(call=ToolCall(id="c1", name="work_tool", arguments={})),
            TurnDone(usage=None, raw_text=None),
        ],
        [TurnDone(usage=None, raw_text="finished after renewal")],
    )
    client = LoopModelClient(backend)

    events, terminal = asyncio.run(
        collect(make_params(client=client, registry=registry, clock=clock))
    )

    renewals = [e for e in events if isinstance(e, BudgetRenewed)]
    assert len(renewals) == 1
    assert renewals[0].turn == 2
    assert renewals[0].renewals_used == 1
    assert len(backend.received) == 2
    assert terminal.reason is TransitionReason.COMPLETED
    assert terminal.message == "finished after renewal"


def test_budget_renewal_denied_for_error_only_rounds():
    """T1: a round where every tool errored is not productive -> hard cut."""
    clock = FakeClock()
    tool, _ = make_counting_tool(
        "err_tool",
        fail=ActionFailure(FailureType.TOOL_ERROR, "boom"),
        on_call=lambda: clock.advance(10_000),
    )
    registry = ToolRegistry()
    registry.register(tool)
    backend = ScriptedBackend(
        [
            ToolCallArrived(call=ToolCall(id="c1", name="err_tool", arguments={})),
            TurnDone(usage=None, raw_text=None),
        ],
        [TurnDone(usage=None, raw_text="never")],
    )
    client = LoopModelClient(backend)

    events, terminal = asyncio.run(
        collect(make_params(client=client, registry=registry, clock=clock))
    )

    assert [type(e).__name__ for e in events].count("BudgetRenewed") == 0
    assert len(backend.received) == 1
    assert terminal.reason is TransitionReason.BUDGET_EXHAUSTED


def test_budget_renewals_bounded_by_budget_renewals_param():
    """T1: renewal is bounded; exhausted renewals -> hard cut."""
    clock = FakeClock()
    tool, _ = make_counting_tool(
        "work_tool", value="ok", on_call=lambda: clock.advance(10_000)
    )
    registry = ToolRegistry()
    registry.register(tool)
    backend = ScriptedBackend(
        [
            ToolCallArrived(call=ToolCall(id="c1", name="work_tool", arguments={})),
            TurnDone(usage=None, raw_text=None),
        ],
        [
            ToolCallArrived(call=ToolCall(id="c2", name="work_tool", arguments={})),
            TurnDone(usage=None, raw_text=None),
        ],
        [TurnDone(usage=None, raw_text="never")],
    )
    client = LoopModelClient(backend)

    events, terminal = asyncio.run(
        collect(make_params(client=client, registry=registry, clock=clock, budget_renewals=1))
    )

    renewals = [e for e in events if isinstance(e, BudgetRenewed)]
    assert len(renewals) == 1
    assert len(backend.received) == 2
    assert terminal.reason is TransitionReason.BUDGET_EXHAUSTED


def test_productive_rounds_are_not_hard_cut_when_renewals_are_exhausted():
    """A productive round must renew even past the renewals cap: the budget
    constrains feedback rhythm, not loop life. Only non-productive rounds
    (duplicate evidence, pure errors, stalls) are hard-cut at the deadline."""
    clock = FakeClock()
    values = ["evidence-1", "evidence-2", "evidence-3", "evidence-4"]
    calls = {"n": 0}

    def execute(scope=None, **kwargs):
        index = min(calls["n"], len(values) - 1)
        calls["n"] += 1
        clock.advance(10_000)
        return values[index]

    registry = ToolRegistry()
    registry.register(ToolSpec(
        name="read_more",
        description="read one more distinct piece",
        input_schema=EMPTY_SCHEMA,
        execute=execute,
        effect=Effect.READ,
        is_concurrency_safe=True,
        used_backend="fake_read",
    ))
    rounds = []
    for _ in range(4):
        rounds.append([
            ToolCallArrived(call=ToolCall(id=f"c{len(rounds)}", name="read_more", arguments={})),
            TurnDone(usage=None, raw_text=None),
        ])
    rounds.append([TurnDone(usage=None, raw_text="done")])
    backend = ScriptedBackend(*rounds)
    client = LoopModelClient(backend)

    events, terminal = asyncio.run(
        collect(make_params(client=client, registry=registry, clock=clock, budget_renewals=1))
    )

    assert calls["n"] == 4
    assert len(backend.received) == 5
    assert terminal.reason is TransitionReason.COMPLETED
    assert terminal.message == "done"


def test_proactive_compaction_replaces_history_at_seventy_percent():
    """Proactive compaction fires before a model call at >=70% token budget."""
    calls = {"n": 0}

    def compactor(messages):
        calls["n"] += 1
        return messages[:-1]

    def estimator(messages):
        return sum(len(m.content or "") for m in messages)

    backend = ScriptedBackend([TurnDone(usage=None, raw_text="done")])
    client = LoopModelClient(backend)

    events, terminal = asyncio.run(
        collect(
            make_params(
                client=client,
                user_input="x" * 80,
                compactor=compactor,
                context_budget_tokens=100,
                token_estimator=estimator,
            )
        )
    )

    assert calls["n"] == 1
    finished = [e for e in events if isinstance(e, TurnFinished)]
    assert finished[0].state.transition is TransitionReason.COMPACT_TRIGGERED
    assert terminal.reason is TransitionReason.COMPLETED
    assert terminal.message == "done"


def test_event_sink_sees_every_event_before_the_caller():
    seen: list = []
    backend = ScriptedBackend([TurnDone(usage=None, raw_text="hi")])
    client = LoopModelClient(backend)

    events, terminal = asyncio.run(
        collect(make_params(client=client, event_sink=seen.append))
    )

    assert [type(e).__name__ for e in seen] == [type(e).__name__ for e in events]
    assert seen[0] is events[0]


def test_raising_event_sink_never_kills_the_loop():
    def boom(_event):
        raise RuntimeError("sink failure")

    backend = ScriptedBackend([TurnDone(usage=None, raw_text="hi")])
    client = LoopModelClient(backend)

    events, terminal = asyncio.run(
        collect(make_params(client=client, event_sink=boom))
    )

    assert terminal.reason is TransitionReason.COMPLETED
    assert terminal.message == "hi"
