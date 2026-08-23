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
- Per-turn flow: budget check (rolling deadline with per-turn renewal —
  see :class:`LoopParams`; only genuine stalls hard-cut) -> model turn ->
  collect ToolCallArrived -> bounded scheduling (exclusive barriers,
  resource conflicts, model-order commits) -> execution (validate_input gate,
  permission-mode gate, registry.execute_tool wrapped in a
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

- **Natural completion reason**: the loop always terminates a natural
  answer (model gave a final answer, no tool calls, no hook blocked it)
  with ``TransitionReason.COMPLETED`` (CC returns ``completed``).
  ``last_transition`` lives only on :class:`TurnState` -- it records why the
  previous round continued (tool_result / tool_error / recovery / hook
  reasons) and is never mixed into the Terminal reason. The other terminal
  reasons keep their independent meanings: ``INVARIANT_FAILED``, ``BUDGET_EXHAUSTED``,
  ``STOP_HOOK``, ``USER_INTERRUPT`` and ``MAX_OUTPUT_TOKENS_RECOVERED``
  (recovery limit exceeded) are terminations, not completions.
- Concurrency-safe calls (``is_concurrency_safe``) use a bounded rolling pool.
  Exclusive calls are model-order barriers and matching ``resource_keys``
  never overlap. Physical settlement may be out of order, but results commit
  in the model's call order. Tool failures keep ``execute_tool`` semantics
  (ActionFailure passthrough, anything else wrapped as TOOL_ERROR); only a
  cancelled scope raises :class:`CancelledError` after replay-safe receipts.
- Withheld-turn recovery (CC withhold-until-recover): the loop routes
  ``TurnWithheld`` by its ``reason``. Token-class withhold reasons
  (``max_output_tokens`` / empty) increment the state recovery counter and
  inject the recovery user message; more than
  ``MAX_OUTPUT_TOKENS_RECOVERY_LIMIT`` consecutive token-withheld rounds
  terminate with ``max_output_tokens_recovered``. Provider failures have
  already used request-level retries inside ``LoopModelClient``; an exhausted
  backend failure terminates this semantic turn as ``provider_unavailable``
  without injecting any message. The optional ``compactor`` fires once on the first
  token-withheld round (guarded by ``has_attempted_reactive_compact``),
  replacing the message list, and the continue transition is recorded as
  ``compact_triggered``.
- Proactive compaction: when ``context_budget_tokens`` and a
  ``token_estimator`` are configured, each round starts by estimating the
  request — messages and system prompt via the estimator, tool schemas added
  by the loop, which owns that list. At >=70% of the budget the ``compactor``
  replaces the history (``compact_triggered``) before any model call. This
  repeats for the life of the loop: a long job that keeps accumulating tool
  results needs to compact more than once. Two consecutive attempts that
  leave the request still over the line stop further tries
  (``_MAX_FRUITLESS_COMPACTIONS``) — summarising is a model call, and a
  history that will not shrink must not be re-summarised every round.
- Rolling budget (T1): the FULL_ANSWER budget is a deadline that renews
  once per productive round (at least one non-error tool result); each
  renewal emits :class:`BudgetRenewed` so a UI can heartbeat progress.
  Productive rounds renew without a cap — the budget constrains feedback
  rhythm, not loop life. Hard cut only when the deadline expires on a
  non-productive round (pure-error rounds, duplicate-evidence stalls,
  withhold storms).
- Pi StreamFn truncation guard: ``client.last_truncated`` invalidates the
  round's tool calls (nothing executes); one ``is_error=False`` tool message
  ("输出被截断，重新生成") is fed back and the loop continues, protected by
  a high emergency invariant fuse that reports ``invariant_failed`` rather
  than pretending a normal task limit was reached.
- Hermes-style semantic tool guardrails classify progress from registered
  effects and result novelty. Repeated failures, duplicate read evidence
  (including across different read tools), or identical successful writes
  warn through the tool-result channel and eventually terminate as
  ``stalled``. Genuinely new evidence can continue without a small turn cap.
- Stop hooks gate only the natural-answer settling path, evaluated once per
  round after the round's messages (assistant text plus any tool results
  from earlier rounds of this turn) are merged into the state -- a hook
  always sees what it is gating (CC evaluates only at the
  ``!needsFollowUp`` boundary, never after a tool round). A
  ``prevent_continuation`` decision terminates with the hook's reason
  (``stop_hook`` fallback); a raising hook is recorded in a loop-local
  notes list (``TurnState`` has no ``note`` field -- types.py is outside
  this batch's file scope), the continue transition is ``stop_hook``, and
  ``stop_hook_active`` is set so the next round skips the hooks instead of
  re-entering the failing one (sticky until the natural completion
  resets it, mirroring CC).
- ``interrupt_check`` runs at the start of every round before the model
  call; True terminates with ``user_interrupt``.
- Model calls and tool execution are synchronous inside the async generator
  boundary. The model receives the loop cancellation token and a late result
  is discarded if cancellation lands while a synchronous provider settles.

Channel separation: every message carries an ``origin`` tag
(``ORIGIN_INSTRUCTION`` | ``ORIGIN_DATA``). Only the first user message is an
instruction; tool results, truncation feedback, recovery prompts and backend
errors are harness-internal data. ``instruction_messages`` filters the
instruction channel (future system prompt assembly);
``validate_messages`` asserts the role/origin legality (data never uses the
user role, tool results are always data).
"""

from __future__ import annotations

import hashlib
import json
import math
import threading
import time
from collections.abc import AsyncIterator, Callable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

from app.action_guard.preconditions import PreconditionContext, check_all
from app.agent_runtime.errors import (
    MAX_OUTPUT_TOKENS_RECOVERY_LIMIT,
    ActionFailure,
    FailureType,
)
from app.agent_runtime.inbox import Inbox
from app.agent_runtime.turn_verification import (
    VerificationGate,
    should_nudge_before_completion,
)
from app.agent_runtime.hooks import HookManager
from app.agent_runtime.model_client import (
    LoopModelClient,
    MessageDelta,
    TurnWithheld,
)
from app.agent_runtime.perception_tools import evidence_to_text
from app.agent_runtime.token_estimate import estimate_text_tokens
from app.agent_runtime.permission_modes import (
    PermissionDecision,
    PermissionDecisionResult,
    PermissionMode,
    decide_effect,
)
from app.agent_runtime.session import EventSession
from app.agent_runtime.tool_scheduler import (
    ScheduledCallCommitted,
    ScheduledCallStarted,
    schedule_tool_calls,
)
from app.agent_runtime.tool_guardrails import (
    ToolCallGuardrailConfig,
    ToolCallGuardrailController,
    ToolGuardrailDecision,
    append_toolguard_guidance,
)
from app.agent_runtime.tool_registry import Effect, ToolRegistry, spec_effect
from app.agent_runtime.types import (
    ORIGIN_DATA,
    ORIGIN_INSTRUCTION,
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
from app.artifacts.projection import project_artifacts
from app.evidence.contract import Evidence
from app.receipts.projection import compose_receipt
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
)

__all__ = [
    "LoopParams",
    "LoopStart",
    "LoopStopped",
    "ModelChunk",
    "BudgetRenewed",
    "BackendRecovery",
    "StopDecision",
    "ToolCallFinished",
    "ToolCallStarted",
    "TurnFinished",
    "TurnStarted",
    "instruction_messages",
    "run_agent_loop",
    "validate_messages",
]

_FULL_ANSWER_STAGE = Stage.FULL_ANSWER

_PROACTIVE_COMPACT_RATIO = 0.7
"""Proactive compaction threshold: >=70% of the token budget (review Q11)."""

_MAX_FRUITLESS_COMPACTIONS = 2
"""Give up re-compacting after this many attempts that stayed over threshold.

Ported from Hermes' anti-thrash counters (``context_compressor.should_compress``):
compaction is a model call, so a history that will not shrink must not be
re-summarised every round for the rest of a long job.
"""


def _over_compact_threshold(
    params: LoopParams,
    messages: Sequence[AgentMessage],
    tool_schema_tokens: int,
) -> bool:
    """Would this request sit at or above the proactive compaction line?

    The estimator covers messages and the system prompt; tool schemas are the
    loop's own list, so their weight is added here.
    """
    if params.token_estimator is None or params.context_budget_tokens is None:
        return False
    estimated = params.token_estimator(list(messages)) + tool_schema_tokens
    return estimated >= _PROACTIVE_COMPACT_RATIO * params.context_budget_tokens


def _real_prompt_tokens(usage: Mapping[str, Any] | None) -> int:
    """Provider-reported prompt tokens from the last round (0 when absent)."""
    if not isinstance(usage, Mapping):
        return 0
    for key in ("prompt_tokens", "input_tokens"):
        value = usage.get(key)
        if (
            isinstance(value, (int, float))
            and not isinstance(value, bool)
            and math.isfinite(value)
            and value > 0
        ):
            return int(value)
    return 0

_MAX_TOOL_RESULT_CHARS = 64_000
"""Maximum model-visible/logged characters from one tool invocation."""

_RECOVERY_MESSAGE = (
    "Output token limit hit. Resume directly — no apology, no explanation. "
    "Break remaining work into smaller pieces."
)
"""CC query.ts 1224-1229 recovery meta message injected on withheld turns."""

_TRUNCATION_MESSAGE = "输出被截断，重新生成"
"""Pi StreamFn truncation feedback: tool calls were cut off, regenerate."""

_sleep = time.sleep
"""Indirection for tests: the backend-recovery backoff must be observable
and monkeypatchable without real wall-clock waits."""

_MAX_BACKEND_RECOVERIES = 2
_BACKEND_RECOVERY_DELAYS_S = (15.0, 25.0)
"""Backoff schedule for transient backend errors on a productive turn.

The real-machine notepad-edit failure chain was: compaction summarizer hit a
transient SSL error → endpoint circuit breaker opened (20s cooldown) → the
main call was skipped → the whole turn died as provider_unavailable after ten
productive rounds. Sub-second retries cannot outlive a 20s breaker; these
delays can. The rolling budget still bounds total wait: rounds spent waiting
are non-productive, so the deadline eventually hard-cuts."""


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
    emergency_turn_fuse: int = 1000
    trajectory: Trajectory | None = None
    budgets: Mapping[Stage, BudgetPolicy] = field(default_factory=lambda: DEFAULT_BUDGETS)
    cancel_registry: CancellationRegistry | None = None
    stop_hooks: Sequence = ()
    nudge_hooks: Sequence = ()
    """Completion gates: each callable() -> str | None; text injects a nudge."""
    clock: Callable[[], float] | None = None
    tool_limit: int = 12
    max_parallel_tool_calls: int = 4
    interrupt_check: Callable[[], bool] | None = None
    event_sink: Callable[[Any], None] | None = None
    permission_mode: str = "default"
    budget_renewals: int = 3
    compactor: Callable[[list[AgentMessage]], list[AgentMessage]] | None = None
    context_budget_tokens: int | None = None
    token_estimator: Callable[[Sequence[AgentMessage]], int] | None = None
    allowed_effects: tuple[Effect, ...] = (Effect.READ, Effect.REVERSIBLE_WRITE)
    precondition_context_factory: (
        Callable[[ToolCall], PreconditionContext] | None
    ) = None
    hook_manager: HookManager | None = None
    tool_guardrail_config: ToolCallGuardrailConfig = field(
        default_factory=ToolCallGuardrailConfig
    )
    session: EventSession | None = None
    request_header: Mapping[str, Any] = field(default_factory=dict)
    evidence_input: str | None = None
    inbox: Inbox | None = None
    interaction_metadata: Mapping[str, Any] = field(default_factory=dict)
    keepalive: Callable[[str], None] | None = None
    todo_store: Any = None
    """Optional TodoStore-like object that exposes ``read()`` -> list[dict].

    Used by partial-delivery message construction when the loop hits
    BUDGET_EXHAUSTED — the user-facing terminal message lists the still
    pending todos so the next /resume picks them up.
    """
    """Optional stderr heartbeat used to reset the IPC idle deadline.

    The Electron-side ``python_bridge_runner`` kills a Python child after 60s
    of silence on stderr/stdout (long-task blocker). During one model call or
    a long-running tool the agent can legitimately stay quiet for minutes
    while a single ``run_command``/``read_file`` finishes, and the child is
    killed before any progress is delivered. A bridge-provided callback that
    writes a single ``@@mp phase=…`` line to stderr at every turn and tool
    boundary is enough to keep the deadline alive without inventing data the
    model did not produce. Receivers must be silent on failure (a downstream
    stream that fails to flush must never abort a tool call).
    """


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
class BudgetRenewed:
    kind = "budget_renewed"
    turn: int
    deadline_ms: float
    renewals_used: int


@dataclass(frozen=True, slots=True)
class Steered:
    """Steer 输入在 step 边界被吸收：下一轮模型请求即携带（Pi next-step）。"""

    turn: int
    texts: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class FollowupContinued:
    """模型想停时 followup 队列非空：续跑新轮而非终止（Pi 外循环）。"""

    turn: int
    texts: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class VerificationNudged:
    """验证门拦截了一次收尾：注入 nudge 后续跑一轮（最多一次）。"""

    turn: int


@dataclass(frozen=True, slots=True)
class BackendRecovery:
    """瞬时后端错误后的退避重试（真机 notepad-edit 事故的修复）。

    有进展的 turn 遇到 backend_error 不再立即终止：等待一段能穿过熔断
    冷却的时间后重试同一轮。GUI 通过这个事件显示「端点抖动，等待恢复」。"""

    turn: int
    attempt: int
    delay_s: float
    reason: str


@dataclass(frozen=True, slots=True)
class LoopStopped:
    kind = "loop_stopped"
    terminal: Terminal


def _validate_loop_params(params: LoopParams) -> None:
    """Reject malformed public-loop configuration before any side effect.

    ``LoopParams`` is also a plugin seam, so callers do not necessarily pass
    through :class:`FabricEngine`'s configuration loader.  A typo must not
    survive until the first matching tool call, after the model and journal
    have already done work.
    """

    def require_int(name: str, value: object, *, minimum: int) -> None:
        if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
            raise ValueError(f"{name} must be an integer >= {minimum}")

    try:
        PermissionMode(params.permission_mode)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"permission_mode is invalid: {params.permission_mode!r}") from exc

    require_int("emergency_turn_fuse", params.emergency_turn_fuse, minimum=1)
    require_int("tool_limit", params.tool_limit, minimum=0)
    require_int("max_parallel_tool_calls", params.max_parallel_tool_calls, minimum=1)
    require_int("budget_renewals", params.budget_renewals, minimum=0)
    if params.context_budget_tokens is not None:
        require_int("context_budget_tokens", params.context_budget_tokens, minimum=1)
    if not isinstance(params.allowed_effects, tuple) or any(
        not isinstance(effect, Effect) for effect in params.allowed_effects
    ):
        raise ValueError("allowed_effects must be a tuple of Effect values")

    try:
        full_answer_budget = params.budgets[_FULL_ANSWER_STAGE]
    except (KeyError, TypeError) as exc:
        raise ValueError("budgets must define FULL_ANSWER") from exc
    if (
        not isinstance(full_answer_budget, BudgetPolicy)
        or full_answer_budget.stage is not _FULL_ANSWER_STAGE
        or isinstance(full_answer_budget.budget_ms, bool)
        or not isinstance(full_answer_budget.budget_ms, int)
        or full_answer_budget.budget_ms <= 0
    ):
        raise ValueError("FULL_ANSWER budget must be a positive matching BudgetPolicy")


async def run_agent_loop(params: LoopParams) -> AsyncIterator[Any]:
    """Run one agentic query loop; yields events, Terminal on LoopStopped.

    CC's ``AsyncGenerator<StreamEvent, Terminal>`` dual channel cannot be
    reproduced verbatim: PEP 525 forbids ``return value`` in async
    generators, so the Terminal is delivered as the **final** event
    (:class:`LoopStopped`). Consumers collect events and read
    ``events[-1].terminal``; the generator itself returns None.

    ``params.event_sink`` (when set) receives a copy of every yielded
    event before the caller sees it, so a UI/progress channel can react
    (turn started / budget renewed / tool finished) without consuming the
    generator. A raising sink never kills the loop.

    Per-turn flow: budget check (rolling deadline with per-turn renewal;
    only genuine stalls hard-cut) -> interrupt check -> model turn ->
    withheld recovery (bounded by ``MAX_OUTPUT_TOKENS_RECOVERY_LIMIT``,
    compactor fires once) -> truncation invalidation
    (``client.last_truncated``) -> tool execution (concurrency-safe batch
    on a thread pool, then sequential in order) -> stop-hook gateway ->
    rebuild state and continue, or terminate.
    """
    _validate_loop_params(params)
    sink = params.event_sink
    try:
        async for event in _run_agent_loop(params):
            if isinstance(event, LoopStopped) and params.session is not None:
                open_turn = params.session.open_turn
                if open_turn is not None:
                    params.session.end_turn(
                        open_turn,
                        reason=event.terminal.reason.value,
                        detail=event.terminal.message,
                    )
            if sink is not None:
                try:
                    sink(event)
                except Exception:  # noqa: BLE001 -- progress plumbing never kills the loop
                    pass
            yield event
    except BaseException:
        # A process crash cannot run this branch, but ordinary runtime failures
        # can still leave a durable open turn. Close it using the same
        # risk-aware repair path resume uses. Never hide the original failure
        # if the journal itself is unavailable.
        if params.session is not None and params.session.open_turn is not None:
            try:
                params.session.repair_interrupted_turn()
            except Exception:  # noqa: BLE001
                pass
        raise


def _withheld_recovery_plan(
    state: TurnState,
    params: LoopParams,
    text: str | None,
) -> tuple[list[AgentMessage], TransitionReason, bool]:
    """CC withhold 恢复轮的消息计划（纯构造 + 可选会话落盘）。

    返回 ``(messages, transition_reason, has_attempted_compact)``；
    调用方负责 with_transition / TurnFinished / 计数。
    """
    messages = list(state.messages)
    if text is not None:
        partial = AgentMessage(
            role=Role.ASSISTANT,
            content=text,
            tool_call_id=None,
            name=None,
            origin=ORIGIN_DATA,
        )
        messages.append(partial)
        if params.session is not None:
            params.session.append_message(partial)
    recovery_message = AgentMessage(
        role=Role.USER,
        content=_RECOVERY_MESSAGE,
        tool_call_id=None,
        name=None,
        origin=ORIGIN_DATA,
        injected=True,
    )
    messages.append(recovery_message)
    if params.session is not None:
        params.session.append_message(recovery_message)
        messages = params.session.derive_messages()
    has_attempted = state.has_attempted_reactive_compact
    transition_reason = TransitionReason.MAX_OUTPUT_TOKENS_RECOVERED
    if not has_attempted and params.compactor is not None:
        compacted_messages = params.compactor(list(messages))
        if len(compacted_messages) < len(messages):
            messages = compacted_messages
            has_attempted = True
            transition_reason = TransitionReason.COMPACT_TRIGGERED
            if params.session is not None:
                params.session.replace_messages(
                    messages,
                    reason="reactive_context_compaction",
                )
                messages = params.session.derive_messages()
    return messages, transition_reason, has_attempted


def _truncation_messages(
    state: TurnState,
    params: LoopParams,
    calls: Sequence[ToolCall],
    text: str | None,
) -> list[AgentMessage]:
    """截断恢复轮的消息计划：请求原样保留，工具调用全部换成截断提示结果。"""
    messages = list(state.messages)
    truncated_request = AgentMessage(
        role=Role.ASSISTANT,
        content=text or "",
        tool_call_id=None,
        name=None,
        tool_calls=tuple(
            {
                "id": call.id,
                "name": call.name,
                "arguments": dict(call.arguments),
            }
            for call in calls
        ),
        origin=ORIGIN_DATA,
    )
    truncated_results = [
        AgentMessage(
            role=Role.TOOL,
            content=_TRUNCATION_MESSAGE,
            tool_call_id=call.id,
            name=call.name,
            is_error=False,
            origin=ORIGIN_DATA,
        )
        for call in calls
    ]
    messages.extend((truncated_request, *truncated_results))
    if params.session is not None:
        params.session.append_message(truncated_request)
        for truncated_result in truncated_results:
            params.session.append_message(truncated_result)
        messages = params.session.derive_messages()
    return messages


async def _run_agent_loop(params: LoopParams) -> AsyncIterator[Any]:
    """The loop body (see :func:`run_agent_loop` for the public contract)."""
    registry = params.registry
    client = params.client
    # Loop budgets are expressed in milliseconds.  Keep that invariant at
    # this public seam as well as in higher-level callers; otherwise a direct
    # LoopParams user silently turns a 4-second budget into ~66 minutes.
    clock = (
        params.clock
        if params.clock is not None
        else lambda: time.perf_counter() * 1000.0
    )
    cancel_registry = (
        params.cancel_registry if params.cancel_registry is not None else get_registry()
    )
    start_ms = clock()
    budget_ms = float(params.budgets[_FULL_ANSWER_STAGE].budget_ms)
    deadline_ms = start_ms + budget_ms
    renewals_used = 0
    last_progress_turn = 0
    fruitless_compactions = 0
    backend_recovery_attempts = 0
    tool_schemas = _select_tool_schemas(params)
    tool_schema_tokens = estimate_text_tokens(str(tool_schemas))
    loaded_extra: list[str] = []
    stop_hooks = tuple(params.stop_hooks)
    keepalive = params.keepalive

    def _beat(label: str) -> None:
        """Optional stderr heartbeat for the IPC bridge idle deadline.

        The Electron-side ``python_bridge_runner`` kills any Python child
        that stays silent on stderr/stdout for 60s (the long-task ceiling
        users see as "agent disconnected mid-run"). One callback per turn
        and per tool is enough to keep the deadline re-armed without
        inventing data the model did not produce; receivers must be silent
        on failure because a broken heartbeat must never abort a tool call.
        """
        if keepalive is None:
            return
        try:
            keepalive(label)
        except Exception:  # noqa: BLE001 - heartbeat is best-effort
            return

    first_messages = _first_messages(params)
    if params.session is not None:
        # Hold the durable turn lease until turn/end. A concurrent bridge may
        # resume the same session, but it must not mistake this live turn for a
        # crashed one and synthesize repair results underneath the model.
        params.session.start_turn(hold_lease=True)
        params.session.record_interaction_start(params.interaction_metadata)
        for message in first_messages:
            params.session.append_message(message)
        initial_messages = params.session.derive_messages()
    else:
        initial_messages = list(first_messages)
    state = TurnState(
        messages=initial_messages,
        tool_calls_pending=[],
    )
    results: list[ToolResult] = []
    model_usage: dict[str, int] = {}
    last_real_prompt_tokens = 0
    last_transition: TransitionReason | None = None
    turn_number = 1
    hook_notes: list[str] = []
    tool_guardrails = ToolCallGuardrailController(params.tool_guardrail_config)
    verification_gate = VerificationGate()

    def _stop(terminal: Terminal) -> LoopStopped:
        if params.session is not None:
            _record_loop_receipt(
                params.session, verification_gate, terminal, results
            )
        return LoopStopped(terminal)

    yield LoopStart()

    with CancellationScope(cancel_registry) as loop_scope:
        while True:
            now_ms = clock()
            if now_ms > deadline_ms:
                last_round_productive = (
                    last_progress_turn > 0
                    and turn_number - 1 == last_progress_turn
                )
                # Compaction and pending inbox / tool suspension are forms of
                # genuine progress that the pure tool-mark metric cannot see.
                # A round that fired proactive compaction spent a turn paying
                # for cheaper follow-up calls; a round that woke for a
                # pending user steer must not be killed by the deadline check
                # before it can act (Codex agent.rs::is_auto_compact +
                # input_queue pending).
                compaction_progress = (
                    last_transition is TransitionReason.COMPACT_TRIGGERED
                )
                pending_steer_or_input = (
                    params.inbox is not None and params.inbox.has_pending()
                )
                productive = (
                    last_round_productive
                    or compaction_progress
                    or pending_steer_or_input
                )
                if productive and params.budget_renewals > 0:
                    # A productive round always renews: the budget constrains
                    # feedback rhythm, not loop life (review T1). The renewals
                    # cap is not consulted for genuinely progressing work —
                    # hard cuts apply only to non-productive rounds
                    # (duplicate evidence, pure errors, stalls) below.
                    # budget_renewals=0 keeps the explicit single-budget mode.
                    renewals_used += 1
                    deadline_ms = now_ms + budget_ms
                    yield BudgetRenewed(
                        turn=turn_number,
                        deadline_ms=deadline_ms,
                        renewals_used=renewals_used,
                    )
                else:
                    terminal = Terminal(
                        reason=TransitionReason.BUDGET_EXHAUSTED,
                        message=_build_partial_delivery_message(
                            results, getattr(params, "todo_store", None)
                        ),
                        turns=turn_number - 1,
                        results=tuple(results),
                        model_usage=_model_usage_snapshot(model_usage),
                    )
                    yield _stop(terminal)
                    return
            elapsed_ms = now_ms - start_ms
            remaining_ms = max(0.0, deadline_ms - now_ms)

            state = with_transition(
                state,
                last_transition,  # type: ignore[arg-type]  # None on turn 1
                turn_count=turn_number,
                budget_remaining_ms=remaining_ms,
            )
            validate_messages(state.messages)
            _beat(f"agent_turn turn={turn_number}")
            yield TurnStarted(turn=turn_number)

            if (
                params.compactor is not None
                and params.context_budget_tokens is not None
                and params.token_estimator is not None
                and fruitless_compactions < _MAX_FRUITLESS_COMPACTIONS
                and (
                    _over_compact_threshold(params, state.messages, tool_schema_tokens)
                    # The provider's own prompt_tokens from the previous round
                    # is ground truth. The real-machine notepad-edit run had
                    # the estimator at ~48k while the provider reported 86k —
                    # CJK-heavy contexts defeat char-rate estimates, and a
                    # late compaction costs whole rounds of duplicated tool
                    # output (or a context-window rejection).
                    or last_real_prompt_tokens
                    >= _PROACTIVE_COMPACT_RATIO * params.context_budget_tokens
                )
            ):
                compacted_messages = params.compactor(list(state.messages))
                # Judge by weight, not by count. Compaction trades many
                # messages for one summary and may re-attach carried-over
                # state (the unfinished plan), so the list can get *longer*
                # while the request gets much smaller.
                compactor_succeeded_this_turn = False
                if params.token_estimator(compacted_messages) < params.token_estimator(
                    list(state.messages)
                ):
                    if params.session is not None:
                        params.session.replace_messages(
                            compacted_messages,
                            reason="proactive_context_compaction",
                        )
                        compacted_messages = params.session.derive_messages()
                    state = with_transition(
                        state,
                        TransitionReason.COMPACT_TRIGGERED,
                        messages=compacted_messages,
                        tool_calls_pending=[],
                        turn_count=turn_number,
                    )
                    yield TurnFinished(state)
                    compactor_succeeded_this_turn = True
                    # Still over the line after compacting means the history is
                    # not where the weight is; summarising again costs a model
                    # call and buys nothing.
                    fruitless_compactions = (
                        fruitless_compactions + 1
                        if _over_compact_threshold(
                            params, compacted_messages, tool_schema_tokens
                        )
                        else 0
                    )
                else:
                    fruitless_compactions += 1
                # A successful compaction spent a round paying for cheaper
                # follow-up calls; without marking it productive, the next
                # model's deadline check sees the stale progress marker
                # (the previous turn's tool call) and hard-cuts a long
                # task that is genuinely making progress (review T1).
                if compactor_succeeded_this_turn:
                    last_progress_turn = turn_number

            if params.interrupt_check is not None and params.interrupt_check():
                terminal = Terminal(
                    reason=TransitionReason.USER_INTERRUPT,
                    message="user interrupt",
                    turns=turn_number,
                    results=tuple(results),
                    model_usage=_model_usage_snapshot(model_usage),
                )
                yield _stop(terminal)
                return


            if loop_scope.is_cancelled:
                raise CancelledError("cancelled before model call")

            ephemeral_steer = (
                params.inbox.drain("next-step") if params.inbox is not None else []
            )
            if params.session is not None:
                for text in ephemeral_steer:
                    params.session.enqueue_inbox(text, "next-step")
                steered_texts = params.session.claim_inbox("next-step")
            else:
                steered_texts = ephemeral_steer
            if steered_texts:
                steer_messages = [
                    AgentMessage(
                        role=Role.USER,
                        content=text,
                        tool_call_id=None,
                        name=None,
                        origin=ORIGIN_INSTRUCTION,
                    )
                    for text in steered_texts
                ]
                state = with_transition(
                    state,
                    TransitionReason.TOOL_RESULT,
                    messages=(
                        params.session.derive_messages()
                        if params.session is not None
                        else [*state.messages, *steer_messages]
                    ),
                    tool_calls_pending=[],
                    turn_count=turn_number,
                )
                validate_messages(state.messages)
                yield Steered(turn=turn_number, texts=tuple(steered_texts))

            if params.session is not None:
                params.session.record_model_request(
                    state.messages,
                    tools=tool_schemas,
                    header=params.request_header,
                    step=turn_number,
                )
            events = client.generate_turn(
                state.messages,
                tool_schemas,
                budget_ms=remaining_ms,
                cancel_scope=loop_scope.token,
            )
            if loop_scope.is_cancelled:
                raise CancelledError("cancelled during model call")
            calls, text = client.parse_tool_calls(events)
            _merge_model_usage(model_usage, client.last_usage)
            last_real_prompt_tokens = _real_prompt_tokens(client.last_usage)
            if params.session is not None:
                params.session.record_model_response(
                    step=turn_number,
                    outcome=(
                        "withheld"
                        if any(isinstance(event, TurnWithheld) for event in events)
                        else "completed"
                    ),
                    usage=client.last_usage,
                    output_text_chars=len(text or ""),
                    tool_call_count=len(calls),
                )
            yielded_delta = 0
            for event in events:
                if isinstance(event, MessageDelta):
                    yield ModelChunk(text=event.text)
                    yielded_delta += 1
            if yielded_delta == 0 and text is not None:
                yield ModelChunk(text)

            if any(isinstance(event, TurnWithheld) for event in events):
                withheld_events = [
                    event for event in events if isinstance(event, TurnWithheld)
                ]
                token_withheld = any(
                    _is_token_withheld(event.reason) for event in withheld_events
                )
                if not token_withheld:
                    reasons = ", ".join(event.reason for event in withheld_events)
                    # A transient backend failure must not throw away a turn
                    # that has already done work (real-machine notepad-edit:
                    # ten productive rounds, the document actually edited,
                    # then one skipped call killed everything). Wait out a
                    # breaker-scale cooldown and retry the same round; only
                    # a turn with zero progress terminates immediately.
                    if (
                        any(not result.is_error for result in results)
                        and backend_recovery_attempts < _MAX_BACKEND_RECOVERIES
                    ):
                        delay_s = _BACKEND_RECOVERY_DELAYS_S[
                            backend_recovery_attempts
                        ]
                        bounded_delay_s = min(
                            delay_s, max(0.0, (remaining_ms - 1_000.0) / 1000.0)
                        )
                        if bounded_delay_s >= 1.0:
                            backend_recovery_attempts += 1
                            yield BackendRecovery(
                                turn=turn_number,
                                attempt=backend_recovery_attempts,
                                delay_s=bounded_delay_s,
                                reason=reasons,
                            )
                            state = with_transition(
                                state,
                                TransitionReason.BACKEND_RECOVERY,
                                tool_calls_pending=[],
                                turn_count=turn_number,
                                last_result=results[-1] if results else None,
                            )
                            yield TurnFinished(state)
                            _sleep(bounded_delay_s)
                            if loop_scope.is_cancelled:
                                raise CancelledError(
                                    "cancelled during backend recovery wait"
                                )
                            continue
                    terminal = Terminal(
                        reason=TransitionReason.PROVIDER_UNAVAILABLE,
                        message=reasons or "backend_error:unknown",
                        turns=turn_number,
                        results=tuple(results),
                        model_usage=_model_usage_snapshot(model_usage),
                    )
                    yield _stop(terminal)
                    return
                recovery = state.max_output_tokens_recovery_count + 1
                if recovery > MAX_OUTPUT_TOKENS_RECOVERY_LIMIT:
                    terminal = Terminal(
                        reason=TransitionReason.MAX_OUTPUT_TOKENS_RECOVERED,
                        message="max output tokens recovery limit exceeded",
                        turns=turn_number,
                        results=tuple(results),
                        model_usage=_model_usage_snapshot(model_usage),
                    )
                    yield _stop(terminal)
                    return
                (
                    messages,
                    transition_reason,
                    has_attempted,
                ) = _withheld_recovery_plan(state, params, text)
                last_transition = transition_reason
                state = with_transition(
                    state,
                    transition_reason,
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
                messages = list(state.messages)
                if text is not None:
                    final_message = AgentMessage(
                        role=Role.ASSISTANT,
                        content=text,
                        tool_call_id=None,
                        name=None,
                        origin=ORIGIN_DATA,
                    )
                    messages.append(final_message)
                    if params.session is not None:
                        params.session.append_message(final_message)
                        messages = params.session.derive_messages()
                if stop_hooks and not state.stop_hook_active:
                    hook_state = with_transition(
                        state,
                        TransitionReason.COMPLETED,
                        messages=messages,
                        tool_calls_pending=[],
                        last_result=results[-1] if results else None,
                    )
                    decision, hook_errored = _run_stop_hooks(
                        stop_hooks, hook_state, hook_notes
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
                            model_usage=_model_usage_snapshot(model_usage),
                        )
                        yield _stop(terminal)
                        return
                    if hook_errored:
                        last_transition = TransitionReason.STOP_HOOK
                        state = with_transition(
                            state,
                            TransitionReason.STOP_HOOK,
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
                nudge = should_nudge_before_completion(verification_gate)
                if nudge is None:
                    for nudge_hook in params.nudge_hooks:
                        try:
                            nudge = nudge_hook()
                        except Exception as exc:  # noqa: BLE001 - gates never kill the loop
                            del exc
                            continue
                        if nudge:
                            break
                if nudge is not None:
                    verification_gate.mark_nudged()
                    nudge_message = AgentMessage(
                        role=Role.USER,
                        content=nudge,
                        tool_call_id=None,
                        name=None,
                        origin=ORIGIN_INSTRUCTION,
                    )
                    if params.session is not None:
                        params.session.append_message(nudge_message)
                    state = with_transition(
                        state,
                        TransitionReason.STOP_HOOK,
                        messages=(
                            params.session.derive_messages()
                            if params.session is not None
                            else [*messages, nudge_message]
                        ),
                        tool_calls_pending=[],
                        turn_count=turn_number,
                        stop_hook_active=True,
                        last_result=results[-1] if results else None,
                    )
                    yield TurnFinished(state)
                    yield VerificationNudged(turn=turn_number)
                    turn_number += 1
                    continue
                ephemeral_followups = (
                    params.inbox.drain("next-turn")
                    if params.inbox is not None
                    else []
                )
                if params.session is not None:
                    for body in ephemeral_followups:
                        params.session.enqueue_inbox(body, "next-turn")
                    followup_texts = params.session.claim_inbox("next-turn")
                else:
                    followup_texts = ephemeral_followups
                if followup_texts:
                    followup_messages = [
                        AgentMessage(
                            role=Role.USER,
                            content=body,
                            tool_call_id=None,
                            name=None,
                            origin=ORIGIN_INSTRUCTION,
                        )
                        for body in followup_texts
                    ]
                    state = with_transition(
                        state,
                        TransitionReason.TOOL_RESULT,
                        messages=(
                            params.session.derive_messages()
                            if params.session is not None
                            else [*messages, *followup_messages]
                        ),
                        tool_calls_pending=[],
                        turn_count=turn_number,
                        stop_hook_active=False,
                        last_result=results[-1] if results else None,
                    )
                    yield TurnFinished(state)
                    yield FollowupContinued(turn=turn_number, texts=tuple(followup_texts))
                    turn_number += 1
                    continue
                if params.session is not None and str(text or "").strip():
                    params.session.record_artifact_generated(str(text))
                final_state = with_transition(
                    state,
                    TransitionReason.COMPLETED,
                    messages=messages,
                    last_result=results[-1] if results else None,
                    stop_hook_active=False,
                )
                terminal = Terminal(
                    reason=TransitionReason.COMPLETED,
                    message=text or "",
                    turns=turn_number,
                    results=tuple(results),
                    model_usage=_model_usage_snapshot(model_usage),
                )
                yield TurnFinished(final_state)
                yield _stop(terminal)
                return

            if client.last_truncated:
                messages = _truncation_messages(state, params, calls, text)
                if turn_number + 1 > params.emergency_turn_fuse:
                    terminal = Terminal(
                        reason=TransitionReason.INVARIANT_FAILED,
                        message="emergency turn fuse reached; agent loop invariant failed",
                        turns=turn_number,
                        results=tuple(results),
                        model_usage=_model_usage_snapshot(model_usage),
                    )
                    yield _stop(terminal)
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

            # A clarification request is a turn boundary, not one more tool in
            # a speculative batch. If the model emitted actions beside it,
            # retain only the question: executing work before the answer would
            # defeat the purpose of asking and can create stale side effects.
            # The assistant message keeps the full call list (so ids
            # round-trip), and each dropped call gets an explicit TOOL result
            # saying it never ran — the model must not believe writes happened
            # (runtime-audit P2).
            suspending_call = next(
                (
                    call
                    for call in calls
                    if _tool_suspends_for_user_input(registry, call.name)
                ),
                None,
            )
            skipped_calls: list[ToolCall] = []
            if suspending_call is not None:
                skipped_calls = [call for call in calls if call is not suspending_call]
                calls = [suspending_call]
            for call in skipped_calls:
                skipped_result = ToolResult(
                    tool_call_id=call.id,
                    value=(
                        f"not executed: {call.name} was dropped because "
                        "clarification was requested in the same turn"
                    ),
                    is_error=False,
                    failure_type="not_executed",
                    used_backend=None,
                    latency_ms=None,
                    tool_name=call.name,
                    arguments=dict(call.arguments),
                )
                results.append(skipped_result)

            all_calls = [call for call in calls] + list(skipped_calls)
            assistant_tool_message = AgentMessage(
                role=Role.ASSISTANT,
                content=text or "",
                tool_call_id=None,
                name=None,
                tool_calls=tuple(
                    {
                        "id": call.id,
                        "name": call.name,
                        "arguments": dict(call.arguments),
                    }
                    for call in all_calls
                ),
                origin=ORIGIN_DATA,
            )
            if params.session is not None:
                params.session.append_message(assistant_tool_message)

            tool_messages: list[AgentMessage] = []
            for call in skipped_calls:
                skipped = next(
                    result for result in results
                    if result.tool_call_id == call.id
                    and result.failure_type == "not_executed"
                )
                skipped_message = AgentMessage(
                    role=Role.TOOL,
                    content=skipped.value,
                    tool_call_id=skipped.tool_call_id,
                    name=call.name,
                    is_error=skipped.is_error,
                    origin=ORIGIN_DATA,
                )
                tool_messages.append(skipped_message)
                if params.session is not None:
                    params.session.append_message(skipped_message)
            any_error = False
            round_progress = False
            halt_decision: ToolGuardrailDecision | None = None
            pending_input: dict[str, Any] | None = None

            def classify_tool(call: ToolCall) -> str:
                try:
                    return (
                        "parallel"
                        if registry.get(call.name).is_concurrency_safe
                        else "exclusive"
                    )
                except KeyError:
                    return "exclusive"

            def execute_scheduled(call: ToolCall) -> ToolResult:
                return _execute_one(
                    registry,
                    call,
                    cancel_registry,
                    loop_scope,
                    params.allowed_effects,
                    params.precondition_context_factory,
                    params.hook_manager,
                    params.permission_mode,
                    interrupt_check=params.interrupt_check,
                )

            schedule = schedule_tool_calls(
                calls,
                classify=classify_tool,
                conflict_keys=lambda call: registry.resource_keys_for(
                    call.name, call.arguments
                ),
                execute=execute_scheduled,
                max_parallel_tool_calls=params.max_parallel_tool_calls,
                is_cancelled=lambda: loop_scope.is_cancelled,
            )
            operation_ids: dict[int, str] = {}
            for scheduled in schedule:
                call = scheduled.call
                if isinstance(scheduled, ScheduledCallStarted):
                    if params.session is not None:
                        try:
                            effect = spec_effect(
                                registry.get(call.name), call.arguments
                            )
                        except KeyError:
                            effect = Effect.DESTRUCTIVE
                        prepared = params.session.record_tool_call(
                            call.id,
                            call.name,
                            call.arguments,
                            step=turn_number,
                            effect=effect,
                            dispatched=scheduled.dispatched,
                        )
                        operation_ids[id(call)] = str(prepared.data["operationId"])
                    if scheduled.dispatched:
                        yield ToolCallStarted(name=call.name, id=call.id)
                    continue

                if not isinstance(scheduled, ScheduledCallCommitted):
                    raise RuntimeError(
                        f"unknown tool scheduler event {type(scheduled).__name__}"
                    )
                normalized, guardrail_decision = _apply_tool_guardrail(
                    tool_guardrails, registry, call, scheduled.result
                )
                if normalized.tool_name is None:
                    normalized = ToolResult(
                        tool_call_id=normalized.tool_call_id,
                        value=normalized.value,
                        is_error=normalized.is_error,
                        failure_type=normalized.failure_type,
                        used_backend=normalized.used_backend,
                        latency_ms=normalized.latency_ms,
                        tool_name=call.name,
                        arguments=dict(call.arguments),
                    )
                results.append(normalized)
                if normalized.is_error:
                    any_error = True
                else:
                    committed_spec = registry.get(call.name)
                    if committed_spec is not None:
                        verification_gate.record_executed(
                            effect=spec_effect(committed_spec, call.arguments),
                            verified=(
                                committed_spec.verify_result is not None
                                or _json_verification_matched(normalized.value)
                            ),
                            tool_name=call.name,
                        )
                if guardrail_decision.made_progress:
                    round_progress = True
                if guardrail_decision.should_halt and halt_decision is None:
                    halt_decision = guardrail_decision
                tool_message = AgentMessage(
                    role=Role.TOOL,
                    content=normalized.value,
                    tool_call_id=normalized.tool_call_id,
                    name=call.name,
                    is_error=normalized.is_error,
                    origin=ORIGIN_DATA,
                )
                tool_messages.append(tool_message)
                if params.session is not None:
                    operation_id = operation_ids.get(id(call))
                    if operation_id is None:
                        raise RuntimeError(
                            f"tool call {call.id!r} committed without a prepared operation"
                        )
                    outcome = None
                    if not scheduled.dispatched:
                        outcome = "not_started"
                    elif not scheduled.outcome_known:
                        outcome = "unknown"
                    params.session.record_tool_settlement(
                        operation_id,
                        tool_message,
                        failure_type=normalized.failure_type,
                        used_backend=normalized.used_backend,
                        latency_ms=normalized.latency_ms,
                        outcome=outcome,
                    )
                yield ToolCallFinished(result=normalized)
                _beat(f"tool_done name={call.name} ok={int(not normalized.is_error)}")
                if (
                    not normalized.is_error
                    and _tool_suspends_for_user_input(registry, call.name)
                ):
                    pending_input = _pending_user_input(normalized.value)

            if round_progress:
                last_progress_turn = turn_number

            # Provider discovery tools may register deferred tools while they
            # execute. Load only names returned by a registry-declared
            # discovery tool; ordinary tool output can never alter schemas.
            for message in tool_messages:
                if message.is_error or not message.name:
                    continue
                try:
                    discovery_spec = params.registry.get(message.name)
                except KeyError:
                    continue
                if not discovery_spec.discovers_tools:
                    continue
                discovered = _discovered_tool_names(message.content or "")
                for name in discovered:
                    if name not in loaded_extra:
                        loaded_extra.append(name)
            if loaded_extra:
                tool_schemas = _select_tool_schemas(params, extra_names=loaded_extra)
                tool_schema_tokens = estimate_text_tokens(str(tool_schemas))

            if pending_input is not None:
                messages = list(state.messages)
                messages.append(assistant_tool_message)
                messages.extend(tool_messages)
                if params.session is not None:
                    messages = params.session.derive_messages()
                waiting_state = with_transition(
                    state,
                    TransitionReason.AWAITING_USER,
                    messages=messages,
                    tool_calls_pending=[],
                    turn_count=turn_number,
                    max_output_tokens_recovery_count=0,
                    last_result=results[-1] if results else None,
                )
                terminal = Terminal(
                    reason=TransitionReason.AWAITING_USER,
                    message=str(pending_input["question"]),
                    turns=turn_number,
                    results=tuple(results),
                    pending_input=pending_input,
                    model_usage=_model_usage_snapshot(model_usage),
                )
                yield TurnFinished(waiting_state)
                yield _stop(terminal)
                return

            if halt_decision is not None:
                terminal = Terminal(
                    reason=TransitionReason.STALLED,
                    message=halt_decision.message,
                    turns=turn_number,
                    results=tuple(results),
                    model_usage=_model_usage_snapshot(model_usage),
                )
                yield _stop(terminal)
                return

            if turn_number + 1 > params.emergency_turn_fuse:
                terminal = Terminal(
                    reason=TransitionReason.INVARIANT_FAILED,
                    message="emergency turn fuse reached; agent loop invariant failed",
                    turns=turn_number,
                    results=tuple(results),
                    model_usage=_model_usage_snapshot(model_usage),
                )
                yield _stop(terminal)
                return

            last_transition = (
                TransitionReason.TOOL_ERROR if any_error else TransitionReason.TOOL_RESULT
            )
            messages = list(state.messages)
            messages.append(assistant_tool_message)
            messages.extend(tool_messages)
            if params.session is not None:
                messages = params.session.derive_messages()
            state = with_transition(
                state,
                last_transition,
                messages=messages,
                tool_calls_pending=[],
                turn_count=turn_number,
                max_output_tokens_recovery_count=0,
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
        # A hook returning None violates the StopDecision contract; treat it
        # like a raising hook instead of AttributeError-ing the whole loop
        # (runtime-audit P2: 'hook failures never kill the loop').
        if not isinstance(decision, StopDecision):
            notes.append(
                f"stop hook {hook!r} returned {type(decision).__name__} "
                "instead of StopDecision"
            )
            return None, True
        if decision.prevent_continuation:
            return decision, False
    return None, False


def _is_token_withheld(reason: str) -> bool:
    """True for the output-token withhold class (CC withhold-until-recover).

    ``AiClientBackend`` maps every backend failure to
    ``TurnWithheld(reason="backend_error:...")``; only the token-limit class
    (``max_output_tokens`` or empty) may consume the recovery ceiling.
    """
    return reason in ("", "max_output_tokens")


def _first_messages(params: LoopParams) -> list[AgentMessage]:
    """Initial messages: the instruction, then the evidence as data.

    The bridge used to concatenate the grounded evidence block into the first
    user message, which stamped the whole thing ``origin=instruction`` and
    made screen text structurally indistinguishable from the user's command.
    ``evidence_input`` now travels as a separate user-role message tagged
    ``origin=ORIGIN_DATA`` + ``injected=True`` (the one legal user/data
    combination), so the instruction channel filter never sees screen data
    (invariant: screen content is always data).
    """
    if params.trajectory is not None:
        content = params.trajectory.first_user_message.replace(
            "{input}", params.user_input
        )
    else:
        content = params.user_input
    messages = [
        AgentMessage(
            role=Role.USER,
            content=content,
            tool_call_id=None,
            name=None,
            origin=ORIGIN_INSTRUCTION,
        )
    ]
    if params.evidence_input:
        messages.append(
            AgentMessage(
                role=Role.USER,
                content=params.evidence_input,
                tool_call_id=None,
                name=None,
                origin=ORIGIN_DATA,
                injected=True,
            )
        )
    return messages


def instruction_messages(messages: Sequence[AgentMessage]) -> list[AgentMessage]:
    """Filter to the instruction channel (``origin=ORIGIN_INSTRUCTION``).

    Genuine user entries only (first user message, future voice/gesture
    entries); tool results and harness-internal data never reach the
    instruction channel. Intended for future system prompt assembly.
    """
    return [message for message in messages if message.origin == ORIGIN_INSTRUCTION]


def validate_messages(messages: Sequence[AgentMessage]) -> None:
    """Assert role/origin legality; raise ValueError on an illegal combo.

    ``ORIGIN_DATA`` messages may only use the TOOL/ASSISTANT roles — a data
    message must never masquerade as a user instruction — except
    harness-injected token-recovery feedback (``injected=True``),
    which uses the user role so the model treats it as a corrective signal
    (CC withhold recovery pattern); it is never a user instruction.
    ``ORIGIN_INSTRUCTION`` messages may never use the TOOL role (tool output
    is always data).
    """
    for message in messages:
        if message.origin == ORIGIN_DATA and message.role is Role.USER:
            if not message.injected:
                raise ValueError(
                    f"origin={ORIGIN_DATA!r} message must not use role "
                    f"{message.role.value} (content={message.content!r})"
                )
        if message.origin == ORIGIN_INSTRUCTION and message.role is Role.TOOL:
            raise ValueError(
                f"origin={ORIGIN_INSTRUCTION!r} message must not use role "
                f"{message.role.value} (content={message.content!r})"
            )


def _select_tool_schemas(
    params: LoopParams,
    *,
    extra_names: Sequence[str] = (),
) -> list[dict[str, object]]:
    """Tool list: trajectory-recommended (registered ones) first, then tools
    discovered via find_capability (``extra_names``), then the rest of the
    registry in registration order, truncated at tool_limit."""

    registry = params.registry
    specs = {spec.name: spec for spec in registry.list()}
    selected: list[str] = []
    if params.trajectory is not None:
        for name in params.trajectory.recommended_tools:
            if name in specs and name not in selected:
                selected.append(name)
    for name in extra_names:
        if name in specs and name not in selected:
            selected.append(name)
    for spec in registry.list():
        if spec.name in selected or spec.deferred:
            # Deferred tools (Codex exposure model) stay out of the initial
            # list; find_capability surfaces and loads them on demand.
            continue
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


def _discovered_tool_names(value: str) -> list[str]:
    """Parse find_capability's JSON result for discovered tool names."""
    try:
        payload = json.loads(value)
    except (ValueError, TypeError):
        return []
    if not isinstance(payload, dict):
        return []
    names: list[str] = []
    for item in payload.get("tools") or []:
        if isinstance(item, dict) and isinstance(item.get("name"), str):
            names.append(str(item["name"]))
    return names


def _tool_suspends_for_user_input(registry: ToolRegistry, name: str) -> bool:
    try:
        return registry.get(name).suspends_for_user_input
    except KeyError:
        return False


def _merge_model_usage(
    aggregate: dict[str, int], raw_usage: Mapping[str, Any] | None
) -> None:
    """Merge OpenAI- and Messages-style counters into one vocabulary."""
    if not isinstance(raw_usage, Mapping):
        return

    def count(*keys: str) -> int | None:
        for key in keys:
            value = raw_usage.get(key)
            if (
                isinstance(value, (int, float))
                and not isinstance(value, bool)
                and math.isfinite(value)
            ):
                return max(0, int(value))
        return None

    input_tokens = count("input_tokens", "prompt_tokens")
    output_tokens = count("output_tokens", "completion_tokens")
    total_tokens = count("total_tokens")
    if total_tokens is None and (input_tokens is not None or output_tokens is not None):
        total_tokens = (input_tokens or 0) + (output_tokens or 0)
    if input_tokens is not None:
        aggregate["inputTokens"] = aggregate.get("inputTokens", 0) + input_tokens
    if output_tokens is not None:
        aggregate["outputTokens"] = aggregate.get("outputTokens", 0) + output_tokens
    if total_tokens is not None:
        aggregate["totalTokens"] = aggregate.get("totalTokens", 0) + total_tokens
    if any(value is not None for value in (input_tokens, output_tokens, total_tokens)):
        aggregate["turnsReported"] = aggregate.get("turnsReported", 0) + 1


def _model_usage_snapshot(aggregate: Mapping[str, int]) -> dict[str, int] | None:
    return dict(aggregate) if aggregate else None


def _summarize_tool_result(result: Any, limit: int = 240) -> str:
    """Compact one ToolResult into a single-line digest for partial delivery."""
    name = getattr(result, "tool_call_id", None) or "tool"
    is_error = bool(getattr(result, "is_error", False))
    value = getattr(result, "value", "") or ""
    value = str(value).replace("\n", " ").strip()
    if len(value) > limit:
        value = value[: limit - 1] + "…"
    flag = "ERR" if is_error else "OK"
    return f"{name} [{flag}]: {value}"


def _build_partial_delivery_message(
    results: Sequence[Any], todo_store: Any
) -> str:
    """Compose a human-readable partial delivery for BUDGET_EXHAUSTED.

    The user is looking at a deadline kill. They deserve to know what got
    done, what is still pending, and the last thing that the agent
    observed — Hermes partial delivery (hermes_cli.exit_codes).
    """
    completed: list[str] = []
    for result in results[-5:]:
        completed.append(_summarize_tool_result(result))
    pending: list[str] = []
    todo_snapshot = getattr(todo_store, "read", None)
    if callable(todo_snapshot):
        try:
            todos = todo_snapshot()
        except Exception:
            todos = []
        for entry in list(todos)[-6:]:
            status = entry.get("status") if isinstance(entry, dict) else None
            content = (
                entry.get("content") if isinstance(entry, dict) else None
            ) or str(entry)
            pending.append(f"[{status or 'pending'}] {content}")
    lines = ["full answer budget exhausted", "completed steps:"]
    lines.extend(f"  - {line}" for line in completed) if completed else lines.append("  - (none)")
    lines.append("pending todos:")
    lines.extend(f"  - {line}" for line in pending) if pending else lines.append("  - (none)")
    lines.append("next: the user can /resume to keep going from this point.")
    return "\n".join(lines)


def _pending_user_input(value: str) -> dict[str, Any] | None:
    """Return the bounded clarification payload explicitly requested by a tool."""
    try:
        payload = json.loads(value)
    except (TypeError, ValueError):
        return None
    if not isinstance(payload, dict) or payload.get("awaitingUserInput") is not True:
        return None
    question = str(payload.get("question") or "").strip()[:1000]
    raw_options = payload.get("options")
    if not question or not isinstance(raw_options, list):
        return None
    options = [
        str(option).strip()[:200]
        for option in raw_options[:4]
        if str(option).strip()
    ]
    if len(options) < 2:
        return None
    return {"question": question, "options": options}


def _execute_one(
    registry: ToolRegistry,
    call: ToolCall,
    cancel_registry: CancellationRegistry,
    loop_scope: CancellationScope,
    allowed_effects: tuple[Effect, ...],
    precondition_context_factory: Callable[[ToolCall], PreconditionContext] | None,
    hook_manager: HookManager | None = None,
    permission_mode: str = "default",
    *,
    interrupt_check: Callable[[], bool] | None = None,
) -> ToolResult:
    """Validate, gate, execute and normalize one tool call.

    validate_input failures produce an is_error ToolResult without invoking
    ``execute`` (fail closed). Two permission gates compose: a tool whose
    :class:`Effect` is not in ``allowed_effects`` is refused, and a tool
    whose effect is not ALLOWed by the permission mode is refused with the
    mode's feedback (CC canUseTool permission decision): the model gets an
    is_error ``PERMISSION_DENIED`` result it can read and self-correct
    against — an ASK refusal tells it to propose a plan through a
    capability tool instead of executing directly.
    Declared preconditions (``spec.preconditions``) are evaluated after
    input validation against a :class:`PreconditionContext` from the
    injected ``precondition_context_factory``: an unconfigured factory
    means "cannot evaluate" and is refused fail-closed; a factory that
    returns None is refused the same way as
    ``PERMISSION_DENIED``; a failing precondition blocks ``execute`` and
    feeds the model an is_error result with the failure_type passthrough
    and the recovery hint. Unknown tools are caught as a structured
    TOOL_ERROR instead of a KeyError killing the loop. Execution is
    wrapped in a CancellationScope; once cancelled, the loop raises
    CancelledError instead of feeding the result back. The pre-execution
    check reads the loop's outer scope, so a cancellation that landed
    while the model was generating skips ``execute`` entirely; a
    cancellation that lands mid-execution lets the tool run to completion
    and then raises.
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
    if call.argument_error is not None:
        return ToolResult(
            tool_call_id=call.id,
            value=call.argument_error,
            is_error=True,
            failure_type=FailureType.TOOL_ERROR,
            used_backend=None,
            latency_ms=None,
        )
    resolved_effect = spec_effect(spec, call.arguments)
    if resolved_effect not in allowed_effects:
        return ToolResult(
            tool_call_id=call.id,
            value=(
                f"permission denied: tool {call.name!r} requires effect "
                f"{resolved_effect.value} which is not in allowed_effects "
                f"({', '.join(effect.value for effect in allowed_effects)})"
            ),
            is_error=True,
            failure_type=FailureType.PERMISSION_DENIED,
            used_backend=None,
            latency_ms=None,
        )
    mode_decision = decide_effect(permission_mode, resolved_effect)
    if mode_decision is not PermissionDecision.ALLOW:
        from app.agent_runtime.permission_modes import PermissionMode

        resolved_mode = PermissionMode(permission_mode)
        feedback = PermissionDecisionResult(
            decision=mode_decision,
            mode=resolved_mode,
            effect=resolved_effect,
        ).feedback(call.name)
        return ToolResult(
            tool_call_id=call.id,
            value=feedback,
            is_error=True,
            failure_type=FailureType.PERMISSION_DENIED,
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
    execution_args = call.arguments
    if hook_manager is not None:
        pre = hook_manager.run_pre_tool_use(call.name, call.arguments)
        if not pre.allowed:
            # CC semantics: a blocking PreToolUse hook is fed back to the
            # model as a readable refusal it can self-correct against.
            return ToolResult(
                tool_call_id=call.id,
                value=pre.reason,
                is_error=True,
                failure_type=FailureType.PERMISSION_DENIED,
                used_backend=None,
                latency_ms=None,
            )
        execution_args = pre.input
        try:
            errors = registry.validate_input(spec, execution_args)
        except TypeError as exc:
            # A hook that rewrites input to a non-mapping must not kill the
            # loop (runtime-audit P2: the guardrail's "never kill the loop"
            # role fails on non-dict arguments otherwise).
            return ToolResult(
                tool_call_id=call.id,
                value=f"post-hook input invalid: {exc}",
                is_error=True,
                failure_type=FailureType.TOOL_ERROR,
                used_backend=None,
                latency_ms=None,
            )
        if errors:
            return ToolResult(
                tool_call_id=call.id,
                value="post-hook input invalid: " + "; ".join(errors),
                is_error=True,
                failure_type=FailureType.TOOL_ERROR,
                used_backend=None,
                latency_ms=None,
            )
        if execution_args != call.arguments and callable(spec.resource_keys):
            try:
                original_resources = frozenset(
                    registry.resource_keys_for(call.name, call.arguments)
                )
                effective_resources = frozenset(
                    registry.resource_keys_for(call.name, execution_args)
                )
            except Exception as exc:
                return ToolResult(
                    tool_call_id=call.id,
                    value=(
                        "post-hook resource ownership is not evaluable: "
                        f"{type(exc).__name__}: {exc}"
                    ),
                    is_error=True,
                    failure_type=FailureType.PERMISSION_DENIED,
                    used_backend=None,
                    latency_ms=None,
                )
            if effective_resources != original_resources:
                return ToolResult(
                    tool_call_id=call.id,
                    value=(
                        "post-hook input changed dynamic resource ownership; "
                        "refusing execution after scheduling"
                    ),
                    is_error=True,
                    failure_type=FailureType.PERMISSION_DENIED,
                    used_backend=None,
                    latency_ms=None,
                )
    effective_call = ToolCall(
        id=call.id,
        name=call.name,
        arguments=execution_args,
    )
    if spec.preconditions:
        if precondition_context_factory is None:
            return ToolResult(
                tool_call_id=call.id,
                value=(
                    "preconditions not evaluable: context factory is not "
                    "configured (fail closed)"
                ),
                is_error=True,
                failure_type=FailureType.PERMISSION_DENIED,
                used_backend=None,
                latency_ms=None,
            )
        try:
            context = precondition_context_factory(effective_call)
        except Exception as exc:
            return ToolResult(
                tool_call_id=call.id,
                value=(
                    "precondition probe failed; refusing execution "
                    f"(fail closed): {type(exc).__name__}"
                ),
                is_error=True,
                failure_type=FailureType.PERMISSION_DENIED,
                used_backend=None,
                latency_ms=None,
            )
        if context is None:
            return ToolResult(
                tool_call_id=call.id,
                value=(
                    "preconditions not evaluable: context factory returned "
                    "None (fail closed)"
                ),
                is_error=True,
                failure_type=FailureType.PERMISSION_DENIED,
                used_backend=None,
                latency_ms=None,
            )
        try:
            check_all(spec.preconditions, context)
        except ActionFailure as exc:
            value = exc.message
            if exc.recovery_hint:
                value = f"{value} recovery_hint={exc.recovery_hint}"
            return ToolResult(
                tool_call_id=call.id,
                value=value,
                is_error=True,
                failure_type=exc.failure_type,
                used_backend=None,
                latency_ms=None,
            )
    if loop_scope.is_cancelled:
        raise CancelledError(f"cancelled before tool {call.name!r} ({call.id})")
    # The pre-execution check above only catches a cancel that landed during
    # the model call. A cancel that the bridge observes while a tool is
    # *about* to dispatch (between the model yielding ToolCallArrived and
    # the worker picking it up) would otherwise wait for the tool's full
    # timeout. The runtime contract is that the next tool boundary honours
    # the user's stop, not the wall-clock (CC: stop kills the next tool,
    # not the model). Returning a cancelled result (rather than raising)
    # lets the loop's existing turn-boundary interrupt check convert the
    # observation into a USER_INTERRUPT terminal on the very next round.
    if interrupt_check is not None and interrupt_check():
        return ToolResult(
            tool_call_id=call.id,
            value=f"Error: cancelled before tool {call.name!r} ({call.id})",
            is_error=True,
            failure_type=FailureType.TOOL_ERROR,
            used_backend=None,
            latency_ms=None,
        )
    timeout_fired = threading.Event()
    with CancellationScope(cancel_registry) as scope:
        def expire_tool() -> None:
            timeout_fired.set()
            scope.cancel_all()

        timeout_timer = threading.Timer(spec.timeout_ms / 1000.0, expire_tool)
        timeout_timer.daemon = True
        timeout_timer.start()
        try:
            executed = registry.execute_tool(
                call.name, execution_args, scope=scope.token
            )
        finally:
            timeout_timer.cancel()
    if loop_scope.is_cancelled:
        raise CancelledError(f"cancelled during tool {call.name!r} ({call.id})")
    if timeout_fired.is_set():
        return ToolResult(
            tool_call_id=call.id,
            value=f"Error: tool call timed out after {spec.timeout_ms}ms",
            is_error=True,
            failure_type=FailureType.TIMEOUT,
            used_backend=spec.used_backend,
            latency_ms=executed.latency_ms,
        )
    normalized = _normalize_result(executed, call)
    if hook_manager is not None:
        post = hook_manager.run_post_tool_use(call.name, execution_args, normalized.value)
        if not post.allowed:
            feedback = (
                "PostToolUse hook blocked the result after tool execution: "
                + (post.reason or "blocked by post-tool hook")
            )
            if post.extra_context:
                feedback += "\n\n[hook feedback]\n" + post.extra_context
            return ToolResult(
                tool_call_id=normalized.tool_call_id,
                value=_bounded_tool_result(feedback),
                is_error=True,
                failure_type=FailureType.PERMISSION_DENIED,
                used_backend=normalized.used_backend,
                latency_ms=normalized.latency_ms,
            )
        if post.extra_context:
            return ToolResult(
                tool_call_id=normalized.tool_call_id,
                value=_bounded_tool_result(
                    normalized.value + "\n\n[hook feedback]\n" + post.extra_context
                ),
                is_error=normalized.is_error,
                failure_type=normalized.failure_type,
                used_backend=normalized.used_backend,
                latency_ms=normalized.latency_ms,
            )
    return normalized


def _apply_tool_guardrail(
    controller: ToolCallGuardrailController,
    registry: ToolRegistry,
    call: ToolCall,
    result: ToolResult,
) -> tuple[ToolResult, ToolGuardrailDecision]:
    """Classify progress and append any corrective guidance to a receipt."""

    try:
        effect = registry.resolve_effect(call.name, call.arguments)
    except KeyError:
        # Unknown tools already carry an error result.  READ is only a type
        # placeholder here; failed observations never use effect semantics.
        effect = Effect.READ
    decision = controller.observe(
        call.name,
        call.arguments,
        result.value,
        failed=result.is_error,
        effect=effect,
    )
    guided_value = append_toolguard_guidance(result.value, decision)
    if guided_value == result.value:
        return result, decision
    return (
        ToolResult(
            tool_call_id=result.tool_call_id,
            value=guided_value,
            is_error=result.is_error,
            failure_type=result.failure_type,
            used_backend=result.used_backend,
            latency_ms=result.latency_ms,
        ),
        decision,
    )


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
    value = _bounded_tool_result(value)
    return ToolResult(
        tool_call_id=call.id,
        value=value,
        is_error=executed.is_error,
        failure_type=executed.failure_type,
        used_backend=executed.used_backend,
        latency_ms=executed.latency_ms,
    )


def _json_verification_matched(value: Any) -> bool:
    """Desktop tools report verification.matched in JSON; that counts as evidence."""
    if not isinstance(value, str):
        return False
    text = value.strip()
    if not text.startswith("{"):
        return False
    try:
        payload = json.loads(text)
    except json.JSONDecodeError:
        return False
    if not isinstance(payload, dict):
        return False
    verification = payload.get("verification")
    if not isinstance(verification, dict):
        return False
    return verification.get("matched") is True


def _record_loop_receipt(
    session: EventSession,
    gate: VerificationGate,
    terminal: Terminal,
    results: Sequence[ToolResult],
) -> None:
    artifacts = project_artifacts(session.events)
    used_backend = "loop"
    for item in reversed(tuple(results or ())):
        backend = getattr(item, "used_backend", None)
        if backend:
            used_backend = str(backend)
            break
    session.record_receipt(compose_receipt(
        wrote=gate.wrote,
        verified=gate.verified,
        artifact_ids=tuple(item.artifact_id for item in artifacts),
        reason=str(terminal.reason.value),
        used_backend=used_backend,
    ))


def _result_value_text(value: Any) -> str:
    """One text channel for the model: Evidence -> readable JSON, else str."""
    if isinstance(value, Evidence):
        return evidence_to_text(value)
    return "" if value is None else str(value)


def _bounded_tool_result(value: str) -> str:
    """Keep one result from consuming the rest of the Agent context window."""
    if len(value) <= _MAX_TOOL_RESULT_CHARS:
        return value
    digest = hashlib.sha256(value.encode("utf-8", errors="surrogatepass")).hexdigest()
    marker = (
        f"\n[tool result truncated: original_chars={len(value)} sha256={digest}; "
        "preserving beginning and end]\n"
    )
    available = max(0, _MAX_TOOL_RESULT_CHARS - len(marker))
    head = available * 2 // 3
    tail = available - head
    return value[:head] + marker + (value[-tail:] if tail else "")
