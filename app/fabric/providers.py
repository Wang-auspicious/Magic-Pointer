from __future__ import annotations

import re
import shutil
import subprocess
from dataclasses import dataclass
from typing import Callable


@dataclass(frozen=True)
class AgentAvailability:
    id: str
    name: str
    available: bool
    executable: str | None
    version: str | None
    protocols: tuple[str, ...]
    reason: str | None = None
    install_hint: str | None = None

    def to_dict(self) -> dict[str, object]:
        return {
            "id": self.id,
            "name": self.name,
            "available": self.available,
            "executable": self.executable,
            "version": self.version,
            "protocols": list(self.protocols),
            "reason": self.reason,
            "installHint": self.install_hint,
        }


_PROVIDERS = (
    ("codex", "Codex", "codex", ("app-server", "exec-json"), "Install the OpenAI Codex CLI."),
    ("pi", "Pi", "pi", ("extension-hooks", "rpc-steer", "json"), "Install @earendil-works/pi-coding-agent."),
    ("claude", "Claude Code", "claude", ("user-prompt-hook", "stream-json"), "Install Claude Code."),
    ("gemini", "Gemini CLI", "gemini", ("before-agent-hook", "extension", "json"), "Install the Gemini CLI."),
    ("cursor", "Cursor Agent", "cursor-agent", ("headless-stream-json", "hooks-observe"), "Install Cursor Agent CLI."),
    ("opencode", "OpenCode", "opencode", ("plugin-hooks", "http-openapi"), "Install OpenCode."),
    ("aider", "Aider", "aider", ("message-file", "print"), "Install Aider."),
)


def _default_version_probe(path: str, args: tuple[str, ...]) -> str:
    completed = subprocess.run(
        [path, *args],
        capture_output=True,
        text=True,
        timeout=2.5,
        check=False,
        shell=False,
    )
    return (completed.stdout or completed.stderr or "").strip()


def _sanitize_version(value: str) -> str | None:
    first = str(value or "").splitlines()[0].strip()[:160]
    if not first:
        return None
    first = re.sub(r"(?i)(api[_ -]?key|token|secret)\s*=\s*\S+", r"\1=[redacted]", first)
    return first


class AgentProviderDiscovery:
    def __init__(
        self,
        *,
        which: Callable[[str], str | None] = shutil.which,
        version_probe: Callable[[str, tuple[str, ...]], str] = _default_version_probe,
    ) -> None:
        self.which = which
        self.version_probe = version_probe

    def discover_all(self) -> list[AgentAvailability]:
        discovered: list[AgentAvailability] = []
        for provider_id, name, command, protocols, hint in _PROVIDERS:
            executable = self.which(command)
            if not executable:
                discovered.append(AgentAvailability(
                    id=provider_id,
                    name=name,
                    available=False,
                    executable=None,
                    version=None,
                    protocols=protocols,
                    reason="executable_not_found",
                    install_hint=hint,
                ))
                continue
            try:
                version = _sanitize_version(self.version_probe(executable, ("--version",)))
                reason = None
            except Exception as exc:
                version = None
                reason = f"version_probe_failed:{type(exc).__name__}"
            discovered.append(AgentAvailability(
                id=provider_id,
                name=name,
                available=True,
                executable=str(executable),
                version=version,
                protocols=protocols,
                reason=reason,
                install_hint=None,
            ))
        return discovered
