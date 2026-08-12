"""Governance wiring tests for the agent loop (plan T5.1).

Covers the real wiring between the loop/tools and the governance modules:

1. Latency budget: the loop checks the FULL_ANSWER stage via
   ``check_budget`` at every round start; DEFAULT_BUDGETS is the
   LoopParams default; exactly-at-boundary runs complete, over-limit runs
   terminate with Terminal(reason=budget_exhausted) and no new model call.
2. Cancellation (generational teardown): LoopParams.cancel_registry drives
   the loop; cancel_all from an external thread mid-run raises
   CancelledError before the next model call and before tool execution;
   already-submitted parallel tools run to completion but the loop
   terminates instead of continuing.
3. Evidence contract at the message boundary: perception tools return
   Evidence; the loop serializes it into readable ``{status, confidence,
   value, note}`` text for the model (no repr leakage) while the registry
   layer keeps the Evidence object; the Evidence invariant (status=ok
   must carry value + confidence >= 0.5) is enforced.
4. Honest failures: validate_input failures and ActionFailure(timeout)
   from perception backends transmit ``failure_type`` (TOOL_ERROR /
   TIMEOUT) into Terminal.results and the tool messages.

All backends are fakes; nothing real is touched, no network, no desktop.
"""

from __future__ import annotations

