"""Read configured extensions without importing plugins or connecting MCP.

Configured is a filesystem/configuration fact, not an activation or connection
verdict. Only identity and display metadata leave this module; executable
arguments, environment values and transport credentials remain in their files.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from app.fabric.mcp_client import McpServerConfig
from app.harness.extension_paths import mcp_config_path, user_plugin_dir
from app.harness.plugin import _is_reparse_path, _resolves_within, _valid_plugin_name


def _plugins(directory: Path) -> dict[str, Any]:
    result: dict[str, Any] = {"directory": str(directory), "exists": directory.exists(), "items": []}
    if not result["exists"]:
        return result
    try:
        entries = sorted(directory.iterdir(), key=lambda entry: entry.name.casefold())
    except OSError:
        result["error"] = "Plugin directory cannot be read."
        return result
    for entry in entries:
        linked = _is_reparse_path(entry)
        if not linked and not entry.is_dir():
            continue
        manifest = entry / "plugin.json"
        module = entry / "plugin.py"
        # Skills are a separate runtime facility; a SKILL.md alone is not a
        # plugin row. Optional manifests and plugin.py are the real contract.
        if not linked and not manifest.exists() and not module.exists():
            continue
        row = {"id": entry.name, "name": entry.name, "description": "", "path": str(entry), "status": "configured"}
        error = ""
        if linked or not _resolves_within(directory, entry):
            error = "Linked plugin directories are not supported by the runtime."
        elif not _valid_plugin_name(entry.name):
            error = "Plugin names must match [a-z0-9_]+."
        elif _is_reparse_path(manifest) or _is_reparse_path(module):
            error = "Linked plugin files are not supported by the runtime."
        elif not module.is_file():
            error = "Plugin code is missing: plugin.py."
        elif manifest.exists():
            try:
                metadata = json.loads(manifest.read_text(encoding="utf-8"))
                if not isinstance(metadata, dict):
                    error = "plugin.json must contain a JSON object."
                elif isinstance(metadata.get("description"), str):
                    row["description"] = metadata["description"]
            except (OSError, UnicodeError, ValueError):
                error = "plugin.json cannot be read as a JSON object."
        if error:
            row.update(status="invalid", error=error)
        result["items"].append(row)
    return result


def _mcp(path: Path) -> dict[str, Any]:
    result: dict[str, Any] = {"path": str(path), "exists": path.exists(), "servers": []}
    if not result["exists"]:
        return result
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, ValueError):
        result["error"] = "MCP configuration cannot be read as JSON."
        return result
    servers = raw.get("mcpServers") if isinstance(raw, dict) else None
    if not isinstance(servers, dict):
        result["error"] = "MCP configuration must contain an mcpServers object."
        return result
    for name, value in sorted(servers.items(), key=lambda item: item[0].casefold()):
        fields = value if isinstance(value, dict) else {}
        transport = "stdio" if fields.get("command") else "http" if fields.get("url") else "unknown"
        enabled = fields.get("disabled") is not True and fields.get("enabled") is not False
        try:
            config = McpServerConfig.from_dict(name, value)
        except (TypeError, ValueError):
            config = None
        row = {"name": name, "transport": transport, "enabled": enabled,
               "status": "configured" if config and enabled else "disabled" if config else "invalid"}
        if config is None:
            row["error"] = "Only stdio MCP servers are supported." if transport == "http" else "Invalid stdio MCP server configuration."
        result["servers"].append(row)
    return result


def extensions_inventory(root: Path) -> dict[str, Any]:
    return {"ok": True, "plugins": _plugins(user_plugin_dir(root)), "mcp": _mcp(mcp_config_path(root))}
