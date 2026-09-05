from __future__ import annotations

from app.action_guard.undo_log import UndoLog
from app.actions.executor import SafeActionExecutor
from app.actions.schema import ActionProposal, ExecutionResult, ExecutionStatus, SafetyLevel


def _write_result() -> ExecutionResult:
    return ExecutionResult(
        proposal_id="write-1",
        action_type="shopping_list_add",
        status=ExecutionStatus.SUCCEEDED,
        output={
            "undo_proposal": ActionProposal(
                id="undo-write-1",
                action_type="shopping_list_undo_add",
                parameters={"receipt_id": "receipt-1"},
                safety_level=SafetyLevel.LOW,
                confirmation_required=False,
            ).to_dict()
        },
    )


def test_successful_write_result_is_registered_in_shared_undo_log() -> None:
    log = UndoLog()
    executor = SafeActionExecutor(undo_log=log)

    result = executor._finalize_execution(_write_result())

    assert result.metadata["undo_registered"] is True
    assert log.peek() is not None
    assert log.peek().action_id == "write-1"


def test_undo_compensation_reenters_executor_and_requires_success(monkeypatch) -> None:
    log = UndoLog()
    executor = SafeActionExecutor(undo_log=log)
    calls: list[tuple[str, bool]] = []

    def fake_execute(proposal, *, confirmed=False):
        calls.append((proposal.action_type, confirmed))
        return ExecutionResult(
            proposal_id=proposal.id,
            action_type=proposal.action_type,
            status=ExecutionStatus.SUCCEEDED,
        )

    monkeypatch.setattr(executor, "execute", fake_execute)
    executor._finalize_execution(_write_result())

    restored = log.undo()

    assert restored.action_id == "write-1"
    assert calls == [("shopping_list_undo_add", True)]


def test_default_executors_share_process_undo_ledger() -> None:
    first = SafeActionExecutor()
    second = SafeActionExecutor()

    assert first.undo_log is second.undo_log
