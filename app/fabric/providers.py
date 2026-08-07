from __future__ import annotations

import re
import shutil
import subprocess
import threading
import time
from dataclasses import dataclass
from typing import Callable

PROBE_TIMEOUT_SECONDS = 2.0


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
    # Popen + kill-on-timeout instead of subprocess.run: on Windows, npm .cmd
    # shims spawn a node grandchild that keeps the pipes open, so run()'s
    # post-kill communicate() drain blocks for several extra seconds.
    process = subprocess.Popen(
        [path, *args],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        shell=False,
    )
    try:
        stdout, stderr = process.communicate(timeout=PROBE_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired:
        process.kill()
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            pass
        raise
    return (stdout or stderr or "").strip()


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
        located = [
            (provider_id, name, self.which(command), protocols, hint)
            for provider_id, name, command, protocols, hint in _PROVIDERS
        ]
        probed = self._probe_versions({
            provider_id: str(executable)
            for provider_id, _name, executable, _protocols, _hint in located
            if executable
        })
        discovered: list[AgentAvailability] = []
        for provider_id, name, executable, protocols, hint in located:
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
            version, reason = probed[provider_id]
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

    def _probe_versions(self, executables: dict[str, str]) -> dict[str, tuple[str | None, str | None]]:
        """Probe every executable concurrently under a hard wall-clock deadline.

        Returns {provider_id: (version, reason)}. A probe that hangs past the
        deadline yields (None, "version_probe_failed:TimeoutExpired") instead of
        blocking discovery; the executable's presence stays honestly reported.
        """
        boxes: dict[str, dict[str, object]] = {}
        threads: dict[str, threading.Thread] = {}
        for provider_id, executable in executables.items():
            box: dict[str, object] = {}

            def run(executable: str = executable, box: dict[str, object] = box) -> None:
                try:
                    box["value"] = self.version_probe(executable, ("--version",))
                except Exception as exc:
                    box["error"] = exc

            thread = threading.Thread(target=run, daemon=True, name=f"provider-probe-{provider_id}")
            thread.start()
            boxes[provider_id] = box
            threads[provider_id] = thread
        deadline = time.monotonic() + PROBE_TIMEOUT_SECONDS + 0.5
        results: dict[str, tuple[str | None, str | None]] = {}
        for provider_id, thread in threads.items():
            thread.join(max(0.0, deadline - time.monotonic()))
            box = boxes[provider_id]
            if thread.is_alive():
                results[provider_id] = (None, "version_probe_failed:TimeoutExpired")
            elif "error" in box:
                results[provider_id] = (None, f"version_probe_failed:{type(box['error']).__name__}")
            else:
                results[provider_id] = (_sanitize_version(str(box.get("value") or "")), None)
        return results
