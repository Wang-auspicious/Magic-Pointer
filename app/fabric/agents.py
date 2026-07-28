from __future__ import annotations

from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any


class AgentConnectorError(ValueError):
    pass


@dataclass(frozen=True)
class AgentRequest:
    provider: str
    prompt: str
    cwd: str
    attachments: tuple[str, ...] = ()
    permission: str = "read"
    session_id: str | None = None
    resume_token: str | None = None
    metadata: dict[str, Any] | None = None

    def to_dict(self) -> dict[str, Any]:
        value = asdict(self)
        value["attachments"] = list(self.attachments)
        return value

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "AgentRequest":
        return cls(
            provider=str(value.get("provider") or ""),
            prompt=str(value.get("prompt") or ""),
            cwd=str(value.get("cwd") or ""),
            attachments=tuple(str(item) for item in value.get("attachments") or []),
            permission=str(value.get("permission") or "read"),
            session_id=str(value.get("session_id") or "") or None,
            resume_token=str(value.get("resume_token") or "") or None,
            metadata=dict(value.get("metadata") or {}),
        )


@dataclass(frozen=True)
class AgentInvocation:
    argv: tuple[str, ...]
    stdin: str | None
    cwd: str
    protocol: str
    shell: bool = False
    submit: bool = False
    env: dict[str, str] | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "argv": list(self.argv),
            "stdin": self.stdin,
            "cwd": self.cwd,
            "protocol": self.protocol,
            "shell": self.shell,
            "submit": self.submit,
            "env": dict(self.env or {}),
        }

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "AgentInvocation":
        return cls(
            argv=tuple(str(item) for item in value.get("argv") or []),
            stdin=None if value.get("stdin") is None else str(value.get("stdin")),
            cwd=str(value.get("cwd") or ""),
            protocol=str(value.get("protocol") or "text"),
            shell=value.get("shell") is True,
            submit=value.get("submit") is True,
            env={str(key): str(item) for key, item in dict(value.get("env") or {}).items()},
        )


def _valid_cwd(value: str) -> str:
    path = Path(value).expanduser().resolve()
    if not path.is_dir():
        raise AgentConnectorError(f"agent cwd does not exist: {path}")
    return str(path)


class AgentConnectorRegistry:
    """Build argv/stdin contracts without a shell or prompt interpolation."""

    def build(
        self,
        request: AgentRequest,
        *,
        executable: str,
        profile: dict[str, Any] | None = None,
    ) -> AgentInvocation:
        provider = request.provider.casefold().strip()
        cwd = _valid_cwd(request.cwd)
        executable = str(executable or "").strip()
        if not executable:
            raise AgentConnectorError("agent executable is missing")
        if request.permission not in {"read", "write"}:
            raise AgentConnectorError("agent permission must be read or write")

        if provider == "codex":
            argv = [executable, "exec"]
            if request.permission == "read":
                argv.extend(["--sandbox", "read-only"])
            if request.session_id:
                argv.extend(["resume", "--json", "--skip-git-repo-check"])
            else:
                argv.extend(["--json", "--skip-git-repo-check"])
            for attachment in request.attachments:
                if Path(attachment).is_file():
                    argv.extend(["--image", str(Path(attachment).resolve())])
            if request.session_id:
                argv.extend([request.resume_token or request.session_id, "-"])
            else:
                argv.append("-")
            return AgentInvocation(tuple(argv), request.prompt, cwd, "jsonl")

        if provider == "pi":
            argv = [executable, "--mode", "json", "--print"]
            if request.session_id:
                argv.extend(["--session", request.resume_token or request.session_id])
            else:
                argv.append("--no-session")
            if request.permission == "read":
                argv.extend(["--tools", "read"])
            return AgentInvocation(tuple(argv), request.prompt, cwd, "json")

        if provider == "claude":
            argv = [executable, "-p", "--verbose", "--output-format", "stream-json", "--input-format", "text"]
            if request.session_id:
                argv.extend(["--resume", request.session_id])
            if request.permission == "read":
                argv.extend(["--permission-mode", "plan"])
            return AgentInvocation(tuple(argv), request.prompt, cwd, "jsonl")

        if provider == "gemini":
            argv = [executable, "-p", "", "--output-format", "json"]
            if request.permission == "read":
                argv.extend(["--approval-mode", "plan"])
            if request.session_id:
                argv.extend(["--resume", request.resume_token or request.session_id])
            return AgentInvocation(tuple(argv), request.prompt, cwd, "json")

        if provider == "cursor":
            argv = [executable, "-p", "--output-format", "stream-json"]
            if request.permission == "write":
                argv.append("--force")
            if request.session_id:
                argv.append(f"--resume={request.session_id}")
            return AgentInvocation(tuple(argv), request.prompt, cwd, "jsonl")

        if provider == "opencode":
            argv = [executable, "run", "--format", "json"]
            if request.session_id:
                argv.extend(["--session", request.session_id])
            return AgentInvocation(tuple(argv), request.prompt, cwd, "jsonl")

        if provider == "aider":
            argv = [
                executable,
                "--message-file",
                "{PROMPT_FILE}",
                "--no-auto-commits",
                "--no-dirty-commits",
            ]
            if request.permission == "read":
                argv.append("--dry-run")
            return AgentInvocation(tuple(argv), None, cwd, "text")

        if provider == "generic":
            value = dict(profile or {})
            if isinstance(value.get("command"), str):
                raise AgentConnectorError("generic profile command strings are unsafe; use argv")
            argv_value = value.get("argv")
            if not isinstance(argv_value, list) or not argv_value or not all(isinstance(item, str) for item in argv_value):
                raise AgentConnectorError("generic profile requires a non-empty argv list")
            if any("{prompt}" in item.casefold() for item in argv_value):
                raise AgentConnectorError("generic argv cannot interpolate prompt text; use stdin")
            return AgentInvocation(
                tuple(argv_value),
                request.prompt,
                cwd,
                str(value.get("protocol") or "text"),
            )

        raise AgentConnectorError(f"unsupported provider: {provider}")

    def build_rpc_command(self, request: AgentRequest, *, executable: str) -> AgentInvocation:
        if request.provider.casefold() != "pi":
            raise AgentConnectorError("RPC command is only defined for Pi")
        cwd = _valid_cwd(request.cwd)
        argv = [executable, "--mode", "rpc"]
        if request.session_id:
            argv.extend(["--session", request.resume_token or request.session_id])
        else:
            argv.append("--no-session")
        return AgentInvocation(tuple(argv), None, cwd, "jsonl-rpc")

    def build_app_server_command(self, request: AgentRequest, *, executable: str) -> AgentInvocation:
        if request.provider.casefold() != "codex":
            raise AgentConnectorError("app-server command is only defined for Codex")
        return AgentInvocation((executable, "app-server"), None, _valid_cwd(request.cwd), "jsonl-app-server")
