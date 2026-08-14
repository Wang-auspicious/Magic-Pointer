"""Production background-review launch and structured-output contracts."""

from __future__ import annotations

from pathlib import Path

import pytest

from app.self_evolution.background import BackgroundReviewLauncher
from app.self_evolution.worker import (
    build_review_context,
    parse_candidate_response,
    write_review_result,
)


def test_launcher_starts_detached_worker_without_shell(tmp_path: Path) -> None:
    calls: list[tuple[list[str], dict]] = []

    class Process:
        pid = 4321

    def popen(argv, **kwargs):
        calls.append((list(argv), dict(kwargs)))
        return Process()

    launcher = BackgroundReviewLauncher(
        project_root=tmp_path,
        user_root=tmp_path / "user",
        session_root=tmp_path / "sessions",
        python_executable=Path("python.exe"),
        worker_script=tmp_path / "learning_review_worker.py",
        popen=popen,
        enabled=True,
    )

    result = launcher.launch("agent-session", terminal_reason="completed")

    assert result == {"launched": True, "pid": 4321, "sessionId": "agent-session"}
    argv, kwargs = calls[0]
    assert argv[0] == "python.exe"
    assert "agent-session" in argv
    assert kwargs["shell"] is False
    assert kwargs["cwd"] == str(tmp_path)


def test_launcher_skips_disabled_or_non_learning_terminals(tmp_path: Path) -> None:
    calls: list = []
    launcher = BackgroundReviewLauncher(
        project_root=tmp_path,
        user_root=tmp_path,
        session_root=tmp_path,
        popen=lambda *args, **kwargs: calls.append((args, kwargs)),
        enabled=False,
    )
    assert launcher.launch("s1", terminal_reason="completed")["launched"] is False

    enabled = BackgroundReviewLauncher(
        project_root=tmp_path,
        user_root=tmp_path,
        session_root=tmp_path,
        popen=lambda *args, **kwargs: calls.append((args, kwargs)),
        enabled=True,
    )
    assert enabled.launch("s1", terminal_reason="provider_unavailable")["launched"] is False
    assert calls == []


def test_candidate_response_parser_accepts_fenced_or_wrapped_json() -> None:
    fenced = """```json
[{"kind":"memory","target":"learning/MEMORY.md","proposedContent":"x","rationale":"r"}]
```"""
    wrapped = '{"candidates":[{"kind":"skill","target":"skills/a/SKILL.md","proposedContent":"y","rationale":"r"}]}'

    assert parse_candidate_response(fenced)[0]["kind"] == "memory"
    assert parse_candidate_response(wrapped)[0]["kind"] == "skill"
    assert parse_candidate_response("not json") == []


def test_review_context_includes_user_learning_files_but_is_bounded(tmp_path: Path) -> None:
    (tmp_path / "learning").mkdir()
    (tmp_path / "learning" / "MEMORY.md").write_text("preference", encoding="utf-8")
    skill = tmp_path / "skills" / "desktop"
    skill.mkdir(parents=True)
    (skill / "SKILL.md").write_text("skill body", encoding="utf-8")
    plugin = tmp_path / "plugins" / "demo"
    plugin.mkdir(parents=True)
    (plugin / "plugin.py").write_text("x" * 100_000, encoding="utf-8")

    context = build_review_context(
        tmp_path,
        {"sessionId": "s1", "messages": [{"role": "user", "content": "correct me"}]},
        max_chars=2_000,
    )

    assert "learning/MEMORY.md" in context
    assert "skills/desktop/SKILL.md" in context
    assert "plugins/demo/plugin.py" in context
    assert len(context) <= 2_000


def test_review_context_redacts_credentials_before_model_handoff(tmp_path: Path) -> None:
    plugin = tmp_path / "plugins" / "demo"
    plugin.mkdir(parents=True)
    (plugin / "plugin.py").write_text(
        'OPENAI_API_KEY = "sk-local-super-secret"\n'
        'Authorization: Bearer eyJhbGciOi-local-token\n',
        encoding="utf-8",
    )

    context = build_review_context(
        tmp_path,
        {
            "sessionId": "s1",
            "messages": [{
                "role": "user",
                "content": "password=hunter2 and token=ghp_secretvalue123",
            }],
        },
    )

    assert "sk-local-super-secret" not in context
    assert "eyJhbGciOi-local-token" not in context
    assert "hunter2" not in context
    assert "ghp_secretvalue123" not in context
    assert context.count("[REDACTED]") >= 4


def test_review_context_redacts_json_shaped_credentials(tmp_path: Path) -> None:
    """Red-team probe: the digest is json.dumps-ed, so ``{"api_key": "..."}``
    (with quotes between key and separator) used to bypass the assignment
    regex entirely and leak the value to the background model."""
    import json

    from app.self_evolution.worker import _redact_review_text

    digest = json.dumps(
        {
            "api_key": "hunter2secretvalue",
            "password": "p@ssw0rd",
            "aws": "Token AKIAIOSFODNN7EXAMPLE",
        },
        ensure_ascii=False,
    )
    redacted = _redact_review_text(digest)
    assert "hunter2secretvalue" not in redacted
    assert "p@ssw0rd" not in redacted
    assert "AKIAIOSFODNN7EXAMPLE" not in redacted
    assert redacted.count("[REDACTED]") >= 3


def test_review_result_rejects_session_id_path_traversal(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="session id"):
        write_review_result(tmp_path, "../escape", {"ok": False})

    assert not (tmp_path / "escape.json").exists()
