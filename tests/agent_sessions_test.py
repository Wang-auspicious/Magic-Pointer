from __future__ import annotations

import ctypes
import json
from pathlib import Path
from typing import Any

from app.fabric import agent_sessions
from app.fabric.agent_sessions import AgentSessionRegistry


def _line(path: Path, value: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value) + "\n", encoding="utf-8")


def _lines(path: Path, *values: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(value) + "\n" for value in values), encoding="utf-8")


def _registry(tmp_path: Path, **roots: Path) -> AgentSessionRegistry:
    return AgentSessionRegistry(
        codex_root=roots.get("codex", tmp_path / "missing-codex"),
        claude_root=roots.get("claude", tmp_path / "missing-claude"),
        gemini_root=roots.get("gemini", tmp_path / "missing-gemini"),
        pi_root=roots.get("pi", tmp_path / "missing-pi"),
    )


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
        "type": "assistant",
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


def test_discovers_real_provider_title_metadata_and_preserves_session_contract(tmp_path: Path) -> None:
    workspace = tmp_path / "repo"
    workspace.mkdir()
    codex_home = tmp_path / ".codex"
    codex = codex_home / "sessions"
    claude = tmp_path / "claude"
    gemini = tmp_path / "gemini"
    pi = tmp_path / "pi"
    _line(codex / "rollout.jsonl", {
        "type": "session_meta",
        "payload": {"id": "codex-title-1", "cwd": str(workspace)},
    })
    _line(codex_home / "session_index.jsonl", {
        "id": "codex-title-1",
        "thread_name": "Checkout regression",
        "updated_at": "2026-08-02T10:00:00Z",
    })
    _lines(
        claude / "project" / "claude-title-1.jsonl",
        {
            "type": "user",
            "sessionId": "claude-title-1",
            "cwd": str(workspace),
            "message": {"role": "user", "content": "private claude prompt"},
        },
        {"type": "ai-title", "sessionId": "claude-title-1", "aiTitle": "Billing review"},
    )
    project = gemini / "repo"
    (project / "chats").mkdir(parents=True)
    (project / ".project_root").write_text(str(workspace), encoding="utf-8")
    _lines(
        project / "chats" / "session-gemini-title-1.jsonl",
        {
            "kind": "main",
            "sessionId": "gemini-title-1",
            "projectHash": "repo",
            "startTime": "2026-08-02T10:00:00Z",
            "lastUpdated": "2026-08-02T10:01:00Z",
        },
        {"$set": {"summary": "Release risk map"}},
        {"id": "user-1", "type": "user", "content": "private gemini prompt"},
    )
    _lines(
        pi / "repo" / "pi-title-1.jsonl",
        {"type": "session", "version": 3, "id": "pi-title-1", "cwd": str(workspace)},
        {"type": "session_info", "id": "info-1", "name": "Ticket investigation"},
        {"type": "message", "message": {"role": "user", "content": "private pi prompt"}},
    )

    sessions = _registry(tmp_path, codex=codex, claude=claude, gemini=gemini, pi=pi).discover(cwd=workspace)
    public = {item.provider: item.to_dict() for item in sessions}

    assert {provider: item["title"] for provider, item in public.items()} == {
        "codex": "Checkout regression",
        "claude": "Billing review",
        "gemini": "Release risk map",
        "pi": "Ticket investigation",
    }
    old_fields = {
        "provider", "sessionId", "cwd", "lastActiveAt", "state", "transport",
        "source", "resumeToken", "cwdMatch",
    }
    assert all(old_fields <= set(item) for item in public.values())
    serialized = json.dumps(public)
    assert "private claude prompt" not in serialized
    assert "private gemini prompt" not in serialized
    assert "private pi prompt" not in serialized


