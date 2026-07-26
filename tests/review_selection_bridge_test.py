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


def pdf_snapshot(*, page: int, text: str, snapshot_id: str) -> dict[str, Any]:
    now = datetime.now(timezone.utc)
    return {
        "snapshot_id": snapshot_id,
        "captured_at": now.isoformat(),
        "expires_at": (now + timedelta(minutes=2)).isoformat(),
        "status": "ready",
        "source_kind": "native_selection",
        "source_window": {"title": "paper.pdf - Edge", "hwnd": 101, "process_id": 201},
        "context": {
            "adapter": "uia_text_selection",
            "app": "pdf",
            "window": {"title": "paper.pdf - Edge", "hwnd": 101},
            "content": text,
            "label": r"D:\papers\paper.pdf",
            "method": "pdf:screen-highlight+local-text-layer",
            "capabilities": [],
            "artifacts": {
                "pdf_document_path": r"D:\papers\paper.pdf",
                "pdf_page_number": page,
                "selection_context": f"Context around {text}",
                "selection_rectangles": [[10, 20, 300, 40]],
            },
            "error": None,
        },
    }


def target_snapshot() -> dict[str, Any]:
    now = datetime.now(timezone.utc)
    return {
        "snapshot_id": "target-input",
        "captured_at": now.isoformat(),
        "expires_at": (now + timedelta(minutes=2)).isoformat(),
        "status": "unsupported",
        "source_kind": "foreground_window",
        "target_point": {"x": 450, "y": 850},
        "target_point_space": "physical_screen_pixels",
        "source_window": {
            "title": "Agent conversation",
            "hwnd": 909,
            "process_id": 1009,
            "process_name": "agent.exe",
        },
        "context": None,
    }


def run_bridge(payload: dict[str, Any], user_data_dir: Path) -> tuple[int, dict[str, Any]]:
    env = dict(os.environ)
    env["MAGIC_POINTER_USER_DATA_DIR"] = str(user_data_dir)
    proc = subprocess.run(
        [sys.executable, "scripts/selection_bridge.py"],
        input=json.dumps(payload, ensure_ascii=False),
        text=True,
        capture_output=True,
        cwd=ROOT,
        env=env,
        timeout=20,
    )
    lines = [line for line in proc.stdout.splitlines() if line.strip()]
    assert lines, proc.stderr
    return proc.returncode, json.loads(lines[-1])


def test_bridge_records_multiple_pages_compiles_and_prepares_delivery(tmp_path: Path) -> None:
    code, first = run_bridge({
        "command": "验收：图注和正文不一致",
        "selectionSessionId": "selection-1",
        "selectionSnapshot": pdf_snapshot(page=2, text="Figure 2", snapshot_id="snap-2"),
    }, tmp_path)
    assert code == 0
    assert first["intentKind"] == "review_anchor_recorded"
    assert first["reviewSession"]["anchor_count"] == 1

    code, second = run_bridge({
        "command": "批注：这个表格的单位需要统一",
        "selectionSessionId": "selection-2",
        "selectionSnapshot": pdf_snapshot(page=7, text="Table 4", snapshot_id="snap-7"),
    }, tmp_path)
    assert code == 0
    assert second["reviewSession"]["anchor_count"] == 2

    code, compiled = run_bridge({
        "command": "整理验收意见",
        "selectionSessionId": "selection-3",
        "selectionSnapshot": pdf_snapshot(page=7, text="Table 4", snapshot_id="snap-compile"),
    }, tmp_path)
    assert code == 0
    assert compiled["intentKind"] == "review_prompt_compiled"
    assert compiled["answer"].index("第 2 页") < compiled["answer"].index("第 7 页")
    assert Path(compiled["promptArtifact"]).exists()

    code, delivery = run_bridge({
        "command": "把验收意见填到这里",
        "selectionSessionId": "selection-target",
        "selectionSnapshot": target_snapshot(),
        "targetPoint": {"x": 450, "y": 850},
        "targetPointSpace": "physical_screen_pixels",
    }, tmp_path)
    assert code == 0
    assert delivery["intentKind"] == "review_draft_delivery"
    assert delivery["autoExecuteProposalId"] == delivery["actionProposals"][0]["id"]
    action = delivery["actionProposals"][0]
    assert action["action_type"] == "paste_text_to_foreground"
    assert action["parameters"]["target_hwnd"] == 909
    assert action["parameters"]["target_point"] == [450, 850]
    assert action["parameters"]["submit"] is False
    assert action["parameters"]["text_sha256"] == hashlib.sha256(
        action["parameters"]["text"].encode("utf-8")
    ).hexdigest()


def test_bridge_refuses_delivery_without_active_review(tmp_path: Path) -> None:
    code, output = run_bridge({
        "command": "填入这里",
        "selectionSessionId": "selection-target",
        "selectionSnapshot": target_snapshot(),
        "targetPoint": {"x": 450, "y": 850},
        "targetPointSpace": "physical_screen_pixels",
    }, tmp_path)

    assert code == 1
    assert output["ok"] is False
    assert output["intentKind"] == "review_draft_delivery"
    assert output["actionProposals"] == []
