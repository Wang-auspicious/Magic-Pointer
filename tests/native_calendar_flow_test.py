from __future__ import annotations

import json
import os
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def run_script(tmp_path: Path, script: str, payload: dict) -> tuple[int, dict]:
    env = os.environ.copy()
    env["MAGIC_POINTER_USER_DATA_DIR"] = str(tmp_path)
    env["MAGIC_POINTER_TIMEZONE"] = "Asia/Shanghai"
    env["PYTHONIOENCODING"] = "utf-8"
    completed = subprocess.run(
        [sys.executable, str(ROOT / "scripts" / script)],
        cwd=ROOT,
        input=json.dumps(payload, ensure_ascii=False),
        text=True,
        encoding="utf-8",
        capture_output=True,
        env=env,
        check=False,
    )
    return completed.returncode, json.loads(completed.stdout.strip())


def test_selected_poster_to_confirmed_local_event_and_receipt_undo(tmp_path: Path) -> None:
    expires_at = (datetime.now(timezone.utc) + timedelta(minutes=1)).isoformat()
    selection = {
        "command": "添加到日历",
        "selectionSessionId": "session-calendar-e2e",
        "selectionSnapshot": {
            "snapshot_id": "snapshot-calendar-e2e",
            "expires_at": expires_at,
            "source_window": {"title": "产品发布会.pdf - Microsoft Edge", "hwnd": 123},
            "context": {
                "adapter": "uia_text_selection",
                "app": "pdf",
                "window": {"title": "产品发布会.pdf - Microsoft Edge", "hwnd": 123},
                "content": "产品发布会\n2026年7月20日 14:00—16:00\n地点：上海徐汇滨江",
                "label": "产品发布会.pdf",
                "method": "uia:text-pattern.selection",
                "capabilities": [],
                "artifacts": {},
                "error": None,
            },
        },
    }
    code, drafted = run_script(tmp_path, "selection_bridge.py", selection)
    assert code == 0
    assert drafted["intentKind"] == "calendar_event_draft"
    assert drafted["actionProposals"] == []
    draft = drafted["calendarDraft"]

    code, unconfirmed = run_script(tmp_path, "calendar_bridge.py", {
        "operation": "create",
        "event": draft["event"],
        "idempotencyKey": draft["idempotency_key"],
        "source": draft["source"],
        "allowConflict": False,
        "confirmed": False,
    })
    assert code != 0
    assert unconfirmed["ok"] is False

    code, created = run_script(tmp_path, "calendar_bridge.py", {
        "operation": "create",
        "event": draft["event"],
        "idempotencyKey": draft["idempotency_key"],
        "source": draft["source"],
        "allowConflict": False,
        "confirmed": True,
    })
    assert code == 0
    output = created["executionResult"]["output"]
    assert output["verified"] is True
    assert output["event"]["title"] == "产品发布会"
    assert created["state"]["events"][0]["source"]["app"] == "pdf"

    code, undone = run_script(tmp_path, "calendar_bridge.py", {
        "operation": "undo_create",
        "eventId": output["event"]["id"],
        "receiptId": output["receipt_id"],
        "expectedUpdatedAt": output["event"]["updated_at"],
    })
    assert code == 0
    assert undone["state"]["events"] == []
