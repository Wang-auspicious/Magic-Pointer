from __future__ import annotations

from app.fabric.providers import AgentProviderDiscovery


def test_discovers_supported_agents_and_reports_missing_reasons() -> None:
    paths = {
        "codex": r"C:\bin\codex.exe",
        "pi": r"C:\bin\pi.cmd",
        "claude": r"C:\bin\claude.exe",
        "gemini": r"C:\bin\gemini.cmd",
    }
    discovery = AgentProviderDiscovery(
        which=lambda name: paths.get(name),
        version_probe=lambda _path, _args: "1.2.3",
    )
    providers = {item.id: item for item in discovery.discover_all()}

    assert set(providers) == {
        "codex",
        "pi",
        "claude",
        "gemini",
        "cursor",
        "opencode",
        "aider",
    }
    assert providers["codex"].available is True
    assert providers["pi"].protocols == ("extension-hooks", "rpc-steer", "json")
    assert providers["cursor"].available is False
    assert providers["cursor"].reason == "executable_not_found"
    assert providers["cursor"].install_hint


def test_discovery_never_includes_credentials_or_shell_commands() -> None:
    discovery = AgentProviderDiscovery(
        which=lambda name: f"/usr/bin/{name}",
        version_probe=lambda _path, _args: "tool 9.0\nAPI_KEY=secret",
    )
    for item in discovery.discover_all():
        assert "secret" not in (item.version or "")
        assert item.executable
        assert isinstance(item.protocols, tuple)
