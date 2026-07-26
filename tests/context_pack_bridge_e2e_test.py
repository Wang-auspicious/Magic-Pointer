from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]


def selection_snapshot(*, snapshot_id: str, text: str, path: str) -> dict[str, Any]:
    now = datetime.now(timezone.utc)
    return {
        "snapshot_id": snapshot_id,
        "captured_at": now.isoformat(),
        "expires_at": (now + timedelta(minutes=2)).isoformat(),
        "status": "ready",
        "source_kind": "native_selection",
        "target_point": {"x": 300, "y": 400},
        "target_point_space": "physical_screen_pixels",
        "source_window": {"title": f"{Path(path).name} - Code", "hwnd": 101, "pid": 201},
        "context": {
            "adapter": "uia_text_selection",
            "app": "code",
            "window": {"title": f"{Path(path).name} - Code", "hwnd": 101},
            "content": text,
            "label": path,
            "method": "uia:text-pattern.selection",
            "capabilities": [],
            "artifacts": {"document": path, "selection_context": f"context around {text}"},
            "error": None,
        },
    }


def agent_target_snapshot() -> dict[str, Any]:
    now = datetime.now(timezone.utc)
    return {
        "snapshot_id": "agent-target",
        "captured_at": now.isoformat(),
        "expires_at": (now + timedelta(minutes=2)).isoformat(),
        "status": "unsupported",
        "source_kind": "foreground_window",
        "target_point": {"x": 450, "y": 850},
        "target_point_space": "physical_screen_pixels",
        "source_window": {"title": "Codex", "hwnd": 909, "pid": 1009},
        "context": None,
    }


def run_bridge(payload: dict[str, Any], user_data_dir: Path) -> tuple[int, dict[str, Any]]:
    env = dict(os.environ)
    env["MAGIC_POINTER_USER_DATA_DIR"] = str(user_data_dir)
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUTF8"] = "1"
    proc = subprocess.run(
        [sys.executable, "scripts/selection_bridge.py"],
        input=json.dumps(payload, ensure_ascii=False),
        text=True,
        encoding="utf-8",
        capture_output=True,
        cwd=ROOT,
        env=env,
        timeout=20,
    )
    lines = [line for line in proc.stdout.splitlines() if line.strip()]
    assert lines, proc.stderr
    return proc.returncode, json.loads(lines[-1])


def test_process_bridge_collects_compiles_and_prepares_no_submit_handoff(tmp_path: Path) -> None:
    code, first = run_bridge(
        {
            "command": "收集：这是当前实现入口",
            "selectionSessionId": "selection-1",
            "selectionSnapshot": selection_snapshot(
                snapshot_id="snap-1",
                text="def checkout(order):",
                path=r"D:\repo\app.py",
            ),
        },
        tmp_path,
    )
    assert code == 0
    assert first["intentKind"] == "context_item_recorded"
    assert first["contextSession"]["item_count"] == 1

    code, second = run_bridge(
        {
            "command": "加入上下文：这是相关测试",
            "selectionSessionId": "selection-2",
            "selectionSnapshot": selection_snapshot(
                snapshot_id="snap-2",
                text="def test_checkout_failure():",
                path=r"D:\repo\test_checkout.py",
            ),
        },
        tmp_path,
    )
    assert code == 0
    assert second["contextSession"]["item_count"] == 2

    code, compiled = run_bridge(
        {
            "command": "生成提示词：修复结账错误并运行测试",
            "selectionSessionId": "selection-3",
            "selectionSnapshot": selection_snapshot(
                snapshot_id="snap-3",
                text="def test_checkout_failure():",
                path=r"D:\repo\test_checkout.py",
            ),
        },
        tmp_path,
    )
    assert code == 0
    assert compiled["intentKind"] == "context_prompt_compiled"
    assert "修复结账错误并运行测试" in compiled["contextPrompt"]
    assert r"D:\repo\app.py" in compiled["contextPrompt"]
    assert Path(compiled["promptArtifact"]).exists()

    code, delivered = run_bridge(
        {
            "command": "发送到这里",
            "selectionSessionId": "selection-target",
            "selectionSnapshot": agent_target_snapshot(),
            "targetPoint": {"x": 450, "y": 850},
            "targetPointSpace": "physical_screen_pixels",
        },
        tmp_path,
    )
    assert code == 0
    assert delivered["intentKind"] == "context_prompt_delivery"
    assert delivered["contextSession"]["target_profile"] == "codex"
    proposal = delivered["actionProposals"][0]
    assert proposal["parameters"]["target_hwnd"] == 909
    assert proposal["parameters"]["target_process_id"] == 1009
    assert proposal["parameters"]["submit"] is False
    assert proposal["parameters"]["text_sha256"] == hashlib.sha256(
        proposal["parameters"]["text"].encode("utf-8")
    ).hexdigest()
