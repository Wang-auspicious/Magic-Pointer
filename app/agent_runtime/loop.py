"""Agent runtime query loop interpreter (harness loop batch, plan T2.4a).

Port of the Claude Code ``queryLoop`` state machine
(``docs/harness-port-notes/2026-08-12-cc-query-loop.md``):

- Frozen :class:`LoopParams` snapshot; the loop reads it, never mutates it.
- ``TurnState`` is rebuilt whole at every continue point via
  :func:`with_transition` (the query.ts "continue sites write
  state = { ... }" pattern); the transition reason is recorded per turn and
  is test-assertable.
- The loop is an **async generator**: events are yielded to drive a UI, the
  final :class:`~app.agent_runtime.types.Terminal` is the generator's return
  value (CC ``AsyncGenerator<StreamEvent, Terminal>`` dual channel).
- Per-turn flow: budget check (``check_budget`` on latency_budget
  FULL_ANSWER, injected clock; only the FULL_ANSWER stage gates the loop)
  -> model turn -> collect ToolCallArrived -> sequential execution
  (validate_input gate, registry.execute_tool wrapped in a
  CancellationScope; cancellation surfaces as CancelledError) ->
  ``_normalize_result`` maps the registry's execution-layer ToolResult to
  the types-layer ToolResult (error_message merged into value; Evidence
  values serialized via ``evidence_to_text`` so the model reads
  ``{status, confidence, value, note}`` instead of a repr) ->
  tool messages appended with the is_error flag -> continue or terminate.
- The whole loop runs inside one :class:`CancellationScope` over
  ``params.cancel_registry`` (fallback: the module singleton). Cancellation
  is checked before every model call and before every tool execution;
  ``cancel_all()`` from any thread raises :class:`CancelledError` out of
  the loop. Already-started parallel tools run to completion (the pool
  drains), but the loop terminates instead of continuing.

Honest semantics of this batch:

- **Natural completion reason**: the TransitionReason enum has no
  ``completed`` member (CC returns ``completed``). The loop records the last
  transition (``tool_result`` / ``tool_error`` / recovery reasons); a turn
  answered without any prior tool round defaults to ``tool_result``.
  Consumers must not read "natural answer" out of the reason alone;
  T2.4b/engine work should treat ``reason not in {MAX_TURNS, BUDGET_EXHAUSTED}``
  as completion.
- Concurrency-safe batches (``is_concurrency_safe``) run on a short-lived
  :class:`concurrent.futures.ThreadPoolExecutor`; unsafe tools keep input
  order on the loop thread. Tool failures keep ``execute_tool`` semantics
  (ActionFailure passthrough, anything else wrapped as TOOL_ERROR); only a
  cancelled scope raises :class:`CancelledError` out of the worker.
- Withheld-turn recovery (CC withhold-until-recover): a round whose events
  carry ``TurnWithheld`` increments the state recovery counter and injects a
  recovery user message; more than ``MAX_OUTPUT_TOKENS_RECOVERY_LIMIT``
  consecutive withheld rounds terminate with ``max_output_tokens_recovered``.
  The optional ``compact_callback`` fires once on the first withheld round
  (guarded by ``has_attempted_reactive_compact``).
- Pi StreamFn truncation guard: ``client.last_truncated`` invalidates the
  round's tool calls (nothing executes); one ``is_error=False`` tool message
  ("输出被截断，重新生成") is fed back and the loop continues, still
  bounded by ``max_turns``.
- Stop hooks gate the round-end settling paths (natural answer and
  post-tool continuation; withheld/truncation recovery continues bypass
  them, mirroring CC). A ``prevent_continuation`` decision terminates with
  the hook's reason (``stop_hook`` fallback); a raising hook is recorded in
  a loop-local notes list (``TurnState`` has no ``note`` field -- types.py
  is outside this batch's file scope) and sets ``stop_hook_active`` so the
  next round skips the hooks instead of re-entering the failing one.
- ``interrupt_check`` runs at the start of every round before the model
  call; True terminates with ``user_interrupt``.
- Model calls and tool execution are synchronous inside the async generator
  boundary (per task); the model ``cancel_scope`` is passed as None.
"""

from __future__ import annotations

