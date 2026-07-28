from __future__ import annotations

import json
from pathlib import Path

from app.fabric.agent_sessions import AgentSessionRegistry


def _line(path: Path, value: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value) + "\n", encoding="utf-8")


def test_discovers_existing_sessions_without_exposing_transcript_content(tmp_path: Path) -> None:
    workspace = tmp_path / "repo"
    workspace.mkdir()
    codex = tmp_path / "codex"
    claude = tmp_path / "claude"
    gemini = tmp_path / "gemini"
    pi = tmp_path / "pi"
    _line(codex / "2026" / "07" / "27" / "rollout-codex-1.jsonl", {
        "type": "session_meta",
        "payload": {"id": "codex-1", "cwd": str(workspace), "timestamp": "2026-07-27T10:00:00Z"},
        "secretPrompt": "must never leave discovery",
    })
    _line(claude / "project" / "claude-1.jsonl", {
        "type": "user",
        "sessionId": "claude-1",
        "cwd": str(workspace),
        "message": "must never leave discovery",
    })
    project = gemini / "repo"
    (project / "chats").mkdir(parents=True)
    (project / ".project_root").write_text(str(workspace), encoding="utf-8")
    _line(project / "chats" / "session-gemini-1.jsonl", {
        "kind": "main",
        "sessionId": "gemini-1",
        "lastUpdated": "2026-07-27T11:00:00Z",
        "prompt": "must never leave discovery",
    })
    _line(pi / "repo" / "pi-1.jsonl", {
        "type": "session",
        "sessionId": "pi-1",
        "cwd": str(workspace),
        "updatedAt": "2026-07-27T12:00:00Z",
        "messages": ["must never leave discovery"],
    })

    registry = AgentSessionRegistry(
        codex_root=codex,
        claude_root=claude,
        gemini_root=gemini,
        pi_root=pi,
    )
    sessions = registry.discover(cwd=workspace)

    assert {item.provider for item in sessions} == {"codex", "claude", "gemini", "pi"}
    public = [item.to_dict() for item in sessions]
    assert {item["sessionId"] for item in public} == {"codex-1", "claude-1", "gemini-1", "pi-1"}
    serialized = json.dumps(public)
    assert "must never leave discovery" not in serialized
    assert all(item["cwdMatch"] == "strict" for item in public)


def test_resolve_requires_exact_existing_identity_and_enforces_cwd(tmp_path: Path) -> None:
    workspace = tmp_path / "repo"
    other = tmp_path / "other"
    workspace.mkdir()
    other.mkdir()
    codex = tmp_path / "codex"
    _line(codex / "rollout.jsonl", {
        "type": "session_meta",
        "payload": {"id": "existing", "cwd": str(workspace), "timestamp": "2026-07-27T10:00:00Z"},
    })
    registry = AgentSessionRegistry(codex_root=codex, claude_root=tmp_path / "none1", gemini_root=tmp_path / "none2", pi_root=tmp_path / "none3")

    assert registry.resolve("codex", "existing", cwd=workspace, cwd_match="strict").session_id == "existing"
    assert registry.resolve("codex", "missing", cwd=workspace, cwd_match="strict") is None
    assert registry.resolve("codex", "existing", cwd=other, cwd_match="strict") is None


def test_auto_select_is_fail_closed_when_more_than_one_session_matches(tmp_path: Path) -> None:
    workspace = tmp_path / "repo"
    workspace.mkdir()
    codex = tmp_path / "codex"
    for index in (1, 2):
        _line(codex / f"rollout-{index}.jsonl", {
            "type": "session_meta",
            "payload": {"id": f"session-{index}", "cwd": str(workspace), "timestamp": f"2026-07-27T10:0{index}:00Z"},
        })
    registry = AgentSessionRegistry(codex_root=codex, claude_root=tmp_path / "none1", gemini_root=tmp_path / "none2", pi_root=tmp_path / "none3")

    assert registry.unique("codex", cwd=workspace, cwd_match="strict") is None


def test_codex_child_agent_sessions_are_not_offered_for_direct_resume(tmp_path: Path) -> None:
    workspace = tmp_path / "repo"
    workspace.mkdir()
    codex = tmp_path / "codex"
    _line(codex / "child.jsonl", {
        "type": "session_meta",
        "payload": {
            "id": "child-session",
            "cwd": str(workspace),
            "source": {"subagent": {"thread_spawn": {"parent_thread_id": "parent"}}},
        },
    })
    _line(codex / "main.jsonl", {
        "type": "session_meta",
        "payload": {"id": "main-session", "cwd": str(workspace), "source": "vscode"},
    })
    registry = AgentSessionRegistry(codex_root=codex, claude_root=tmp_path / "none1", gemini_root=tmp_path / "none2", pi_root=tmp_path / "none3")

    assert [item.session_id for item in registry.discover(provider="codex", cwd=workspace)] == ["main-session"]