def test_session_titles_are_clean_bounded_and_have_stable_body_free_fallbacks(tmp_path: Path) -> None:
    workspace = tmp_path / "repo"
    workspace.mkdir()
    claude = tmp_path / "claude"
    codex = tmp_path / "codex"
    unsafe_title = "  Unicode 🚀\x00\n\t roadmap  " + ("界" * 120)
    _lines(
        claude / "project" / "claude-clean.jsonl",
        {"type": "user", "sessionId": "claude-clean", "cwd": str(workspace)},
        {"type": "ai-title", "sessionId": "claude-clean", "aiTitle": unsafe_title},
    )
    _line(codex / "rollout.jsonl", {
        "type": "session_meta",
        "payload": {"id": "abcdef1234567890", "cwd": str(workspace)},
        "prompt": "body must not become fallback",
    })
    registry = _registry(tmp_path, codex=codex, claude=claude)

    public = {item.provider: item.to_dict() for item in registry.discover(cwd=workspace)}

    clean = public["claude"]["title"]
    assert clean.startswith("Unicode 🚀 roadmap ")
    assert len(clean) <= 80
    assert not any(ord(character) < 32 or ord(character) == 127 for character in clean)
    assert public["codex"]["title"] == "Codex · repo · abcdef12"
    assert "body must not become fallback" not in json.dumps(public)
    assert public["codex"]["title"] == {
        item.provider: item.to_dict() for item in registry.discover(cwd=workspace)
    }["codex"]["title"]


def test_uses_only_a_bounded_first_user_message_when_title_metadata_is_missing(tmp_path: Path) -> None:
    workspace = tmp_path / "repo"
    workspace.mkdir()
    gemini = tmp_path / "gemini"
    project = gemini / "repo"
    (project / "chats").mkdir(parents=True)
    (project / ".project_root").write_text(str(workspace), encoding="utf-8")
    first_user = "Investigate the Unicode checkout failure " + ("细节" * 80)
    _lines(
        project / "chats" / "session-gemini-user-title.jsonl",
        {
            "kind": "main",
            "sessionId": "gemini-user-title",
            "projectHash": "repo",
            "startTime": "2026-08-02T10:00:00Z",
            "lastUpdated": "2026-08-02T10:01:00Z",
        },
        {"id": "user-1", "type": "user", "content": first_user},
        {"id": "assistant-1", "type": "gemini", "content": "assistant secret must stay private"},
    )

    session = _registry(tmp_path, gemini=gemini).discover(provider="gemini", cwd=workspace)[0].to_dict()

    assert session["title"].startswith("Investigate the Unicode checkout failure")
    assert len(session["title"]) <= 80
    assert first_user not in session["title"]
    assert "assistant secret" not in json.dumps(session)


def test_session_metadata_reads_are_byte_bounded_even_with_multi_megabyte_lines(
    tmp_path: Path,
    monkeypatch: Any,
) -> None:
    workspace = tmp_path / "repo"
    workspace.mkdir()
    pi = tmp_path / "pi"
    path = pi / "repo" / "bounded.jsonl"
    _lines(
        path,
        {"type": "session", "version": 3, "id": "pi-bounded", "cwd": str(workspace)},
        {"type": "session_info", "id": "info-1", "name": "Bounded metadata"},
        {"type": "message", "message": {"role": "assistant", "content": "x" * 2_000_000}},
    )
    original_open = Path.open
    read_sizes: list[int] = []

    class _GuardedReader:
        def __init__(self, handle: Any) -> None:
            self.handle = handle

        def __enter__(self) -> "_GuardedReader":
            self.handle.__enter__()
            return self

        def __exit__(self, *args: object) -> object:
            return self.handle.__exit__(*args)

        def __getattr__(self, name: str) -> Any:
            return getattr(self.handle, name)

        def read(self, size: int = -1) -> Any:
            assert 0 <= size <= 128_000
            read_sizes.append(size)
            return self.handle.read(size)

        def readline(self, *_args: object, **_kwargs: object) -> Any:
            raise AssertionError("session discovery must not use unbounded readline()")

    def guarded_open(path_obj: Path, *args: object, **kwargs: object) -> Any:
        return _GuardedReader(original_open(path_obj, *args, **kwargs))

    monkeypatch.setattr(Path, "open", guarded_open)

    sessions = _registry(tmp_path, pi=pi).discover(provider="pi", cwd=workspace)

    assert sessions[0].to_dict()["title"] == "Bounded metadata"
    assert read_sizes
    assert sum(read_sizes) <= 128_000


