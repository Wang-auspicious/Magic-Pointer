from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Callable

from app.fabric.catalog import public_recipe_catalog
from app.fabric.engine import FabricEngine
from app.fabric.task_store import AgentTaskStore


class CurrentObjectStore:
    def __init__(self, path: Path) -> None:
        self.path = path

    def write(self, episode: dict[str, Any]) -> Path:
        if not isinstance(episode, dict) or episode.get("schemaVersion") != 1:
            raise ValueError("current object episode requires schemaVersion 1")
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temp = self.path.with_suffix(self.path.suffix + ".tmp")
        temp.write_text(json.dumps(episode, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
        os.replace(temp, self.path)
        return self.path

    def read(self) -> dict[str, Any] | None:
        if not self.path.exists():
            return None
        try:
            value = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
        if not isinstance(value, dict) or value.get("schemaVersion") != 1:
            return None
        return value


_TOOLS = (
    {
        "name": "current_object",
        "description": "Return the frozen Magic Pointer THIS/THAT/THESE/HERE episode. Does not capture a new screen.",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "list_recipes",
        "description": "List the 30 Magic Pointer action Recipes and their capability/risk contracts.",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "plan_recipe",
        "description": "Create a permission-bound action plan from a short command and grounded objects.",
        "inputSchema": {
            "type": "object",
            "required": ["command"],
            "properties": {
                "command": {"type": "string"},
                "objects": {"type": "array", "items": {"type": "object"}},
                "parameters": {"type": "object"},
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "execute_recipe",
        "description": "Execute a previously returned plan. Confirmation cannot be bypassed.",
        "inputSchema": {
            "type": "object",
            "required": ["plan", "confirmed"],
            "properties": {
                "plan": {"type": "object"},
                "confirmed": {"type": "boolean"},
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "agent_task_status",
        "description": "Return persisted status and terminal receipt for a Magic Pointer background Agent task.",
        "inputSchema": {
            "type": "object",
            "required": ["taskId"],
            "properties": {"taskId": {"type": "string"}},
            "additionalProperties": False,
        },
    },
    {
        "name": "agent_task_cancel",
        "description": "Request cancellation of a Magic Pointer background Agent task.",
        "inputSchema": {
            "type": "object",
            "required": ["taskId"],
            "properties": {"taskId": {"type": "string"}},
            "additionalProperties": False,
        },
    },
    {
        "name": "agent_task_steer",
        "description": "Queue a steering message for a running Magic Pointer background Agent task.",
        "inputSchema": {
            "type": "object",
            "required": ["taskId", "message"],
            "properties": {
                "taskId": {"type": "string"},
                "message": {"type": "string"},
            },
            "additionalProperties": False,
        },
    },
)


class MagicPointerMcpServer:
    def __init__(
        self,
        *,
        root: Path | str | None = None,
        clipboard_writer: Callable[[str], Any] | None = None,
        clipboard_reader: Callable[[], str] | None = None,
    ) -> None:
        self.root = Path(root) if root is not None else Path(os.environ.get("MAGIC_POINTER_USER_DATA_DIR") or Path.cwd() / "data" / "runtime")
        self.current_objects = CurrentObjectStore(self.root / "current-object.json")
        self.engine = FabricEngine(
            root=self.root,
            clipboard_writer=clipboard_writer,
            clipboard_reader=clipboard_reader,
        )
        self.tasks = AgentTaskStore(self.root / "agent-tasks")

    def call_tool(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        if name == "current_object":
            episode = self.current_objects.read()
            return {"ok": False, "error": "no_frozen_object"} if episode is None else {"ok": True, "episode": episode}
        if name == "list_recipes":
            return {"ok": True, "recipes": public_recipe_catalog()}
        if name == "plan_recipe":
            return self.engine.plan(
                str(arguments.get("command") or ""),
                objects=[dict(item) for item in arguments.get("objects") or [] if isinstance(item, dict)],
                parameters=dict(arguments.get("parameters") or {}),
            )
        if name == "execute_recipe":
            return self.engine.execute(
                dict(arguments.get("plan") or {}),
                confirmed=arguments.get("confirmed") is True,
            )
        if name == "agent_task_status":
            return {"ok": True, "task": self.tasks.status(str(arguments.get("taskId") or ""))}
        if name == "agent_task_cancel":
            return {"ok": True, "task": self.tasks.cancel(str(arguments.get("taskId") or ""))}
        if name == "agent_task_steer":
            return {
                "ok": True,
                "task": self.tasks.steer(
                    str(arguments.get("taskId") or ""),
                    str(arguments.get("message") or ""),
                ),
            }
        raise ValueError(f"unknown tool: {name}")

    def handle(self, message: dict[str, Any]) -> dict[str, Any] | None:
        request_id = message.get("id")
        if message.get("jsonrpc") != "2.0" or not isinstance(message.get("method"), str):
            return {"jsonrpc": "2.0", "id": request_id, "error": {"code": -32600, "message": "Invalid Request"}}
        method = message["method"]
        if method == "notifications/initialized":
            return None
        if method == "initialize":
            return {
                "jsonrpc": "2.0",
                "id": request_id,
                "result": {
                    "protocolVersion": "2025-06-18",
                    "capabilities": {"tools": {"listChanged": False}},
                    "serverInfo": {"name": "magic-pointer", "version": "2.0.0"},
                },
            }
        if method == "ping":
            return {"jsonrpc": "2.0", "id": request_id, "result": {}}
        if method == "tools/list":
            return {"jsonrpc": "2.0", "id": request_id, "result": {"tools": list(_TOOLS)}}
        if method == "tools/call":
            params = dict(message.get("params") or {})
            name = str(params.get("name") or "")
            if name not in {item["name"] for item in _TOOLS}:
                return {"jsonrpc": "2.0", "id": request_id, "error": {"code": -32602, "message": f"Unknown tool: {name}"}}
            try:
                value = self.call_tool(name, dict(params.get("arguments") or {}))
            except Exception as exc:
                return {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "result": {
                        "content": [{"type": "text", "text": json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"}, ensure_ascii=False)}],
                        "isError": True,
                    },
                }
            return {
                "jsonrpc": "2.0",
                "id": request_id,
                "result": {
                    "content": [{"type": "text", "text": json.dumps(value, ensure_ascii=False)}],
                    "isError": value.get("ok") is False,
                },
            }
        return {"jsonrpc": "2.0", "id": request_id, "error": {"code": -32601, "message": f"Method not found: {method}"}}
