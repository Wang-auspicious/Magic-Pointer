from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.fabric.settings import FabricSettings, SettingsError, SettingsStore


def test_default_settings_are_wiggle_first_and_minimum_permission(tmp_path: Path) -> None:
    store = SettingsStore(tmp_path / "settings.json")
    settings = store.load()
    assert settings.schema_version == 1
    assert settings.activation.wiggle_enabled is True
    assert settings.activation.fallback_hotkey_enabled is True
    assert settings.interaction.default_input_mode == "voice"
    assert settings.interaction.voice_auto_submit is True
    assert settings.permissions.default_write == "confirm"
    assert settings.permissions.default_send == "confirm"
    assert settings.permissions.default_purchase == "deny"
    assert settings.privacy.upload_screenshots is False


def test_settings_round_trip_atomically_as_utf8(tmp_path: Path) -> None:
    path = tmp_path / "settings.json"
    store = SettingsStore(path)
    settings = store.load()
    settings.activation.disabled_apps = ["blender", "原神"]
    settings.agents.preferred = "pi"
    settings.interaction.default_input_mode = "text"
    saved = store.save(settings)

    assert saved == path
    assert not path.with_suffix(".json.tmp").exists()
    raw = path.read_text(encoding="utf-8")
    assert "原神" in raw
    loaded = store.load()
    assert loaded.activation.disabled_apps == ["blender", "原神"]
    assert loaded.agents.preferred == "pi"
    assert loaded.interaction.default_input_mode == "text"


def test_corrupt_or_unknown_settings_fail_closed_without_overwrite(tmp_path: Path) -> None:
    path = tmp_path / "settings.json"
    path.write_text("{broken", encoding="utf-8")
    with pytest.raises(SettingsError):
        SettingsStore(path).load()
    assert path.read_text(encoding="utf-8") == "{broken"

    path.write_text(json.dumps({"schema_version": 999}), encoding="utf-8")
    with pytest.raises(SettingsError):
        SettingsStore(path).load()
    assert json.loads(path.read_text(encoding="utf-8"))["schema_version"] == 999


def test_sensitive_application_and_recipe_permissions_are_explicit() -> None:
    settings = FabricSettings.defaults()
    settings.privacy.sensitive_apps = ["1password", "keepass"]
    settings.permissions.recipe_overrides = {"agent.handoff": "confirm"}
    assert settings.is_sensitive_app("C:/Apps/1Password/1Password.exe")
    assert not settings.is_sensitive_app("code.exe")
    assert settings.permission_for("agent.handoff", "write") == "confirm"
    assert settings.permission_for("unknown", "purchase") == "deny"


def test_invalid_default_input_mode_fails_closed(tmp_path: Path) -> None:
    path = tmp_path / "settings.json"
    payload = FabricSettings.defaults().to_dict()
    payload["interaction"]["default_input_mode"] = "both"
    path.write_text(json.dumps(payload), encoding="utf-8")
    with pytest.raises(SettingsError, match="default_input_mode"):
        SettingsStore(path).load()
