
from __future__ import annotations

import hashlib
import json
import math
import threading
import time
from collections.abc import AsyncIterator, Callable, Mapping, Sequence
from contextlib import closing
from dataclasses import dataclass, field, replace
from typing import Any

from app import ai_client as _ai_client
from app.action_guard.preconditions import PreconditionContext, check_all
from app.agent_runtime.errors import (
    MAX_OUTPUT_TOKENS_RECOVERY_LIMIT,
    ActionFailure,
    FailureType,
)
from app.agent_runtime.inbox import Inbox
from app.agent_runtime.usage_cost import estimate_cost_usd
from app.agent_runtime.turn_verification import (
    VerificationGate,
    should_nudge_before_completion,
)
from app.agent_runtime.hooks import HookManager
from app.agent_runtime.model_client import (
    CONTEXT_OVERFLOW_REASON,
    LoopModelClient,
    MessageDelta,
    ModelTurnEvent,
    ReasoningDelta,
    ToolCallArrived,
    TurnDone,
    TurnWithheld,
)
from app.agent_runtime.perception_tools import evidence_to_text
from app.agent_runtime.token_estimate import estimate_text_tokens
from app.agent_runtime.tool_discovery import tool_directory
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
from app.agent_runtime.tool_registry import FIND_CAPABILITY_TOOL, Effect, ToolRegistry, spec_effect
from app.agent_runtime.types import (
    ORIGIN_DATA,
    ORIGIN_INSTRUCTION,
    AgentMessage,
    Role,
    Terminal,
    ToolCall,
    ToolResult,
    TransitionReason,
    TurnState,
    with_transition,
)
from app.artifacts.projection import latest_turn_artifacts
from app.evidence.contract import Evidence, EvidenceStatus
from app.receipts.projection import compose_receipt
from app.run_kernel import RecoveryPolicy, project_operations
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
    "ToolsTruncated",
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

_PROACTIVE_COMPACT_RATIO = 0.8

_MAX_FRUITLESS_COMPACTIONS = 2

_MAX_CONTEXT_OVERFLOW_RECOVERIES = 3

_MAX_EMPTY_RESPONSE_RECOVERIES = 3


def _over_compact_threshold(
    params: LoopParams,
    messages: Sequence[AgentMessage],
    tool_schema_tokens: int,
) -> bool:
    if params.token_estimator is None or params.context_budget_tokens is None:
        return False
    estimated = params.token_estimator(list(messages)) + tool_schema_tokens
    return estimated >= _PROACTIVE_COMPACT_RATIO * params.context_budget_tokens


def _grounded_request_tokens(
    params: LoopParams,
    messages: Sequence[AgentMessage],
    real_prompt_tokens: int,
    real_prompt_index: int | None,
) -> int:
    if real_prompt_tokens <= 0:
        return 0
    if real_prompt_index is None or params.token_estimator is None:
        return real_prompt_tokens
    if real_prompt_index >= len(messages):
        return real_prompt_tokens
    tail = list(messages)[real_prompt_index:]
    return real_prompt_tokens + params.token_estimator(tail)


_FRUITLESS_COMPACTION_RETRY_RATIO = 0.9


def _history_moved_since(
    params: LoopParams,
    messages: Sequence[AgentMessage],
    baseline: int | None,
) -> bool:
    if baseline is None:
        return False
    if params.token_estimator is None:
        return False
    current = params.token_estimator(list(messages))
    return current < int(baseline * _FRUITLESS_COMPACTION_RETRY_RATIO)


def _real_prompt_tokens(usage: Mapping[str, Any] | None) -> int:
    if not isinstance(usage, Mapping):
        return 0

    def count(key: str) -> int:
        value = usage.get(key)
        if (
            isinstance(value, (int, float))
            and not isinstance(value, bool)
            and math.isfinite(value)
            and value > 0
        ):
            return int(value)
        return 0

    prompt_tokens = count("prompt_tokens")
    if prompt_tokens:
        return prompt_tokens
    return sum(count(key) for key in (
        "input_tokens",
        "cache_read_input_tokens",
        "cache_creation_input_tokens",
    ))

_MAX_TOOL_RESULT_CHARS = 64_000

_PERSIST_PREVIEW_CHARS = 3_000

_RECOVERY_MESSAGE = (
    "Output token limit hit. Resume directly — no apology, no explanation. "
    "Break remaining work into smaller pieces."
)

_TRUNCATION_MESSAGE = "输出被截断，重新生成"

_sleep = time.sleep

_MAX_BACKEND_RECOVERIES = 2
_BACKEND_RECOVERY_DELAYS_S = (15.0, 25.0)


@dataclass(frozen=True, slots=True)
class StopDecision:

    reason: TransitionReason
    prevent_continuation: bool


@dataclass(frozen=True, slots=True)
class LoopParams:

    user_input: str
    registry: ToolRegistry
    client: LoopModelClient
    emergency_turn_fuse: int = 1000
    budgets: Mapping[Stage, BudgetPolicy] = field(default_factory=lambda: DEFAULT_BUDGETS)
    cancel_registry: CancellationRegistry | None = None
    stop_hooks: Sequence = ()
    nudge_hooks: Sequence = ()
    clock: Callable[[], float] | None = None
    tool_limit: int = 12
    max_parallel_tool_calls: int = 8
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
    tool_result_dir: str | None = None
    evidence_input: str | None = None
    inbox: Inbox | None = None
    interaction_metadata: Mapping[str, Any] = field(default_factory=dict)
    keepalive: Callable[[str], None] | None = None
    todo_store: Any = None
    permission_decisions: Any = None
    source_scope: Any = None


@dataclass(frozen=True, slots=True)
class LoopStart:
    kind = "loop_start"


@dataclass(frozen=True, slots=True)
class ToolsTruncated:

    kind = "tools_truncated"
    dropped: tuple[str, ...]
    limit: int


@dataclass(frozen=True, slots=True)
class TurnStarted:
    kind = "turn_started"
    turn: int


@dataclass(frozen=True, slots=True)
class ModelChunk:
    kind = "model_chunk"
    text: str


@dataclass(frozen=True, slots=True)
class ModelUsage:
    kind = "model_usage"
    usage: dict[str, int | float]


@dataclass(frozen=True, slots=True)
class ReasoningChunk:

    kind = "reasoning_chunk"
    text: str


