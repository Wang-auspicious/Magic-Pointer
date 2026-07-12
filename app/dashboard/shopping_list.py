from __future__ import annotations

import json
import os
import uuid
from copy import deepcopy
from datetime import datetime
from pathlib import Path
from typing import Any

JsonDict = dict[str, Any]
STORE_VERSION = 1
LIST_ID = "default-shopping-list"


class ShoppingListError(RuntimeError):
    pass


class ShoppingListValidationError(ShoppingListError):
    pass


class ShoppingListConflict(ShoppingListError):
    pass


class ShoppingListDataError(ShoppingListError):
    pass


def _now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="microseconds")


def _default_root() -> Path:
    configured = os.environ.get("MAGIC_POINTER_USER_DATA_DIR")
    if configured:
        return Path(configured)
    local_app_data = os.environ.get("LOCALAPPDATA")
    if local_app_data:
        return Path(local_app_data) / "Magic Pointer"
    return Path.home() / ".magic-pointer"


def _normalize_text(value: str) -> tuple[str, str]:
    raw = str(value or "").replace("\r\n", "\n").replace("\r", "\n")
    logical_lines = raw.split("\n")
    if len(logical_lines) > 2:
        raise ShoppingListValidationError("shopping list item must be at most two lines")
    text = " ".join(raw.split())
    if not text:
        raise ShoppingListValidationError("shopping list item is empty")
    if len(text) > 160:
        raise ShoppingListValidationError("shopping list item exceeds 160 characters")
    return text, text.casefold()


def _safe_source(source: Any) -> JsonDict:
    if not isinstance(source, dict):
        return {}
    allowed = ("selection_snapshot_id", "app", "window_title", "content_sha256")
    return {
        key: str(source[key])[:1000]
        for key in allowed
        if source.get(key) is not None and str(source[key]).strip()
    }


