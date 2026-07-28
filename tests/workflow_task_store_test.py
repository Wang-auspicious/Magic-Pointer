from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.fabric.workflow_task_store import WorkflowTaskError, WorkflowTaskStore


def _plan(*, plan_id: str = "plan-1", key: str = "idem-1", confirmation: bool = True) -> dict:
    return {
        "id": plan_id,
        "recipeId": "agent.handoff",
        "command": "fix this",
        "risk": "external_send",
        "provider": "agent.task",
        "objectIds": ["obj-1"],
        "parameters": {},
        "preview": {"title": "Agent handoff"},
        "requiresConfirmation": confirmation,
        "idempotencyKey": key,
        "integrityToken": "signed-token",
    }


def test_cli_and_gui_resume_same_task_and_approval_state(tmp_path: Path) -> None:
    store = WorkflowTaskStore(tmp_path)
    created = store.create(_plan(), surface="cli")
    opened = store.get(created["taskId"], surface="gui")

    assert opened["taskId"] == created["taskId"]
    assert opened["status"] == "approval_required"
    assert opened["approvalState"] == "pending"
    assert opened["surfaceHistory"] == ["cli", "gui"]

    approved = store.approve(created["taskId"], surface="gui")
    resumed = store.get(created["taskId"], surface="cli")

    assert approved["approvalState"] == "approved"
    assert resumed["approvalState"] == "approved"
    assert resumed["status"] == "ready"
    assert resumed["taskId"] == created["taskId"]


def test_execution_claim_prevents_duplicate_run_and_reuses_terminal_receipt(tmp_path: Path) -> None:
    store = WorkflowTaskStore(tmp_path)
    task = store.create(_plan(confirmation=False), surface="gui")

    first = store.claim_execution(task["taskId"], surface="gui")
    second = store.claim_execution(task["taskId"], surface="cli")

    assert first["claimed"] is True
    assert first["claimId"]
    assert second["claimed"] is False
    assert second["reason"] == "execution_in_progress"
    receipt = {"id": "receipt-1", "status": "succeeded", "verified": True, "output": {"artifact": "one.md"}}
    completed = store.complete_execution(
        task["taskId"],
        claim_id=first["claimId"],
        receipt=receipt,
        surface="cli",
    )
    reused = store.claim_execution(task["taskId"], surface="gui")

    assert completed["receiptStatus"] == "succeeded"
    assert reused["claimed"] is False
    assert reused["reused"] is True
    assert reused["receipt"] == receipt


def test_pending_approval_cannot_claim_execution(tmp_path: Path) -> None:
    store = WorkflowTaskStore(tmp_path)
    task = store.create(_plan(confirmation=True), surface="cli")

    claim = store.claim_execution(task["taskId"], surface="gui")

    assert claim["claimed"] is False
    assert claim["reason"] == "approval_required"
    assert claim["task"]["approvalState"] == "pending"


def test_idempotency_key_reuses_existing_task_instead_of_creating_duplicate(tmp_path: Path) -> None:
    store = WorkflowTaskStore(tmp_path)
    first = store.create(_plan(plan_id="plan-a", key="same-key"), surface="cli")
    second = store.create(_plan(plan_id="plan-b", key="same-key"), surface="gui")

    assert second["taskId"] == first["taskId"]
    assert second["reused"] is True
    assert len(list(tmp_path.glob("*/task.json"))) == 1


def test_corrupt_workflow_state_fails_closed(tmp_path: Path) -> None:
    store = WorkflowTaskStore(tmp_path)
    task = store.create(_plan(), surface="cli")
    path = tmp_path / task["taskId"] / "task.json"
    path.write_text(json.dumps({"schemaVersion": 999, "taskId": task["taskId"]}), encoding="utf-8")

    with pytest.raises(WorkflowTaskError, match="invalid workflow task state"):
        store.get(task["taskId"], surface="gui")
