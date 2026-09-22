
from __future__ import annotations

import os
from pathlib import Path


def user_extension_root(root: Path) -> Path:
    user_data = os.environ.get("MAGIC_POINTER_USER_DATA_DIR")
    return (Path(user_data) / "data") if user_data else root / "data"


def user_plugin_dir(root: Path) -> Path:
    override = os.environ.get("MAGIC_POINTER_PLUGIN_DIR")
    return Path(override) if override else user_extension_root(root) / "plugins"


def mcp_config_path(root: Path) -> Path:
    override = os.environ.get("MAGIC_POINTER_MCP_CONFIG")
    return Path(override) if override else user_extension_root(root) / "mcp.json"
