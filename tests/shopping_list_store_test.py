from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.dashboard.shopping_list import (
    ShoppingListConflict,
    ShoppingListDataError,
    ShoppingListStore,
    ShoppingListValidationError,
)


def test_add_is_persistent_verified_and_idempotent(tmp_path: Path) -> None:
    store = ShoppingListStore(tmp_path)
    first = store.add_item(
        "  1 lb   Spaghetti  ",
        idempotency_key="key-1",
        source={"selection_snapshot_id": "snap-1", "app": "pdf"},
        now="2026-07-12T10:00:00+08:00",
    )
    assert first["created"] is True
    assert first["verified"] is True
    assert first["item"]["text"] == "1 lb Spaghetti"
    assert first["item"]["normalized_text"] == "1 lb spaghetti"
    assert first["receipt_id"].startswith("receipt-")
    assert store.public_list()["items"][0]["id"] == first["item"]["id"]

    retry = store.add_item(
        "1 lb Spaghetti",
        idempotency_key="key-1",
        source={"selection_snapshot_id": "snap-1", "app": "pdf"},
        now="2026-07-12T10:01:00+08:00",
    )
    assert retry["created"] is False
    assert retry["item"]["id"] == first["item"]["id"]
    assert retry["receipt_id"] == first["receipt_id"]
    assert len(store.public_list()["items"]) == 1

    reloaded = ShoppingListStore(tmp_path)
    assert reloaded.public_list()["items"][0]["text"] == "1 lb Spaghetti"


def test_same_text_from_new_snapshot_can_be_added_again(tmp_path: Path) -> None:
    store = ShoppingListStore(tmp_path)
    first = store.add_item("Milk", idempotency_key="snap-1-key", source={"selection_snapshot_id": "snap-1"})
    second = store.add_item("Milk", idempotency_key="snap-2-key", source={"selection_snapshot_id": "snap-2"})
    assert first["item"]["id"] != second["item"]["id"]
    assert [item["text"] for item in store.public_list()["items"]] == ["Milk", "Milk"]


def test_check_uses_expected_version_and_undo_is_precise(tmp_path: Path) -> None:
    store = ShoppingListStore(tmp_path)
    first = store.add_item("Spaghetti", idempotency_key="key-1", source={})
    second = store.add_item("Tomatoes", idempotency_key="key-2", source={})

    checked = store.set_checked(
        first["item"]["id"],
        True,
        first["item"]["updated_at"],
        now="2026-07-12T10:02:00+08:00",
    )
    assert checked["verified"] is True
    assert checked["item"]["checked"] is True

    with pytest.raises(ShoppingListConflict):
        store.undo_add(
            first["item"]["id"],
            first["receipt_id"],
            first["item"]["updated_at"],
            now="2026-07-12T10:03:00+08:00",
        )

    undone = store.undo_add(
        second["item"]["id"],
        second["receipt_id"],
        second["item"]["updated_at"],
        now="2026-07-12T10:04:00+08:00",
    )
    assert undone["verified"] is True
    assert undone["item"]["removed_at"] == "2026-07-12T10:04:00+08:00"
    assert [item["text"] for item in store.public_list()["items"]] == ["Spaghetti"]


@pytest.mark.parametrize("text", ["", " ", "x" * 161, "one\ntwo\nthree"])
def test_invalid_item_text_is_rejected(tmp_path: Path, text: str) -> None:
    with pytest.raises(ShoppingListValidationError):
        ShoppingListStore(tmp_path).add_item(text, idempotency_key="key", source={})


def test_corrupt_or_unknown_store_fails_closed_without_overwrite(tmp_path: Path) -> None:
    dashboard = tmp_path / "dashboard"
    dashboard.mkdir(parents=True)
    path = dashboard / "shopping_list.json"
    path.write_text("{broken", encoding="utf-8")
    with pytest.raises(ShoppingListDataError):
        ShoppingListStore(tmp_path).public_list()
    assert path.read_text(encoding="utf-8") == "{broken"

    original = {"version": 2, "revision": 0, "list": {"id": "x", "name": "x", "items": [], "receipts": []}}
    path.write_text(json.dumps(original), encoding="utf-8")
    with pytest.raises(ShoppingListDataError):
        ShoppingListStore(tmp_path).public_list()
    assert json.loads(path.read_text(encoding="utf-8"))["version"] == 2
