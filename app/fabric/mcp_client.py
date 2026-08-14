"""The other half of MCP: use the servers the user already configured.

Magic Pointer is an MCP server — an agent can point it at the screen. The loop
only closes if the reverse is also true: the tools the user has already set up
elsewhere (their notes, their tracker, their database) should be available to a
command about something on screen, without configuring them a second time here.

This speaks the same stdio JSON-RPC dialect our own server does, from the client
side: spawn, initialize, list tools, call one. Deliberately minimal — no
sampling, no roots, no notifications. The value is "your tools are reachable",
and every line beyond that is surface area on a process we did not write.

Three rules that shape it:

  **A server that misbehaves must not take the command down.** Every call is
  bounded by a timeout and every failure is a value, not an exception. An MCP
  server is third-party code on the user's machine and it will hang one day.
  **Nothing is called without being asked for.** Discovery lists tools; calling
  one is a separate act. A tool named `delete_everything` must never be invoked
  as part of finding out that it exists.
  **The user's config is read, never written.** We are a guest in that file.
"""

from __future__ import annotations

import contextlib
import json
import os
import subprocess
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

PROTOCOL_VERSION = "2025-06-18"

# A server that has not answered in this long is not going to. The command that
# triggered this is on screen in a bubble; it cannot wait on someone else's
# process.
DEFAULT_TIMEOUT_S = 8.0
STARTUP_TIMEOUT_S = 12.0

# Tool descriptions go into a model prompt, so an enormous manifest is both a
# cost and a way for a third party to fill the context window.
MAX_TOOLS_PER_SERVER = 40
MAX_DESCRIPTION_CHARS = 400
MAX_RESPONSE_CHARS = 2_000_000
_KNOWN_TOOL_EFFECTS = frozenset({
    "read",
    "reversible_write",
    "local_irreversible",
    "external_send",
    "destructive",
    "purchase",
})


class McpClientError(RuntimeError):
    pass


@dataclass(frozen=True)
class McpTool:
    server: str
    name: str
    description: str
    input_schema: dict[str, Any] = field(default_factory=dict)
    annotations: dict[str, Any] = field(default_factory=dict)

    @property
    def qualified_name(self) -> str:
        """Namespaced, so two servers offering `search` stay distinguishable."""
        return f"{self.server}__{self.name}"

    def to_dict(self) -> dict[str, Any]:
        return {
            "server": self.server,
            "name": self.name,
            "qualifiedName": self.qualified_name,
            "description": self.description,
            "inputSchema": dict(self.input_schema),
            "annotations": dict(self.annotations),
        }


@dataclass(frozen=True)
class McpServerConfig:
    name: str
    command: str
    args: tuple[str, ...] = ()
    env: dict[str, str] = field(default_factory=dict)
    enabled: bool = True
    tool_effects: dict[str, str] = field(default_factory=dict)

    @staticmethod
    def from_dict(name: str, value: Any) -> McpServerConfig | None:
        if not isinstance(value, dict):
            return None
        command = str(value.get("command") or "").strip()
        if not command:
            return None
        args = tuple(str(item) for item in list(value.get("args") or []))
        env = {
            str(key): str(item)
            for key, item in dict(value.get("env") or {}).items()
            if str(key)
        }
        raw_tool_effects = value.get("toolEffects")
        tool_effects = {
            str(key): str(item)
            for key, item in (
                raw_tool_effects.items()
                if isinstance(raw_tool_effects, dict)
                else ()
            )
            if str(key).strip() and str(item) in _KNOWN_TOOL_EFFECTS
        }
        return McpServerConfig(
            name=str(name),
            command=command,
            args=args,
            env=env,
            enabled=value.get("disabled") is not True and value.get("enabled") is not False,
            tool_effects=tool_effects,
        )


def load_server_configs(path: Path | str) -> list[McpServerConfig]:
    """Read an `mcpServers` map — the shape Claude Desktop and friends all use.

    A malformed entry is skipped rather than raised: one bad server must not make
    every other one unreachable, and the user is far more likely to have a typo in
    one entry than a broken file.
    """
    try:
        raw = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    servers = raw.get("mcpServers") if isinstance(raw, dict) else None
    if not isinstance(servers, dict):
        return []
    configs = []
    for name, value in servers.items():
        config = McpServerConfig.from_dict(str(name), value)
        if config is not None and config.enabled:
            configs.append(config)
    return configs


