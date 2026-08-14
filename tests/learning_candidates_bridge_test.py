"""User-controlled API for reviewing background learning candidates."""

from __future__ import annotations

from pathlib import Path
from tempfile import TemporaryDirectory

import pytest

from app.self_evolution.candidates import LearningCandidateStore
from scripts.learning_candidates_bridge import handle_request


def test_candidate_bridge_lists_diffs_and_requires_explicit_apply() -> None:
    with TemporaryDirectory(prefix="mp-learning-") as directory:
        _exercise_candidate_bridge(Path(directory))


def _exercise_candidate_bridge(tmp_path: Path) -> None:
    store = LearningCandidateStore(tmp_path)
    candidate = store.propose(
        session_id="session-1",
        kind="memory",
        target="learning/MEMORY.md",
        proposed_content="# Memory\n\nPrefer concise answers.\n",
        rationale="user corrected answer length repeatedly",
    )

    listed = handle_request(
        {"action": "list", "status": "pending"}, user_root=tmp_path
    )
    assert [item["id"] for item in listed["candidates"]] == [candidate.id]
    assert "proposed_content" not in listed["candidates"][0]

    detail = handle_request(
        {"action": "get", "candidateId": candidate.id}, user_root=tmp_path
    )
    assert "Prefer concise answers." in detail["diff"]

    with pytest.raises(PermissionError, match="explicit user approval"):
        handle_request(
            {"action": "apply", "candidateId": candidate.id},
            user_root=tmp_path,
        )

    applied = handle_request(
        {
            "action": "apply",
            "candidateId": candidate.id,
            "userApproved": True,
        },
        user_root=tmp_path,
    )
    assert applied["candidate"]["status"] == "applied"
    assert (tmp_path / "learning" / "MEMORY.md").read_text(encoding="utf-8") == (
        "# Memory\n\nPrefer concise answers.\n"
    )

    rolled_back = handle_request(
        {
            "action": "rollback",
            "candidateId": candidate.id,
            "userApproved": True,
        },
        user_root=tmp_path,
    )
    assert rolled_back["candidate"]["status"] == "rolled_back"
    assert not (tmp_path / "learning" / "MEMORY.md").exists()
