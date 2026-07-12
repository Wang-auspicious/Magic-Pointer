from __future__ import annotations

import hashlib

import pytest

from app.actions.draft_delivery import DraftDeliveryError, make_draft_delivery_proposal
from app.actions.executor import SafeActionExecutor
from app.actions.schema import ExecutionStatus


def proposal():
    return make_draft_delivery_proposal(
        "请修改第 2 页的图注。",
        target_window={
            "title": "Codex",
            "hwnd": 901,
            "process_id": 902,
            "process_name": "Codex.exe",
        },
        target_point={"x": 420, "y": 860},
        review_session_id="review-1",
        prompt_artifact=r"C:\tmp\review-1.md",
    )


def test_delivery_proposal_locks_exact_target_and_never_submits() -> None:
    action = proposal()
    expected_text = "请修改第 2 页的图注。"

    assert action.action_type == "paste_text_to_foreground"
    assert action.target.point == (420, 860)
    assert action.parameters["target_hwnd"] == 901
    assert action.parameters["target_process_id"] == 902
    assert action.parameters["target_title"] == "Codex"
    assert action.parameters["text"] == expected_text
    assert action.parameters["text_sha256"] == hashlib.sha256(expected_text.encode("utf-8")).hexdigest()
    assert action.parameters["submit"] is False
    assert action.confirmation_required is False
    assert action.metadata["explicit_user_delivery_intent"] is True


def test_delivery_proposal_rejects_missing_text_window_or_point() -> None:
    with pytest.raises(DraftDeliveryError, match="text is empty"):
        make_draft_delivery_proposal("", target_window={"hwnd": 1}, target_point=[1, 2])
    with pytest.raises(DraftDeliveryError, match="target window"):
        make_draft_delivery_proposal("text", target_window={}, target_point=[1, 2])
    with pytest.raises(DraftDeliveryError, match="target point"):
        make_draft_delivery_proposal("text", target_window={"hwnd": 1}, target_point=None)


def test_executor_accepts_only_verified_no_submit_receipt(tmp_path) -> None:
    action = proposal()

    def writer(parameters):
        return {
            "ok": True,
            "target_hwnd": parameters["target_hwnd"],
            "target_title": parameters["target_title"],
            "written_chars": len(parameters["text"]),
            "method": "uia:value-pattern",
            "verified": True,
            "submit_sent": False,
        }

    result = SafeActionExecutor(draft_writer=writer).execute(action, confirmed=False)

    assert result.status == ExecutionStatus.SUCCEEDED
    assert result.output["verified"] is True
    assert result.output["submit_sent"] is False


def test_executor_fails_closed_if_writer_reports_submit() -> None:
    action = proposal()
    result = SafeActionExecutor(
        draft_writer=lambda parameters: {
            "ok": True,
            "target_hwnd": parameters["target_hwnd"],
            "written_chars": len(parameters["text"]),
            "method": "unsafe",
            "verified": True,
            "submit_sent": True,
        }
    ).execute(action, confirmed=False)

    assert result.status == ExecutionStatus.FAILED
    assert "submit" in result.error.lower()
