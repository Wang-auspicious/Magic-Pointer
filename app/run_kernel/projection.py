"""Pure projections from append-only session events."""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import replace
from typing import Any

from .schema import (
    InboxMessage,
    OperationOutcome,
    OperationPhase,
    OperationSnapshot,
    RecoveryPolicy,
    RunProjectionError,
)

_READ_EFFECT = "read"
_REVERSIBLE_EFFECT = "reversible_write"


def _recovery(effect: str, *, dispatched: bool, settled: bool) -> RecoveryPolicy:
    if settled:
        return RecoveryPolicy.NONE
    if not dispatched or effect == _READ_EFFECT:
        return RecoveryPolicy.SAFE_REPLAY
    if effect == _REVERSIBLE_EFFECT:
        return RecoveryPolicy.VERIFY_BEFORE_RETRY
    return RecoveryPolicy.NEVER_REPLAY


def _unsettled_outcome(*, dispatched: bool) -> OperationOutcome:
    return OperationOutcome.UNKNOWN if dispatched else OperationOutcome.NOT_STARTED


def project_operations(events: Iterable[Any]) -> tuple[OperationSnapshot, ...]:
    """Project every operation in prepared order with strict settlement rules."""
    ordered: list[OperationSnapshot] = []
    by_id: dict[str, int] = {}
    for event in events:
        event_type = str(getattr(event, "type", "") or "")
        data = dict(getattr(event, "data", {}) or {})
        seq = int(getattr(event, "seq", -1))
        if event_type == "operation/prepared":
            operation_id = str(data.get("operationId") or "")
            if not operation_id:
                raise RunProjectionError(f"prepared operation at event {seq} has no id")
            if operation_id in by_id:
                raise RunProjectionError(f"duplicate operation id {operation_id!r}")
            effect = str(data.get("effect") or "unknown")
            dispatched = bool(data.get("dispatched"))
            snapshot = OperationSnapshot(
                operation_id=operation_id,
                turn=int(data.get("turn") or 0),
                step=int(data.get("step") or 0),
                call_id=str(data.get("callId") or ""),
                tool_name=str(data.get("name") or ""),
                arguments=dict(data.get("arguments") or {}),
                effect=effect,
                dispatched=dispatched,
                phase=OperationPhase.PREPARED,
                outcome=_unsettled_outcome(dispatched=dispatched),
                recovery_policy=_recovery(effect, dispatched=dispatched, settled=False),
                prepared_seq=seq,
            )
            by_id[operation_id] = len(ordered)
            ordered.append(snapshot)
            continue
        if event_type != "operation/settled":
            continue
        operation_id = str(data.get("operationId") or "")
        index = by_id.get(operation_id)
        if index is None:
            raise RunProjectionError(
                f"settlement at event {seq} has no prepared operation {operation_id!r}"
            )
        current = ordered[index]
        if current.phase is OperationPhase.SETTLED:
            raise RunProjectionError(f"operation {operation_id!r} settled more than once")
        try:
            outcome = OperationOutcome(str(data.get("outcome") or ""))
        except ValueError as exc:
            raise RunProjectionError(
                f"operation {operation_id!r} has invalid outcome"
            ) from exc
        if outcome is OperationOutcome.PENDING:
            raise RunProjectionError(f"operation {operation_id!r} settled as pending")
        latency = data.get("latencyMs")
        ordered[index] = replace(
            current,
            phase=OperationPhase.SETTLED,
            outcome=outcome,
            recovery_policy=(
                RecoveryPolicy.NONE
                if outcome in {OperationOutcome.SUCCEEDED, OperationOutcome.FAILED}
                else _recovery(
                    current.effect,
                    dispatched=current.dispatched,
                    settled=False,
                )
            ),
            settled_seq=seq,
            failure_type=(str(data.get("failureType")) if data.get("failureType") else None),
            used_backend=(str(data.get("usedBackend")) if data.get("usedBackend") else None),
            latency_ms=(float(latency) if isinstance(latency, (int, float)) and not isinstance(latency, bool) else None),
        )
    return tuple(ordered)


def pending_inbox(events: Iterable[Any], target: str | None = None) -> tuple[InboxMessage, ...]:
    """Return unconsumed inbox messages in append order."""
    messages: list[InboxMessage] = []
    by_id: dict[str, InboxMessage] = {}
    consumed: set[str] = set()
    for event in events:
        event_type = str(getattr(event, "type", "") or "")
        data = dict(getattr(event, "data", {}) or {})
        seq = int(getattr(event, "seq", -1))
        if event_type == "inbox/message":
            message_id = str(data.get("messageId") or "")
            if not message_id or message_id in by_id:
                raise RunProjectionError(f"invalid or duplicate inbox message at event {seq}")
            item = InboxMessage(
                message_id=message_id,
                target=str(data.get("target") or ""),
                text=str(data.get("text") or ""),
                seq=seq,
                time_ms=int(getattr(event, "time_ms", 0)),
            )
            by_id[message_id] = item
            messages.append(item)
        elif event_type == "inbox/consumed":
            for raw_id in list(data.get("messageIds") or []):
                message_id = str(raw_id or "")
                if message_id not in by_id or message_id in consumed:
                    raise RunProjectionError(
                        f"inbox consumption at event {seq} references non-pending {message_id!r}"
                    )
                consumed.add(message_id)
    return tuple(
        item
        for item in messages
        if item.message_id not in consumed and (target is None or item.target == target)
    )