import time
from collections.abc import AsyncIterator, Callable, Mapping, Sequence
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any

from app.agent_runtime.errors import (
    MAX_OUTPUT_TOKENS_RECOVERY_LIMIT,
    FailureType,
)
from app.agent_runtime.model_client import (
    LoopModelClient,
    MessageDelta,
    TurnWithheld,
)
from app.agent_runtime.perception_tools import evidence_to_text
from app.agent_runtime.tool_registry import ToolRegistry
from app.agent_runtime.types import (
    AgentMessage,
    Role,
    Terminal,
    ToolCall,
    ToolResult,
    Trajectory,
    TransitionReason,
    TurnState,
    with_transition,
)
from app.evidence.contract import Evidence
from app.governance.cancellation import (
    CancellationRegistry,
    CancellationScope,
    CancelledError,
    get_registry,
)
from app.governance.latency_budget import (
    DEFAULT_BUDGETS,
    BudgetPolicy,
    Stage,
    check_budget,
)

__all__ = [
    "LoopParams",
    "LoopStart",
    "LoopStopped",
    "ModelChunk",
    "StopDecision",
    "ToolCallFinished",
    "ToolCallStarted",
    "TurnFinished",
    "TurnStarted",
    "run_agent_loop",
]

_FULL_ANSWER_STAGE = Stage.FULL_ANSWER

_RECOVERY_MESSAGE = (
    "Output token limit hit. Resume directly — no apology, no explanation. "
    "Break remaining work into smaller pieces."
)
"""CC query.ts 1224-1229 recovery meta message injected on withheld turns."""

_TRUNCATION_MESSAGE = "输出被截断，重新生成"
"""Pi StreamFn truncation feedback: tool calls were cut off, regenerate."""


@dataclass(frozen=True, slots=True)
class StopDecision:
    """Stop-hook verdict (CC stopHooks.ts StopHookResult).

    ``prevent_continuation`` terminates the loop with ``reason`` (the
    ``stop_hook`` transition is the fallback when the hook leaves it None).
    """

    reason: TransitionReason
    prevent_continuation: bool


@dataclass(frozen=True, slots=True)
class LoopParams:
    """Immutable snapshot of one loop run (CC query params, frozen form)."""

    user_input: str
    registry: ToolRegistry
    client: LoopModelClient
    max_turns: int = 6
    trajectory: Trajectory | None = None
    budgets: Mapping[Stage, BudgetPolicy] = field(default_factory=lambda: DEFAULT_BUDGETS)
    cancel_registry: CancellationRegistry | None = None
    stop_hooks: Sequence = ()
    clock: Callable[[], float] | None = None
    tool_limit: int = 12
    interrupt_check: Callable[[], bool] | None = None
    compact_callback: Callable[[TurnState], Any] | None = None


@dataclass(frozen=True, slots=True)
class LoopStart:
    kind = "loop_start"


@dataclass(frozen=True, slots=True)
class TurnStarted:
    kind = "turn_started"
    turn: int


@dataclass(frozen=True, slots=True)
class ModelChunk:
    kind = "model_chunk"
    text: str


@dataclass(frozen=True, slots=True)
class ToolCallStarted:
    kind = "tool_call_started"
    name: str
    id: str


@dataclass(frozen=True, slots=True)
class ToolCallFinished:
    kind = "tool_call_finished"
    result: ToolResult


@dataclass(frozen=True, slots=True)
class TurnFinished:
    kind = "turn_finished"
    state: TurnState


@dataclass(frozen=True, slots=True)
class LoopStopped:
    kind = "loop_stopped"
    terminal: Terminal


