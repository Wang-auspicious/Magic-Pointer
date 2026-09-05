from __future__ import annotations

from app.action_guard.approval import ActionApproval, ApprovalStatus
from app.actions.executor import SafeActionExecutor
from app.actions.schema import ActionProposal, SafetyLevel


def _proposal(*, level: SafetyLevel = SafetyLevel.HIGH) -> ActionProposal:
    return ActionProposal(
        id="governance-test",
        action_type="copy_text_to_clipboard",
        parameters={"text": "draft"},
        safety_level=level,
        confirmation_required=True,
    )


def test_executor_records_unconfirmed_irreversible_proposal() -> None:
    ledger = ActionApproval()
    result = SafeActionExecutor(approval_ledger=ledger).execute(
        _proposal(), confirmed=False
    )

    request_id = result.metadata["approval_request_id"]
    assert ledger.status(request_id) is ApprovalStatus.PENDING
    assert result.confirmed_by_user is False


def test_executor_binds_true_confirmation_to_human_approval() -> None:
    ledger = ActionApproval()
    result = SafeActionExecutor(approval_ledger=ledger).execute(
        _proposal(level=SafetyLevel.LOW), confirmed=True
    )

    request_id = result.metadata["approval_request_id"]
    assert ledger.status(request_id) is ApprovalStatus.APPROVED
