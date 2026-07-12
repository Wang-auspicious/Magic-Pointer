from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

from app.dashboard.shopping_list import ShoppingListStore


ROOT = Path(__file__).resolve().parents[1]
BRIDGE = ROOT / "scripts" / "shopping_list_bridge.py"


def run_bridge(tmp_path: Path, payload: dict) -> tuple[int, dict]:
    env = os.environ.copy()
    env["MAGIC_POINTER_USER_DATA_DIR"] = str(tmp_path)
    env["PYTHONIOENCODING"] = "utf-8"
    completed = subprocess.run(
        [sys.executable, str(BRIDGE)],
        cwd=ROOT,
        input=json.dumps(payload, ensure_ascii=False),
        text=True,
        encoding="utf-8",
        capture_output=True,
        env=env,
        check=False,
    )
    return completed.returncode, json.loads(completed.stdout.strip())


def seed_item(tmp_path: Path) -> dict:
    return ShoppingListStore(tmp_path).add_item(
        "Organic milk",
        idempotency_key="seed-milk",
        source={"app": "test"},
    )["item"]


def test_list_returns_public_persistent_state(tmp_path: Path) -> None:
    item = seed_item(tmp_path)
    code, result = run_bridge(tmp_path, {"operation": "list", "requestId": "request-1"})
    assert code == 0
    assert result["ok"] is True
    assert result["requestId"] == "request-1"
    assert result["state"]["items"][0]["id"] == item["id"]


def test_set_checked_executes_typed_action_and_returns_fresh_state(tmp_path: Path) -> None:
    item = seed_item(tmp_path)
    code, result = run_bridge(tmp_path, {
        "operation": "set_checked",
        "requestId": "request-2",
        "itemId": item["id"],
        "checked": True,
        "expectedUpdatedAt": item["updated_at"],
    })
    assert code == 0
    assert result["ok"] is True
    assert result["executionResult"]["status"] == "succeeded"
    assert result["state"]["items"][0]["checked"] is True


def test_undo_add_uses_exact_receipt_and_removes_only_that_item(tmp_path: Path) -> None:
    item = seed_item(tmp_path)
    store = ShoppingListStore(tmp_path)
    store.add_item("Coffee", idempotency_key="seed-coffee", source={"app": "test"})
    code, result = run_bridge(tmp_path, {
        "operation": "undo_add",
        "requestId": "request-3",
        "itemId": item["id"],
        "receiptId": item["add_receipt_id"],
        "expectedUpdatedAt": item["updated_at"],
    })
    assert code == 0
    assert result["ok"] is True
    assert [entry["text"] for entry in result["state"]["items"]] == ["Coffee"]


def test_unknown_operation_fails_closed_without_mutation(tmp_path: Path) -> None:
    item = seed_item(tmp_path)
    code, result = run_bridge(tmp_path, {
        "operation": "delete_everything",
        "itemId": item["id"],
    })
    assert code != 0
    assert result["ok"] is False
    assert ShoppingListStore(tmp_path).public_list()["items"][0]["id"] == item["id"]
