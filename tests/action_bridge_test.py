from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]


def run_bridge(payload: dict[str, Any], *, user_data_dir: Path | None = None) -> tuple[int, dict[str, Any]]:
    env = dict(os.environ)
    if user_data_dir is not None:
        env["MAGIC_POINTER_USER_DATA_DIR"] = str(user_data_dir)
    proc = subprocess.run(
        [sys.executable, "scripts/action_bridge.py"],
        input=json.dumps(payload, ensure_ascii=False),
        text=True,
        capture_output=True,
        cwd=ROOT,
        timeout=15,
        env=env,
    )
    lines = [line for line in proc.stdout.splitlines() if line.strip()]
    assert lines, proc.stderr
    return proc.returncode, json.loads(lines[-1])


def proposal(action_type: str = "copy_text_to_clipboard") -> dict[str, Any]:
    return {
        "id": "test-action",
        "action_type": action_type,
        "parameters": {"text": "hello"},
        "safety_level": "medium",
    }


def word_replace_proposal() -> dict[str, Any]:
    return {
        "id": "word-replace-test",
        "action_type": "office_replace_selection",
        "parameters": {
            "document": r"C:\demo\doc.docx",
            "selection_start": 1,
            "selection_end": 4,
            "expected_text_sha256": "0" * 64,
            "replacement_text": "new text",
        },
        "safety_level": "high",
        "confirmation_required": True,
    }


def shopping_add_proposal() -> dict[str, Any]:
    return {
        "id": "shopping-add-test",
        "action_type": "shopping_list_add",
        "target": {"object_id": "magic-pointer://dashboard/shopping-list/default"},
        "parameters": {
            "item_text": "1 lb Spaghetti",
            "idempotency_key": "bridge-key-1",
            "source": {"selection_snapshot_id": "snap-1", "app": "pdf"},
        },
        "safety_level": "low",
        "confirmation_required": False,
    }


def test_missing_proposal_is_rejected() -> None:
    code, output = run_bridge({})
    assert code == 2
    assert output["ok"] is False
    assert output["error"] == "missing proposal"


def test_confirmation_is_required_before_clipboard_copy() -> None:
    code, output = run_bridge({"proposal": proposal(), "confirmed": False})
    assert code == 1
    assert output["ok"] is False
    assert output["executionResult"]["status"] == "skipped"
    assert output["executionResult"]["error"] == "confirmation required"


def test_word_replace_selection_requires_confirmation_when_not_confirmed() -> None:
    code, output = run_bridge({"proposal": word_replace_proposal(), "confirmed": False})
    assert code == 1
    assert output["ok"] is False
    assert output["executionResult"]["status"] == "skipped"
    assert output["executionResult"]["error"] == "confirmation required"
    assert output.get("actionProposals") == []


def test_unsupported_action_is_not_executed_even_when_confirmed() -> None:
    code, output = run_bridge({"proposal": proposal("type_arbitrary_text"), "confirmed": True})
    assert code == 1
    assert output["ok"] is False
    assert output["executionResult"]["status"] == "failed"
    assert "unsupported action_type" in output["executionResult"]["error"]


def test_shopping_add_executes_without_second_confirmation_and_returns_undo(tmp_path: Path) -> None:
    code, output = run_bridge(
        {"proposal": shopping_add_proposal(), "confirmed": False},
        user_data_dir=tmp_path,
    )
    assert code == 0
    assert output["ok"] is True
    assert output["answer"] == "已加入购物清单。"
    assert output["executionResult"]["output"]["verified"] is True
    assert output["executionResult"]["output"]["item"]["text"] == "1 lb Spaghetti"
    assert output["actionProposals"][0]["action_type"] == "shopping_list_undo_add"
    assert (tmp_path / "dashboard" / "shopping_list.json").exists()


def main() -> None:
    test_missing_proposal_is_rejected()
    test_confirmation_is_required_before_clipboard_copy()
    test_word_replace_selection_requires_confirmation_when_not_confirmed()
    test_unsupported_action_is_not_executed_even_when_confirmed()
    print("action bridge test ok")


if __name__ == "__main__":
    main()
