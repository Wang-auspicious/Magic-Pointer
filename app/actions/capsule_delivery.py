
from __future__ import annotations

import hashlib
import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from app.actions.draft_delivery import DraftDeliveryError, make_prompt_delivery_proposal
from app.actions.schema import ActionProposal, SafetyLevel

CAPSULE_DELIVERY_KIND = "capsule_text_delivery"
CAPSULE_WORKFLOW_KIND = "capsule_delivery"
CLIPBOARD_FALLBACK_KIND = "capsule_clipboard_fallback"

_CLIPBOARD_TAIL = "结果已复制，把光标点进输入框按 Ctrl+V 就行。"


def _now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def make_capsule_delivery_proposal(
    text: str,
    *,
    target_window: dict[str, Any],
    target_point: Any,
    target_point_space: str | None = None,
    target_resolution: str = "exact",
    current_target_window: dict[str, Any] | None = None,
) -> ActionProposal:
    delegate = make_prompt_delivery_proposal(
        text,
        target_window=target_window,
        target_point=target_point,
        target_point_space=target_point_space,
        target_resolution=target_resolution,
        current_target_window=current_target_window,
        delivery_kind=CAPSULE_DELIVERY_KIND,
    )
    return ActionProposal(
        id=delegate.id.replace("prompt-delivery-", "capsule-delivery-", 1),
        action_type=delegate.action_type,
        target=delegate.target,
        parameters=delegate.parameters,
        safety_level=delegate.safety_level,
        confirmation_required=delegate.confirmation_required,
        rationale=(
            "Write the answer shown in the capsule into the input surface the "
            "user pointed at, without submitting it."
        ),
        created_at=delegate.created_at,
        metadata=delegate.metadata,
    )


def make_clipboard_fallback_proposal(text: str, *, reason_code: str) -> ActionProposal:
    exact_text = str(text or "")
    if not exact_text.strip():
        raise DraftDeliveryError("draft text is empty")
    return ActionProposal(
        id=f"capsule-clipboard-{uuid.uuid4().hex[:12]}",
        action_type="copy_text_to_clipboard",
        parameters={
            "text": exact_text,
            "text_sha256": hashlib.sha256(exact_text.encode("utf-8")).hexdigest(),
            "fallback_reason": str(reason_code or "unknown"),
        },
        safety_level=SafetyLevel.LOW,
        confirmation_required=False,
        rationale="The capsule answer could not be written into the app, so it is placed on the clipboard instead.",
        created_at=_now_iso(),
        metadata={
            "trusted_local_intent": True,
            "delivery_kind": CLIPBOARD_FALLBACK_KIND,
            "fallback_reason": str(reason_code or "unknown"),
        },
    )


@dataclass(frozen=True)
class DeliveryVerdict:

    kind: str
    reason_code: str
    message: str
    write_attempted: bool

    def to_dict(self) -> dict[str, object]:
        return {
            "kind": self.kind,
            "reasonCode": self.reason_code,
            "message": self.message,
            "writeAttempted": self.write_attempted,
        }


WRITTEN = DeliveryVerdict(
    kind="written",
    reason_code="verified",
    message="已填入输入框并核对过内容，没有发送。",
    write_attempted=True,
)

_FAILURE_RULES: tuple[tuple[str, str, str, bool], ...] = (
    (
        "not an editable input surface",
        "not_an_input_surface",
        "你划的那个位置不是可以输入的框，所以没往里写。",
        False,
    ),
    (
        "already contains a different draft",
        "input_already_has_text",
        "那个输入框里已经有别的内容，没有覆盖掉它。",
        False,
    ),
    (
        "password",
        "password_input",
        "那是密码框，任何情况下都不会写入。",
        False,
    ),
    (
        "input surface is disabled",
        "input_disabled",
        "那个输入框现在不可编辑。",
        False,
    ),
    (
        "foreground",
        "window_not_foreground",
        "没能把目标窗口切到前台，所以没敢往里写。",
        False,
    ),
    (
        "terminal",
        "terminal_target",
        "目标是终端窗口，不直接往里敲字。",
        False,
    ),
    (
        "could not be verified",
        "write_not_verifiable",
        "已经粘贴了一次，但这个输入框不让我们读回内容，所以无法确认写没写进去——请自己看一眼。",
        True,
    ),
    (
        "verification failed",
        "write_not_verifiable",
        "已经写了一次，但读回来的内容和预期不一致，所以不算成功。",
        True,
    ),
    (
        "character-count verification",
        "write_not_verifiable",
        "已经写了一次，但字数核对不上，所以不算成功。",
        True,
    ),
    (
        "did not verify the write",
        "write_not_verifiable",
        "写入没有通过校验，所以不算成功。",
        True,
    ),
)


def describe_delivery_failure(error: str | None) -> DeliveryVerdict:
    text = str(error or "").casefold()
    for needle, code, message, attempted in _FAILURE_RULES:
        if needle in text:
            return DeliveryVerdict(
                kind="clipboard",
                reason_code=code,
                message=f"{message}{_CLIPBOARD_TAIL}",
                write_attempted=attempted,
            )
    return DeliveryVerdict(
        kind="clipboard",
        reason_code="write_refused",
        message=f"没能写进这个应用。{_CLIPBOARD_TAIL}",
        write_attempted=False,
    )
