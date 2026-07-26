from __future__ import annotations

import json
from pathlib import Path

from app.fabric.mcp import MagicPointerMcpServer


def test_initialize_and_tools_list_expose_action_fabric(tmp_path: Path) -> None:
    server = MagicPointerMcpServer(root=tmp_path)
    initialized = server.handle({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {"protocolVersion": "2025-06-18", "capabilities": {}},
    })
    assert initialized["id"] == 1
    assert initialized["result"]["serverInfo"]["name"] == "magic-pointer"
    assert "tools" in initialized["result"]["capabilities"]

    listed = server.handle({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}})
    names = {tool["name"] for tool in listed["result"]["tools"]}
    assert names == {
        "current_object",
        "list_recipes",
        "plan_recipe",
        "execute_recipe",
        "agent_task_status",
        "agent_task_cancel",
        "agent_task_steer",
    }


def test_current_object_is_explicitly_missing_or_returns_frozen_snapshot(tmp_path: Path) -> None:
    server = MagicPointerMcpServer(root=tmp_path)
    missing = server.handle({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {"name": "current_object", "arguments": {}},
    })
    value = json.loads(missing["result"]["content"][0]["text"])
    assert value == {"ok": False, "error": "no_frozen_object"}

    server.current_objects.write({
        "schemaVersion": 1,
        "episodeId": "ep-1",
        "objects": [{"id": "this", "kind": "text", "content": "secret"}],
    })
    current = server.handle({
        "jsonrpc": "2.0",
        "id": 2,
        "method": "tools/call",
        "params": {"name": "current_object", "arguments": {}},
    })
    value = json.loads(current["result"]["content"][0]["text"])
    assert value["ok"] is True
    assert value["episode"]["episodeId"] == "ep-1"


def test_plan_and_execute_cannot_bypass_confirmation(tmp_path: Path) -> None:
    clipboard = {"value": ""}
    server = MagicPointerMcpServer(
        root=tmp_path,
        clipboard_writer=lambda value: clipboard.__setitem__("value", value),
        clipboard_reader=lambda: clipboard["value"],
    )
    planned = server.call_tool("plan_recipe", {
        "command": "复制这段文字",
        "objects": [{"id": "one", "kind": "text", "content": "hello"}],
    })
    assert planned["ok"] is True
    assert planned["plan"]["requiresConfirmation"] is True

    refused = server.call_tool("execute_recipe", {"plan": planned["plan"], "confirmed": False})
    assert refused["status"] == "confirmation_required"
    assert clipboard["value"] == ""

    allowed = server.call_tool("execute_recipe", {"plan": planned["plan"], "confirmed": True})
    assert allowed["status"] == "succeeded"
    assert clipboard["value"] == "hello"


def test_invalid_jsonrpc_or_unknown_tool_returns_protocol_error(tmp_path: Path) -> None:
    server = MagicPointerMcpServer(root=tmp_path)
    invalid = server.handle({"jsonrpc": "1.0", "id": 4, "method": "tools/list"})
    assert invalid["error"]["code"] == -32600
    unknown = server.handle({
        "jsonrpc": "2.0",
        "id": 5,
        "method": "tools/call",
        "params": {"name": "erase_disk", "arguments": {}},
    })
    assert unknown["error"]["code"] == -32602