@dataclass(frozen=True, slots=True)
class ToolCallStarted:
    kind = "tool_call_started"
    name: str
    id: str
    arguments: dict[str, Any] = field(default_factory=dict)


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

    turn: int
    texts: tuple[str, ...]
    input_ids: tuple[str, ...] = ()
    reference_revision: int | None = None


@dataclass(frozen=True, slots=True)
class FollowupContinued:

    turn: int
    texts: tuple[str, ...]
    input_ids: tuple[str, ...] = ()
    reference_revision: int | None = None


@dataclass(frozen=True, slots=True)
class VerificationNudged:

    turn: int


@dataclass(frozen=True, slots=True)
class BackendRecovery:

    turn: int
    attempt: int
    delay_s: float
    reason: str


@dataclass(frozen=True, slots=True)
class LoopStopped:
    kind = "loop_stopped"
    terminal: Terminal


def _validate_loop_params(params: LoopParams) -> None:

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
    session_id = params.session.id if params.session is not None else None
    with _ai_client.request_ai_session(session_id):
        async for event in _run_agent_loop_impl(params):
            yield event


async def _run_agent_loop_impl(params: LoopParams) -> AsyncIterator[Any]:
    _validate_loop_params(params)
    if params.interrupt_check is not None:
        original_interrupt_check = params.interrupt_check
        interrupt_latched = False
        interrupt_lock = threading.Lock()

        def interrupt_requested() -> bool:
            nonlocal interrupt_latched
            with interrupt_lock:
                if not interrupt_latched:
                    interrupt_latched = bool(original_interrupt_check())
                return interrupt_latched

        params = replace(params, interrupt_check=interrupt_requested)
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
        if params.session is not None and params.session.open_turn is not None:
            try:
                params.session.repair_interrupted_turn()
            except Exception:  # noqa: BLE001
                pass
        raise
    finally:
        params.registry.notify_session_end()


def _withheld_recovery_plan(
    state: TurnState,
    params: LoopParams,
    text: str | None,
) -> tuple[list[AgentMessage], TransitionReason, bool]:
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


@dataclass(frozen=True, slots=True)
class _ClaimedInput:
    texts: tuple[str, ...]
    input_ids: tuple[str, ...]
    reference_revision: int | None
    messages: tuple[AgentMessage, ...]


def _claim_task_input(params: LoopParams, target: str) -> _ClaimedInput:
    ephemeral_items = params.inbox.drain_items(target) if params.inbox is not None else []
    if params.session is not None:
        for item in ephemeral_items:
            params.session.enqueue_inbox(
                item.text,
                target,
                payload=item.payload,
            )
        claim_task_inputs = getattr(params.session, "claim_task_inputs", None)
        if callable(claim_task_inputs):
            claim = claim_task_inputs(target)
            return _ClaimedInput(
                texts=tuple(claim.instructions),
                input_ids=tuple(claim.input_ids),
                reference_revision=claim.reference_revision,
                messages=tuple(claim.messages),
            )
        texts = tuple(params.session.claim_inbox(target))
        messages = tuple(AgentMessage(
            role=Role.USER,
            content=text,
            tool_call_id=None,
            name=None,
            origin=ORIGIN_INSTRUCTION,
        ) for text in texts)
        return _ClaimedInput(texts, (), None, messages)

    messages: list[AgentMessage] = []
    texts: list[str] = []
    input_ids: list[str] = []
    from app.context_pack.sources import TaskInput

    for item in ephemeral_items:
        if not item.payload:
            texts.append(item.text)
            input_ids.append(f"memory-{item.sequence}")
            messages.append(AgentMessage(
                role=Role.USER,
                content=item.text,
                tool_call_id=None,
                name=None,
                origin=ORIGIN_INSTRUCTION,
            ))
            continue
        task_input = TaskInput.from_dict(item.payload)
        input_ids.append(task_input.input_id)
        if task_input.instruction:
            texts.append(task_input.instruction)
            messages.append(AgentMessage(
                role=Role.USER,
                content=task_input.instruction,
                tool_call_id=None,
                name=None,
                origin=ORIGIN_INSTRUCTION,
            ))
        material = {
            "schemaVersion": 1,
            "inputId": task_input.input_id,
            "referenceUpdates": [update.to_dict() for update in task_input.reference_updates],
            "sourceIds": list(task_input.source_ids),
            "timeline": [event.to_dict() for event in task_input.timeline],
        }
        if task_input.reference_updates or task_input.source_ids or task_input.timeline:
            messages.append(AgentMessage(
                role=Role.USER,
                content=(
                    "[TaskInput context update · origin=data]\n"
                    + json.dumps(material, ensure_ascii=False, separators=(",", ":"))
                ),
                tool_call_id=None,
                name=None,
                origin=ORIGIN_DATA,
                injected=True,
            ))
    return _ClaimedInput(tuple(texts), tuple(input_ids), None, tuple(messages))


