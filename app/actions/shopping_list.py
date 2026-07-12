from __future__ import annotations

import hashlib
import re
import uuid
from datetime import datetime
from typing import Any

from app.actions.schema import ActionProposal, ActionTarget, SafetyLevel
from app.adapters.base import AdapterReadContext

SHOPPING_LIST_TARGET_URI = "magic-pointer://dashboard/shopping-list/default"

_ENGLISH_PATTERNS = (
    re.compile(r"^add\s+(?:this|it)$", re.IGNORECASE),
    re.compile(r"^add\s+(?:this|it)\s+to\s+(?:(?:my|the)\s+)?shopping\s+list$", re.IGNORECASE),
    re.compile(r"^add\s+to\s+(?:(?:my|the)\s+)?shopping\s+list$", re.IGNORECASE),
)
_CHINESE_COMMANDS = {
    "添加这个", "添加它", "加入清单", "加入购物清单", "加到购物清单",
    "把这个加入清单", "把这个加入购物清单", "把它加入购物清单",
}


def _now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def normalize_item_text(value: str) -> str | None:
    raw = str(value or "").replace("\r\n", "\n").replace("\r", "\n")
    if len(raw.split("\n")) > 2:
        return None
    text = " ".join(raw.split())
    if not text or len(text) > 160:
        return None
    return text


def wants_shopping_list_add(command: str) -> bool:
    normalized = " ".join(str(command or "").strip().split())
    if not normalized:
        return False
    if normalized in _CHINESE_COMMANDS:
        return True
    return any(pattern.fullmatch(normalized) for pattern in _ENGLISH_PATTERNS)


def _idempotency_key(snapshot_id: str, item_text: str) -> str:
    material = "\0".join(("default-shopping-list", snapshot_id, item_text.casefold(), "shopping_list_add"))
    return "sha256:" + hashlib.sha256(material.encode("utf-8", errors="surrogatepass")).hexdigest()


def make_shopping_list_add_proposal(
    ctx: AdapterReadContext,
    *,
    command: str,
    selection_session_id: str | None,
    selection_snapshot_id: str | None,
) -> ActionProposal | None:
    if not wants_shopping_list_add(command):
        return None
    item_text = normalize_item_text(ctx.content or "")
    snapshot_id = str(selection_snapshot_id or "").strip()
    if not item_text or not snapshot_id:
        return None
    source_window_title = str((ctx.window or {}).get("title") or "")
    content_hash = hashlib.sha256(item_text.encode("utf-8", errors="surrogatepass")).hexdigest()
    proposal_id = f"shopping-add-{uuid.uuid4().hex[:12]}"
    return ActionProposal(
        id=proposal_id,
        action_type="shopping_list_add",
        target=ActionTarget(
            object_id=SHOPPING_LIST_TARGET_URI,
            selection_id=snapshot_id,
            description="Magic Pointer 购物清单",
            metadata={
                "provider": "magic_pointer_dashboard",
                "destination": "shopping_list",
                "list_id": "default-shopping-list",
            },
        ),
        parameters={
            "item_text": item_text,
            "idempotency_key": _idempotency_key(snapshot_id, item_text),
            "source": {
                "selection_snapshot_id": snapshot_id,
                "app": ctx.app,
                "window_title": source_window_title,
                "content_sha256": content_hash,
            },
            "selection_session_id": selection_session_id,
        },
        safety_level=SafetyLevel.LOW,
        confirmation_required=False,
        rationale="Add the explicitly selected item to the local Magic Pointer shopping list.",
        created_at=_now_iso(),
        metadata={
            "trusted_local_intent": True,
            "auto_execute": True,
            "intent_kind": "shopping_list_add",
        },
    )


def make_shopping_list_check_proposal(item: dict[str, Any], *, checked: bool) -> ActionProposal:
    return ActionProposal(
        id=f"shopping-check-{uuid.uuid4().hex[:12]}",
        action_type="shopping_list_set_checked",
        target=ActionTarget(object_id=SHOPPING_LIST_TARGET_URI, description=str(item.get("text") or "Shopping item")),
        parameters={
            "item_id": str(item.get("id") or ""),
            "checked": checked,
            "expected_updated_at": str(item.get("updated_at") or ""),
        },
        safety_level=SafetyLevel.LOW,
        confirmation_required=False,
        rationale="Update one item in the local Magic Pointer shopping list.",
        created_at=_now_iso(),
        metadata={"trusted_dashboard_action": True},
    )


def make_shopping_list_undo_proposal(*, receipt_id: str, item: dict[str, Any]) -> ActionProposal:
    return ActionProposal(
        id=f"shopping-undo-{uuid.uuid4().hex[:12]}",
        action_type="shopping_list_undo_add",
        target=ActionTarget(object_id=SHOPPING_LIST_TARGET_URI, description=str(item.get("text") or "Shopping item")),
        parameters={
            "receipt_id": str(receipt_id or ""),
            "item_id": str(item.get("id") or ""),
            "expected_updated_at": str(item.get("updated_at") or ""),
        },
        safety_level=SafetyLevel.LOW,
        confirmation_required=False,
        rationale="Precisely undo one verified local shopping-list add.",
        created_at=_now_iso(),
        metadata={"trusted_dashboard_action": True},
    )
