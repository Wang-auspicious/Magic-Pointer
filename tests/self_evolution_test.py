"""Hermes-style background learning with a stricter candidate boundary."""

from __future__ import annotations

import json
import threading
import time
from pathlib import Path

import pytest

from app.self_evolution import (
    CandidateConflictError,
    CandidatePermissionError,
    LearningCandidateStore,
    SessionLearningReviewer,
)


def test_background_proposal_cannot_write_or_target_core_files(tmp_path: Path) -> None:
    store = LearningCandidateStore(tmp_path)
    target = tmp_path / "learning" / "MEMORY.md"

    candidate = store.propose(
        session_id="s1",
        kind="memory",
        target="learning/MEMORY.md",
        proposed_content="用户偏好简洁回答。\n",
        rationale="用户明确纠正了回答风格",
    )

    assert candidate.status == "pending"
    assert not target.exists()
    assert "+用户偏好简洁回答。" in store.diff(candidate.id)
    for illegal in (
        "app/agent_runtime/loop.py",
        "../outside.txt",
        str((tmp_path / "absolute.txt").resolve()),
    ):
        with pytest.raises(CandidatePermissionError):
            store.propose(
                session_id="s1",
                kind="skill",
                target=illegal,
                proposed_content="bad",
                rationale="bad",
            )


def test_apply_requires_user_approval_and_supports_exact_rollback(tmp_path: Path) -> None:
    target = tmp_path / "skills" / "desktop-reading" / "SKILL.md"
    target.parent.mkdir(parents=True)
    target.write_text("old\n", encoding="utf-8")
    store = LearningCandidateStore(tmp_path)
    candidate = store.propose(
        session_id="s1",
        kind="skill",
        target="skills/desktop-reading/SKILL.md",
        proposed_content="new\n",
        rationale="capture a durable reading technique",
    )

    with pytest.raises(CandidatePermissionError, match="user approval"):
        store.apply(candidate.id, approved_by="background_agent")
    applied = store.apply(candidate.id, approved_by="user")

    assert applied.status == "applied"
    assert target.read_text(encoding="utf-8") == "new\n"
    assert Path(applied.backup_path).read_text(encoding="utf-8") == "old\n"
    audit = [json.loads(line) for line in store.audit_path.read_text(encoding="utf-8").splitlines()]
    assert audit[-1]["action"] == "applied"
    assert audit[-1]["approvedBy"] == "user"

    rolled_back = store.rollback(candidate.id, approved_by="user")
    assert rolled_back.status == "rolled_back"
    assert target.read_text(encoding="utf-8") == "old\n"


def test_apply_fails_if_target_changed_since_review(tmp_path: Path) -> None:
    target = tmp_path / "plugins" / "demo" / "plugin.py"
    target.parent.mkdir(parents=True)
    target.write_text("v1\n", encoding="utf-8")
    store = LearningCandidateStore(tmp_path)
    candidate = store.propose(
        session_id="s1",
        kind="plugin",
        target="plugins/demo/plugin.py",
        proposed_content="v2\n",
        rationale="improve provider behavior",
    )
    target.write_text("user edit\n", encoding="utf-8")

    with pytest.raises(CandidateConflictError, match="changed"):
        store.apply(candidate.id, approved_by="user")

    assert target.read_text(encoding="utf-8") == "user edit\n"


def test_reject_is_audited_and_never_changes_target(tmp_path: Path) -> None:
    store = LearningCandidateStore(tmp_path)
    candidate = store.propose(
        session_id="s1",
        kind="memory",
        target="learning/MEMORY.md",
        proposed_content="candidate",
        rationale="possible preference",
    )

    rejected = store.reject(candidate.id, approved_by="user", reason="not durable")

    assert rejected.status == "rejected"
    assert not (tmp_path / "learning" / "MEMORY.md").exists()
    assert "not durable" in rejected.decision_reason


def test_reviewer_accepts_only_bounded_structured_candidates(tmp_path: Path) -> None:
    store = LearningCandidateStore(tmp_path)

    def model(_digest: dict) -> list[dict]:
        return [
            {
                "kind": "memory",
                "target": "learning/MEMORY.md",
                "proposedContent": "用户要求先把底层做好。\n",
                "rationale": "durable workflow preference",
            },
            {
                "kind": "core",
                "target": "app/agent_runtime/loop.py",
                "proposedContent": "rewrite core",
                "rationale": "unsafe",
            },
            {
                "kind": "skill",
                "target": "skills/transient/SKILL.md",
                "proposedContent": "x" * 300_000,
                "rationale": "oversized",
            },
        ]

    reviewer = SessionLearningReviewer(store, model, max_candidates=3, max_content_chars=20_000)
    created, warnings = reviewer.review_digest(
        {
            "sessionId": "s1",
            "terminalReason": "completed",
            "messages": [{"role": "user", "content": "先把底层做好"}],
        }
    )

    assert [candidate.target for candidate in created] == ["learning/MEMORY.md"]
    assert len(warnings) == 2
    assert store.list(status="pending") == created


