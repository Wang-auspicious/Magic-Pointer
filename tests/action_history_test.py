from __future__ import annotations

import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.actions.history import ActionHistoryRecord, ActionHistoryStore, make_word_undo_proposal
from app.actions.office import text_sha256
from app.actions.schema import ActionProposal, SafetyLevel
from app.actions.executor import SafeActionExecutor
from app.adapters.office_adapter import OfficeProbeResult
import app.actions.executor as executor_module

ROOT = Path(__file__).resolve().parents[1]


def temp_history_path() -> Path:
    root = Path(r"D:\tmp")
    if not root.exists():
        root = ROOT / "data" / "runtime"
    root.mkdir(parents=True, exist_ok=True)
    return root / f"magic_pointer_action_history_test_{uuid.uuid4().hex}.jsonl"


def test_history_recent_undoable_and_mark_undone() -> None:
    path = temp_history_path()
    try:
        store = ActionHistoryStore(path)
        failed = ActionHistoryRecord(
            id="hist-failed",
            action_type="office_replace_selection",
            app="word",
            proposal_id="p0",
            status="failed",
        )
        success = ActionHistoryRecord(
            id="hist-ok",
            action_type="office_replace_selection",
            app="word",
            proposal_id="p1",
            document=r"C:\demo\doc.docx",
            before_sha256=text_sha256("old"),
            after_sha256=text_sha256("new"),
            before_excerpt="old",
            after_excerpt="new",
        )
        store.append(failed)
        store.append(success)
        assert store.recent_undoable(app="word").id == "hist-ok"
        undo = make_word_undo_proposal(success)
        assert undo.action_type == "office_undo_last_action"
        assert undo.confirmation_required is True
        assert undo.parameters["history_id"] == "hist-ok"
        store.mark_undone("hist-ok")
        assert store.get("hist-ok").undone_at is not None
        assert store.recent_undoable(app="word") is None
    finally:
        try:
            path.unlink()
        except FileNotFoundError:
            pass


def test_executor_records_history_and_returns_undo_proposal_with_fake_word_com() -> None:
    path = temp_history_path()
    original = executor_module._run_powershell_json
    try:
        def fake_run(script: str, *, timeout: int = 10) -> OfficeProbeResult:
            if "com:word.selection.replace" in script:
                return OfficeProbeResult(True, {
                    "ok": True,
                    "method": "com:word.selection.replace",
                    "document": r"C:\demo\doc.docx",
                    "hwnd": 123,
                    "selection_start": 5,
                    "selection_end": 8,
                    "before_text": "old",
                    "before_sha256": text_sha256("old"),
                    "after_sha256": text_sha256("new"),
                })
            if "com:word.application.undo" in script:
                return OfficeProbeResult(True, {
                    "ok": True,
                    "method": "com:word.application.undo",
                    "document": r"C:\demo\doc.docx",
                })
            return OfficeProbeResult(False, {}, "unexpected script")

        executor_module._run_powershell_json = fake_run
        store = ActionHistoryStore(path)
        executor = SafeActionExecutor(history_store=store)
        proposal = ActionProposal(
            id="replace-1",
            action_type="office_replace_selection",
            parameters={
                "document": r"C:\demo\doc.docx",
                "selection_start": 5,
                "selection_end": 8,
                "expected_text_sha256": text_sha256("old"),
                "replacement_text": "new",
                "replacement_text_sha256": text_sha256("new"),
            },
            safety_level=SafetyLevel.HIGH,
            confirmation_required=True,
        )
        result = executor.execute(proposal, confirmed=True)
        assert result.status.value == "succeeded"
        assert result.output["history_id"]
        assert result.output["undo_proposal"]["action_type"] == "office_undo_last_action"
        records = store.records()
        assert len(records) == 1
        assert records[0].before_excerpt == "old"
        assert records[0].after_excerpt == "new"

        undo = ActionProposal.from_dict(result.output["undo_proposal"])
        undo_result = executor.execute(undo, confirmed=True)
        assert undo_result.status.value == "succeeded"
        assert store.get(records[0].id).undone_at is not None
    finally:
        executor_module._run_powershell_json = original
        try:
            path.unlink()
        except FileNotFoundError:
            pass


def main() -> None:
    test_history_recent_undoable_and_mark_undone()
    test_executor_records_history_and_returns_undo_proposal_with_fake_word_com()
    print("action history test ok")


if __name__ == "__main__":
    main()
