from __future__ import annotations

import hashlib
import uuid
from datetime import datetime
from typing import Any

from app.actions.schema import ActionProposal, ActionTarget, SafetyLevel


class DraftDeliveryError(ValueError):
    pass


def _now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def _positive_int(value: Any) -> int | None:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None


def _point(value: Any) -> tuple[int, int] | None:
    if isinstance(value, dict):
        raw = (value.get("x"), value.get("y"))
    elif isinstance(value, (list, tuple)) and len(value) == 2:
        raw = (value[0], value[1])
    else:
        return None
    try:
        return int(raw[0]), int(raw[1])
    except (TypeError, ValueError):
        return None


def make_prompt_delivery_proposal(
    text: str,
    *,
    target_window: dict[str, Any],
    target_point: Any,
    target_point_space: str | None = None,
    context_session_id: str | None = None,
    review_session_id: str | None = None,
    prompt_artifact: str | None = None,
    target_profile: str | None = None,
    delivery_kind: str = "context_prompt_delivery",
    workflow_kind: str = "context_pack",
) -> ActionProposal:
    exact_text = str(text or "")
    if not exact_text.strip():
        raise DraftDeliveryError("draft text is empty")
    hwnd = _positive_int((target_window or {}).get("hwnd"))
    if hwnd is None:
        raise DraftDeliveryError("target window identity is missing")
    point = _point(target_point)
    if point is None:
        raise DraftDeliveryError("target point is missing")
    if target_point_space != "physical_screen_pixels":
        raise DraftDeliveryError("target coordinate space is not trusted physical screen pixels")
    title = str((target_window or {}).get("title") or "")[:1000]
    if not title.strip():
        raise DraftDeliveryError("target window title is missing")
    process_id = _positive_int((target_window or {}).get("process_id") or (target_window or {}).get("pid"))
    if process_id is None:
        raise DraftDeliveryError("target process identity is missing")
    process_name = str((target_window or {}).get("process_name") or "")[:500]
    text_hash = hashlib.sha256(exact_text.encode("utf-8")).hexdigest()
    return ActionProposal(
        id=f"prompt-delivery-{uuid.uuid4().hex[:12]}",
        action_type="paste_text_to_foreground",
        target=ActionTarget(
            point=point,
            description=title or f"Window {hwnd}",
            metadata={
                "hwnd": hwnd,
                "process_id": process_id,
                "process_name": process_name,
                "input_surface": "user_pointed",
                "target_point_space": target_point_space,
            },
        ),
        parameters={
            "text": exact_text,
            "text_sha256": text_hash,
            "target_hwnd": hwnd,
            "target_title": title,
            "target_process_id": process_id,
            "target_process_name": process_name,
            "target_point": [point[0], point[1]],
            "target_point_space": target_point_space,
            "context_session_id": str(context_session_id or ""),
            "review_session_id": str(review_session_id or ""),
            "prompt_artifact": str(prompt_artifact or ""),
            "target_profile": str(target_profile or "generic"),
            "workflow_kind": str(workflow_kind or "context_pack"),
            "submit": False,
        },
        safety_level=SafetyLevel.LOW,
        confirmation_required=False,
        rationale="Write the compiled grounded prompt into the exact user-pointed input surface without submitting it.",
        created_at=_now_iso(),
        metadata={
            "trusted_local_intent": True,
            "explicit_user_delivery_intent": True,
            "auto_execute": True,
            "no_submit": True,
            "delivery_kind": str(delivery_kind or "context_prompt_delivery"),
            "workflow_kind": str(workflow_kind or "context_pack"),
        },
    )


def make_draft_delivery_proposal(
    text: str,
    *,
    target_window: dict[str, Any],
    target_point: Any,
    target_point_space: str | None = None,
    review_session_id: str | None = None,
    prompt_artifact: str | None = None,
) -> ActionProposal:
    proposal = make_prompt_delivery_proposal(
        text,
        target_window=target_window,
        target_point=target_point,
        target_point_space=target_point_space,
        review_session_id=review_session_id,
        prompt_artifact=prompt_artifact,
        delivery_kind="review_prompt_delivery",
    )
    return ActionProposal(
        id=proposal.id.replace("prompt-delivery-", "draft-delivery-", 1),
        action_type=proposal.action_type,
        target=proposal.target,
        parameters=proposal.parameters,
        safety_level=proposal.safety_level,
        confirmation_required=proposal.confirmation_required,
        rationale=proposal.rationale.replace("grounded prompt", "review draft"),
        created_at=proposal.created_at,
        metadata=proposal.metadata,
    )