async def run_agent_loop(params: LoopParams) -> AsyncIterator[Any]:
    """Run one agentic query loop; yields events, Terminal on LoopStopped.

    CC's ``AsyncGenerator<StreamEvent, Terminal>`` dual channel cannot be
    reproduced verbatim: PEP 525 forbids ``return value`` in async
    generators, so the Terminal is delivered as the **final** event
    (:class:`LoopStopped`). Consumers collect events and read
    ``events[-1].terminal``; the generator itself returns None.

    Per-turn flow: budget check (latency_budget FULL_ANSWER, injected
    clock) -> interrupt check -> model turn -> withheld recovery (bounded
    by ``MAX_OUTPUT_TOKENS_RECOVERY_LIMIT``, compact callback fires once) ->
    truncation invalidation (``client.last_truncated``) -> tool execution
    (concurrency-safe batch on a thread pool, then sequential in order) ->
    stop-hook gateway -> rebuild state and continue, or terminate.
    """
    registry = params.registry
    client = params.client
    clock = params.clock if params.clock is not None else time.perf_counter
    cancel_registry = (
        params.cancel_registry if params.cancel_registry is not None else get_registry()
    )
    start_ms = clock()
    budget_ms = float(params.budgets[_FULL_ANSWER_STAGE].budget_ms)
    tool_schemas = _select_tool_schemas(params)
    stop_hooks = tuple(params.stop_hooks)

    first_message = _first_message(params)
    state = TurnState(
        messages=[first_message],
        tool_calls_pending=[],
    )
    results: list[ToolResult] = []
    last_transition: TransitionReason | None = None
    turn_number = 1
    hook_notes: list[str] = []

    yield LoopStart()

    with CancellationScope(cancel_registry) as loop_scope:
        while True:
            elapsed_ms = clock() - start_ms
            budget_result = check_budget(_FULL_ANSWER_STAGE, elapsed_ms, params.budgets)
            remaining_ms = max(0.0, budget_ms - elapsed_ms)
            if not budget_result.within_budget:
                terminal = Terminal(
                    reason=TransitionReason.BUDGET_EXHAUSTED,
                    message="full answer budget exhausted",
                    turns=turn_number - 1,
                    results=tuple(results),
                )
                yield LoopStopped(terminal)
                return

            state = with_transition(
                state,
                last_transition,  # type: ignore[arg-type]  # None on turn 1
                turn_count=turn_number,
                budget_remaining_ms=remaining_ms,
            )
            yield TurnStarted(turn=turn_number)

            if params.interrupt_check is not None and params.interrupt_check():
                terminal = Terminal(
                    reason=TransitionReason.USER_INTERRUPT,
                    message="user interrupt",
                    turns=turn_number,
                    results=tuple(results),
                )
                yield LoopStopped(terminal)
                return

            if loop_scope.is_cancelled:
                raise CancelledError("cancelled before model call")

            events = client.generate_turn(
                state.messages,
                tool_schemas,
                budget_ms=remaining_ms,
                cancel_scope=None,
            )
            calls, text = client.parse_tool_calls(events)
            yielded_delta = 0
            for event in events:
                if isinstance(event, MessageDelta):
                    yield ModelChunk(text=event.text)
                    yielded_delta += 1
            if yielded_delta == 0 and text is not None:
                yield ModelChunk(text)

            if any(isinstance(event, TurnWithheld) for event in events):
                recovery = state.max_output_tokens_recovery_count + 1
                if recovery > MAX_OUTPUT_TOKENS_RECOVERY_LIMIT:
                    terminal = Terminal(
                        reason=TransitionReason.MAX_OUTPUT_TOKENS_RECOVERED,
                        message="max output tokens recovery limit exceeded",
                        turns=turn_number,
                        results=tuple(results),
                    )
                    yield LoopStopped(terminal)
                    return
                messages = list(state.messages)
                if text is not None:
                    messages.append(
                        AgentMessage(
                            role=Role.ASSISTANT,
                            content=text,
                            tool_call_id=None,
                            name=None,
                        )
                    )
                messages.append(
                    AgentMessage(
                        role=Role.USER,
                        content=_RECOVERY_MESSAGE,
                        tool_call_id=None,
                        name=None,
                    )
                )
                has_attempted = state.has_attempted_reactive_compact
                if not has_attempted and params.compact_callback is not None:
                    params.compact_callback(state)
                    has_attempted = True
                last_transition = TransitionReason.MAX_OUTPUT_TOKENS_RECOVERED
                state = with_transition(
                    state,
                    TransitionReason.MAX_OUTPUT_TOKENS_RECOVERED,
                    messages=messages,
                    tool_calls_pending=[],
                    max_output_tokens_recovery_count=recovery,
                    has_attempted_reactive_compact=has_attempted,
                    turn_count=turn_number,
                    last_result=results[-1] if results else None,
                )
                yield TurnFinished(state)
                turn_number += 1
                continue

            if not calls:
                if stop_hooks and not state.stop_hook_active:
                    decision, hook_errored = _run_stop_hooks(
                        stop_hooks, state, hook_notes
                    )
                    if decision is not None:
                        reason = (
                            decision.reason
                            if decision.reason is not None
                            else TransitionReason.STOP_HOOK
                        )
                        terminal = Terminal(
                            reason=reason,
                            message="stop hook prevented continuation",
                            turns=turn_number,
                            results=tuple(results),
                        )
                        yield LoopStopped(terminal)
                        return
                    if hook_errored:
                        messages = list(state.messages)
                        if text is not None:
                            messages.append(
                                AgentMessage(
                                    role=Role.ASSISTANT,
                                    content=text,
                                    tool_call_id=None,
                                    name=None,
                                )
                            )
                        state = with_transition(
                            state,
                            last_transition or TransitionReason.TOOL_RESULT,
                            messages=messages,
                            tool_calls_pending=[],
                            turn_count=turn_number,
                            max_output_tokens_recovery_count=0,
                            stop_hook_active=True,
                            last_result=results[-1] if results else None,
                        )
                        yield TurnFinished(state)
                        turn_number += 1
                        continue
                messages = list(state.messages)
                if text is not None:
                    messages.append(
                        AgentMessage(
                            role=Role.ASSISTANT,
                            content=text,
                            tool_call_id=None,
                            name=None,
                        )
                    )
                completion_reason = last_transition or TransitionReason.TOOL_RESULT
                final_state = with_transition(
                    state,
                    completion_reason,
                    messages=messages,
                    last_result=results[-1] if results else None,
                    stop_hook_active=False,
                )
                terminal = Terminal(
                    reason=completion_reason,
                    message=text or "",
                    turns=turn_number,
                    results=tuple(results),
                )
                yield TurnFinished(final_state)
                yield LoopStopped(terminal)
                return

            if client.last_truncated:
                messages = list(state.messages)
                messages.append(
                    AgentMessage(
                        role=Role.TOOL,
                        content=_TRUNCATION_MESSAGE,
                        tool_call_id=calls[0].id,
                        name=calls[0].name,
                        is_error=False,
                    )
                )
                if turn_number + 1 > params.max_turns:
                    terminal = Terminal(
                        reason=TransitionReason.MAX_TURNS,
                        message="max turns reached",
                        turns=turn_number,
                        results=tuple(results),
                    )
                    yield LoopStopped(terminal)
                    return
                state = with_transition(
                    state,
                    TransitionReason.TOOL_RESULT,
                    messages=messages,
                    tool_calls_pending=[],
                    turn_count=turn_number,
                    max_output_tokens_recovery_count=0,
                    last_result=results[-1] if results else None,
                )
                yield TurnFinished(state)
                turn_number += 1
                continue

            tool_messages: list[AgentMessage] = []
            any_error = False
            names = [call.name for call in calls]
            try:
                parallel_names, sequential_names = registry.concurrency_partition(names)
            except KeyError:
                # Unknown names fail closed as sequential; _execute_one reports
                # them as TOOL_ERROR instead of the partition killing the loop.
                parallel_names, sequential_names = [], list(names)
            parallel_set = frozenset(parallel_names)
            sequential_set = frozenset(sequential_names)
            parallel_calls = [call for call in calls if call.name in parallel_set]
            sequential_calls = [call for call in calls if call.name in sequential_set]

            for call in parallel_calls:
                yield ToolCallStarted(name=call.name, id=call.id)
            parallel_results = _execute_parallel(
                parallel_calls, registry, cancel_registry, loop_scope
            )
            for call, normalized in zip(parallel_calls, parallel_results, strict=True):
                results.append(normalized)
                if normalized.is_error:
                    any_error = True
                yield ToolCallFinished(result=normalized)
                tool_messages.append(
                    AgentMessage(
                        role=Role.TOOL,
                        content=normalized.value,
                        tool_call_id=normalized.tool_call_id,
                        name=call.name,
                        is_error=normalized.is_error,
                    )
                )

            for call in sequential_calls:
                yield ToolCallStarted(name=call.name, id=call.id)
                normalized = _execute_one(registry, call, cancel_registry, loop_scope)
                results.append(normalized)
                if normalized.is_error:
                    any_error = True
                yield ToolCallFinished(result=normalized)
                tool_messages.append(
                    AgentMessage(
                        role=Role.TOOL,
                        content=normalized.value,
                        tool_call_id=normalized.tool_call_id,
                        name=call.name,
                        is_error=normalized.is_error,
                    )
                )

            if turn_number + 1 > params.max_turns:
                terminal = Terminal(
                    reason=TransitionReason.MAX_TURNS,
                    message="max turns reached",
                    turns=turn_number,
                    results=tuple(results),
                )
                yield LoopStopped(terminal)
                return

            hook_errored = False
            if stop_hooks and not state.stop_hook_active:
                decision, hook_errored = _run_stop_hooks(stop_hooks, state, hook_notes)
                if decision is not None:
                    reason = (
                        decision.reason
                        if decision.reason is not None
                        else TransitionReason.STOP_HOOK
                    )
                    terminal = Terminal(
                        reason=reason,
                        message="stop hook prevented continuation",
                        turns=turn_number,
                        results=tuple(results),
                    )
                    yield LoopStopped(terminal)
                    return

            last_transition = (
                TransitionReason.TOOL_ERROR if any_error else TransitionReason.TOOL_RESULT
            )
            messages = list(state.messages)
            if text is not None:
                messages.append(
                    AgentMessage(
                        role=Role.ASSISTANT,
                        content=text,
                        tool_call_id=None,
                        name=None,
                    )
                )
            messages.extend(tool_messages)
            state = with_transition(
                state,
                last_transition,
                messages=messages,
                tool_calls_pending=[],
                turn_count=turn_number,
                max_output_tokens_recovery_count=0,
                stop_hook_active=hook_errored,
                last_result=results[-1],
            )
            yield TurnFinished(state)
            turn_number += 1


