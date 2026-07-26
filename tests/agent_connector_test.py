from __future__ import annotations

from pathlib import Path

import pytest

from app.fabric.agents import AgentConnectorError, AgentConnectorRegistry, AgentRequest


@pytest.mark.parametrize(
    ("provider", "expected"),
    [
        ("codex", ("exec", "--json")),
        ("pi", ("--mode", "json", "--print")),
        ("claude", ("-p", "--output-format", "stream-json")),
        ("gemini", ("-p", "--output-format", "json")),
        ("cursor", ("-p", "--output-format", "stream-json")),
        ("aider", ("--message-file", "{PROMPT_FILE}", "--no-auto-commits")),
    ],
)
def test_builds_safe_non_shell_invocations(provider: str, expected: tuple[str, ...], tmp_path: Path) -> None:
    request = AgentRequest(
        provider=provider,
        prompt='fix "this"; Remove-Item -Recurse C:\\',
        cwd=str(tmp_path),
        attachments=(str(tmp_path / "screen.png"),),
        permission="read",
    )
    invocation = AgentConnectorRegistry().build(
        request,
        executable=f"C:/bin/{provider}.exe",
    )
    joined = tuple(invocation.argv[1:])
    for token in expected:
        assert token in joined
    assert invocation.shell is False
    assert request.prompt not in invocation.argv
    assert "dangerously-skip-permissions" not in invocation.argv
    assert "--force" not in invocation.argv
    assert invocation.stdin == request.prompt or "{PROMPT_FILE}" in invocation.argv


def test_pi_and_codex_expose_rich_protocol_commands(tmp_path: Path) -> None:
    registry = AgentConnectorRegistry()
    request = AgentRequest(provider="pi", prompt="inspect", cwd=str(tmp_path))
    pi_rpc = registry.build_rpc_command(request, executable="pi")
    assert pi_rpc.argv == ("pi", "--mode", "rpc", "--no-session")
    assert pi_rpc.protocol == "jsonl-rpc"

    codex = registry.build_app_server_command(
        AgentRequest(provider="codex", prompt="inspect", cwd=str(tmp_path)),
        executable="codex",
    )
    assert codex.argv == ("codex", "app-server")
    assert codex.protocol == "jsonl-app-server"


def test_write_permission_is_explicit_and_never_implies_submission(tmp_path: Path) -> None:
    registry = AgentConnectorRegistry()
    read_cursor = registry.build(
        AgentRequest(provider="cursor", prompt="review", cwd=str(tmp_path), permission="read"),
        executable="cursor-agent",
    )
    write_cursor = registry.build(
        AgentRequest(provider="cursor", prompt="fix", cwd=str(tmp_path), permission="write"),
        executable="cursor-agent",
    )
    assert "--force" not in read_cursor.argv
    assert "--force" in write_cursor.argv
    assert write_cursor.submit is False


def test_generic_profile_requires_argv_and_rejects_shell_strings(tmp_path: Path) -> None:
    request = AgentRequest(provider="generic", prompt="inspect", cwd=str(tmp_path))
    with pytest.raises(AgentConnectorError):
        AgentConnectorRegistry().build(request, executable="tool", profile={"command": "tool --run {prompt}"})

    invocation = AgentConnectorRegistry().build(
        request,
        executable="tool",
        profile={"argv": ["tool", "--json", "-"], "protocol": "jsonl"},
    )
    assert invocation.argv == ("tool", "--json", "-")
    assert invocation.stdin == "inspect"


def test_unknown_provider_fails_closed(tmp_path: Path) -> None:
    with pytest.raises(AgentConnectorError, match="unsupported provider"):
        AgentConnectorRegistry().build(
            AgentRequest(provider="mystery", prompt="do it", cwd=str(tmp_path)),
            executable="mystery",
        )

