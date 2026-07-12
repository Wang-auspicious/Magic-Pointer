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


def test_selection_to_verified_action_to_dashboard_state(tmp_path: Path) -> None:
    expires_at = (datetime.now(timezone.utc) + timedelta(minutes=1)).isoformat()
    selection_payload = {
        "command": "添加这个",
        "selectionSessionId": "session-e2e",
        "selectionSnapshot": {
            "snapshot_id": "snapshot-e2e",
            "expires_at": expires_at,
            "source_window": {"title": "周末食谱.pdf - Microsoft Edge", "hwnd": 123},
            "context": {
                "adapter": "uia_text_selection",
                "app": "pdf",
                "window": {"title": "周末食谱.pdf - Microsoft Edge", "hwnd": 123},
                "content": "有机牛奶 2 盒",
                "label": "周末食谱.pdf",
                "method": "uia:text-pattern.selection",
                "capabilities": [],
                "artifacts": {},
                "error": None,
            },
        },
    }

    code, selected = run_script(tmp_path, "selection_bridge.py", selection_payload)
    assert code == 0
    assert selected["intentKind"] == "shopping_list_add"
    assert selected["autoExecuteProposalId"] == selected["actionProposals"][0]["id"]

    proposal = selected["actionProposals"][0]
    code, executed = run_script(tmp_path, "action_bridge.py", {"proposal": proposal, "confirmed": False})
    assert code == 0
    assert executed["ok"] is True
    assert executed["executionResult"]["output"]["verified"] is True

    code, dashboard = run_script(tmp_path, "shopping_list_bridge.py", {"operation": "list"})
    assert code == 0
    assert dashboard["state"]["items"][0]["text"] == "有机牛奶 2 盒"
    assert dashboard["state"]["items"][0]["source"]["app"] == "pdf"

    code, replayed = run_script(tmp_path, "action_bridge.py", {"proposal": proposal, "confirmed": False})
    assert code == 0
    assert replayed["executionResult"]["output"]["created"] is False
    _, dashboard_after_replay = run_script(tmp_path, "shopping_list_bridge.py", {"operation": "list"})
    assert len(dashboard_after_replay["state"]["items"]) == 1
