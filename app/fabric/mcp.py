from __future__ import annotations

import json
import os
import secrets
import time
from pathlib import Path
from typing import Any, Callable

from app.fabric.capabilities import CapabilityRegistry
from app.fabric.agent_gateway import AgentGateway
from app.fabric.catalog import public_recipe_catalog
from app.fabric.engine import FabricEngine
from app.fabric.task_store import AgentTaskStore
from app.system_context import list_visible_windows


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
        "name": "search_capabilities",
        "description": "Return only 3-8 Magic Pointer capabilities relevant to the current intent and objects.",
        "inputSchema": {
            "type": "object",
            "required": ["command"],
            "properties": {
                "command": {"type": "string"},
                "objects": {"type": "array", "items": {"type": "object"}},
                "selectedRecipeId": {"type": "string"},
                "platform": {"type": "string"},
                "providerAvailability": {"type": "object"},
                "limit": {"type": "integer", "minimum": 3, "maximum": 8},
            },
            "additionalProperties": False,
        },
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
        "description": "Execute a previously returned plan. Protected plans require a one-time token from the trusted desktop UI.",
        "inputSchema": {
            "type": "object",
            "required": ["plan"],
            "properties": {
                "plan": {"type": "object"},
                "confirmationToken": {"type": "string"},
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "agent_task_list",
        "description": "List durable Agent tasks and their real persisted states without synthetic progress.",
        "inputSchema": {
            "type": "object",
            "properties": {"limit": {"type": "integer", "minimum": 0, "maximum": 500}},
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
    {
        "name": "agent_task_resume",
        "description": "Resume a persisted interrupted or failed Agent task as a new recorded attempt.",
        "inputSchema": {
            "type": "object",
            "required": ["taskId"],
            "properties": {"taskId": {"type": "string"}},
            "additionalProperties": False,
        },
    },
    {
        "name": "agent_task_reconfirm_target",
        "description": "Explicitly reconfirm a paused task target on the current desktop and restart it with a renewed lease.",
        "inputSchema": {
            "type": "object",
            "required": ["taskId"],
            "properties": {
                "taskId": {"type": "string"},
                "confirmationToken": {"type": "string"},
            },
            "additionalProperties": False,
        },
    },
)


class MagicPointerMcpServer:
    _SERVER_NAME = "magic-pointer"
    _SERVER_VERSION = "1.0.0"
    _PROTOCOL_VERSION = "2025-06-18"

    def __init__(
        self,
        *,
        root: Path | str | None = None,
        clipboard_writer: Callable[[str], Any] | None = None,
        clipboard_reader: Callable[[], str] | None = None,
    ) -> None:
        self.root = Path(root) if root is not None else Path(os.environ.get("MAGIC_POINTER_USER_DATA_DIR") or Path.cwd() / "data" / "runtime")
        self.current_objects = CurrentObjectStore(self.root / "current-object.json")
        self.capabilities = CapabilityRegistry()
        self.engine = FabricEngine(
            root=self.root,
            clipboard_writer=clipboard_writer,
            clipboard_reader=clipboard_reader,
            target_probe=lambda _lease: list_visible_windows(),
        )
        self.tasks = AgentTaskStore(self.root / "agent-tasks")
        self.gateway = AgentGateway(
            root=self.root,
            task_store=self.tasks,
            target_probe=lambda _lease: list_visible_windows(),
        )
        self._disabled_tools: set[str] = set()
        self._confirmations: dict[str, tuple[str, str, float]] = {}
        self._load_tool_settings()

    @property
    def all_tool_names(self) -> frozenset[str]:
        return frozenset(item["name"] for item in _TOOLS)

    def _load_tool_settings(self) -> None:
        path = self.root / "mcp-tool-settings.json"
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                for name, enabled in data.get("tools", {}).items():
                    if name in self.all_tool_names and enabled is False:
                        self._disabled_tools.add(name)
        except (OSError, json.JSONDecodeError):
            pass

    def _save_tool_settings(self) -> None:
        path = self.root / "mcp-tool-settings.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        tools_state = {name: name not in self._disabled_tools for name in self.all_tool_names}
        temp = path.with_suffix(path.suffix + ".tmp")
        temp.write_text(
            json.dumps({"tools": tools_state}, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
            newline="\n",
        )
        os.replace(temp, path)

    def set_tool_enabled(self, name: str, enabled: bool) -> bool:
        if name not in self.all_tool_names:
            raise ValueError(f"unknown tool: {name}")
        if enabled:
            self._disabled_tools.discard(name)
        else:
            self._disabled_tools.add(name)
        self._save_tool_settings()
        return enabled

    def tool_enabled(self, name: str) -> bool:
        return name in self.all_tool_names and name not in self._disabled_tools

    def _active_tools(self) -> list[dict[str, Any]]:
        return [dict(item) for item in _TOOLS if item["name"] not in self._disabled_tools]

    def _issue_confirmation(self, scope: str, subject: str, *, ttl_seconds: float = 120.0) -> str:
        token = secrets.token_urlsafe(32)
        self._confirmations[token] = (scope, subject, time.monotonic() + ttl_seconds)
        return token

    def _consume_confirmation(self, scope: str, subject: str, token: Any) -> bool:
        if not isinstance(token, str) or not token:
            return False
        issued = self._confirmations.pop(token, None)
        if issued is None:
            return False
        issued_scope, issued_subject, expires_at = issued
        return issued_scope == scope and issued_subject == subject and time.monotonic() <= expires_at

    @staticmethod
    def _recipe_confirmation_subject(plan: dict[str, Any]) -> str:
        plan_id = str(plan.get("id") or "")
        integrity_token = str(plan.get("integrityToken") or "")
        if not plan_id or not integrity_token:
            raise ValueError("confirmation requires a signed plan")
        return f"{plan_id}:{integrity_token}"

    def issue_recipe_confirmation(self, plan: dict[str, Any]) -> str:
        """Mint a token from the trusted desktop channel; this is not an MCP tool."""
        return self._issue_confirmation("execute_recipe", self._recipe_confirmation_subject(plan))

    def issue_task_reconfirmation(self, task_id: str) -> str:
        """Mint a target-reconfirmation token from the trusted desktop channel."""
        subject = str(task_id or "")
        if not subject:
            raise ValueError("taskId is required")
        return self._issue_confirmation("agent_task_reconfirm_target", subject)

    def call_tool(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        if name in self.all_tool_names and not self.tool_enabled(name):
            raise PermissionError(f"tool_disabled:{name}")
        if name == "current_object":
            episode = self.current_objects.read()
            return {"ok": False, "error": "no_frozen_object"} if episode is None else {"ok": True, "episode": episode}
        if name == "list_recipes":
            return {"ok": True, "recipes": public_recipe_catalog()}
        if name == "search_capabilities":
            return {
                "ok": True,
                "capabilities": self.capabilities.search(
                    str(arguments.get("command") or ""),
                    objects=[
                        dict(item)
                        for item in arguments.get("objects") or []
                        if isinstance(item, dict)
                    ],
                    selected_recipe_id=str(arguments.get("selectedRecipeId") or "") or None,
                    platform=str(arguments.get("platform") or "") or None,
                    provider_availability=(
                        dict(arguments.get("providerAvailability") or {})
                        if arguments.get("providerAvailability") is not None
                        else None
                    ),
                    limit=int(arguments.get("limit") or 6),
                ),
            }
        if name == "plan_recipe":
            return self.engine.plan(
                str(arguments.get("command") or ""),
                objects=[dict(item) for item in arguments.get("objects") or [] if isinstance(item, dict)],
                parameters=dict(arguments.get("parameters") or {}),
            )
        if name == "execute_recipe":
            plan = dict(arguments.get("plan") or {})
            return self.engine.execute(
                plan,
                confirmed=self._consume_confirmation(
                    "execute_recipe",
                    self._recipe_confirmation_subject(plan),
                    arguments.get("confirmationToken"),
                ),
            )
        if name == "agent_task_status":
            return {"ok": True, "task": self.gateway.status(str(arguments.get("taskId") or ""))}
        if name == "agent_task_list":
            return {
                "ok": True,
                "tasks": self.gateway.list(limit=int(arguments.get("limit") or 100)),
            }
        if name == "agent_task_cancel":
            return {"ok": True, "task": self.gateway.cancel(str(arguments.get("taskId") or ""))}
        if name == "agent_task_steer":
            return {
                "ok": True,
                "task": self.gateway.steer(
                    str(arguments.get("taskId") or ""),
                    str(arguments.get("message") or ""),
                ),
            }
        if name == "agent_task_resume":
            return {
                "ok": True,
                "task": self.gateway.resume(str(arguments.get("taskId") or "")),
            }
        if name == "agent_task_reconfirm_target":
            task_id = str(arguments.get("taskId") or "")
            if not self._consume_confirmation(
                "agent_task_reconfirm_target",
                task_id,
                arguments.get("confirmationToken"),
            ):
                return {
                    "ok": True,
                    "task": {
                        "taskId": task_id,
                        "status": "confirmation_required",
                        "reconfirmationRequired": True,
                    },
                }
            return {
                "ok": True,
                "task": self.gateway.reconfirm_target(
                    task_id,
                    confirmed_windows=list_visible_windows(),
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
                    "protocolVersion": self._PROTOCOL_VERSION,
                    "capabilities": {"tools": {"listChanged": False}},
                    "serverInfo": {"name": self._SERVER_NAME, "version": self._SERVER_VERSION},
                },
            }
        if method == "ping":
            return {"jsonrpc": "2.0", "id": request_id, "result": {}}
        if method == "tools/list":
            return {"jsonrpc": "2.0", "id": request_id, "result": {"tools": self._active_tools()}}
        if method == "tools/call":
            params = dict(message.get("params") or {})
            name = str(params.get("name") or "")
            if name not in self.all_tool_names:
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
