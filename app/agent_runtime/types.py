"""Agent runtime turn-state and trajectory types.

Ported from the Claude Code query-loop study note
(docs/harness-port-notes/2026-08-12-cc-query-loop.md): the State
dataclass is rebuilt whole at every continue point with the transition
reason recorded; it is never mutated in place. Pure Python, no I/O.
"""

from __future__ import annotations

import dataclasses
import enum
from dataclasses import dataclass
from typing import Any


class Role(enum.StrEnum):
    USER = "user"
    ASSISTANT = "assistant"
    TOOL = "tool"


ORIGIN_INSTRUCTION = "instruction"
"""Origin tag: a genuine user instruction (first user message, future
voice/gesture entries). Only these messages may drive the model as
instructions."""

ORIGIN_DATA = "data"
"""Origin tag: tool results and harness-internal state (perception reads,
tool results/errors, truncation feedback, recovery prompts). Never an
instruction."""


class TransitionReason(enum.StrEnum):
    """Why the loop continued (or why it terminated)."""

    COMPLETED = "completed"
    TOOL_RESULT = "tool_result"
    TOOL_ERROR = "tool_error"
    MAX_OUTPUT_TOKENS_RECOVERED = "max_output_tokens_recovered"
    COMPACT_TRIGGERED = "compact_triggered"
    BACKEND_RECOVERY = "backend_recovery"
    STOP_HOOK = "stop_hook"
    USER_INTERRUPT = "user_interrupt"
    BUDGET_EXHAUSTED = "budget_exhausted"
    PROVIDER_UNAVAILABLE = "provider_unavailable"
    AWAITING_USER = "awaiting_user"
    STALLED = "stalled"
    INVARIANT_FAILED = "invariant_failed"
    LOCAL_ACTION = "local_action"


