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
            before_text="old",
            after_text="new",
            selection_start=5,
            selection_end=8,
            after_selection_end=8,
            left_anchor_sha256="left-hash",
            left_anchor_chars=4,
            right_anchor_sha256="right-hash",
            right_anchor_chars=5,
        )
        store.append(failed)
        store.append(success)
        assert store.recent_undoable(app="word").id == "hist-ok"
        assert store.recent_undoable(app="word").left_anchor_chars == 4
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
    undo_scripts: list[str] = []
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
                    "after_selection_end": 8,
                    "before_text": "old",
                    "before_sha256": text_sha256("old"),
                    "after_text": "new",
                    "after_sha256": text_sha256("new"),
                    "left_anchor_sha256": text_sha256("left"),
                    "left_anchor_chars": 4,
                    "right_anchor_sha256": text_sha256("right"),
                    "right_anchor_chars": 5,
                })
            if "com:word.range.precise_restore" in script:
                undo_scripts.append(script)
                return OfficeProbeResult(True, {
                    "ok": True,
                    "method": "com:word.range.precise_restore",
                    "document": r"C:\demo\doc.docx",
                    "restored_by": "recorded_range",
                    "match_count": 0,
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
        assert records[0].before_text == "old"
        assert records[0].after_text == "new"
        assert records[0].after_selection_end == 8
        assert records[0].left_anchor_chars == 4
        assert records[0].right_anchor_chars == 5

        undo = ActionProposal.from_dict(result.output["undo_proposal"])
        undo_result = executor.execute(undo, confirmed=True)
        assert undo_result.status.value == "succeeded"
        restored = store.get(records[0].id)
        assert restored.undone_at is not None
        assert restored.before_text is None
        assert restored.after_text is None
        assert undo_result.output["restored_by"] == "recorded_range"
        assert len(undo_scripts) == 1
        assert "anchored_text_match" in undo_scripts[0]
        assert "refusing an ambiguous restore" in undo_scripts[0]
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