def _run_stop_hooks(
    stop_hooks: Sequence,
    state: TurnState,
    notes: list[str],
) -> tuple[StopDecision | None, bool]:
    """Run the stop-hook gateway; ``(decision, hook_errored)``.

    Hooks run in order; the first ``prevent_continuation`` decision wins.
    A hook exception is recorded in ``notes`` and reported via
    ``hook_errored`` -- the loop keeps running (CC: a failing hook must not
    kill the session; the caller sets ``stop_hook_active`` so the next
    round skips the hooks instead of re-entering the failing one).
    """
    for hook in stop_hooks:
        try:
            decision = hook(state)
        except Exception as exc:  # noqa: BLE001 -- hook failures never kill the loop
            notes.append(f"stop hook {hook!r} raised {type(exc).__name__}: {exc}")
            return None, True
        if decision.prevent_continuation:
            return decision, False
    return None, False


def _execute_parallel(
    calls: Sequence[ToolCall],
    registry: ToolRegistry,
    cancel_registry: CancellationRegistry,
    loop_scope: CancellationScope,
) -> list[ToolResult]:
    """Execute a concurrency-safe batch on a short-lived thread pool.

    The :class:`ThreadPoolExecutor` is created per batch and shut down by
    the context manager once the batch settles (no pool survives between
    rounds; workers = ``min(len(calls), 4)``). Futures are submitted in
    call order and read back in submit order, so results and the loop's
    events keep call order regardless of completion order. Tool exceptions
    keep ``execute_tool`` semantics (ActionFailure passthrough, anything
    else wrapped as TOOL_ERROR) because :func:`_execute_one` runs inside
    the worker; only a cancelled scope raises :class:`CancelledError` out
    of the worker, propagating through ``future.result()`` exactly like the
    serial path. ``loop_scope`` is the loop's outer scope: its token is
    shared with every worker so a pre-execution cancellation check is
    visible across threads. Already-submitted tools still run to
    completion; the loop raises instead of continuing.
    """
    if not calls:
        return []
    workers = min(len(calls), 4)
    with ThreadPoolExecutor(
        max_workers=workers, thread_name_prefix="mp-tool"
    ) as pool:
        futures = [
            pool.submit(_execute_one, registry, call, cancel_registry, loop_scope)
            for call in calls
        ]
        return [future.result() for future in futures]