class McpStdioClient:
    """One connection to one MCP server, over its stdin/stdout."""

    def __init__(self, config: McpServerConfig, *, timeout: float = DEFAULT_TIMEOUT_S) -> None:
        self.config = config
        self.timeout = float(timeout)
        self._process: subprocess.Popen[str] | None = None
        self._next_id = 0
        self._lock = threading.Lock()

    def __enter__(self) -> McpStdioClient:
        self.start()
        return self

    def __exit__(self, *_exc: Any) -> None:
        self.close()

    def start(self) -> None:
        env = dict(os.environ)
        env.update(self.config.env)
        try:
            self._process = subprocess.Popen(
                [self.config.command, *self.config.args],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
                encoding="utf-8",
                errors="replace",
                env=env,
                bufsize=1,
            )
        except (OSError, ValueError) as exc:
            raise McpClientError(f"could not start {self.config.name}: {type(exc).__name__}") from exc
        self._request("initialize", {
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": {"name": "magic-pointer", "version": "1.0.0"},
        }, timeout=STARTUP_TIMEOUT_S)
        self._notify("notifications/initialized", {})

    def close(self) -> None:
        process = self._process
        self._process = None
        if process is None:
            return
        try:
            if process.stdin:
                process.stdin.close()
            process.wait(timeout=2)
        except Exception:
            with contextlib.suppress(Exception):
                process.kill()

    def _abort(self) -> None:
        """Immediately discard a protocol-violating process and its stream."""
        process = self._process
        self._process = None
        if process is None:
            return
        with contextlib.suppress(Exception):
            if process.stdin:
                process.stdin.close()
        with contextlib.suppress(Exception):
            process.kill()

    def _write(self, message: dict[str, Any]) -> None:
        process = self._process
        if process is None or process.stdin is None:
            raise McpClientError("server is not running")
        try:
            process.stdin.write(json.dumps(message, ensure_ascii=False) + "\n")
            process.stdin.flush()
        except (OSError, ValueError) as exc:
            raise McpClientError(f"could not write to {self.config.name}") from exc

    def _notify(self, method: str, params: dict[str, Any]) -> None:
        self._write({"jsonrpc": "2.0", "method": method, "params": params})

    def _request(self, method: str, params: dict[str, Any], *, timeout: float | None = None) -> dict[str, Any]:
        with self._lock:
            return self._request_locked(method, params, timeout=timeout)

    def _request_locked(
        self,
        method: str,
        params: dict[str, Any],
        *,
        timeout: float | None = None,
    ) -> dict[str, Any]:
        """Complete one write/read exchange while owning the stdio stream."""
        self._next_id += 1
        request_id = self._next_id
        self._write({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params})
        deadline = float(self.timeout if timeout is None else timeout)
        result: dict[str, Any] = {}
        error: str = ""
        fatal_protocol_error = False

        def read() -> None:
            nonlocal result, error, fatal_protocol_error
            process = self._process
            if process is None or process.stdout is None:
                error = "server is not running"
                return
            while True:
                line = process.stdout.readline(MAX_RESPONSE_CHARS + 1)
                if not line:
                    error = "server closed the connection"
                    return
                if len(line) > MAX_RESPONSE_CHARS:
                    error = f"response line exceeds {MAX_RESPONSE_CHARS} characters"
                    fatal_protocol_error = True
                    return
                text = line.strip()
                if not text:
                    continue
                try:
                    message = json.loads(text)
                except ValueError:
                    # Servers log to stdout despite the spec. Skip, do not fail.
                    continue
                if message.get("id") != request_id:
                    continue
                if isinstance(message.get("error"), dict):
                    error = str(message["error"].get("message") or "unknown error")
                else:
                    value = message.get("result")
                    result = value if isinstance(value, dict) else {}
                return

        reader = threading.Thread(target=read, daemon=True)
        reader.start()
        reader.join(deadline)
        if reader.is_alive():
            # A hung third-party process must not hold a bubble open.
            self._abort()
            raise McpClientError(f"{self.config.name} did not answer within {deadline:.0f}s")
        if error:
            if fatal_protocol_error:
                self._abort()
            raise McpClientError(f"{self.config.name}: {error}")
        return result

    def list_tools(self) -> list[McpTool]:
        payload = self._request("tools/list", {})
        tools: list[McpTool] = []
        for item in list(payload.get("tools") or [])[:MAX_TOOLS_PER_SERVER]:
            if not isinstance(item, dict):
                continue
            name = str(item.get("name") or "").strip()
            if not name:
                continue
            schema = item.get("inputSchema")
            tools.append(McpTool(
                server=self.config.name,
                name=name,
                description=str(item.get("description") or "").strip()[:MAX_DESCRIPTION_CHARS],
                input_schema=schema if isinstance(schema, dict) else {},
                annotations=(
                    dict(item.get("annotations"))
                    if isinstance(item.get("annotations"), dict)
                    else {}
                ),
            ))
        return tools

    def call_tool(self, name: str, arguments: dict[str, Any] | None = None) -> dict[str, Any]:
        """Call one tool. Only ever from an explicit request — never from discovery."""
        payload = self._request("tools/call", {
            "name": str(name),
            "arguments": dict(arguments or {}),
        })
        blocks = [item for item in list(payload.get("content") or []) if isinstance(item, dict)]
        text = "\n".join(
            str(block.get("text") or "") for block in blocks if block.get("type") == "text"
        ).strip()
        return {
            "text": text,
            "isError": payload.get("isError") is True,
            "raw": payload,
        }


def discover_tools(
    configs: list[McpServerConfig],
    *,
    timeout: float = DEFAULT_TIMEOUT_S,
) -> tuple[list[McpTool], list[str]]:
    """Ask every configured server what it offers. Returns (tools, warnings).

    Nothing is called here. A server that fails contributes a warning and no
    tools, because one broken entry in someone's config must not remove every
    other integration they have.
    """
    tools: list[McpTool] = []
    warnings: list[str] = []
    for config in configs:
        try:
            with McpStdioClient(config, timeout=timeout) as client:
                tools.extend(client.list_tools())
        except McpClientError as exc:
            warnings.append(str(exc))
        except Exception as exc:  # noqa: BLE001 - third-party process, any failure
            warnings.append(f"{config.name}: {type(exc).__name__}")
    return tools, warnings