def test_session_metadata_scan_stops_after_sixty_four_complete_lines(tmp_path: Path) -> None:
    workspace = tmp_path / "repo"
    workspace.mkdir()
    pi = tmp_path / "pi"
    path = pi / "repo" / "line-budget.jsonl"
    values: list[dict[str, object]] = [
        {"type": "session", "version": 3, "id": "pi-lines", "cwd": str(workspace)},
    ]
    values.extend({"type": "model_change", "id": f"change-{index}"} for index in range(63))
    values.append({"type": "session_info", "id": "too-late", "name": "Must not be scanned"})
    _lines(path, *values)

    session = _registry(tmp_path, pi=pi).discover(provider="pi", cwd=workspace)[0].to_dict()

    assert session["title"] == "Pi · repo · pi-lines"
    assert "Must not be scanned" not in json.dumps(session)


def test_active_only_returns_explicit_open_handle_sessions_without_history_backfill(tmp_path: Path) -> None:
    workspace = tmp_path / "repo"
    workspace.mkdir()
    codex = tmp_path / "codex"
    for name in ("active-a", "history", "active-b", "more-history"):
        _line(codex / f"{name}.jsonl", {
            "type": "session_meta",
            "payload": {"id": name, "cwd": str(workspace)},
        })
    active_paths = {codex / "active-a.jsonl", codex / "active-b.jsonl"}
    registry = AgentSessionRegistry(
        codex_root=codex,
        claude_root=tmp_path / "missing-claude",
        gemini_root=tmp_path / "missing-gemini",
        pi_root=tmp_path / "missing-pi",
        liveness_probe=lambda provider, path: (
            "open_handle" if provider == "codex" and path in active_paths else None
        ),
    )

    sessions = registry.discover(provider="codex", cwd=workspace, active_only=True, limit=5)

    assert {item.session_id for item in sessions} == {"active-a", "active-b"}
    assert len(sessions) == 2
    assert all(item.to_dict()["live"] is True for item in sessions)
    assert all(item.to_dict()["liveEvidence"] == "open_handle" for item in sessions)


def test_active_only_returns_empty_when_recent_files_have_no_live_evidence(tmp_path: Path) -> None:
    workspace = tmp_path / "repo"
    workspace.mkdir()
    codex = tmp_path / "codex"
    _line(codex / "recent-history.jsonl", {
        "type": "session_meta",
        "payload": {"id": "recent-history", "cwd": str(workspace)},
    })
    registry = AgentSessionRegistry(
        codex_root=codex,
        claude_root=tmp_path / "missing-claude",
        gemini_root=tmp_path / "missing-gemini",
        pi_root=tmp_path / "missing-pi",
        liveness_probe=lambda _provider, _path: None,
    )

    assert registry.discover(provider="codex", cwd=workspace, active_only=True) == []


def test_active_only_fails_closed_when_liveness_probe_raises(tmp_path: Path) -> None:
    workspace = tmp_path / "repo"
    workspace.mkdir()
    codex = tmp_path / "codex"
    _line(codex / "session.jsonl", {
        "type": "session_meta",
        "payload": {"id": "session", "cwd": str(workspace)},
    })

    def broken_probe(_provider: str, _path: Path) -> str | None:
        raise RuntimeError("probe failed")

    registry = AgentSessionRegistry(
        codex_root=codex,
        claude_root=tmp_path / "missing-claude",
        gemini_root=tmp_path / "missing-gemini",
        pi_root=tmp_path / "missing-pi",
        liveness_probe=broken_probe,
    )

    assert registry.discover(provider="codex", cwd=workspace, active_only=True) == []


