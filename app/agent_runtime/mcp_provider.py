"""Lazy MCP servers as ordinary model-visible Agent tools."""

from __future__ import annotations

import contextlib
import hashlib
import json
import re
import threading
import time
from collections.abc import Callable
from typing import Any

from app.agent_runtime.errors import ActionFailure, FailureType
from app.agent_runtime.tool_registry import Effect, ToolRegistry, ToolSpec
from app.fabric.mcp_client import (
    DEFAULT_TIMEOUT_S,
    McpServerConfig,
    McpStdioClient,
    McpTool,
)

ClientFactory = Callable[..., McpStdioClient]
Clock = Callable[[], float]


class McpToolProvider:
    """Connect only after ``mcp_search`` and retain connections until unload."""

    def __init__(
        self,
        configs: list[McpServerConfig],
        *,
        timeout: float = DEFAULT_TIMEOUT_S,
        client_factory: ClientFactory = McpStdioClient,
        retry_cooldown_s: float = 5.0,
        clock: Clock = time.monotonic,
    ) -> None:
        if not 0.1 <= float(retry_cooldown_s) <= 300.0:
            raise ValueError("retry_cooldown_s must be between 0.1 and 300")
        self.configs = list(configs)
        self.timeout = float(timeout)
        self.client_factory = client_factory
        self.retry_cooldown_s = float(retry_cooldown_s)
        self.clock = clock
        self._configs_by_name = {config.name: config for config in self.configs}
        self._registry: ToolRegistry | None = None
        self._clients: dict[str, Any] = {}
        self._tools: dict[str, McpTool] = {}
        self._warnings: list[str] = []
        self._retry_after: dict[str, float] = {}
        self._discovered = False
        self._closed = False
        self._lock = threading.Lock()

    def register(self, registry: ToolRegistry) -> ToolSpec:
        if self._registry is not None:
            raise RuntimeError("MCP provider is already registered")
        self._registry = registry
        return registry.register(ToolSpec(
            name="mcp_search",
            description=(
                "按关键词发现用户已配置的 MCP 工具（如 Figma、浏览器、数据库）。"
                "只有调用本工具时才启动 MCP 服务器；返回的工具下一轮可直接调用。"
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "能力或服务关键词"},
                },
                "required": ["query"],
            },
            execute=self._search,
            effect=Effect.READ,
            is_concurrency_safe=False,
            used_backend="mcp.discovery",
            timeout_ms=max(1000, int(self.timeout * 1000)),
            resource_keys=("mcp-discovery",),
            discovers_tools=True,
        ))

    def _search(self, query: str, scope: object = None) -> str:
        self._ensure_discovered()
        needle = str(query or "").casefold().strip()
        rows = []
        for name, tool in self._tools.items():
            haystack = f"{tool.server} {tool.name} {tool.description}".casefold()
            if needle and needle not in haystack:
                continue
            spec = self._registry.get(name) if self._registry is not None else None
            if spec is not None:
                rows.append({
                    "name": name,
                    "description": spec.description,
                    "parameters": spec.input_schema,
                    "server": tool.server,
                    "effect": spec.effect.value,
                    "annotationReadOnlyHint": tool.annotations.get("readOnlyHint") is True,
                })
        return json.dumps(
            {"query": query, "tools": rows, "warnings": list(self._warnings)},
            ensure_ascii=False,
        )

    def _ensure_discovered(self) -> None:
        with self._lock:
            if self._discovered:
                return
            now = self.clock()
            for config in self.configs:
                if config.name in self._clients:
                    continue
                if now < self._retry_after.get(config.name, 0.0):
                    continue
                client = None
                registered_names: list[str] = []
                try:
                    client = self.client_factory(config, timeout=self.timeout)
                    client.start()
                    tools = list(client.list_tools())
                    self._clients[config.name] = client
                    self._retry_after.pop(config.name, None)
                    prefix = f"{config.name}:"
                    self._warnings = [
                        warning for warning in self._warnings
                        if not warning.startswith(prefix)
                    ]
                    for tool in tools:
                        registered = self._register_remote_tool(client, tool)
                        if registered is not None:
                            registered_names.append(registered)
                except Exception as exc:  # third-party process boundary
                    self._clients.pop(config.name, None)
                    registry = self._registry
                    if registry is not None:
                        for name in registered_names:
                            registry.unregister(name)
                            self._tools.pop(name, None)
                    if client is not None:
                        with contextlib.suppress(Exception):
                            client.close()
                    self._retry_after[config.name] = now + self.retry_cooldown_s
                    prefix = f"{config.name}:"
                    self._warnings = [
                        warning for warning in self._warnings
                        if not warning.startswith(prefix)
                    ]
                    self._warnings.append(
                        f"{config.name}: {type(exc).__name__}: {exc}"[:500]
                    )
            self._discovered = all(
                config.name in self._clients for config in self.configs
            )

    def _register_remote_tool(self, client: Any, tool: McpTool) -> str | None:
        registry = self._registry
        if registry is None:
            return None
        name = self._model_name(tool)
        schema = self._schema(tool.input_schema)
        effect = self._configured_effect(tool)
        read_only = effect is Effect.READ

        def execute(scope: object = None, **arguments: Any) -> str:
            result = client.call_tool(tool.name, arguments)
            if result.get("isError") is True:
                raise ActionFailure(
                    FailureType.TOOL_ERROR,
                    str(result.get("text") or "MCP tool returned an error"),
                )
            return json.dumps(
                {
                    "server": tool.server,
                    "tool": tool.name,
                    "text": str(result.get("text") or ""),
                    "raw": result.get("raw") or {},
                },
                ensure_ascii=False,
            )

        spec = ToolSpec(
            name=name,
            description=f"MCP {tool.server}: {tool.description or tool.name}",
            input_schema=schema,
            execute=execute,
            effect=effect,
            is_concurrency_safe=read_only,
            used_backend=f"mcp:{tool.server}",
            timeout_ms=max(1000, int(self.timeout * 1000)),
            resource_keys=(f"mcp:{tool.server}",),
        )
        try:
            registry.register(spec)
        except ValueError:
            return None
        self._tools[name] = tool
        return name

    def _configured_effect(self, tool: McpTool) -> Effect:
        """Only user-owned config may lower a remote tool's permission class.

        MCP annotations are untrusted hints, not authorization.  An
        unclassified remote tool therefore remains EXTERNAL_SEND even when
        its server advertises ``readOnlyHint=true``.
        """
        config = self._configs_by_name.get(tool.server)
        raw = config.tool_effects.get(tool.name) if config is not None else None
        if raw:
            try:
                return Effect(raw)
            except ValueError:
                pass
        return Effect.EXTERNAL_SEND

    def _model_name(self, tool: McpTool) -> str:
        def safe_part(value: str) -> str:
            cleaned = re.sub(r"[^a-z0-9]+", "_", value.casefold()).strip("_")
            return cleaned or "tool"

        raw = f"{tool.server}\0{tool.name}"
        candidate = f"mcp_{safe_part(tool.server)}__{safe_part(tool.name)}"[:60]
        registry = self._registry
        occupied = candidate in self._tools
        if registry is not None and not occupied:
            try:
                registry.get(candidate)
            except KeyError:
                pass
            else:
                occupied = True
        if occupied:
            digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()[:8]
            candidate = f"{candidate[:51]}_{digest}"
        return candidate

    @staticmethod
    def _schema(value: dict[str, Any]) -> dict[str, Any]:
        schema = dict(value or {})
        if schema.get("type") != "object":
            schema = {"type": "object", "properties": {}}
        if not isinstance(schema.get("properties"), dict):
            schema["properties"] = {}
        required = schema.get("required")
        schema["required"] = (
            [item for item in required if isinstance(item, str)]
            if isinstance(required, list)
            else []
        )
        return schema

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        for client in list(self._clients.values()):
            with contextlib.suppress(Exception):
                client.close()
        self._clients.clear()
        self._retry_after.clear()
