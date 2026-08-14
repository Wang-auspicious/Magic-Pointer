"""Lazy MCP ToolProvider integration with the Agent registry."""

from __future__ import annotations

import json

from app.agent_runtime.mcp_provider import McpToolProvider
from app.agent_runtime.tool_registry import Effect, ToolRegistry
from app.fabric.mcp_client import McpServerConfig, McpTool


class FakeClient:
    def __init__(self, config, *, timeout=8.0):
        self.config = config
        self.timeout = timeout
        self.started = 0
        self.closed = 0
        self.calls = []

    def start(self):
        self.started += 1

    def list_tools(self):
        return [
            McpTool(
                server=self.config.name,
                name="get-file",
                description="Read one Figma file",
                input_schema={
                    "type": "object",
                    "properties": {"key": {"type": "string"}},
                    "required": ["key"],
                },
                annotations={"readOnlyHint": True},
            ),
            McpTool(
                server=self.config.name,
                name="publish",
                description="Publish a Figma change",
                input_schema={"type": "object", "properties": {}},
                annotations={"readOnlyHint": False},
            ),
        ]

    def call_tool(self, name, arguments):
        self.calls.append((name, dict(arguments)))
        return {"text": f"{name}:{arguments}", "isError": False, "raw": {}}

    def close(self):
        self.closed += 1


def test_search_lazily_connects_registers_and_reuses_mcp_tools() -> None:
    clients = []

    def factory(config, *, timeout=8.0):
        client = FakeClient(config, timeout=timeout)
        clients.append(client)
        return client

    registry = ToolRegistry()
    provider = McpToolProvider(
        [McpServerConfig(
            name="Figma Dev",
            command="fake",
            tool_effects={
                "get-file": "read",
                "publish": "external_send",
            },
        )],
        client_factory=factory,
    )
    provider.register(registry)

    assert [spec.name for spec in registry.list()] == ["mcp_search"]
    discovered = registry.execute_tool("mcp_search", {"query": "figma"})
    payload = json.loads(discovered.value)
    assert clients[0].started == 1
    assert {tool["name"] for tool in payload["tools"]} == {
        "mcp_figma_dev__get_file",
        "mcp_figma_dev__publish",
    }

    read = registry.get("mcp_figma_dev__get_file")
    publish = registry.get("mcp_figma_dev__publish")
    assert read.effect is Effect.READ
    assert read.is_concurrency_safe is True
    assert read.resource_keys == ("mcp:Figma Dev",)
    assert publish.effect is Effect.EXTERNAL_SEND

    result = registry.execute_tool("mcp_figma_dev__get_file", {"key": "abc"})
    assert result.is_error is False
    assert "get-file" in result.value
    registry.execute_tool("mcp_search", {"query": "file"})
    assert len(clients) == 1
    assert clients[0].started == 1

    provider.close()
    assert clients[0].closed == 1


def test_untrusted_mcp_read_only_hint_never_downgrades_permission() -> None:
    registry = ToolRegistry()
    provider = McpToolProvider(
        [McpServerConfig(name="untrusted", command="fake")],
        client_factory=FakeClient,
    )
    provider.register(registry)

    registry.execute_tool("mcp_search", {"query": "file"})

    spec = registry.get("mcp_untrusted__get_file")
    assert spec.effect is Effect.EXTERNAL_SEND
    assert spec.is_concurrency_safe is False
    provider.close()


def test_mcp_config_parses_only_known_explicit_tool_effects() -> None:
    config = McpServerConfig.from_dict("server", {
        "command": "fake",
        "toolEffects": {
            "read": "read",
            "remove": "destructive",
            "bad": "admin",
            "": "purchase",
        },
    })

    assert config is not None
    assert config.tool_effects == {"read": "read", "remove": "destructive"}


def test_mcp_tool_error_is_structured_tool_failure() -> None:
    class ErrorClient(FakeClient):
        def call_tool(self, name, arguments):
            return {"text": "remote denied", "isError": True, "raw": {}}

    registry = ToolRegistry()
    provider = McpToolProvider(
        [McpServerConfig(name="figma", command="fake")],
        client_factory=ErrorClient,
    )
    provider.register(registry)
    registry.execute_tool("mcp_search", {"query": "figma"})

    result = registry.execute_tool("mcp_figma__get_file", {"key": "abc"})

    assert result.is_error is True
    assert "remote denied" in (result.error_message or "")
    provider.close()


def test_failed_mcp_discovery_closes_partial_client_immediately() -> None:
    class BrokenClient(FakeClient):
        def list_tools(self):
            raise RuntimeError("server stopped during discovery")

    clients = []

    def factory(config, **kwargs):
        client = BrokenClient(config, **kwargs)
        clients.append(client)
        return client

    registry = ToolRegistry()
    provider = McpToolProvider(
        [McpServerConfig(name="broken", command="fake")],
        client_factory=factory,
    )
    provider.register(registry)

    result = registry.execute_tool("mcp_search", {"query": "anything"})
    payload = json.loads(result.value)

    assert result.is_error is False
    assert payload["tools"] == []
    assert "server stopped during discovery" in payload["warnings"][0]
    assert clients[0].closed == 1


def test_failed_mcp_server_retries_after_cooldown_without_restarting_successes() -> None:
    now = [10.0]
    clients = []

    class FlakyClient(FakeClient):
        def list_tools(self):
            if len(clients) == 1:
                raise RuntimeError("temporary discovery failure")
            return super().list_tools()

    def factory(config, **kwargs):
        client = FlakyClient(config, **kwargs)
        clients.append(client)
        return client

    registry = ToolRegistry()
    provider = McpToolProvider(
        [McpServerConfig(name="flaky", command="fake")],
        client_factory=factory,
        retry_cooldown_s=5.0,
        clock=lambda: now[0],
    )
    provider.register(registry)

    first = json.loads(registry.execute_tool("mcp_search", {"query": "file"}).value)
    second = json.loads(registry.execute_tool("mcp_search", {"query": "file"}).value)
    now[0] += 5.0
    recovered = json.loads(registry.execute_tool("mcp_search", {"query": "file"}).value)

    assert first["tools"] == []
    assert second["tools"] == []
    assert len(clients) == 2
    assert recovered["tools"][0]["server"] == "flaky"
    assert recovered["warnings"] == []
    provider.close()