@dataclass(frozen=True, slots=True)
class AgentMessage:
    role: Role
    content: str | None
    tool_call_id: str | None
    name: str | None
    is_error: bool = False
    origin: str = ORIGIN_INSTRUCTION
    injected: bool = False
    tool_calls: tuple[dict[str, Any], ...] = ()

    def to_dict(self) -> dict[str, Any]:
        return {
            "role": self.role.value,
            "content": self.content,
            "tool_call_id": self.tool_call_id,
            "name": self.name,
            "is_error": self.is_error,
            "origin": self.origin,
            "injected": self.injected,
            "tool_calls": list(self.tool_calls),
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> AgentMessage:
        _reject_unknown(data, cls)
        data = {
            **data,
            # Fail closed: a message without an explicit origin tag is data,
            # never an instruction (runtime-audit P2). The write path always
            # emits origin; only foreign/legacy logs can omit it.
            "origin": data.get("origin", ORIGIN_DATA),
            "injected": data.get("injected", False),
            "tool_calls": data.get("tool_calls", ()),
        }
        _require_fields(data, cls)
        origin = data["origin"]
        if origin not in (ORIGIN_INSTRUCTION, ORIGIN_DATA):
            raise ValueError(f"invalid origin {origin!r} for AgentMessage")
        return cls(
            role=Role(data["role"]),
            content=data["content"],
            tool_call_id=data["tool_call_id"],
            name=data["name"],
            is_error=data["is_error"],
            origin=origin,
            injected=data["injected"],
            tool_calls=tuple(data["tool_calls"]),
        )


@dataclass(frozen=True, slots=True)
class ToolCall:
    id: str
    name: str
    arguments: Any
    argument_error: str | None = None


@dataclass(frozen=True, slots=True)
class ToolResult:
    tool_call_id: str
    value: str
    is_error: bool
    failure_type: str | None
    used_backend: str | None
    latency_ms: float | None
    tool_name: str | None = None
    arguments: dict[str, Any] | None = None


@dataclass(frozen=True, slots=True)
class TurnState:
    """One agentic turn loop state (query.ts State, 9 fields, Python form).

    Rebuilt whole at every continue point via :func:`with_transition`;
    never mutated in place.
    """

    messages: list[AgentMessage]
    tool_calls_pending: list[ToolCall]
    max_output_tokens_recovery_count: int = 0
    has_attempted_reactive_compact: bool = False
    stop_hook_active: bool = False
    turn_count: int = 1
    transition: TransitionReason | None = None
    budget_remaining_ms: float | None = None
    last_result: ToolResult | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "messages": [m.to_dict() for m in self.messages],
            "tool_calls_pending": [_tool_call_to_dict(c) for c in self.tool_calls_pending],
            "max_output_tokens_recovery_count": self.max_output_tokens_recovery_count,
            "has_attempted_reactive_compact": self.has_attempted_reactive_compact,
            "stop_hook_active": self.stop_hook_active,
            "turn_count": self.turn_count,
            "transition": self.transition.value if self.transition is not None else None,
            "budget_remaining_ms": self.budget_remaining_ms,
            "last_result": (
                _tool_result_to_dict(self.last_result)
                if self.last_result is not None
                else None
            ),
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> TurnState:
        _reject_unknown(data, cls)
        _require_fields(data, cls)
        transition = (
            TransitionReason(data["transition"])
            if data["transition"] is not None
            else None
        )
        last_result = (
            _tool_result_from_dict(data["last_result"])
            if data["last_result"] is not None
            else None
        )
        return cls(
            messages=[AgentMessage.from_dict(m) for m in data["messages"]],
            tool_calls_pending=[
                _tool_call_from_dict(c) for c in data["tool_calls_pending"]
            ],
            max_output_tokens_recovery_count=data["max_output_tokens_recovery_count"],
            has_attempted_reactive_compact=data["has_attempted_reactive_compact"],
            stop_hook_active=data["stop_hook_active"],
            turn_count=data["turn_count"],
            transition=transition,
            budget_remaining_ms=data["budget_remaining_ms"],
            last_result=last_result,
        )


def with_transition(
    state: TurnState,
    reason: TransitionReason,
    **overrides: Any,
) -> TurnState:
    """Rebuild the whole state, recording why the loop continues.

    Mirrors the query.ts "continue sites write state = { ... }" pattern:
    the original state is untouched; fields not overridden carry over.
    """
    return dataclasses.replace(state, transition=reason, **overrides)


@dataclass(frozen=True, slots=True)
class Terminal:
    """Final return value of the query loop.

    ``local_action`` carries a deterministic local action id
    (save_screenshot / copy_object_text / show_source) when the routing
    layer resolved the command without running the loop at all
    (``reason=LOCAL_ACTION``); it is None for every loop-driven terminal.
    """

    reason: TransitionReason
    message: str
    turns: int
    results: tuple[ToolResult, ...]
    local_action: str | None = None
    pending_input: dict[str, Any] | None = None
    model_usage: dict[str, int] | None = None
    failure_kind: str | None = None
    """§12.3：INVARIANT_FAILED 的细分（runaway_rounds / output_truncation），
    其余 reason 为 None。用户文案据此给出下一步该做什么。"""

    def to_dict(self) -> dict[str, Any]:
        return {
            "reason": self.reason.value,
            "message": self.message,
            "turns": self.turns,
            "results": [_tool_result_to_dict(r) for r in self.results],
            "local_action": self.local_action,
            "pending_input": self.pending_input,
            "model_usage": self.model_usage,
            "failure_kind": self.failure_kind,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Terminal:
        _reject_unknown(data, cls)
        data = {
            **data,
            "pending_input": data.get("pending_input"),
            "model_usage": data.get("model_usage"),
            "failure_kind": data.get("failure_kind"),
        }
        _require_fields(data, cls)
        return cls(
            reason=TransitionReason(data["reason"]),
            message=data["message"],
            turns=data["turns"],
            results=tuple(_tool_result_from_dict(r) for r in data["results"]),
            local_action=data["local_action"],
            pending_input=data["pending_input"],
            model_usage=data["model_usage"],
            failure_kind=data["failure_kind"],
        )


@dataclass(frozen=True, slots=True)
class Trajectory:
    """Precompiled recipe trajectory (input to later agent-runtime tasks)."""

    recipe_id: str | None
    first_user_message: str
    recommended_tools: tuple[str, ...]
    risk: str = "read"


def _reject_unknown(data: dict[str, Any], cls: type) -> None:
    known = {f.name for f in dataclasses.fields(cls)}
    unknown = sorted(set(data) - known)
    if unknown:
        raise ValueError(f"unknown field(s) for {cls.__name__}: {unknown}")


def _require_fields(data: dict[str, Any], cls: type) -> None:
    missing = sorted({f.name for f in dataclasses.fields(cls)} - set(data))
    if missing:
        raise ValueError(f"missing field(s) for {cls.__name__}: {missing}")


def _tool_call_to_dict(call: ToolCall) -> dict[str, Any]:
    value = {"id": call.id, "name": call.name, "arguments": call.arguments}
    if call.argument_error is not None:
        value["argument_error"] = call.argument_error
    return value


def _tool_call_from_dict(data: dict[str, Any]) -> ToolCall:
    _reject_unknown(data, ToolCall)
    missing = sorted({"id", "name", "arguments"} - set(data))
    if missing:
        raise ValueError(f"missing field(s) for ToolCall: {missing}")
    return ToolCall(
        id=data["id"],
        name=data["name"],
        arguments=data["arguments"],
        argument_error=data.get("argument_error"),
    )


def _tool_result_to_dict(result: ToolResult) -> dict[str, Any]:
    return {
        "tool_call_id": result.tool_call_id,
        "value": result.value,
        "is_error": result.is_error,
        "failure_type": result.failure_type,
        "used_backend": result.used_backend,
        "latency_ms": result.latency_ms,
        "tool_name": result.tool_name,
        "arguments": result.arguments,
    }


def _tool_result_from_dict(data: dict[str, Any]) -> ToolResult:
    _reject_unknown(data, ToolResult)
    missing = sorted({"tool_call_id", "value", "is_error"} - set(data))
    if missing:
        raise ValueError(f"missing field(s) for ToolResult: {missing}")
    return ToolResult(
        tool_call_id=data["tool_call_id"],
        value=data["value"],
        is_error=data["is_error"],
        failure_type=data.get("failure_type"),
        used_backend=data.get("used_backend"),
        latency_ms=data.get("latency_ms"),
        tool_name=data.get("tool_name"),
        arguments=data.get("arguments"),
    )
