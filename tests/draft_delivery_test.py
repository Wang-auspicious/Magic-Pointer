from __future__ import annotations

import hashlib
from pathlib import Path

import pytest

from app.actions.draft_delivery import (
    DraftDeliveryError,
    make_draft_delivery_proposal,
    make_prompt_delivery_proposal,
)
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
        target_point_space="physical_screen_pixels",
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
    assert action.parameters["target_point_space"] == "physical_screen_pixels"
    assert action.parameters["text"] == expected_text
    assert action.parameters["text_sha256"] == hashlib.sha256(expected_text.encode("utf-8")).hexdigest()
    assert action.parameters["submit"] is False
    assert action.confirmation_required is False
    assert action.metadata["explicit_user_delivery_intent"] is True


def test_generic_prompt_delivery_records_context_and_target_profile() -> None:
    action = make_prompt_delivery_proposal(
        "Implement the grounded task.",
        target_window={
            "title": "Claude Code",
            "hwnd": 501,
            "process_id": 502,
            "process_name": "claude.exe",
        },
        target_point=[300, 700],
        target_point_space="physical_screen_pixels",
        context_session_id="context-1",
        prompt_artifact=r"C:\tmp\context-1-prompt.md",
        target_profile="claude",
    )

    assert action.id.startswith("prompt-delivery-")
    assert action.parameters["context_session_id"] == "context-1"
    assert action.parameters["target_profile"] == "claude"
    assert action.parameters["review_session_id"] == ""
    assert action.parameters["submit"] is False
    assert action.metadata["delivery_kind"] == "context_prompt_delivery"
    assert "without submitting" in action.rationale


def test_runtime_prompt_delivery_carries_exact_workflow_lifecycle_contract() -> None:
    action = make_prompt_delivery_proposal(
        "# Runtime UI issue",
        target_window={"title": "Codex", "hwnd": 501, "process_id": 502},
        target_point=[300, 700],
        target_point_space="physical_screen_pixels",
        context_session_id="context-runtime",
        workflow_kind="runtime_issue",
    )

    assert action.parameters["workflow_kind"] == "runtime_issue"
    assert action.parameters["context_session_id"] == "context-runtime"
    assert action.metadata["workflow_kind"] == "runtime_issue"


def test_delivery_accepts_system_window_pid_alias() -> None:
    action = make_prompt_delivery_proposal(
        "Grounded prompt",
        target_window={"title": "Codex", "hwnd": 701, "pid": 702},
        target_point=[10, 20],
        target_point_space="physical_screen_pixels",
        context_session_id="context-1",
    )

    assert action.parameters["target_process_id"] == 702
    assert action.target.metadata["process_id"] == 702


def test_delivery_proposal_rejects_missing_text_window_or_point() -> None:
    with pytest.raises(DraftDeliveryError, match="text is empty"):
        make_draft_delivery_proposal("", target_window={"hwnd": 1}, target_point=[1, 2])
    with pytest.raises(DraftDeliveryError, match="target window"):
        make_draft_delivery_proposal("text", target_window={}, target_point=[1, 2])
    with pytest.raises(DraftDeliveryError, match="target point"):
        make_draft_delivery_proposal("text", target_window={"hwnd": 1}, target_point=None)
    with pytest.raises(DraftDeliveryError, match="target process"):
        make_draft_delivery_proposal(
            "text",
            target_window={"title": "Codex", "hwnd": 1},
            target_point=[1, 2],
            target_point_space="physical_screen_pixels",
        )


@pytest.mark.parametrize("coordinate_space", [None, "dip", "logical_screen_pixels"])
def test_delivery_rejects_untrusted_coordinate_space(coordinate_space: str | None) -> None:
    with pytest.raises(DraftDeliveryError, match="coordinate space"):
        make_prompt_delivery_proposal(
            "Grounded prompt",
            target_window={"title": "Codex", "hwnd": 701, "pid": 702},
            target_point=[10, 20],
            target_point_space=coordinate_space,
            context_session_id="context-1",
        )


def test_native_writer_uses_pointer_width_handle_and_strict_window_title() -> None:
    source = Path("scripts/uia_draft_writer.cs").read_text(encoding="utf-8")

    assert "LongInteger" in source
    assert "long hwndValue" in source
    assert "new IntPtr(hwndValue)" in source
    assert "String.Equals(actualTitle, expectedTitle, StringComparison.Ordinal)" in source
    assert "physical_screen_pixels" in source


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


def test_executor_rejects_delivery_without_locked_process_identity() -> None:
    action = proposal()
    unsafe = type(action)(
        id=action.id,
        action_type=action.action_type,
        target=action.target,
        parameters={**action.parameters, "target_process_id": None},
        safety_level=action.safety_level,
        confirmation_required=action.confirmation_required,
        rationale=action.rationale,
        created_at=action.created_at,
        metadata=action.metadata,
    )

    result = SafeActionExecutor(draft_writer=lambda _parameters: {"ok": True}).execute(unsafe, confirmed=False)

    assert result.status == ExecutionStatus.FAILED
    assert "process" in result.error.lower()


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


def test_executor_accepts_verified_terminal_artifact_reference() -> None:
    action = proposal()

    def writer(parameters):
        return {
            "ok": True,
            "target_hwnd": parameters["target_hwnd"],
            "target_title": parameters["target_title"],
            "written_chars": 72,
            "source_chars": len(parameters["text"]),
            "method": "keyboard:terminal-artifact-reference",
            "delivery_mode": "artifact_reference",
            "verified": True,
            "submit_sent": False,
        }

    result = SafeActionExecutor(draft_writer=writer).execute(action, confirmed=False)

    assert result.status == ExecutionStatus.SUCCEEDED
    assert result.output["delivery_mode"] == "artifact_reference"
    assert result.output["source_chars"] == len(action.parameters["text"])
