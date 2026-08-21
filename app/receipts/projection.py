"""Pure projections of Receipts from session events, plus composition."""

from __future__ import annotations

import uuid
from collections.abc import Iterable, Sequence
from typing import Any

from app.agent_runtime.types import TransitionReason

from .schema import Receipt, ReceiptProjectionError, ReceiptStatus


def project_receipts(events: Iterable[Any]) -> tuple[Receipt, ...]:
    """Replay receipt/issued events. Unknown event types are ignored."""
    receipts: list[Receipt] = []
    for event in events:
        event_type = str(getattr(event, "type", "") or "")
        if event_type != "receipt/issued":
            continue
        data = dict(getattr(event, "data", {}) or {})
        seq = int(getattr(event, "seq", -1))
        receipt_id = str(data.get("receiptId") or "")
        if not receipt_id:
            raise ReceiptProjectionError(f"receipt at event {seq} has no id")
        status_raw = str(data.get("status") or "")
        try:
            status = ReceiptStatus(status_raw)
        except ValueError as exc:
            raise ReceiptProjectionError(
                f"receipt {receipt_id!r} has unknown status {status_raw!r}"
            ) from exc
        artifact_ids = tuple(
            str(item) for item in (data.get("artifactIds") or ()) if str(item)
        )
        receipts.append(Receipt(
            receipt_id=receipt_id,
            status=status,
            effect=str(data.get("effect") or "read"),
            verification_method=str(data.get("verificationMethod") or ""),
            used_backend=str(data.get("usedBackend") or ""),
            artifact_ids=artifact_ids,
            wrote=bool(data.get("wrote")),
            verified=bool(data.get("verified")),
            failure_type=(
                str(data["failureType"]) if data.get("failureType") else None
            ),
            memory_eligible=bool(data.get("memoryEligible")),
        ))
    return tuple(receipts)


def compose_receipt(
    *,
    wrote: bool,
    verified: bool,
    artifact_ids: Sequence[str],
    reason: str,
    used_backend: str = "",
) -> Receipt:
    """Deterministic stop proof from the verification gate and terminal reason."""
    ids = tuple(str(item) for item in artifact_ids if str(item))
    reason_key = str(reason or "")
    status, method, effect, failure = _classify(
        wrote=wrote,
        verified=verified,
        has_artifacts=bool(ids),
        reason=reason_key,
    )
    return Receipt(
        receipt_id=uuid.uuid4().hex,
        status=status,
        effect=effect,
        verification_method=method,
        used_backend=str(used_backend or "loop"),
        artifact_ids=ids,
        wrote=bool(wrote),
        verified=bool(verified),
        failure_type=failure,
        memory_eligible=False,
    )


def _classify(
    *,
    wrote: bool,
    verified: bool,
    has_artifacts: bool,
    reason: str,
) -> tuple[ReceiptStatus, str, str, str | None]:
    effect = "reversible_write" if wrote else "read"
    if reason == TransitionReason.COMPLETED.value:
        if wrote and not verified:
            return ReceiptStatus.UNVERIFIED, "unverified_write", effect, None
        if wrote and verified:
            return ReceiptStatus.SUCCEEDED, "write_verified", effect, None
        if has_artifacts:
            return ReceiptStatus.SUCCEEDED, "draft_generated", effect, None
        return ReceiptStatus.UNKNOWN, "none", effect, None
    if reason == TransitionReason.USER_INTERRUPT.value:
        return ReceiptStatus.INTERRUPTED, reason, effect, reason
    if reason == TransitionReason.AWAITING_USER.value:
        return ReceiptStatus.PARTIAL, reason, effect, reason
    if reason:
        return ReceiptStatus.FAILED, reason, effect, reason
    return ReceiptStatus.UNKNOWN, "none", effect, None