async def _run_agent_loop(params: LoopParams) -> AsyncIterator[Any]:
    registry = params.registry
    client = params.client
    if params.session is not None and params.user_input:
        params.session.cancel_unstarted_permissions()
    approved_calls = params.session.approved_permission_calls() if params.session is not None else []
    approval_by_id = {call['id']: call for call in approved_calls}
    existing_input = params.session.pending_user_input() if params.session is not None else None
    if existing_input is not None and not approved_calls and not params.user_input:
        yield LoopStart()
        yield LoopStopped(Terminal(reason=TransitionReason.AWAITING_USER,
            message=existing_input['question'], turns=0, results=(), pending_input=existing_input))
        return
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
    fruitless_compaction_baseline: int | None = None
    context_overflow_recoveries = 0
    empty_response_recoveries = 0
    backend_recovery_attempts = 0
    stop_hooks = tuple(params.stop_hooks)
    keepalive = params.keepalive

    def _beat(label: str) -> None:
        if keepalive is None:
            return
        try:
            keepalive(label)
        except Exception:  # noqa: BLE001 - heartbeat is best-effort
            return

    first_messages = _first_messages(params)
    if params.session is not None:
        params.session.start_turn(hold_lease=True)
        params.session.record_interaction_start(params.interaction_metadata)
        for message in first_messages:
            params.session.append_message(message)
        initial_messages = params.session.derive_messages()
    else:
        initial_messages = list(first_messages)
    loaded_extra = _restored_tool_names(params)
    tool_schemas, dropped_tools = _select_tool_schemas_with_dropped(params, extra_names=loaded_extra)
    reported_dropped_tools = dropped_tools
    tool_schema_tokens = estimate_text_tokens(str(tool_schemas))
    state = TurnState(
        messages=initial_messages,
        tool_calls_pending=[],
    )
    results: list[ToolResult] = []
    model_usage: dict[str, int | float] = {}
    last_real_prompt_tokens = 0
    last_real_prompt_index: int | None = None
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
    if dropped_tools:
        yield ToolsTruncated(
            dropped=dropped_tools,
            limit=params.tool_limit,
        )

    with CancellationScope(cancel_registry) as loop_scope:
        while True:
            now_ms = clock()
            if now_ms > deadline_ms:
                last_round_productive = (
                    last_progress_turn > 0
                    and turn_number - 1 == last_progress_turn
                )
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
                and (
                    fruitless_compactions < _MAX_FRUITLESS_COMPACTIONS
                    or _history_moved_since(
                        params, state.messages, fruitless_compaction_baseline
                    )
                )
                and (
                    _over_compact_threshold(params, state.messages, tool_schema_tokens)
                    or _grounded_request_tokens(
                        params,
                        state.messages,
                        last_real_prompt_tokens,
                        last_real_prompt_index,
                    )
                    >= _PROACTIVE_COMPACT_RATIO * params.context_budget_tokens
                )
            ):
                compacted_messages = params.compactor(list(state.messages))
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
                    last_real_prompt_tokens = 0
                    last_real_prompt_index = None
                    state = with_transition(
                        state,
                        TransitionReason.COMPACT_TRIGGERED,
                        messages=compacted_messages,
                        tool_calls_pending=[],
                        turn_count=turn_number,
                    )
                    yield TurnFinished(state)
                    compactor_succeeded_this_turn = True
                    if _over_compact_threshold(
                        params, compacted_messages, tool_schema_tokens
                    ):
                        fruitless_compactions += 1
                        fruitless_compaction_baseline = params.token_estimator(
                            compacted_messages
                        )
                    else:
                        fruitless_compactions = 0
                        fruitless_compaction_baseline = None
                else:
                    fruitless_compactions += 1
                    fruitless_compaction_baseline = params.token_estimator(
                        list(state.messages)
                    )
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

            steer_claim = _claim_task_input(params, "next-step")
            if steer_claim.messages:
                state = with_transition(
                    state,
                    TransitionReason.TOOL_RESULT,
                    messages=(
                        params.session.derive_messages()
                        if params.session is not None
                        else [*state.messages, *steer_claim.messages]
                    ),
                    tool_calls_pending=[],
                    turn_count=turn_number,
                )
                validate_messages(state.messages)
                yield Steered(
                    turn=turn_number,
                    texts=steer_claim.texts,
                    input_ids=steer_claim.input_ids,
                    reference_revision=steer_claim.reference_revision,
                )

            if params.token_estimator is not None:
                model_usage["contextTokens"] = params.token_estimator(list(state.messages)) + tool_schema_tokens
                model_usage["contextEstimated"] = 1
                model_usage["systemTokensEstimate"] = params.token_estimator([])
                model_usage["toolSchemaTokensEstimate"] = tool_schema_tokens
                model_usage["messageTokensEstimate"] = max(0, params.token_estimator([
                    message for message in state.messages if message.role is not Role.TOOL
                ]) - model_usage["systemTokensEstimate"])
                model_usage["toolResultTokensEstimate"] = max(0, params.token_estimator([
                    message for message in state.messages if message.role is Role.TOOL
                ]) - model_usage["systemTokensEstimate"])
                model_usage["contextWindow"] = params.context_budget_tokens or 0
                for key in ("lastOutputTokens", "lastCacheReadTokens", "lastCacheWriteTokens"):
                    model_usage.pop(key, None)
                yield ModelUsage(dict(model_usage))
            replaying_approval = bool(approved_calls)
            if params.session is not None and not replaying_approval:
                params.session.record_model_request(
                    state.messages,
                    tools=tool_schemas,
                    header=params.request_header,
                    step=turn_number,
                )
            events: list[ModelTurnEvent] = []
            request_started_at = time.time()
            if replaying_approval:
                thinking_blocks = []
                for call in approved_calls:
                    events.append(ToolCallArrived(call=ToolCall(id=call['id'], name=call['name'], arguments=call['arguments'])))
                    for item in call['provider_items']:
                        if item not in thinking_blocks:
                            thinking_blocks.append(item)
                events.append(TurnDone(usage=None, raw_text=None, provider_items=tuple(thinking_blocks)))
                approved_calls = []
                client.last_usage = None
                client.last_reasoning = None
            with closing((event for event in events) if replaying_approval else client.stream_turn(
                state.messages,
                tool_schemas,
                budget_ms=remaining_ms,
                cancel_scope=loop_scope.token,
            )) as model_events:
                events = []
                for event in model_events:
                    if params.interrupt_check is not None and params.interrupt_check():
                        break
                    events.append(event)
                    if isinstance(event, MessageDelta):
                        yield ModelChunk(text=event.text)
                    elif isinstance(event, ReasoningDelta):
                        yield ReasoningChunk(text=event.text)
            if loop_scope.is_cancelled:
                raise CancelledError("cancelled during model call")
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
            calls, text = client.parse_tool_calls(events)
            _merge_model_usage(model_usage, client.last_usage)
            if client.last_usage and model_usage.get("contextEstimated") == 0:
                header = params.request_header or {}
                cost = estimate_cost_usd(model_usage, str(header.get("model") or ""),
                                         str(header.get("providerHost") or ""), request_started_at)
                if cost is not None:
                    model_usage["estimatedCostUsd"] = model_usage.get("estimatedCostUsd", 0) + cost
                    model_usage["pricedRequests"] = model_usage.get("pricedRequests", 0) + 1
            if model_usage:
                yield ModelUsage(dict(model_usage))
            last_real_prompt_tokens = _real_prompt_tokens(client.last_usage)
            last_real_prompt_index = len(state.messages)
            if params.session is not None and not replaying_approval:
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
            if any(isinstance(event, TurnWithheld) for event in events):
                withheld_events = [
                    event for event in events if isinstance(event, TurnWithheld)
                ]
                model_stream_committed = any(
                    isinstance(
                        event,
                        (MessageDelta, ReasoningDelta, ToolCallArrived),
                    )
                    for event in events
                )
                token_withheld = any(
                    _is_token_withheld(event.reason) for event in withheld_events
                )
                if not token_withheld and any(
                    event.reason == CONTEXT_OVERFLOW_REASON
                    for event in withheld_events
                ):
                    if (
                        params.compactor is None
                        or context_overflow_recoveries >= _MAX_CONTEXT_OVERFLOW_RECOVERIES
                    ):
                        terminal = Terminal(
                            reason=TransitionReason.PROVIDER_UNAVAILABLE,
                            message=(
                                "context_overflow_unrecoverable"
                                if params.compactor is not None
                                else "context_overflow_without_compactor"
                            ),
                            turns=turn_number,
                            results=tuple(results),
                            model_usage=_model_usage_snapshot(model_usage),
                        )
                        yield _stop(terminal)
                        return
                    context_overflow_recoveries += 1
                    compacted_messages = params.compactor(list(state.messages))
                    if params.token_estimator is not None and params.token_estimator(
                        compacted_messages
                    ) >= params.token_estimator(list(state.messages)):
                        terminal = Terminal(
                            reason=TransitionReason.PROVIDER_UNAVAILABLE,
                            message="context_overflow_compaction_ineffective",
                            turns=turn_number,
                            results=tuple(results),
                            model_usage=_model_usage_snapshot(model_usage),
                        )
                        yield _stop(terminal)
                        return
                    if params.session is not None:
                        params.session.replace_messages(
                            compacted_messages,
                            reason="context_overflow_recovery",
                        )
                        compacted_messages = params.session.derive_messages()
                    last_real_prompt_tokens = 0
                    last_real_prompt_index = None
                    state = with_transition(
                        state,
                        TransitionReason.COMPACT_TRIGGERED,
                        messages=compacted_messages,
                        tool_calls_pending=[],
                        turn_count=turn_number,
                        last_result=results[-1] if results else None,
                    )
                    last_progress_turn = turn_number
                    yield TurnFinished(state)
                    turn_number += 1
                    continue
                if not token_withheld:
                    reasons = ", ".join(event.reason for event in withheld_events)
                    transient_backend_error = any(
                        event.reason.startswith("backend_error:http_5")
                        for event in withheld_events
                    )
                    if (
                        not model_stream_committed
                        and (
                            transient_backend_error
                            or any(not result.is_error for result in results)
                        )
                    ) and backend_recovery_attempts < _MAX_BACKEND_RECOVERIES:
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
                            remaining_sleep = bounded_delay_s
                            interrupted_during_wait = False
                            while remaining_sleep > 0:
                                slice_s = min(0.5, remaining_sleep)
                                _sleep(slice_s)
                                remaining_sleep = max(0.0, remaining_sleep - slice_s)
                                if loop_scope.is_cancelled:
                                    raise CancelledError(
                                        "cancelled during backend recovery wait"
                                    )
                                if (
                                    params.interrupt_check is not None
                                    and params.interrupt_check()
                                ):
                                    interrupted_during_wait = True
                                    break
                            if interrupted_during_wait:
                                terminal = Terminal(
                                    reason=TransitionReason.USER_INTERRUPT,
                                    message="user interrupt",
                                    turns=turn_number,
                                    results=tuple(results),
                                    model_usage=_model_usage_snapshot(model_usage),
                                )
                                yield _stop(terminal)
                                return
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
                client.escalate_output_tokens()
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
                    provider_items = tuple(
                        item
                        for event in events
                        if isinstance(event, TurnDone)
                        for item in event.provider_items
                    )
                    final_message = AgentMessage(
                        role=Role.ASSISTANT,
                        content=text,
                        tool_call_id=None,
                        name=None,
                        origin=ORIGIN_DATA,
                        provider_items=provider_items,
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
                followup_claim = _claim_task_input(params, "next-turn")
                if followup_claim.messages:
                    state = with_transition(
                        state,
                        TransitionReason.TOOL_RESULT,
                        messages=(
                            params.session.derive_messages()
                            if params.session is not None
                            else [*messages, *followup_claim.messages]
                        ),
                        tool_calls_pending=[],
                        turn_count=turn_number,
                        stop_hook_active=False,
                        last_result=results[-1] if results else None,
                    )
                    yield TurnFinished(state)
                    yield FollowupContinued(
                        turn=turn_number,
                        texts=followup_claim.texts,
                        input_ids=followup_claim.input_ids,
                        reference_revision=followup_claim.reference_revision,
                    )
                    turn_number += 1
                    continue
                if (
                    not str(text or "").strip()
                    and not state.tool_calls_pending
                    and empty_response_recoveries < _MAX_EMPTY_RESPONSE_RECOVERIES
                ):
                    empty_response_recoveries += 1
                    retry_message = AgentMessage(
                        role=Role.USER,
                        content=(
                            "上一轮你没有返回任何内容。请直接回答用户的问题；"
                            "如果需要调用工具就先调用，不需要就直接给出答案。"
                            "不要返回空回复。"
                        ),
                        tool_call_id=None,
                        name=None,
                        origin=ORIGIN_INSTRUCTION,
                    )
                    if params.session is not None:
                        params.session.append_message(retry_message)
                    state = with_transition(
                        state,
                        TransitionReason.TOOL_RESULT,
                        messages=(
                            params.session.derive_messages()
                            if params.session is not None
                            else [*messages, retry_message]
                        ),
                        tool_calls_pending=[],
                        turn_count=turn_number,
                        stop_hook_active=False,
                        last_result=results[-1] if results else None,
                    )
                    yield TurnFinished(state)
                    turn_number += 1
                    continue
                if not str(text or "").strip():
                    terminal = Terminal(
                        reason=TransitionReason.PROVIDER_UNAVAILABLE,
                        message="backend_error:empty_response",
                        turns=turn_number,
                        results=tuple(results),
                        model_usage=_model_usage_snapshot(model_usage),
                    )
                    yield _stop(terminal)
                    return
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
                        message=(
                            "输出反复被截断，恢复预算耗尽；请缩小本轮任务范围或分步重试。"
                        ),
                        turns=turn_number,
                        results=tuple(results),
                        model_usage=_model_usage_snapshot(model_usage),
                        failure_kind="output_truncation",
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

            if params.hook_manager is not None:
                effective_calls = []
                for call in calls:
                    if call.argument_error is not None:
                        effective_calls.append(call)
                        continue
                    pre = params.hook_manager.run_pre_tool_use(call.name, call.arguments)
                    effective_calls.append(ToolCall(
                        id=call.id, name=call.name,
                        arguments=pre.input if isinstance(pre.input, dict) else call.arguments,
                        argument_error=(None if pre.allowed and isinstance(pre.input, dict)
                                        else pre.reason or "post-hook input invalid"),
                    ))
                calls = effective_calls

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
                provider_items=tuple(
                    item
                    for event in events
                    if isinstance(event, TurnDone)
                    for item in event.provider_items
                ),
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
                    try:
                        skipped_effect = spec_effect(
                            registry.get(call.name), call.arguments
                        )
                    except KeyError:
                        skipped_effect = Effect.DESTRUCTIVE
                    prepared = params.session.record_tool_call(
                        call.id,
                        call.name,
                        call.arguments,
                        step=turn_number,
                        effect=skipped_effect,
                        dispatched=False,
                    )
                    params.session.record_tool_settlement(
                        str(prepared.data["operationId"]),
                        skipped_message,
                        failure_type=skipped.failure_type,
                        used_backend=skipped.used_backend,
                        latency_ms=skipped.latency_ms,
                        outcome="not_started",
                    )
            any_error = False
            round_progress = False
            halt_decision: ToolGuardrailDecision | None = None
            pending_input: dict[str, Any] | None = None
            if replaying_approval and params.session is not None:
                pending_input = params.session.pending_user_input()
            permission_waiting = False

            def decisions_for(call: ToolCall):
                if call.id not in approval_by_id:
                    return params.permission_decisions
                from app.agent_runtime.permission_decisions import PermissionDecisions
                previous = params.permission_decisions
                return PermissionDecisions(allowed=getattr(previous, 'allowed', ()),
                    denied=getattr(previous, 'denied', ()), once=(call.name,),
                    once_arguments={call.name: approval_by_id[call.id]['arguments']})

            def classify_tool(call: ToolCall) -> str:
                try:
                    return (
                        "parallel"
                        if registry.is_concurrency_safe_for(call.name, call.arguments)
                        else "exclusive"
                    )
                except KeyError:
                    return "exclusive"

            def execute_scheduled(call: ToolCall) -> ToolResult:
                from app.agent_runtime.plan_mode import current_mode
                from app.agent_runtime.permission_decisions import current_permission_decisions
                decisions = decisions_for(call)
                token = current_permission_decisions.set(decisions)
                try:
                    return _execute_one(
                        registry, call, cancel_registry, loop_scope, params.allowed_effects,
                        params.precondition_context_factory, params.hook_manager,
                        current_mode(params.session, params.permission_mode),
                        permission_decisions=decisions, interrupt_check=params.interrupt_check,
                        keepalive=keepalive, persist_dir=params.tool_result_dir,
                        source_scope=params.source_scope, pre_hook_applied=True,
                    )
                finally:
                    current_permission_decisions.reset(token)

            def block_mutation_with_pending_input(call: ToolCall) -> ToolResult | None:
                nonlocal permission_waiting
                try:
                    effect = spec_effect(registry.get(call.name), call.arguments)
                except KeyError:
                    return None
                if effect is Effect.READ:
                    return None
                if params.session is not None:
                    for operation in reversed(
                        project_operations(params.session.events)
                    ):
                        if (
                            registry.canonical_name(operation.tool_name)
                            != registry.canonical_name(call.name)
                            or operation.arguments != dict(call.arguments)
                            or operation.recovery_policy
                            not in {
                                RecoveryPolicy.VERIFY_BEFORE_RETRY,
                                RecoveryPolicy.NEVER_REPLAY,
                            }
                        ):
                            continue
                        policy = str(operation.recovery_policy)
                        guidance = (
                            "This external outcome may already exist. Do not "
                            "repeat it automatically; use a fresh harness-owned "
                            "confirmation after checking external state."
                            if operation.recovery_policy is RecoveryPolicy.NEVER_REPLAY
                            else
                            "Read back and verify the target first, then use a "
                            "fresh confirmed action instead of replaying this call."
                        )
                        return ToolResult(
                            tool_call_id=call.id,
                            value=(
                                "RECOVERY_RETRY_BLOCKED: an earlier identical "
                                f"operation has recoveryPolicy={policy}. {guidance}"
                            ),
                            is_error=True,
                            failure_type=FailureType.PERMISSION_DENIED,
                            used_backend=None,
                            latency_ms=0.0,
                        )
                has_pending = (
                    params.inbox is not None
                    and params.inbox.pending("next-step") > 0
                )
                if params.session is not None:
                    has_pending = has_pending or bool(
                        params.session.pending_inbox("next-step")
                    )
                if not has_pending:
                    if params.session is not None and call.argument_error is None:
                        from app.agent_runtime.plan_mode import current_mode
                        spec = registry.get(call.name)
                        if not registry.validate_input(spec, call.arguments):
                            refusal = _permission_refusal(call=call, arguments=call.arguments, spec=spec,
                                allowed_effects=params.allowed_effects,
                                permission_mode=current_mode(params.session, params.permission_mode),
                                permission_decisions=decisions_for(call), request_input=True)
                            if refusal is not None:
                                permission_waiting |= refusal.used_backend == 'permission_request'
                                return refusal
                    if permission_waiting:
                        return ToolResult(tool_call_id=call.id, value='Not executed: an earlier action is waiting for user approval.',
                            is_error=True, failure_type='not_executed', used_backend=None, latency_ms=0.0)
                    return None
                return ToolResult(
                    tool_call_id=call.id,
                    value=(
                        "STEER_PENDING: a newer user instruction or reference "
                        "update arrived before this mutating tool started. "
                        "The call was not dispatched; consume TaskInput and replan."
                    ),
                    is_error=True,
                    failure_type=FailureType.STEER_PENDING,
                    used_backend=None,
                    latency_ms=0.0,
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
                before_dispatch=block_mutation_with_pending_input,
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
                        yield ToolCallStarted(name=call.name, id=call.id, arguments=call.arguments)
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
                                or _json_verification_matched(scheduled.result.value)
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
                    (not normalized.is_error and _tool_suspends_for_user_input(registry, call.name))
                    or (not scheduled.dispatched and normalized.used_backend == 'permission_request')
                ):
                    request = _pending_user_input(scheduled.result.value)
                    if request is not None and normalized.used_backend == 'permission_request' and params.session is not None:
                        request['requestId'] = call.id
                        params.session.append('permission/requested', {'requestId': call.id, 'pendingInput': request})
                    if request is not None and pending_input is None:
                        pending_input = {**request, 'requestId': call.id}

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

            if round_progress:
                last_progress_turn = turn_number

            tool_messages = _fit_turn_tool_messages(tool_messages)

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
                tool_schemas, dynamic_dropped = _select_tool_schemas_with_dropped(
                    params,
                    extra_names=loaded_extra,
                )
                tool_schema_tokens = estimate_text_tokens(str(tool_schemas))
                if dynamic_dropped and dynamic_dropped != reported_dropped_tools:
                    yield ToolsTruncated(
                        dropped=dynamic_dropped,
                        limit=params.tool_limit,
                    )
                reported_dropped_tools = dynamic_dropped

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
                    message=(
                        "回合数超过安全上限，循环未收敛；请把任务拆成更小的步骤重试。"
                    ),
                    turns=turn_number,
                    results=tuple(results),
                    model_usage=_model_usage_snapshot(model_usage),
                    failure_kind="runaway_rounds",
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
    for hook in stop_hooks:
        try:
            decision = hook(state)
        except Exception as exc:  # noqa: BLE001 -- hook failures never kill the loop
            notes.append(f"stop hook {hook!r} raised {type(exc).__name__}: {exc}")
            return None, True
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
    return reason in ("", "max_output_tokens")


def _first_messages(params: LoopParams) -> list[AgentMessage]:
    messages = [
        AgentMessage(
            role=Role.USER,
            content=params.user_input,
            tool_call_id=None,
            name=None,
            origin=ORIGIN_INSTRUCTION,
        )
    ] if params.user_input else []
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
    return [message for message in messages if message.origin == ORIGIN_INSTRUCTION]


def validate_messages(messages: Sequence[AgentMessage]) -> None:
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


def _restored_tool_names(params: LoopParams) -> list[str]:
    if params.session is None:
        return []
    loaded: dict[str, None] = {}
    for event in params.session.events:
        if event.type != "operation/settled" or event.data.get("outcome") != "succeeded":
            continue
        message = event.data["message"]
        try:
            spec = params.registry.get(message.get("name") or "")
        except KeyError:
            continue
        if spec.deferred:
            loaded[spec.name] = None
        if spec.discovers_tools:
            for name in _discovered_tool_names(message.get("content") or ""):
                loaded[name] = None
    return list(loaded)


def _select_tool_schemas(
    params: LoopParams,
    *,
    extra_names: Sequence[str] = (),
) -> list[dict[str, object]]:

    schemas, _dropped = _select_tool_schemas_with_dropped(
        params,
        extra_names=extra_names,
    )
    return schemas


def _select_tool_schemas_with_dropped(
    params: LoopParams,
    *,
    extra_names: Sequence[str] = (),
) -> tuple[list[dict[str, object]], tuple[str, ...]]:
    registry = params.registry
    specs = {spec.name: spec for spec in registry.list()}
    selected: list[str] = [FIND_CAPABILITY_TOOL] if FIND_CAPABILITY_TOOL in specs else []
    for name in extra_names:
        if name in specs and name not in selected:
            selected.append(name)
    for spec in registry.list():
        if spec.name in selected or spec.deferred:
            continue
        selected.append(spec.name)
    dropped = tuple(selected[params.tool_limit:])
    selected = selected[: params.tool_limit]

    def describe(spec) -> str:
        text = spec.description
        if spec.name == FIND_CAPABILITY_TOOL:
            text += tool_directory(
                item for item in specs.values()
                if item.deferred or item.name in dropped
            )
        if spec.examples:
            samples = "\n".join(
                json.dumps(example, ensure_ascii=False)
                for example in spec.examples
            )
            text = f"{text}\n调用示例：\n{samples}"
        return text

    return [
        {
            "name": specs[name].name,
            "description": describe(specs[name]),
            "parameters": specs[name].input_schema,
        }
        for name in selected
    ], dropped


def _discovered_tool_names(value: str) -> list[str]:
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
    aggregate: dict[str, int | float], raw_usage: Mapping[str, Any] | None
) -> None:
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

    def nested(*path: str) -> int | None:
        value: Any = raw_usage
        for key in path:
            if not isinstance(value, Mapping):
                return None
            value = value.get(key)
        if (
            isinstance(value, (int, float))
            and not isinstance(value, bool)
            and math.isfinite(value)
        ):
            return max(0, int(value))
        return None

    input_tokens = (
        _real_prompt_tokens(raw_usage)
        if count("prompt_tokens", "input_tokens") is not None else None
    )
    output_tokens = count("output_tokens", "completion_tokens")
    total_tokens = count("total_tokens")
    if total_tokens is None and (input_tokens is not None or output_tokens is not None):
        total_tokens = (input_tokens or 0) + (output_tokens or 0)
    if input_tokens is not None:
        aggregate["inputTokens"] = aggregate.get("inputTokens", 0) + input_tokens
        aggregate["contextEstimated"] = 0
    if output_tokens is not None:
        aggregate["outputTokens"] = aggregate.get("outputTokens", 0) + output_tokens
    if total_tokens is not None:
        aggregate["totalTokens"] = aggregate.get("totalTokens", 0) + total_tokens
    cache_read = count("cache_read_input_tokens", "prompt_cache_hit_tokens")
    if cache_read is None:
        cache_read = nested("prompt_tokens_details", "cached_tokens")
    if cache_read is not None:
        aggregate["cacheReadTokens"] = aggregate.get("cacheReadTokens", 0) + cache_read
    cache_write = count("cache_creation_input_tokens")
    if cache_write is None:
        cache_write = nested("prompt_tokens_details", "cache_write_tokens")
    if cache_write is not None:
        aggregate["cacheWriteTokens"] = aggregate.get("cacheWriteTokens", 0) + cache_write
    for key, value in (
        ("contextTokens", input_tokens), ("lastOutputTokens", output_tokens),
        ("lastCacheReadTokens", cache_read), ("lastCacheWriteTokens", cache_write),
    ):
        aggregate.pop(key, None)
        if value is not None:
            aggregate[key] = value
    if any(value is not None for value in (input_tokens, output_tokens, total_tokens)):
        aggregate["turnsReported"] = aggregate.get("turnsReported", 0) + 1


