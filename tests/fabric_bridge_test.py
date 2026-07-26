from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "fabric_bridge.py"


def _load_bridge_module():
    spec = importlib.util.spec_from_file_location("fabric_bridge_under_test", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


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


def test_bridge_lists_catalog_and_real_provider_state(tmp_path: Path) -> None:
    code, catalog = _call(tmp_path, {"operation": "catalog"})
    assert code == 0
    assert catalog["ok"] is True
    assert len(catalog["recipes"]) == 30

    code, providers = _call(tmp_path, {"operation": "providers"})
    assert code == 0
    assert providers["ok"] is True
    assert {item["id"] for item in providers["providers"]} >= {"codex", "pi", "claude", "gemini"}


def test_bridge_routes_plans_and_executes_safe_recipe(tmp_path: Path) -> None:
    obj = {"id": "one", "kind": "text", "content": "0800 22 44 88"}
    code, routed = _call(tmp_path, {"operation": "route", "command": "号码去掉空格再复制", "objects": [obj]})
    assert code == 0
    assert routed["match"]["recipeId"] == "text.ocr_clean"

    code, executed = _call(
        tmp_path,
        {
            "operation": "execute",
            "command": "recipe: research.evidence_card",
            "objects": [obj],
            "confirmed": True,
        },
    )
    assert code == 0
    assert executed["receipt"]["status"] == "succeeded"
    assert Path(executed["receipt"]["output"]["artifact"]).exists()


def test_map_execute_result_reports_queued_agent_task_as_accepted_not_failure() -> None:
    bridge = _load_bridge_module()
    planned = {
        "match": {"recipeId": "agent.handoff"},
        "plan": {"recipeId": "agent.handoff", "parameters": {"agent": "pi"}},
    }
    receipt = {
        "status": "accepted",
        "verified": False,
        "output": {"taskId": "task-9", "provider": "pi", "status": "queued"},
    }
    result = bridge.map_execute_result(planned, receipt)
    assert result["ok"] is True
    assert result["state"] == "accepted"
    assert result["provider"] == "pi"
    assert result["taskId"] == "task-9"
    assert "尚未完成" in result["message"]
    assert result["receipt"] is receipt

    completed = bridge.map_execute_result(planned, {"status": "succeeded", "verified": True, "output": {}})
    assert completed["ok"] is True
    assert completed["state"] == "completed"

    failed = bridge.map_execute_result(planned, {"status": "verification_failed", "error": "clipboard_readback_mismatch"})
    assert failed["ok"] is False
    assert failed["state"] == "verification_failed"
    assert failed["error"] == "clipboard_readback_mismatch"


def test_bridge_unknown_operation_fails_closed(tmp_path: Path) -> None:
    code, result = _call(tmp_path, {"operation": "destroy_everything"})
    assert code == 1
    assert result["ok"] is False
    assert "unknown operation" in result["error"]

