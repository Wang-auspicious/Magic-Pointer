from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "fabric_bridge.py"


def _call(tmp_path: Path, payload: dict) -> tuple[int, dict]:
    env = dict(os.environ)
    env["MAGIC_POINTER_USER_DATA_DIR"] = str(tmp_path)
    completed = subprocess.run(
        [sys.executable, str(SCRIPT)],
        input=json.dumps(payload, ensure_ascii=False),
        capture_output=True,
        text=True,
        encoding="utf-8",
        cwd=ROOT,
        env=env,
        timeout=15,
        check=False,
    )
    return completed.returncode, json.loads(completed.stdout.strip().splitlines()[-1])


def test_runtime_snapshot_is_one_bounded_local_truth_response(tmp_path: Path) -> None:
    code, result = _call(
        tmp_path,
        {
            "operation": "runtime.snapshot",
            "runtimeEvidence": {
                "voiceWorker": {"state": "ready", "residentEnabled": True},
                "permissions": {
                    "accessibility": {"state": "ready", "source": "native_runtime"},
                    "screenCapture": {"state": "not_required", "source": "platform_contract"},
                },
            },
        },
    )

    assert code == 0
    assert result["ok"] is True
    snapshot = result["snapshot"]
    assert snapshot["settings"]["schema_version"] == 1
    # Not pinned to a count: recipes are manifest data now, so adding a
    # capability adds a JSON entry. What matters is the snapshot carries the
    # whole catalog and each entry is renderable.
    assert len(snapshot["recipes"]) >= 30
    assert snapshot["models"]["items"] == []
    assert snapshot["workers"]["voice"]["state"] == "ready"
    assert snapshot["permissions"]["accessibility"]["state"] == "ready"
    assert snapshot["diagnostics"]["networkRequests"] == 0
    assert snapshot["diagnostics"]["spawnedProcesses"] == 0
    assert len(snapshot["capabilities"]) == len(snapshot["recipes"])
    assert all("evidence" in item for item in snapshot["capabilities"])
    assert all("state" in item for item in snapshot["capabilities"])


def test_runtime_snapshot_uses_engine_provider_truth(tmp_path: Path) -> None:
    code, result = _call(
        tmp_path,
        {
            "operation": "runtime.snapshot",
            "runtimeEvidence": {"voiceWorker": {"state": "unloaded"}},
        },
    )
    assert code == 0
    statuses = {item["id"]: item for item in result["snapshot"]["capabilities"]}

    assert statuses["activate.wiggle"]["state"] == "ready"
    assert statuses["map.route"]["state"] == "ready"
    assert statuses["agent.handoff"]["state"] in {"ready", "needs_agent"}
    assert statuses["voice.short_command"]["state"] == "needs_setup"
    assert statuses["chart.extract_data"]["state"] in {"ready", "needs_agent", "needs_setup"}
    assert statuses["chart.extract_data"]["evidence"]["engineProvider"].startswith(
        ("unavailable:", "agent.task")
    )
