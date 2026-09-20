from __future__ import annotations

import json
import subprocess
import sys

import pytest

from app.harness.extensions_inventory import extensions_inventory as inventory


@pytest.fixture(autouse=True)
def isolated_extensions(monkeypatch):
    for key in ("MAGIC_POINTER_USER_DATA_DIR", "MAGIC_POINTER_PLUGIN_DIR", "MAGIC_POINTER_MCP_CONFIG"):
        monkeypatch.delenv(key, raising=False)


def test_missing_inventory_is_empty_without_creating_configuration(tmp_path):
    result = inventory(tmp_path)
    assert result["ok"] is True
    assert result["plugins"]["items"] == []
    assert result["mcp"]["servers"] == []
    assert result["plugins"]["exists"] is False
    assert result["mcp"]["exists"] is False
    assert not (tmp_path / "data").exists()


def test_real_plugin_metadata_without_executing_code_or_listing_skills(tmp_path, monkeypatch):
    plugin_root = tmp_path / "custom-plugins"
    monkeypatch.setenv("MAGIC_POINTER_PLUGIN_DIR", str(plugin_root))
    demo = plugin_root / "demo"
    demo.mkdir(parents=True)
    marker = tmp_path / "plugin-imported"
    (demo / "plugin.py").write_text(f"from pathlib import Path\nPath({str(marker)!r}).touch()\n", encoding="utf-8")
    (demo / "plugin.json").write_text(json.dumps({"description": "Local test plugin", "default_config": {"token": "must-not-leak"}}), encoding="utf-8")
    skill = plugin_root / "writing_skill"
    skill.mkdir()
    (skill / "SKILL.md").write_text("A skill is not a plugin.", encoding="utf-8")
    result = inventory(tmp_path)
    assert result["plugins"]["directory"] == str(plugin_root)
    assert [item["id"] for item in result["plugins"]["items"]] == ["demo"]
    item = result["plugins"]["items"][0]
    assert item["description"] == "Local test plugin"
    assert item["status"] == "configured"
    assert "must-not-leak" not in json.dumps(result)
    assert not marker.exists()


def test_bad_plugin_metadata_and_missing_code_are_visible(tmp_path):
    root = tmp_path / "data" / "plugins"
    for name in ("broken", "manifest_only", "bad-name"):
        directory = root / name
        directory.mkdir(parents=True)
        (directory / "plugin.json").write_text("{" if name == "broken" else "{}", encoding="utf-8")
        if name != "manifest_only":
            (directory / "plugin.py").write_text("raise AssertionError('do not import')", encoding="utf-8")
    result = inventory(tmp_path)
    items = result["plugins"]["items"]
    assert len(items) == 3
    assert all(item["status"] == "invalid" and item["error"] for item in items)


def test_mcp_inventory_uses_runtime_path_and_never_starts_servers(tmp_path, monkeypatch):
    profile = tmp_path / "profile"
    monkeypatch.setenv("MAGIC_POINTER_USER_DATA_DIR", str(profile))
    config = profile / "data" / "mcp.json"
    config.parent.mkdir(parents=True)
    config.write_text(json.dumps({"mcpServers": {
        "local": {"command": "never-run", "args": ["secret-argument"], "env": {"TOKEN": "secret-env"}},
        "disabled": {"command": "never-run", "disabled": True},
        "invalid": {"env": {"TOKEN": "secret-invalid"}},
        "bad_env": {"command": "never-run", "env": 1},
        "remote": {"url": "https://secret-host.invalid/?token=secret-url"},
    }}), encoding="utf-8")
    monkeypatch.setattr(subprocess, "Popen", lambda *args, **kwargs: pytest.fail("inventory must not start MCP"))
    result = inventory(tmp_path)
    assert result["mcp"]["path"] == str(config)
    assert result["plugins"]["directory"] == str(profile / "data" / "plugins")
    servers = {item["name"]: item for item in result["mcp"]["servers"]}
    assert servers["local"]["status"] == "configured"
    assert servers["disabled"]["status"] == "disabled"
    assert servers["disabled"]["enabled"] is False
    assert all(servers[name]["status"] == "invalid" for name in ("invalid", "bad_env", "remote"))
    assert servers["remote"]["transport"] == "http"
    assert "secret-" not in json.dumps(result)
    assert "connected" not in json.dumps(result)


@pytest.mark.parametrize("content", ["{", "[]", '{"mcpServers": []}'])
def test_malformed_mcp_file_reports_error_not_empty_success(tmp_path, monkeypatch, content):
    config = tmp_path / "override.json"
    config.write_text(content, encoding="utf-8")
    monkeypatch.setenv("MAGIC_POINTER_MCP_CONFIG", str(config))
    result = inventory(tmp_path)
    assert result["mcp"]["path"] == str(config)
    assert result["mcp"]["servers"] == []
    assert result["mcp"]["error"]


def test_fabric_bridge_inventory_reads_isolated_profile(tmp_path, monkeypatch):
    monkeypatch.setenv("MAGIC_POINTER_USER_DATA_DIR", str(tmp_path))
    result = subprocess.run([sys.executable, "scripts/fabric_bridge.py"],
                            input=json.dumps({"operation": "extensions.inventory"}),
                            text=True, capture_output=True, check=False)
    assert result.returncode == 0, result.stdout + result.stderr
    payload = json.loads(result.stdout)
    assert payload["plugins"]["directory"] == str(tmp_path / "data" / "plugins")
    assert payload["mcp"]["servers"] == []