import asyncio
import json
import sys
import threading
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.agent_runtime.errors import FailureType  # noqa: E402
from app.agent_runtime.loop import (  # noqa: E402
    LoopParams,
    LoopStopped,
    StopDecision,
    TurnFinished,
    run_agent_loop,
)
from app.agent_runtime.model_client import (  # noqa: E402
    LoopModelClient,
    ToolCallArrived,
    TurnDone,
)
from app.agent_runtime.perception_tools import (  # noqa: E402
    BackendBusy,
    PerceptionTools,
    evidence_to_text,
)
from app.agent_runtime.tool_registry import Effect, ToolRegistry, ToolSpec  # noqa: E402
from app.agent_runtime.types import (  # noqa: E402
    Role,
    Terminal,
    ToolCall,
    TransitionReason,
)
from app.evidence.contract import (  # noqa: E402
    Evidence,
    EvidenceSource,
    EvidenceStatus,
    ok_evidence,
)
from app.governance.cancellation import (  # noqa: E402
    CancellationRegistry,
    CancelledError,
)
from app.governance.latency_budget import (  # noqa: E402
    DEFAULT_BUDGETS,
    BudgetPolicy,
    Stage,
    TimeoutAction,
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


class CancellingBackend:
    """ModelBackend that cancels the registry while producing a tool call."""

    def __init__(self, registry: CancellationRegistry) -> None:
        self.registry = registry
        self.received: list[tuple] = []

    def generate(self, messages, tools, budget_ms=None, cancel_scope=None):
        self.received.append((list(messages), list(tools), budget_ms, cancel_scope))
        self.registry.cancel_all()
        yield ToolCallArrived(call=ToolCall(id="c1", name="cancel_me", arguments={}))
        yield TurnDone(usage=None, raw_text=None)


class FakeClock:
    """Callable fake clock: manual elapsed-ms advance."""

    def __init__(self) -> None:
        self.elapsed = 0.0

    def __call__(self) -> float:
        return self.elapsed

    def advance(self, ms: float) -> None:
        self.elapsed += ms


class FakeBackend:
    """In-memory PerceptionBackend; behaviour switchable per test."""

    def __init__(self) -> None:
        self.read_around_calls: list[tuple[str, int]] = []
        self.read_items: list[dict] = []
        self.busy: bool = False
        self.timeout: bool = False

    def read_around(self, anchor: str, radius: int) -> list[dict]:
        self.read_around_calls.append((anchor, radius))
        if self.busy:
            raise BackendBusy("perception worker occupied")
        if self.timeout:
            raise TimeoutError("backend timed out")
        return self.read_items

    def dump_subtree(self, anchor: str, depth: int) -> dict | None:
        return None

    def find_in_window(self, pattern: str) -> list[dict]:
        return []

    def list_windows(self) -> list[dict]:
        return []

    def get_focused(self) -> dict | None:
        return None


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
    """ToolSpec whose execute is a counter; ``fail`` is a raised exception."""

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
    """Consume the async generator; return (events, terminal)."""

    events = []
    generator = run_agent_loop(params)
    while True:
        try:
            events.append(await generator.__anext__())
        except StopAsyncIteration:
            break
    assert isinstance(events[-1], LoopStopped), "loop must end with LoopStopped"
    return events, events[-1].terminal


def perception_registry(backend: FakeBackend) -> ToolRegistry:
    registry = ToolRegistry()
    PerceptionTools(backend).register_all(registry)
    return registry


# --- 1. latency budget -------------------------------------------------------


def test_budget_exactly_at_boundary_completes():
    clock = FakeClock()
    tool, _ = make_counting_tool(
        "boundary_tool", value="x", on_call=lambda: clock.advance(4000)
    )
    registry = ToolRegistry()
    registry.register(tool)
    backend = ScriptedBackend(
        [ToolCallArrived(call=ToolCall(id="c1", name="boundary_tool", arguments={})), TurnDone(usage=None, raw_text=None)],
        [TurnDone(usage=None, raw_text="just in time")],
    )
    client = LoopModelClient(backend)

    events, terminal = asyncio.run(
        collect(make_params(client=client, registry=registry, clock=clock))
    )

    assert len(backend.received) == 2, "elapsed == budget must still run the round"
    assert terminal.reason is TransitionReason.TOOL_RESULT
    assert terminal.turns == 2
    assert terminal.message == "just in time"
    finished = [e for e in events if isinstance(e, TurnFinished)]
    assert finished[0].state.budget_remaining_ms == 4000.0


def test_budget_over_limit_terminates_without_new_model_call():
    clock = FakeClock()
    tool, _ = make_counting_tool(
        "slow_tool", value="x", on_call=lambda: clock.advance(4001)
    )
    registry = ToolRegistry()
    registry.register(tool)
    backend = ScriptedBackend(
        [ToolCallArrived(call=ToolCall(id="c1", name="slow_tool", arguments={})), TurnDone(usage=None, raw_text=None)],
        [TurnDone(usage=None, raw_text="too late")],
    )
    client = LoopModelClient(backend)

    events, terminal = asyncio.run(
        collect(make_params(client=client, registry=registry, clock=clock))
    )

    assert len(backend.received) == 1, "no model call after budget blown"
    assert terminal.reason is TransitionReason.BUDGET_EXHAUSTED
    assert terminal.message == "full answer budget exhausted"
    assert terminal.turns == 1
    assert len(terminal.results) == 1
    assert terminal.results[0].tool_call_id == "c1"
    assert isinstance(events[-1], LoopStopped)


def test_loop_uses_injected_budgets_mapping_not_hardcoded_defaults():
    clock = FakeClock()
    tool, _ = make_counting_tool(
        "injected_tool", value="x", on_call=lambda: clock.advance(101)
    )
    registry = ToolRegistry()
    registry.register(tool)
    budgets = {
        Stage.FULL_ANSWER: BudgetPolicy(
            stage=Stage.FULL_ANSWER,
            budget_ms=100,
            on_timeout=TimeoutAction.STASH_BACKGROUND,
        )
    }
    backend = ScriptedBackend(
        [ToolCallArrived(call=ToolCall(id="c1", name="injected_tool", arguments={})), TurnDone(usage=None, raw_text=None)],
        [TurnDone(usage=None, raw_text="never reached")],
    )
    client = LoopModelClient(backend)

    events, terminal = asyncio.run(
        collect(make_params(client=client, registry=registry, clock=clock, budgets=budgets))
    )

    assert terminal.reason is TransitionReason.BUDGET_EXHAUSTED
    assert len(backend.received) == 1
    assert terminal.turns == 1


def test_default_budgets_is_loop_params_default():
    params = make_params()
    assert params.budgets is DEFAULT_BUDGETS
    assert Stage.FULL_ANSWER in params.budgets
    assert params.budgets[Stage.FULL_ANSWER].budget_ms == 4000


# --- 2. cancellation (generational teardown) ---------------------------------


def test_external_cancel_between_rounds_no_new_model_calls():
    cancel_registry = CancellationRegistry()
    tool, tool_state = make_counting_tool("round_tool", value="x")
    registry = ToolRegistry()
    registry.register(tool)
    backend = ScriptedBackend(
        [ToolCallArrived(call=ToolCall(id="c1", name="round_tool", arguments={})), TurnDone(usage=None, raw_text=None)],
        [TurnDone(usage=None, raw_text="never reached")],
    )
    client = LoopModelClient(backend)

    def cancelling_hook(state):
        cancel_registry.cancel_all()
        return StopDecision(reason=None, prevent_continuation=False)

    with pytest.raises(CancelledError):
        asyncio.run(
            collect(
                make_params(
                    client=client,
                    registry=registry,
                    cancel_registry=cancel_registry,
                    stop_hooks=[cancelling_hook],
                )
            )
        )

    assert len(backend.received) == 1, "zero new model calls after cancellation"
    assert tool_state["calls"] == 1


def test_cancel_during_parallel_batch_submitted_tools_complete_loop_terminates():
    cancel_registry = CancellationRegistry()
    slow_started = threading.Event()
    fast, fast_state = make_counting_tool(
        "fast_p",
        value="x",
        concurrency_safe=True,
        on_call=lambda: (slow_started.wait(2.0), cancel_registry.cancel_all()),
    )
    slow, slow_state = make_counting_tool(
        "slow_p",
        value="x",
        concurrency_safe=True,
        delay=0.1,
        on_call=slow_started.set,
    )
    seq, seq_state = make_counting_tool("seq_after", value="x")
    registry = ToolRegistry()
    registry.register(fast)
    registry.register(slow)
    registry.register(seq)
    backend = ScriptedBackend(
        [
            ToolCallArrived(call=ToolCall(id="c1", name="fast_p", arguments={})),
            ToolCallArrived(call=ToolCall(id="c2", name="slow_p", arguments={})),
            ToolCallArrived(call=ToolCall(id="c3", name="seq_after", arguments={})),
            TurnDone(usage=None, raw_text=None),
        ],
        [TurnDone(usage=None, raw_text="never reached")],
    )
    client = LoopModelClient(backend)

    with pytest.raises(CancelledError):
        asyncio.run(
            collect(
                make_params(
                    client=client,
                    registry=registry,
                    cancel_registry=cancel_registry,
                )
            )
        )

    assert fast_state["calls"] == 1, "already-started parallel tool ran to completion"
    assert slow_state["calls"] == 1, "already-started parallel tool ran to completion"
    assert seq_state["calls"] == 0, "not-yet-started tools must not run after cancel"
    assert len(backend.received) == 1


def test_cancel_before_tool_execution_skips_execute():
    cancel_registry = CancellationRegistry()
    tool, tool_state = make_counting_tool("cancel_me", value="x")
    registry = ToolRegistry()
    registry.register(tool)
    backend = CancellingBackend(cancel_registry)
    client = LoopModelClient(backend)

    with pytest.raises(CancelledError):
        asyncio.run(
            collect(
                make_params(
                    client=client,
                    registry=registry,
                    cancel_registry=cancel_registry,
                )
            )
        )

    assert tool_state["calls"] == 0, "cancelled before execution must skip execute"
    assert len(backend.received) == 1


def test_cancel_all_mid_turn_tool_completes_then_loop_raises():
    cancel_registry = CancellationRegistry()
    tool, tool_state = make_counting_tool(
        "cancel_me", value="x", on_call=cancel_registry.cancel_all
    )
    registry = ToolRegistry()
    registry.register(tool)
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
                    registry=registry,
                    cancel_registry=cancel_registry,
                )
            )
        )

    assert tool_state["calls"] == 1
    assert len(backend.received) == 1


