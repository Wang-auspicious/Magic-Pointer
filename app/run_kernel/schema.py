
from __future__ import annotations

import enum
from dataclasses import dataclass, field
from typing import Any


class OperationPhase(enum.StrEnum):
    PREPARED = "prepared"
    SETTLED = "settled"


class OperationOutcome(enum.StrEnum):
    PENDING = "pending"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    UNKNOWN = "unknown"
    NOT_STARTED = "not_started"


class RecoveryPolicy(enum.StrEnum):
    NONE = "none"
    SAFE_REPLAY = "safe_replay"
    VERIFY_BEFORE_RETRY = "verify_before_retry"
    NEVER_REPLAY = "never_replay"


class RunProjectionError(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class OperationSnapshot:
    operation_id: str
    turn: int
    step: int
    call_id: str
    tool_name: str
    arguments: dict[str, Any]
    effect: str
    dispatched: bool
    phase: OperationPhase
    outcome: OperationOutcome
    recovery_policy: RecoveryPolicy
    prepared_seq: int
    settled_seq: int | None = None
    failure_type: str | None = None
    used_backend: str | None = None
    latency_ms: float | None = None


@dataclass(frozen=True, slots=True)
class InboxMessage:
    message_id: str
    target: str
    text: str
    seq: int
    time_ms: int
    payload: dict[str, Any] = field(default_factory=dict)
