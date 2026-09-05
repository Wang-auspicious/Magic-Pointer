from __future__ import annotations

import json
from pathlib import Path

from app.action_guard.action_broker import ActionBroker
from app.actions.schema import ActionProposal, ExecutionResult, ExecutionStatus, SafetyLevel
from scripts import action_bridge


def _proposal(action_id: str = "write-1") -> ActionProposal:
    return ActionProposal(
        id=action_id,
        action_type="shopping_list_add",
        parameters={"item": "milk"},
        safety_level=SafetyLevel.LOW,
        confirmation_required=False,
    )


def _undo_proposal() -> dict:
    return ActionProposal(
        id="undo-write-1",
        action_type="shopping_list_undo_add",
        parameters={"receipt_id": "receipt-1"},
        safety_level=SafetyLevel.LOW,
        confirmation_required=False,
    ).to_dict()


class FakeExecutor:
    def __init__(self) -> None:
        self.calls: list[tuple[str, bool]] = []

    def execute(self, proposal: ActionProposal, *, confirmed: bool = False) -> ExecutionResult:
        self.calls.append((proposal.action_type, confirmed))
        return ExecutionResult(
            proposal_id=proposal.id,
            action_type=proposal.action_type,
            status=ExecutionStatus.SUCCEEDED,
            output={"undo_proposal": _undo_proposal()} if proposal.action_type == "shopping_list_add" else {},
        )


def test_broker_journals_successful_undo_proposal(tmp_path: Path) -> None:
    journal = tmp_path / "undo.jsonl"
    executor = FakeExecutor()
    broker = ActionBroker(task_id="task-1", journal_path=journal, executor=executor)

    result = broker.execute(_proposal(), confirmed=True)

    assert result.status is ExecutionStatus.SUCCEEDED
    rows = [json.loads(line) for line in journal.read_text(encoding="utf-8").splitlines()]
    assert rows[-1]["kind"] == "record"
    assert rows[-1]["task_id"] == "task-1"
    assert rows[-1]["undo_proposal"]["action_type"] == "shopping_list_undo_add"


def test_broker_rehydrates_compensation_after_process_restart(tmp_path: Path) -> None:
    journal = tmp_path / "undo.jsonl"
    first = FakeExecutor()
    ActionBroker(task_id="task-1", journal_path=journal, executor=first).execute(_proposal(), confirmed=True)

    second = FakeExecutor()
    restarted = ActionBroker(task_id="task-1", journal_path=journal, executor=second)

    restored = restarted.undo()

    assert restored.action_id == "write-1"
    assert second.calls == [("shopping_list_undo_add", True)]
    rows = [json.loads(line) for line in journal.read_text(encoding="utf-8").splitlines()]
    assert rows[-1] == {"kind": "undone", "task_id": "task-1", "action_id": "write-1"}


def test_action_bridge_routes_durable_undo_operation(monkeypatch) -> None:
    calls: list[str | None] = []

    class FakeCompensation:
        action_id = "write-1"
        tool_name = "shopping_list_add"

    class FakeBroker:
        def __init__(self, *, task_id: str) -> None:
            assert task_id == "task-1"

        def undo(self, action_id=None):
            calls.append(action_id)
            return FakeCompensation()

    monkeypatch.setattr(action_bridge, "ActionBroker", FakeBroker)
    output, exit_code = action_bridge.process_payload({
        "operation": "undo",
        "taskId": "task-1",
        "actionId": "write-1",
    })
    assert exit_code == 0
    assert output["ok"] is True
    assert output["undoneActionId"] == "write-1"
    assert calls == ["write-1"]