# --- 3. evidence contract at the message boundary ----------------------------


def test_perception_tool_message_is_readable_text_not_repr():
    backend = FakeBackend()
    backend.read_items = [
        {"text": "hello world", "source": "uia", "bbox_ltrb": [0, 0, 1, 1], "confidence": 1.0}
    ]
    registry = perception_registry(backend)
    model = ScriptedBackend(
        [
            ToolCallArrived(call=ToolCall(id="c1", name="read_around", arguments={"anchor": "a"})),
            TurnDone(usage=None, raw_text=None),
        ],
        [TurnDone(usage=None, raw_text="seen it")],
    )
    client = LoopModelClient(model)

    events, terminal = asyncio.run(collect(make_params(client=client, registry=registry)))

    finished = [e for e in events if isinstance(e, TurnFinished)]
    tool_msg = finished[0].state.messages[1]
    assert tool_msg.role is Role.TOOL
    assert "Evidence(" not in tool_msg.content, "model must not see a repr"
    payload = json.loads(tool_msg.content)
    assert payload["status"] == "ok"
    assert payload["value"] == "hello world"
    assert payload["confidence"] == 1.0
    assert "source(s)" in payload["note"]
    assert terminal.results[0].value == tool_msg.content
    raw = registry.execute_tool("read_around", {"anchor": "a"})
    assert isinstance(raw.value, Evidence), "registry layer keeps the Evidence object"