def test_candidate_deduplicates_same_pending_content(tmp_path: Path) -> None:
    store = LearningCandidateStore(tmp_path)
    first = store.propose(
        session_id="s1",
        kind="memory",
        target="learning/MEMORY.md",
        proposed_content="same",
        rationale="first",
    )
    second = store.propose(
        session_id="s2",
        kind="memory",
        target="learning/MEMORY.md",
        proposed_content="same",
        rationale="second",
    )

    assert second.id == first.id
    assert len(store.list(status="pending")) == 1


def test_apply_rejects_tampered_candidate_payload(tmp_path: Path) -> None:
    store = LearningCandidateStore(tmp_path)
    candidate = store.propose(
        session_id="s1",
        kind="memory",
        target="learning/MEMORY.md",
        proposed_content="reviewed\n",
        rationale="durable preference",
    )
    record_path = store.candidates_dir / f"{candidate.id}.json"
    payload = json.loads(record_path.read_text(encoding="utf-8"))
    payload["proposed_content"] = "tampered\n"
    record_path.write_text(json.dumps(payload), encoding="utf-8")

    with pytest.raises(CandidateConflictError, match="integrity"):
        store.apply(candidate.id, approved_by="user")

    assert not (tmp_path / "learning" / "MEMORY.md").exists()


def test_rollback_rejects_tampered_backup(tmp_path: Path) -> None:
    target = tmp_path / "skills" / "safe" / "SKILL.md"
    target.parent.mkdir(parents=True)
    target.write_text("old\n", encoding="utf-8")
    store = LearningCandidateStore(tmp_path)
    candidate = store.propose(
        session_id="s1",
        kind="skill",
        target="skills/safe/SKILL.md",
        proposed_content="new\n",
        rationale="durable technique",
    )
    applied = store.apply(candidate.id, approved_by="user")
    Path(applied.backup_path).write_text("tampered backup\n", encoding="utf-8")

    with pytest.raises(CandidateConflictError, match="backup.*integrity"):
        store.rollback(candidate.id, approved_by="user")

    assert target.read_text(encoding="utf-8") == "new\n"


def test_reproposal_preserves_the_previous_decision_record(tmp_path: Path) -> None:
    store = LearningCandidateStore(tmp_path)
    first = store.propose(
        session_id="s1",
        kind="memory",
        target="learning/MEMORY.md",
        proposed_content="same proposal\n",
        rationale="first review",
    )
    store.reject(first.id, approved_by="user", reason="not yet")

    second = store.propose(
        session_id="s2",
        kind="memory",
        target="learning/MEMORY.md",
        proposed_content="same proposal\n",
        rationale="new evidence",
    )

    assert second.id != first.id
    assert store.get(first.id).status == "rejected"
    assert store.get(second.id).status == "pending"
    assert len(store.list()) == 2


def test_concurrent_candidate_decision_has_exactly_one_winner(tmp_path: Path) -> None:
    creator = LearningCandidateStore(tmp_path)
    candidate = creator.propose(
        session_id="s1",
        kind="memory",
        target="learning/MEMORY.md",
        proposed_content="candidate\n",
        rationale="durable preference",
    )
    stores = [LearningCandidateStore(tmp_path), LearningCandidateStore(tmp_path)]
    for store in stores:
        original_get = store.get

        def slow_get(candidate_id, *, _get=original_get):
            value = _get(candidate_id)
            time.sleep(0.05)
            return value

        store.get = slow_get  # type: ignore[method-assign]

    start = threading.Barrier(3)
    outcomes: list[str] = []

    def decide(store):
        start.wait()
        try:
            store.reject(candidate.id, approved_by="user", reason="no")
            outcomes.append("rejected")
        except CandidateConflictError:
            outcomes.append("conflict")

    threads = [threading.Thread(target=decide, args=(store,)) for store in stores]
    for thread in threads:
        thread.start()
    start.wait()
    for thread in threads:
        thread.join(timeout=2)

    assert sorted(outcomes) == ["conflict", "rejected"]
    audit = [
        json.loads(line)
        for line in creator.audit_path.read_text(encoding="utf-8").splitlines()
    ]
    assert [row["action"] for row in audit].count("rejected") == 1
