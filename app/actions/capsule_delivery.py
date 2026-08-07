"""Carry the capsule's own answer into the app the user was working in.

The bubble already holds the text, so the natural question is why it cannot just
walk across into the WeChat input box. Mechanically it can: the verified
cross-application write already exists as
`app/actions/executor.py::_paste_text_to_foreground`, and it is already used to
fill Agent input boxes. Two things it deliberately will not do:

* clobber a draft the user typed themselves (the writer refuses when the target
  input already holds different text), and
* claim a write it could not read back (WeChat, Canvas and other self-drawn
  controls expose no readable text to verify against).

Both refusals are features. The cost of pretending otherwise is exactly the bug
`a6a6d08` removed -- a success report for text that never moved. So when the
write cannot happen or cannot be confirmed, this module falls back to the thing
the user can finish themselves in one keystroke: the text goes on the clipboard
and we say so, naming the reason.
"""

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

# The clipboard sentence is appended to every fallback message, so the user
# always learns the same next step regardless of which refusal they hit.
_CLIPBOARD_TAIL = "结果已复制，把光标点进输入框按 Ctrl+V 就行。"


def _now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def make_capsule_delivery_proposal(
    text: str,
    *,
    target_window: dict[str, Any],
    target_point: Any,
    target_point_space: str | None = None,
    prefer_foreground: bool = False,
) -> ActionProposal:
    """The write itself, reusing the existing channel's identity guarantees.

    Every check in `make_prompt_delivery_proposal` is kept: hwnd, pid and title
    must all be present, the point must be trusted physical screen pixels, the
    text is hashed, and `submit` is False so nothing is ever sent for the user.
    """
    delegate = make_prompt_delivery_proposal(
        text,
        target_window=target_window,
        target_point=target_point,
        target_point_space=target_point_space,
        prefer_foreground=prefer_foreground,
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
    """The honest second best: the text is on the clipboard, the user pastes it."""
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
    """What actually happened, in the words we are willing to show the user."""

    kind: str  # "written" | "clipboard"
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

# Ordered because writer errors are matched by substring and the first match
# wins. `attempted` records whether keys were actually sent: for an unverifiable
# paste the text may already be in the box, and saying otherwise would be a
# second kind of lie.
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
    """Turn a writer error into a clipboard verdict that names the real cause.

    Unrecognized errors fall through to a generic message rather than being
    dressed up as a known cause -- an unfamiliar failure is still a failure, and
    guessing its reason would make the message less trustworthy, not more.
    """
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