class ShoppingListStore:
    def __init__(self, root: Path | str | None = None) -> None:
        self.root = Path(root) if root is not None else _default_root()
        self.path = self.root / "dashboard" / "shopping_list.json"

    @staticmethod
    def _default_state() -> JsonDict:
        return {
            "version": STORE_VERSION,
            "revision": 0,
            "list": {
                "id": LIST_ID,
                "name": "购物清单",
                "items": [],
                "receipts": [],
            },
        }

    def _validate_state(self, state: Any) -> JsonDict:
        if not isinstance(state, dict) or state.get("version") != STORE_VERSION:
            raise ShoppingListDataError("unsupported shopping list schema version")
        if not isinstance(state.get("revision"), int) or state["revision"] < 0:
            raise ShoppingListDataError("invalid shopping list revision")
        list_data = state.get("list")
        if not isinstance(list_data, dict) or list_data.get("id") != LIST_ID:
            raise ShoppingListDataError("invalid shopping list identity")
        if not isinstance(list_data.get("items"), list) or not isinstance(list_data.get("receipts"), list):
            raise ShoppingListDataError("invalid shopping list records")
        for item in list_data["items"]:
            if not isinstance(item, dict) or not isinstance(item.get("id"), str):
                raise ShoppingListDataError("invalid shopping list item")
        return state

    def _load(self) -> JsonDict:
        if not self.path.exists():
            return self._default_state()
        try:
            state = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise ShoppingListDataError(f"could not read shopping list: {type(exc).__name__}: {exc}") from exc
        return self._validate_state(state)

    def _save(self, state: JsonDict) -> None:
        validated = self._validate_state(state)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temp_path = self.path.with_suffix(self.path.suffix + ".tmp")
        try:
            with temp_path.open("w", encoding="utf-8", newline="\n") as handle:
                json.dump(validated, handle, ensure_ascii=False, indent=2)
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            temp_path.replace(self.path)
        except OSError as exc:
            raise ShoppingListDataError(f"could not persist shopping list: {type(exc).__name__}: {exc}") from exc

    @staticmethod
    def _find_item(state: JsonDict, item_id: str) -> JsonDict:
        item = next((entry for entry in state["list"]["items"] if entry.get("id") == item_id), None)
        if item is None:
            raise ShoppingListConflict("shopping list item no longer exists")
        return item

    def public_list(self) -> JsonDict:
        state = self._load()
        items = [deepcopy(item) for item in state["list"]["items"] if not item.get("removed_at")]
        return {
            "version": STORE_VERSION,
            "revision": state["revision"],
            "id": LIST_ID,
            "name": state["list"].get("name") or "购物清单",
            "items": items,
        }

    def add_item(
        self,
        text: str,
        *,
        idempotency_key: str,
        source: Any,
        now: str | None = None,
    ) -> JsonDict:
        clean_text, normalized_text = _normalize_text(text)
        key = str(idempotency_key or "").strip()
        if not key:
            raise ShoppingListValidationError("idempotency key is required")
        state = self._load()
        existing = next((item for item in state["list"]["items"] if item.get("idempotency_key") == key), None)
        if existing is not None:
            if existing.get("removed_at"):
                raise ShoppingListConflict("the idempotent add was already undone")
            return {
                "created": False,
                "verified": True,
                "receipt_id": existing.get("add_receipt_id"),
                "item": deepcopy(existing),
                "revision": state["revision"],
            }

        stamp = now or _now_iso()
        item_id = f"item-{uuid.uuid4().hex[:16]}"
        receipt_id = f"receipt-{uuid.uuid4().hex[:16]}"
        item = {
            "id": item_id,
            "text": clean_text,
            "normalized_text": normalized_text,
            "checked": False,
            "idempotency_key": key,
            "source": _safe_source(source),
            "add_receipt_id": receipt_id,
            "created_at": stamp,
            "updated_at": stamp,
            "removed_at": None,
        }
        state["list"]["items"].append(item)
        state["list"]["receipts"].append({
            "id": receipt_id,
            "action_type": "shopping_list_add",
            "item_id": item_id,
            "created_at": stamp,
            "undone_at": None,
        })
        state["revision"] += 1
        self._save(state)
        verified = self._find_item(self._load(), item_id)
        if verified.get("text") != clean_text or verified.get("idempotency_key") != key or verified.get("removed_at"):
            raise ShoppingListDataError("shopping list add verification failed")
        return {
            "created": True,
            "verified": True,
            "receipt_id": receipt_id,
            "item": deepcopy(verified),
            "revision": state["revision"],
        }

    def set_checked(
        self,
        item_id: str,
        checked: bool,
        expected_updated_at: str,
        *,
        now: str | None = None,
    ) -> JsonDict:
        if not isinstance(checked, bool):
            raise ShoppingListValidationError("checked must be boolean")
        state = self._load()
        item = self._find_item(state, str(item_id))
        if item.get("removed_at"):
            raise ShoppingListConflict("shopping list item was removed")
        if item.get("updated_at") != expected_updated_at:
            raise ShoppingListConflict("shopping list item changed before check update")
        item["checked"] = checked
        item["updated_at"] = now or _now_iso()
        state["revision"] += 1
        self._save(state)
        verified = self._find_item(self._load(), str(item_id))
        if verified.get("checked") is not checked:
            raise ShoppingListDataError("shopping list check verification failed")
        return {"verified": True, "item": deepcopy(verified), "revision": state["revision"]}

    def undo_add(
        self,
        item_id: str,
        receipt_id: str,
        expected_updated_at: str,
        *,
        now: str | None = None,
    ) -> JsonDict:
        state = self._load()
        item = self._find_item(state, str(item_id))
        receipt = next((entry for entry in state["list"]["receipts"] if entry.get("id") == receipt_id), None)
        if not receipt or receipt.get("action_type") != "shopping_list_add" or receipt.get("item_id") != item_id:
            raise ShoppingListConflict("shopping list add receipt does not match item")
        if receipt.get("undone_at") or item.get("removed_at"):
            raise ShoppingListConflict("shopping list add was already undone")
        if item.get("updated_at") != expected_updated_at:
            raise ShoppingListConflict("shopping list item changed after it was added")
        stamp = now or _now_iso()
        item["removed_at"] = stamp
        item["updated_at"] = stamp
        receipt["undone_at"] = stamp
        state["revision"] += 1
        self._save(state)
        verified = self._find_item(self._load(), str(item_id))
        if verified.get("removed_at") != stamp:
            raise ShoppingListDataError("shopping list undo verification failed")
        return {"verified": True, "item": deepcopy(verified), "revision": state["revision"]}
