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


def test_bridge_unknown_operation_fails_closed(tmp_path: Path) -> None:
    code, result = _call(tmp_path, {"operation": "destroy_everything"})
    assert code == 1
    assert result["ok"] is False
    assert "unknown operation" in result["error"]