def _model_usage_snapshot(aggregate: Mapping[str, int | float]) -> dict[str, int | float] | None:
    return dict(aggregate) if aggregate else None


def _summarize_tool_result(result: Any, limit: int = 240) -> str:
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
    try:
        payload = json.loads(value)
    except (TypeError, ValueError):
        return None
    if not isinstance(payload, dict) or payload.get("awaitingUserInput") is not True:
        return None
    if payload.get('questions') or payload.get('kind') == 'plan' or payload.get('harnessPermission') is True:
        from app.agent_runtime.user_input import normalize_pending_input
        try:
            return normalize_pending_input(payload)
        except ValueError:
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
    pending: dict[str, Any] = {"question": question, "options": options}
    kind = str(payload.get("kind") or "").strip()[:20]
    tool = str(payload.get("tool") or "").strip()[:64]
    if kind == "permission" and tool:
        pending["kind"] = "permission"
        pending["tool"] = tool
        prefix = str(payload.get("prefix") or "").strip()[:160]
        if prefix:
            pending["prefix"] = prefix
    return pending


def _permission_refusal(
    *,
    call: ToolCall,
    arguments: Mapping[str, Any],
    spec: Any,
    allowed_effects: tuple[Effect, ...],
    permission_mode: str,
    permission_decisions: Any,
    request_input: bool = False,
) -> ToolResult | None:
    permission_name = str(getattr(spec, "name", "") or call.name)
    resolved_effect = spec_effect(spec, arguments)
    if resolved_effect not in allowed_effects:
        return ToolResult(
            tool_call_id=call.id,
            value=(
                f"permission denied: tool {permission_name!r} requires effect "
                f"{resolved_effect.value} which is not in allowed_effects "
                f"({', '.join(effect.value for effect in allowed_effects)})"
            ),
            is_error=True,
            failure_type=FailureType.PERMISSION_DENIED,
            used_backend=None,
            latency_ms=None,
        )
    mode_decision = decide_effect(permission_mode, resolved_effect)
    if permission_mode == 'plan' and resolved_effect is not Effect.READ:
        return ToolResult(tool_call_id=call.id,
            value=f'tool {permission_name!r} is denied in permission mode plan. Plan mode is read-only. Use ExitPlanMode to present the plan for user approval before making changes.',
            is_error=True, failure_type=FailureType.PERMISSION_DENIED,
            used_backend=None, latency_ms=None)
    if permission_decisions is not None:
        from app.agent_runtime.permission_decisions import GRANTABLE_EFFECTS

        memo = permission_decisions.lookup(permission_name, arguments)
        if memo == "deny":
            mode_decision = PermissionDecision.DENY
        elif (
            permission_decisions.allows_call(permission_name, arguments, call.id)
            and mode_decision is PermissionDecision.ASK
            and resolved_effect in GRANTABLE_EFFECTS
        ):
            mode_decision = PermissionDecision.ALLOW
    if mode_decision is PermissionDecision.ALLOW:
        return None
    if request_input and mode_decision is PermissionDecision.ASK:
        from app.agent_runtime.permission_decisions import GRANTABLE_EFFECTS
        from app.agent_runtime.permission_modes import _bash_permission_prefix
        if resolved_effect in GRANTABLE_EFFECTS:
            prefix = _bash_permission_prefix(permission_name, arguments)
            payload = {'kind': 'permission', 'tool': permission_name, 'requestId': call.id,
                'question': f'Allow {permission_name} to execute this action?',
                'options': ['Allow once', 'Allow for this task', 'Deny'],
                'action': {'tool': permission_name, 'arguments': dict(arguments)},
                'actionPreview': (str(arguments['command']) if permission_name == 'Bash' and 'command' in arguments
                    else json.dumps(dict(arguments), ensure_ascii=False, indent=2)),
                'awaitingUserInput': True, 'harnessPermission': True}
            if prefix:
                payload['prefix'] = prefix
            return ToolResult(tool_call_id=call.id, value=json.dumps(payload, ensure_ascii=False),
                is_error=True, failure_type=FailureType.PERMISSION_DENIED,
                used_backend='permission_request', latency_ms=0.0)
    feedback = PermissionDecisionResult(
        decision=mode_decision,
        mode=PermissionMode(permission_mode),
        effect=resolved_effect,
    ).feedback(permission_name, arguments)
    return ToolResult(
        tool_call_id=call.id,
        value=feedback,
        is_error=True,
        failure_type=FailureType.PERMISSION_DENIED,
        used_backend=None,
        latency_ms=None,
    )


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
    permission_decisions: Any = None,
    interrupt_check: Callable[[], bool] | None = None,
    keepalive: Callable[[str], None] | None = None,
    persist_dir: str | None = None,
    source_scope: Any = None,
    pre_hook_applied: bool = False,
) -> ToolResult:
    try:
        spec = registry.get(call.name)
    except KeyError:
        available = ", ".join(sorted(spec_.name for spec_ in registry.list()))
        return ToolResult(
            tool_call_id=call.id,
            value=(
                f"unknown tool {call.name!r}. "
                f"Available tools: {available}."
            ),
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
    permission_refusal = _permission_refusal(
        call=call,
        arguments=call.arguments,
        spec=spec,
        allowed_effects=allowed_effects,
        permission_mode=permission_mode,
        permission_decisions=permission_decisions,
    )
    if permission_refusal is not None:
        return permission_refusal
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
    if hook_manager is not None and not pre_hook_applied:
        pre = hook_manager.run_pre_tool_use(call.name, call.arguments)
        if not pre.allowed:
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
        if execution_args != call.arguments:
            permission_refusal = _permission_refusal(
                call=call,
                arguments=execution_args,
                spec=spec,
                allowed_effects=allowed_effects,
                permission_mode=permission_mode,
                permission_decisions=permission_decisions,
            )
            if permission_refusal is not None:
                return permission_refusal
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
    if source_scope is not None:
        try:
            from app.context_pack.source_scope import authorize_access, resolve_access

            access = resolve_access(spec, execution_args)
            effective_scope = source_scope() if callable(source_scope) else source_scope
            decision = authorize_access(effective_scope, access)
        except Exception as exc:
            return ToolResult(
                tool_call_id=call.id,
                value=f"source access is not evaluable: {type(exc).__name__}: {exc}",
                is_error=True,
                failure_type=FailureType.PERMISSION_DENIED,
                used_backend=None,
                latency_ms=None,
            )
        if not decision.allowed:
            return ToolResult(
                tool_call_id=call.id,
                value=f"source access denied: {decision.reason}",
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
        beat_tick = threading.Event()
        beat_stop = threading.Event()

        def cancel_worker() -> None:
            while not beat_stop.wait(timeout=0.05):
                if loop_scope.is_cancelled or (interrupt_check is not None and interrupt_check()):
                    scope.cancel_all()
                    return

        cancel_thread = threading.Thread(target=cancel_worker, daemon=True)
        cancel_thread.start()

        def beat_worker() -> None:
            while not beat_stop.wait(timeout=20.0):
                try:
                    if keepalive is not None:
                        keepalive(f"tool_beat name={call.name}")
                except Exception:  # noqa: BLE001 - heartbeat is best-effort
                    pass
                if beat_tick.wait(timeout=0.0):
                    return

        beat_thread = threading.Thread(target=beat_worker, daemon=True)
        beat_thread.start()
        try:
            executed = registry.execute_tool(
                call.name, execution_args, scope=scope.token, tool_call_id=call.id
            )
            registry.notify_executed(call.name)
        finally:
            beat_stop.set()
            beat_tick.set()
            timeout_timer.cancel()
            cancel_thread.join(timeout=0.2)
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
    normalized = _normalize_result(executed, call, persist_dir=persist_dir)
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

    try:
        effect = registry.resolve_effect(call.name, call.arguments)
    except KeyError:
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


def _normalize_result(executed: Any, call: ToolCall, persist_dir: str | None = None) -> ToolResult:
    if executed.is_error:
        value = executed.error_message
        if value is not None and executed.value is not None:
            value = json.dumps({"error": value, "partialResult": executed.value}, ensure_ascii=False, default=str)
        elif value is None:
            value = _result_value_text(executed.value)
    else:
        value = _result_value_text(executed.value)
    value = _bounded_tool_result(
        value, persist_dir=persist_dir, tool_call_id=call.id
    )
    failure_type = executed.failure_type
    is_error = executed.is_error
    if not is_error and isinstance(executed.value, Evidence):
        failure_type = {
            EvidenceStatus.ERROR: FailureType.TOOL_ERROR,
            EvidenceStatus.UNSUPPORTED: FailureType.TOOL_ERROR,
            EvidenceStatus.TIMEOUT: FailureType.TIMEOUT,
            EvidenceStatus.BUSY: FailureType.COMPUTER_USE_BUSY,
            EvidenceStatus.DENIED: FailureType.PERMISSION_DENIED,
        }.get(executed.value.status)
        is_error = failure_type is not None
    return ToolResult(
        tool_call_id=call.id,
        value=value,
        is_error=is_error,
        failure_type=failure_type,
        used_backend=executed.used_backend,
        latency_ms=executed.latency_ms,
    )


def _json_verification_matched(value: Any) -> bool:
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
    artifacts = latest_turn_artifacts(session.events)
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
    if isinstance(value, Evidence):
        return evidence_to_text(value)
    if isinstance(value, (dict, list, tuple)):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"), default=str)
    return "" if value is None else str(value)


def _bounded_tool_result(
    value: str,
    *,
    persist_dir: str | None = None,
    tool_call_id: str | None = None,
) -> str:
    if len(value) <= _MAX_TOOL_RESULT_CHARS:
        return value
    if persist_dir and tool_call_id:
        persisted = _persist_tool_result(value, persist_dir, tool_call_id)
        if persisted is not None:
            preview = value[:_PERSIST_PREVIEW_CHARS]
            cut = preview.rfind("\n")
            if cut > _PERSIST_PREVIEW_CHARS // 2:
                preview = preview[:cut]
            return (
                f"{preview}\n"
                f"[tool result too large: {len(value)} chars; full output saved to {persisted}. "
                "Use Read on that path with offset/limit to inspect specific parts.]"
            )
    digest = hashlib.sha256(value.encode("utf-8", errors="surrogatepass")).hexdigest()
    marker = (
        f"\n[tool result truncated: original_chars={len(value)} sha256={digest}; "
        "preserving beginning and end]\n"
    )
    available = max(0, _MAX_TOOL_RESULT_CHARS - len(marker))
    head = available * 2 // 3
    tail = available - head
    return value[:head] + marker + (value[-tail:] if tail else "")


_MAX_TURN_TOOL_RESULT_CHARS = 120_000


def _fit_turn_tool_messages(
    tool_messages: Sequence[AgentMessage],
    *,
    max_total_chars: int = _MAX_TURN_TOOL_RESULT_CHARS,
) -> list[AgentMessage]:
    total = sum(len(message.content or "") for message in tool_messages)
    if total <= max_total_chars or not tool_messages:
        return list(tool_messages)
    fitted = list(tool_messages)
    order = sorted(
        range(len(fitted)),
        key=lambda index: len(fitted[index].content or ""),
        reverse=True,
    )
    for index in order:
        if total <= max_total_chars:
            break
        content = fitted[index].content or ""
        allowed = max(0, len(content) - (total - max_total_chars))
        if allowed >= len(content):
            continue
        marker = (
            f"\n[tool result trimmed to fit this round's budget: "
            f"original_chars={len(content)}]"
        )
        keep = max(0, allowed - len(marker))
        fitted[index] = replace(
            fitted[index],
            content=(content[:keep] + marker) if keep else marker,
        )
        total = sum(len(message.content or "") for message in fitted)
    return fitted


def _persist_tool_result(value: str, persist_dir: str, tool_call_id: str) -> str | None:
    try:
        from pathlib import Path as _Path

        base = _Path(persist_dir)
        base.mkdir(parents=True, exist_ok=True)
        safe_name = "".join(
            ch if ch.isalnum() or ch in "-_." else "_" for ch in str(tool_call_id)
        )[:120] or "result"
        path = base / f"{safe_name}.txt"
        path.write_text(value, encoding="utf-8", errors="surrogatepass")
        return str(path)
    except OSError:
        return None