def _first_message(params: LoopParams) -> AgentMessage:
    """First user message: trajectory template or plain user input."""

    if params.trajectory is not None:
        content = params.trajectory.first_user_message.replace(
            "{input}", params.user_input
        )
    else:
        content = params.user_input
    return AgentMessage(
        role=Role.USER,
        content=content,
        tool_call_id=None,
        name=None,
    )


def _select_tool_schemas(params: LoopParams) -> list[dict[str, object]]:
    """Tool list: trajectory-recommended (registered ones) first, then the
    rest of the registry in registration order, truncated at tool_limit."""

    registry = params.registry
    specs = {spec.name: spec for spec in registry.list()}
    selected: list[str] = []
    if params.trajectory is not None:
        for name in params.trajectory.recommended_tools:
            if name in specs and name not in selected:
                selected.append(name)
    for spec in registry.list():
        if spec.name not in selected:
            selected.append(spec.name)
    selected = selected[: params.tool_limit]
    return [
        {
            "name": specs[name].name,
            "description": specs[name].description,
            "parameters": specs[name].input_schema,
        }
        for name in selected
    ]


def _execute_one(
    registry: ToolRegistry,
    call: ToolCall,
    cancel_registry: CancellationRegistry,
    loop_scope: CancellationScope,
) -> ToolResult:
    """Validate, execute and normalize one tool call.

    validate_input failures produce an is_error ToolResult without invoking
    ``execute`` (fail closed). Unknown tools are caught as a structured
    TOOL_ERROR instead of a KeyError killing the loop. Execution is wrapped
    in a CancellationScope; once cancelled, the loop raises CancelledError
    instead of feeding the result back. The pre-execution check reads the
    loop's outer scope, so a cancellation that landed while the model was
    generating skips ``execute`` entirely; a cancellation that lands
    mid-execution lets the tool run to completion and then raises.
    """
    try:
        spec = registry.get(call.name)
    except KeyError:
        return ToolResult(
            tool_call_id=call.id,
            value=f"unknown tool {call.name!r}",
            is_error=True,
            failure_type=FailureType.TOOL_ERROR,
            used_backend=None,
            latency_ms=None,
        )
    errors = registry.validate_input(spec, call.arguments)
    if errors:
        return ToolResult(
            tool_call_id=call.id,
            value="; ".join(errors),
            is_error=True,
            failure_type=FailureType.TOOL_ERROR,
            used_backend=None,
            latency_ms=None,
        )
    if loop_scope.is_cancelled:
        raise CancelledError(f"cancelled before tool {call.name!r} ({call.id})")
    with CancellationScope(cancel_registry) as scope:
        executed = registry.execute_tool(call.name, call.arguments, scope=scope.token)
    if scope.is_cancelled:
        raise CancelledError(f"cancelled during tool {call.name!r} ({call.id})")
    return _normalize_result(executed, call)


def _normalize_result(executed: Any, call: ToolCall) -> ToolResult:
    """Map the registry execution-layer ToolResult to the types layer.

    ``error_message`` is merged into ``value`` for errors (the model only
    sees one text channel per tool message). Evidence values are rendered
    with :func:`~app.agent_runtime.perception_tools.evidence_to_text` at
    this message boundary so the model reads ``{status, confidence, value,
    note}`` text instead of a dataclass repr; the Evidence object itself
    stays untouched at the registry layer.
    """
    if executed.is_error:
        value = executed.error_message
        if value is None:
            value = _result_value_text(executed.value)
    else:
        value = _result_value_text(executed.value)
    return ToolResult(
        tool_call_id=call.id,
        value=value,
        is_error=executed.is_error,
        failure_type=executed.failure_type,
        used_backend=executed.used_backend,
        latency_ms=executed.latency_ms,
    )


def _result_value_text(value: Any) -> str:
    """One text channel for the model: Evidence -> readable JSON, else str."""
    if isinstance(value, Evidence):
        return evidence_to_text(value)
    return "" if value is None else str(value)
