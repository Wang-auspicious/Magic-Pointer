from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.actions.executor import SafeActionExecutor
from app.actions.schema import ExecutionStatus
from app.actions.shopping_list import (
    make_shopping_list_check_proposal,
    make_shopping_list_undo_proposal,
)
from app.dashboard.shopping_list import ShoppingListError, ShoppingListStore


def read_payload() -> dict[str, Any]:
    raw = sys.stdin.read().lstrip("\ufeff").strip()
    return json.loads(raw) if raw else {}


def emit(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, ensure_ascii=False))


def _find_current_item(store: ShoppingListStore, item_id: str) -> dict[str, Any]:
    return next(
        (item for item in store.public_list()["items"] if item.get("id") == item_id),
        {},
    )


def main() -> int:
    request = read_payload()
    request_id = str(request.get("requestId") or "") or None
    operation = str(request.get("operation") or "")
    store = ShoppingListStore()

    try:
        if operation == "list":
            emit({"ok": True, "requestId": request_id, "state": store.public_list()})
            return 0

        if operation not in {"set_checked", "undo_add"}:
            emit({"ok": False, "requestId": request_id, "error": "Unsupported dashboard operation."})
            return 2

        item_id = str(request.get("itemId") or "")
        expected_updated_at = str(request.get("expectedUpdatedAt") or "")
        item = _find_current_item(store, item_id)
        if not item:
            emit({"ok": False, "requestId": request_id, "error": "The shopping-list item no longer exists."})
            return 2
        if not expected_updated_at or item.get("updated_at") != expected_updated_at:
            emit({"ok": False, "requestId": request_id, "error": "The item changed. The list has been refreshed.", "state": store.public_list()})
            return 2

        if operation == "set_checked":
            checked = request.get("checked")
            if not isinstance(checked, bool):
                emit({"ok": False, "requestId": request_id, "error": "checked must be a boolean."})
                return 2
            proposal = make_shopping_list_check_proposal(item, checked=checked)
        else:
            receipt_id = str(request.get("receiptId") or "")
            if not receipt_id or receipt_id != item.get("add_receipt_id"):
                emit({"ok": False, "requestId": request_id, "error": "The add receipt does not match this item."})
                return 2
            proposal = make_shopping_list_undo_proposal(receipt_id=receipt_id, item=item)

        result = SafeActionExecutor(shopping_list_store=store).execute(proposal, confirmed=False)
        succeeded = result.status == ExecutionStatus.SUCCEEDED
        emit({
            "ok": succeeded,
            "requestId": request_id,
            "executionResult": result.to_dict(),
            "error": result.error,
            "state": store.public_list(),
        })
        return 0 if succeeded else 2
    except (ShoppingListError, json.JSONDecodeError, TypeError, ValueError) as exc:
        emit({"ok": False, "requestId": request_id, "error": str(exc)})
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