def test_evidence_to_text_serializes_status_confidence_value_note():
    evidence = ok_evidence(
        "text payload",
        EvidenceSource.UIA,
        note="2 items",
        confidence=0.9,
    )
    text = evidence_to_text(evidence)
    payload = json.loads(text)
    assert payload == {
        "status": "ok",
        "confidence": 0.9,
        "value": "text payload",
        "note": "2 items",
    }

    busy = Evidence(
        value=None,
        status=EvidenceStatus.BUSY,
        confidence=0.0,
        source=EvidenceSource.UIA,
        note="backend busy",
    )
    busy_payload = json.loads(evidence_to_text(busy))
    assert busy_payload["status"] == "busy"
    assert busy_payload["value"] is None
    assert "Evidence(" not in evidence_to_text(busy)


def test_evidence_validation_status_ok_requires_value_and_confidence():
    with pytest.raises(ValueError, match="value must not be None"):
        Evidence(
            value=None,
            status=EvidenceStatus.OK,
            confidence=1.0,
            source=EvidenceSource.UIA,
        )
    with pytest.raises(ValueError, match="confidence"):
        Evidence(
            value="x",
            status=EvidenceStatus.OK,
            confidence=0.4,
            source=EvidenceSource.UIA,
        )
    with pytest.raises(ValueError, match="confidence"):
        Evidence(
            value="x",
            status=EvidenceStatus.OK,
            confidence=1.5,
            source=EvidenceSource.UIA,
        )


def test_evidence_status_ok_passes_validation():
    ok_evidence("fine", EvidenceSource.TEST, confidence=0.9)
    busy = Evidence(
        value=None,
        status=EvidenceStatus.BUSY,
        confidence=0.0,
        source=EvidenceSource.UIA,
    )
    assert busy.value is None


# --- 4. honest failures ------------------------------------------------------


def test_perception_timeout_failure_type_transmits_to_terminal():
    backend = FakeBackend()
    backend.timeout = True
    registry = perception_registry(backend)
    model = ScriptedBackend(
        [
            ToolCallArrived(call=ToolCall(id="c1", name="read_around", arguments={"anchor": "a"})),
            TurnDone(usage=None, raw_text=None),
        ],
        [TurnDone(usage=None, raw_text="retried")],
    )
    client = LoopModelClient(model)

    events, terminal = asyncio.run(collect(make_params(client=client, registry=registry)))

    result = terminal.results[0]
    assert result.is_error is True
    assert result.failure_type is FailureType.TIMEOUT
    assert "read_around timed out" in result.value
    assert result.used_backend == "perception_backend"
    finished = [e for e in events if isinstance(e, TurnFinished)]
    tool_msg = finished[0].state.messages[1]
    assert tool_msg.is_error is True
    assert "read_around timed out" in tool_msg.content
    assert terminal.reason is TransitionReason.TOOL_ERROR
    assert terminal.turns == 2


def test_validate_input_failure_failure_type_tool_error():
    backend = FakeBackend()
    registry = perception_registry(backend)
    model = ScriptedBackend(
        [
            ToolCallArrived(call=ToolCall(id="c1", name="read_around", arguments={"radius": 2})),
            TurnDone(usage=None, raw_text=None),
        ],
        [TurnDone(usage=None, raw_text="asked again")],
    )
    client = LoopModelClient(model)

    events, terminal = asyncio.run(collect(make_params(client=client, registry=registry)))

    assert backend.read_around_calls == [], "validate_input failure must not execute"
    result = terminal.results[0]
    assert result.is_error is True
    assert result.failure_type is FailureType.TOOL_ERROR
    assert "anchor" in result.value
    finished = [e for e in events if isinstance(e, TurnFinished)]
    assert finished[0].state.messages[1].is_error is True
    assert terminal.reason is TransitionReason.TOOL_ERROR
