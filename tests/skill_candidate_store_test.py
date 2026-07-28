from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from app.fabric.agents import AgentInvocation, AgentRequest
from app.fabric.schema import OperationPlan, RiskLevel
from app.fabric.skill_candidates import SkillCandidateError, SkillCandidateStore
from app.fabric.task_store import AgentTaskStore


def _plan(index: int, *, secret: str = "private screen text") -> OperationPlan:
    return OperationPlan(
        id=f"plan-n16-{index}",
        recipe_id="agent.handoff",
        command=f"fix attempt {index}: {secret}",
        risk=RiskLevel.EXTERNAL_SEND,
        provider="agent.task",
        object_ids=(f"object-{index}",),
        parameters={
            "objects": [{
                "id": f"object-{index}",
                "kind": "screen_region",
                "label": secret,
                "content": secret,
                "source": {"app": "code.exe", "title": secret},
            }],
            "runtimeWorkspace": {"bindingState": "bound", "bindingRelation": "window_process"},
            "terminalEvidence": {"state": "resolved", "method": "uia:terminal-text-pattern"},
            "componentLink": {"state": "resolved", "method": "runtime-source"},
        },
        preview={"title": "Agent handoff"},
        requires_confirmation=True,
        idempotency_key=f"idem-n16-{index}",
        integrity_token="signed",
    )


def _success(index: int) -> dict:
    return {
        "id": f"receipt-n16-{index}",
        "status": "succeeded",
        "verified": True,
        "output": {},
        "verification": {"agentTask": "terminal_success"},
    }


def _make_candidate(store: SkillCandidateStore) -> dict:
    for index in range(3):
        store.observe_execution(_plan(index), _success(index))
    return store.list()[0]


def test_three_similar_successful_flows_create_readable_disabled_draft_without_content(tmp_path: Path) -> None:
    store = SkillCandidateStore(tmp_path)
    secret = "DO NOT STORE THIS SCREEN CONTENT"

    for index in range(2):
        result = store.observe_execution(_plan(index, secret=secret), _success(index))
        assert result["candidate"] is None
        assert result["progress"] == index + 1
    third = store.observe_execution(_plan(2, secret=secret), _success(2))

    candidate = third["candidate"]
    assert candidate["state"] == "candidate_disabled"
    assert candidate["enabled"] is False
    assert candidate["occurrenceCount"] == 3
    assert candidate["sourceReceiptIds"] == ["receipt-n16-0", "receipt-n16-1", "receipt-n16-2"]
    draft = store.draft(candidate["candidateId"])
    assert draft["content"].startswith("---\nname:")
    assert "description:" in draft["content"]
    assert "## Verification" in draft["content"]
    assert secret not in draft["content"]
    assert secret not in json.dumps(json.loads((tmp_path / "skill-candidates.json").read_text(encoding="utf-8")))


def test_duplicate_failed_and_unverified_flows_never_reach_threshold(tmp_path: Path) -> None:
    store = SkillCandidateStore(tmp_path)
    plan = _plan(0)
    store.observe_execution(plan, _success(0))
    store.observe_execution(plan, _success(0))
    store.observe_execution(_plan(1), {"id": "failed", "status": "failed", "verified": False, "output": {}})
    store.observe_execution(_plan(2), {"id": "unverified", "status": "succeeded", "verified": False, "output": {}})

    assert store.list() == []


def test_receipt_id_collision_fails_closed_instead_of_merging_observations(tmp_path: Path) -> None:
    store = SkillCandidateStore(tmp_path)
    store.observe_execution(_plan(0), _success(0))

    with pytest.raises(SkillCandidateError, match="receipt id collision"):
        store.observe_execution(_plan(1), _success(0))


def test_accepted_agent_flows_count_only_after_durable_task_success(tmp_path: Path) -> None:
    tasks = AgentTaskStore(
        tmp_path / "agent-tasks",
        spawn_worker=lambda _path: os.getpid(),
        process_alive=lambda _pid: True,
    )
    store = SkillCandidateStore(tmp_path)
    task_ids: list[str] = []
    for index in range(3):
        task = tasks.start(
            AgentRequest(provider="codex", prompt=f"fix {index}", cwd=str(tmp_path)),
            AgentInvocation(argv=("codex",), stdin=f"fix {index}", cwd=str(tmp_path), protocol="jsonl"),
        )
        task_ids.append(task["taskId"])
        store.observe_execution(_plan(index), {
            "id": f"receipt-n16-{index}",
            "status": "accepted",
            "verified": False,
            "output": {"taskId": task["taskId"]},
        })
    assert store.list() == []

    for task_id in task_ids:
        tasks.complete(task_id, exit_code=0, summary="done", output={})

    candidates = store.list()
    assert len(candidates) == 1
    assert candidates[0]["occurrenceCount"] == 3


def test_install_requires_review_confirmation_and_remains_disabled(tmp_path: Path) -> None:
    store = SkillCandidateStore(tmp_path)
    candidate = _make_candidate(store)

    with pytest.raises(SkillCandidateError, match="review is required"):
        store.install(candidate["candidateId"], confirmed=True)

    review = store.draft(candidate["candidateId"])
    with pytest.raises(SkillCandidateError, match="installation confirmation is required"):
        store.install(
            candidate["candidateId"],
            confirmed=True,
            review_token=review["reviewToken"],
        )
    preview = store.install(
        candidate["candidateId"],
        confirmed=False,
        review_token=review["reviewToken"],
    )
    assert preview["status"] == "confirmation_required"
    assert not (tmp_path / "managed-skills").exists()

    installed = store.install(
        candidate["candidateId"],
        confirmed=True,
        review_token=review["reviewToken"],
    )
    assert installed["status"] == "installed_disabled"
    assert installed["candidate"]["enabled"] is False
    path = Path(installed["installedPath"])
    assert path.exists()
    assert path.is_relative_to((tmp_path / "managed-skills").resolve())
    assert path.read_text(encoding="utf-8") == store.draft(candidate["candidateId"])["content"]


def test_tampered_draft_fails_closed_before_install(tmp_path: Path) -> None:
    store = SkillCandidateStore(tmp_path)
    candidate = _make_candidate(store)
    review = store.draft(candidate["candidateId"])
    Path(review["draftPath"]).write_text("tampered", encoding="utf-8")

    with pytest.raises(SkillCandidateError, match="digest mismatch"):
        store.install(candidate["candidateId"], confirmed=True, review_token=review["reviewToken"])
