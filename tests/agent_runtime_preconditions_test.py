"""Tests for ToolSpec.preconditions + loop wiring (plan B2).

The loop evaluates a tool's declared preconditions against a
``PreconditionContext`` supplied by an injected factory
(``LoopParams.precondition_context_factory``) right before execution:

- ``preconditions=()`` (the default) keeps the batch-1 behavior untouched.
- A configured factory whose returned context fails any precondition blocks
  the execution (execute never runs, call count stays 0) and feeds the model
  an is_error ToolResult with the failure_type passthrough.
- A factory that returns ``None`` means "cannot evaluate" and is rejected
  fail-closed (PERMISSION_DENIED); a **missing** factory (None) skips
  evaluation entirely (batch-1 compatibility).

All tests use fake tools and fake model backends; nothing real is touched.
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.action_guard.preconditions import (  # noqa: E402
    ContentUnchanged,
    NoModalSince,
    PreconditionContext,
    ResolvedExact,
    TargetFocused,
)
from app.agent_runtime.errors import FailureType  # noqa: E402
from app.agent_runtime.loop import (  # noqa: E402
    LoopParams,
    LoopStopped,
    ToolCallFinished,
    TurnFinished,
    run_agent_loop,
)
from app.agent_runtime.model_client import (  # noqa: E402
    LoopModelClient,
    ToolCallArrived,
    TurnDone,
)
from app.agent_runtime.tool_registry import ToolRegistry, ToolSpec  # noqa: E402
from app.agent_runtime.types import (  # noqa: E402
    Role,
    ToolCall,
    TransitionReason,
)
from app.anchor import (  # noqa: E402
    Anchor,
    AppIdentity,
    ResolutionAmbiguous,
    ResolutionExact,
    ResolutionGone,
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


def make_guarded_tool(name, preconditions=(), value="ok", concurrency_safe=False):
    """ToolSpec with optional preconditions; execute is a call counter."""

    state = {"calls": 0}

    def execute(**kwargs):
        state["calls"] += 1
        return value

    spec = ToolSpec(
        name=name,
        description=f"fake guarded tool {name}",
        input_schema=EMPTY_SCHEMA,
        execute=execute,
        preconditions=tuple(preconditions),
        is_concurrency_safe=concurrency_safe,
    )
    return spec, state


def make_anchor(anchor_id="a1"):
    return Anchor(
        anchor_id=anchor_id,
        app_identity=AppIdentity(process_name="notepad.exe"),
        captured_at_utc="2026-08-13T00:00:00Z",
    )


def fixed_context(context):
    """A precondition_context_factory that always returns ``context``."""

    def factory(call: ToolCall) -> PreconditionContext:
        return context

    return factory


def guarded_scene(name, call_id="c1", arguments=None):
    return [
        ToolCallArrived(
            call=ToolCall(id=call_id, name=name, arguments=arguments or {})
        ),
        TurnDone(usage=None, raw_text=None),
    ]


def run_round(name, *, spec, factory, second_scene=None):
    """Run one tool round with the given spec/factory; return (events, terminal)."""

    registry = ToolRegistry()
    registry.register(spec)
    scenes = [guarded_scene(name)]
    scenes.append(
        second_scene if second_scene is not None else [TurnDone(usage=None, raw_text="done")]
    )
    backend = ScriptedBackend(*scenes)
    params = LoopParams(
        user_input="hello",
        registry=registry,
        client=LoopModelClient(backend),
        precondition_context_factory=factory,
    )
    return collect(params)


def collect(params: LoopParams):
    events = []
    generator = run_agent_loop(params)
    while True:
        try:
            events.append(asyncio.run(generator.__anext__()))
        except StopAsyncIteration:
            break
    assert isinstance(events[-1], LoopStopped), "loop must end with LoopStopped"
    return events, events[-1].terminal


def test_empty_preconditions_keep_old_behavior():
    spec, state = make_guarded_tool("plain")
    events, terminal = run_round(
        "plain", spec=spec, factory=fixed_context(PreconditionContext())
    )

    assert state["calls"] == 1
    assert terminal.results[0].is_error is False
    assert terminal.results[0].value == "ok"
    assert terminal.reason is TransitionReason.COMPLETED


def test_empty_preconditions_never_call_factory():
    called = {"n": 0}

    def factory(call):
        called["n"] += 1
        return PreconditionContext()

    spec, state = make_guarded_tool("plain")
    events, terminal = run_round("plain", spec=spec, factory=factory)

    assert called["n"] == 0
    assert state["calls"] == 1
    assert terminal.results[0].is_error is False


def test_resolved_exact_passes_and_executes():
    anchor = make_anchor()
    context = PreconditionContext(resolution=ResolutionExact(anchor, evidence=("e",)))
    spec, state = make_guarded_tool("gated", preconditions=[ResolvedExact()])

    events, terminal = run_round("gated", spec=spec, factory=fixed_context(context))

    assert state["calls"] == 1
    assert terminal.results[0].is_error is False
    assert terminal.results[0].failure_type is None
    assert terminal.reason is TransitionReason.COMPLETED


def test_gone_resolution_blocks_execution_with_stale_anchor():
    context = PreconditionContext(
        resolution=ResolutionGone(anchor=make_anchor(), reason="window closed")
    )
    spec, state = make_guarded_tool("gated", preconditions=[ResolvedExact()])

    events, terminal = run_round("gated", spec=spec, factory=fixed_context(context))

    assert state["calls"] == 0
    assert len(terminal.results) == 1
    result = terminal.results[0]
    assert result.is_error is True
    assert result.failure_type is FailureType.STALE_ANCHOR
    assert "expected exact" in result.value
    assert result.used_backend is None
    assert result.latency_ms is None
    finished = [e for e in events if isinstance(e, TurnFinished)]
    tool_msg = finished[0].state.messages[1]
    assert tool_msg.role is Role.TOOL
    assert tool_msg.is_error is True
    assert tool_msg.tool_call_id == "c1"


def test_ambiguous_resolution_hint_mentions_ambiguous():
    context = PreconditionContext(
        resolution=ResolutionAmbiguous(
            anchor=make_anchor("a0"),
            candidates=(make_anchor("a1"), make_anchor("a2")),
            evidence=(),
        )
    )
    spec, state = make_guarded_tool("gated", preconditions=[ResolvedExact()])

    events, terminal = run_round("gated", spec=spec, factory=fixed_context(context))

    assert state["calls"] == 0
    result = terminal.results[0]
    assert result.is_error is True
    assert result.failure_type is FailureType.STALE_ANCHOR
    assert "ambiguous" in result.value


def test_target_focused_false_blocks_with_focus_lost():
    context = PreconditionContext(target_focused=False)
    spec, state = make_guarded_tool("gated", preconditions=[TargetFocused()])

    events, terminal = run_round("gated", spec=spec, factory=fixed_context(context))

    assert state["calls"] == 0
    result = terminal.results[0]
    assert result.is_error is True
    assert result.failure_type is FailureType.FOCUS_LOST
    assert "not focused" in result.value


def test_target_focused_unknown_blocks_fail_closed():
    context = PreconditionContext(target_focused=None)
    spec, state = make_guarded_tool("gated", preconditions=[TargetFocused()])

    events, terminal = run_round("gated", spec=spec, factory=fixed_context(context))

    assert state["calls"] == 0
    assert terminal.results[0].failure_type is FailureType.FOCUS_LOST


def test_content_unchanged_mismatch_blocks_with_content_changed():
    context = PreconditionContext(expected_content_hash="h1", actual_content_hash="h2")
    spec, state = make_guarded_tool("gated", preconditions=[ContentUnchanged()])

    events, terminal = run_round("gated", spec=spec, factory=fixed_context(context))

    assert state["calls"] == 0
    result = terminal.results[0]
    assert result.is_error is True
    assert result.failure_type is FailureType.CONTENT_CHANGED
    assert "no longer matches" in result.value


def test_no_modal_since_enabled_blocks_and_disabled_passes():
    blocked = PreconditionContext(modal_seen_since=True)
    spec, state = make_guarded_tool("gated", preconditions=[NoModalSince(t0=123.0)])
    events, terminal = run_round("gated", spec=spec, factory=fixed_context(blocked))
    assert state["calls"] == 0
    result = terminal.results[0]
    assert result.is_error is True
    assert result.failure_type is FailureType.BLOCKED_BY_MODAL
    assert "modal" in result.value

    disabled = PreconditionContext(modal_seen_since=True)
    spec2, state2 = make_guarded_tool("ungated", preconditions=[NoModalSince()])
    events2, terminal2 = run_round("ungated", spec=spec2, factory=fixed_context(disabled))
    assert state2["calls"] == 1
    assert terminal2.results[0].is_error is False


def test_factory_returning_none_rejects_fail_closed():
    def factory(call):
        return None

    spec, state = make_guarded_tool("gated", preconditions=[ResolvedExact()])
    events, terminal = run_round("gated", spec=spec, factory=factory)

    assert state["calls"] == 0
    result = terminal.results[0]
    assert result.is_error is True
    assert result.failure_type is FailureType.PERMISSION_DENIED
    assert "not evaluable" in result.value


def test_missing_factory_skips_evaluation_and_executes():
    spec, state = make_guarded_tool("gated", preconditions=[TargetFocused()])

    events, terminal = run_round("gated", spec=spec, factory=None)

    assert state["calls"] == 1
    assert terminal.results[0].is_error is False
    assert terminal.reason is TransitionReason.COMPLETED


def test_first_failing_precondition_stops_chain():
    context = PreconditionContext(
        resolution=ResolutionExact(make_anchor(), evidence=("e",)),
        target_focused=False,
    )
    spec, state = make_guarded_tool(
        "gated", preconditions=[ResolvedExact(), TargetFocused()]
    )

    events, terminal = run_round("gated", spec=spec, factory=fixed_context(context))

    assert state["calls"] == 0
    result = terminal.results[0]
    assert result.failure_type is FailureType.FOCUS_LOST
    assert "TargetFocused" in result.value


def test_failure_reason_visible_in_followup_round():
    context = PreconditionContext(
        resolution=ResolutionGone(anchor=make_anchor(), reason="window closed")
    )
    spec, state = make_guarded_tool("gated", preconditions=[ResolvedExact()])
    second = [TurnDone(usage=None, raw_text="ok, target gone, answering directly")]

    events, terminal = run_round("gated", spec=spec, factory=fixed_context(context), second_scene=second)

    assert state["calls"] == 0
    assert terminal.turns == 2
    assert terminal.reason is TransitionReason.COMPLETED
    finished = [e for e in events if isinstance(e, TurnFinished)]
    tool_msg = finished[0].state.messages[1]
    assert tool_msg.role is Role.TOOL
    assert tool_msg.is_error is True
    assert "expected exact" in tool_msg.content
    assert "ResolutionGone" in tool_msg.content


def test_parallel_safe_guarded_tool_is_also_gated():
    context = PreconditionContext(
        resolution=ResolutionGone(anchor=make_anchor(), reason="gone")
    )
    spec, state = make_guarded_tool(
        "gated_parallel", preconditions=[ResolvedExact()], concurrency_safe=True
    )

    events, terminal = run_round(
        "gated_parallel", spec=spec, factory=fixed_context(context)
    )

    assert state["calls"] == 0
    assert terminal.results[0].is_error is True
    assert terminal.results[0].failure_type is FailureType.STALE_ANCHOR
    assert any(isinstance(e, ToolCallFinished) for e in events)
    finished = [e for e in events if isinstance(e, TurnFinished)]
    tool_msg = finished[0].state.messages[1]
    assert tool_msg.is_error is True
    assert "expected exact" in tool_msg.content