def test_normal_discover_does_not_probe_or_add_live_fields(tmp_path: Path) -> None:
    workspace = tmp_path / "repo"
    workspace.mkdir()
    codex = tmp_path / "codex"
    _line(codex / "history.jsonl", {
        "type": "session_meta",
        "payload": {"id": "history", "cwd": str(workspace)},
    })

    def forbidden_probe(_provider: str, _path: Path) -> str | None:
        raise AssertionError("normal discovery must not run liveness probes")

    registry = AgentSessionRegistry(
        codex_root=codex,
        claude_root=tmp_path / "missing-claude",
        gemini_root=tmp_path / "missing-gemini",
        pi_root=tmp_path / "missing-pi",
        liveness_probe=forbidden_probe,
    )

    public = registry.discover(provider="codex", cwd=workspace)[0].to_dict()

    assert "live" not in public
    assert "liveEvidence" not in public
    assert public["sessionId"] == "history"


def test_win32_exclusive_read_uses_read_access_with_share_mode_zero(tmp_path: Path) -> None:
    class _Kernel32:
        def __init__(self) -> None:
            self.create_args: tuple[object, ...] = ()
            self.closed: object = None

        def CreateFileW(self, *args: object) -> int:
            self.create_args = args
            return 123

        def CloseHandle(self, handle: object) -> int:
            self.closed = handle
            return 1

    kernel32 = _Kernel32()

    opened, error = agent_sessions._win32_exclusive_read(
        tmp_path / "session.jsonl",
        kernel32=kernel32,
        get_last_error=lambda: 999,
    )

    assert opened is True
    assert error == 0
    assert kernel32.create_args[1] == 0x80000000
    assert kernel32.create_args[2] == 0
    assert kernel32.create_args[4] == 3
    assert kernel32.closed == 123


def test_windows_probe_accepts_only_sharing_conflicts(tmp_path: Path) -> None:
    path = tmp_path / "session.jsonl"

    def readable(_path: Path) -> bool:
        return True

    assert agent_sessions._windows_open_handle_evidence(
        path,
        readable=readable,
        exclusive_open=lambda _path: (False, 32),
    ) == "open_handle"
    assert agent_sessions._windows_open_handle_evidence(
        path,
        readable=readable,
        exclusive_open=lambda _path: (False, 33),
    ) == "open_handle"
    for error in (2, 3, 5, 87):
        assert agent_sessions._windows_open_handle_evidence(
            path,
            readable=readable,
            exclusive_open=lambda _path, error=error: (False, error),
        ) is None
    assert agent_sessions._windows_open_handle_evidence(
        path,
        readable=readable,
        exclusive_open=lambda _path: (True, 0),
    ) is None


def test_windows_probe_requires_ordinary_read_access(tmp_path: Path) -> None:
    def forbidden_exclusive_open(_path: Path) -> tuple[bool, int]:
        raise AssertionError("exclusive probe must not run for unreadable paths")

    assert agent_sessions._windows_open_handle_evidence(
        tmp_path / "missing.jsonl",
        readable=lambda _path: False,
        exclusive_open=forbidden_exclusive_open,
    ) is None


def test_win32_exclusive_read_reports_last_error_without_closing_invalid_handle(tmp_path: Path) -> None:
    class _Kernel32:
        def __init__(self) -> None:
            self.closed = False

        def CreateFileW(self, *_args: object) -> int:
            return ctypes.c_void_p(-1).value

        def CloseHandle(self, _handle: object) -> int:
            self.closed = True
            return 1

    kernel32 = _Kernel32()

    opened, error = agent_sessions._win32_exclusive_read(
        tmp_path / "session.jsonl",
        kernel32=kernel32,
        get_last_error=lambda: 32,
    )

    assert opened is False
    assert error == 32
    assert kernel32.closed is False


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
