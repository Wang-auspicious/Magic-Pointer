"""Turn Fabric action receipts into a hard Agent tool-result truth boundary."""

from __future__ import annotations

import json
from typing import Any

from app.agent_runtime.errors import ActionFailure, FailureType


def verify_action_receipt(value: Any) -> None:
    """Accept only a verified completion or verified dispatch acceptance."""
    try:
        payload = json.loads(value) if isinstance(value, str) else dict(value)
    except (TypeError, ValueError, json.JSONDecodeError) as exc:
        raise ActionFailure(
            FailureType.TOOL_ERROR,
            f"invalid action receipt: {type(exc).__name__}",
        ) from exc

    status = str(payload.get("status") or "")
    verified = payload.get("verified") is True
    verification = payload.get("verification")
    verification = dict(verification) if isinstance(verification, dict) else {}

    if status in {"succeeded", "executed"} and verified:
        return
    if status == "accepted" and verification.get("taskAccepted") is True:
        return

    failure_type = (
        FailureType.PERMISSION_DENIED
        if status == "denied"
        else FailureType.CONTENT_CHANGED
        if status == "verification_failed"
        else FailureType.TOOL_ERROR
    )
    error = str(payload.get("error") or status or "action_receipt_unverified")
    receipt = json.dumps(payload, ensure_ascii=False, sort_keys=True)
    raise ActionFailure(
        failure_type,
        f"action did not produce a verified result: {error}; receipt={receipt}",
    )
