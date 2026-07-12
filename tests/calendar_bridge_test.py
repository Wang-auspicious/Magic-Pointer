from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BRIDGE = ROOT / "scripts" / "calendar_bridge.py"


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


def event_payload(title: str = "Design review") -> dict:
    return {
        "title": title,
        "start_at": "2026-07-20T10:00:00+08:00",
        "end_at": "2026-07-20T11:00:00+08:00",
        "timezone": "Asia/Shanghai",
        "location": "Room A",
        "notes": "",
        "all_day": False,
    }


def test_preview_returns_normalized_event_and_conflicts(tmp_path: Path) -> None:
    code, result = run_bridge(tmp_path, {"operation": "preview", "event": event_payload()})
    assert code == 0
    assert result["ok"] is True
    assert result["normalizedEvent"]["title"] == "Design review"
    assert result["conflicts"] == []


def test_create_refuses_missing_confirmation_then_persists(tmp_path: Path) -> None:
    payload = {
        "operation": "create",
        "event": event_payload(),
        "idempotencyKey": "bridge-create",
        "source": {"app": "pdf"},
        "allowConflict": False,
    }
    code, refused = run_bridge(tmp_path, payload)
    assert code != 0
    assert refused["ok"] is False

    code, created = run_bridge(tmp_path, {**payload, "confirmed": True})
    assert code == 0
    assert created["ok"] is True
    assert created["executionResult"]["status"] == "succeeded"
    assert created["state"]["events"][0]["title"] == "Design review"


def test_conflict_is_returned_for_second_confirmation(tmp_path: Path) -> None:
    first = {
        "operation": "create",
        "event": event_payload("First"),
        "idempotencyKey": "first",
        "source": {},
        "confirmed": True,
        "allowConflict": False,
    }
    assert run_bridge(tmp_path, first)[0] == 0
    code, conflict = run_bridge(tmp_path, {**first, "event": event_payload("Second"), "idempotencyKey": "second"})
    assert code != 0
    assert conflict["ok"] is False
    assert conflict["conflicts"][0]["title"] == "First"


def test_undo_uses_exact_receipt(tmp_path: Path) -> None:
    payload = {
        "operation": "create",
        "event": event_payload(),
        "idempotencyKey": "undo-me",
        "source": {},
        "confirmed": True,
        "allowConflict": False,
    }
    _, created = run_bridge(tmp_path, payload)
    event = created["executionResult"]["output"]["event"]
    receipt_id = created["executionResult"]["output"]["receipt_id"]
    code, undone = run_bridge(tmp_path, {
        "operation": "undo_create",
        "eventId": event["id"],
        "receiptId": receipt_id,
        "expectedUpdatedAt": event["updated_at"],
    })
    assert code == 0
    assert undone["state"]["events"] == []
