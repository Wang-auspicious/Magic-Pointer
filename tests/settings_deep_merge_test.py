"""Settings merge-patch tests (review Q6: bridge-side deep merge)."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.fabric.settings import FabricSettings, deep_merge_settings  # noqa: E402


def test_voice_master_switch_normalizes_dependent_fields() -> None:
    settings = FabricSettings.from_dict({
        **FabricSettings.defaults().to_dict(),
        "interaction": {
            **FabricSettings.defaults().to_dict()["interaction"],
            "voice_enabled": False,
            "default_input_mode": "voice",
            "voice_resident_enabled": True,
            "voice_engine": "auto",
        },
    })
    assert settings.interaction.default_input_mode == "text"
    assert settings.interaction.voice_resident_enabled is False


def test_nested_dicts_merge_recursively() -> None:
    base = {
        "general": {"launch_at_login": False, "keep_running": True},
        "privacy": {"upload_screenshots": False},
    }
    patch = {"general": {"launch_at_login": True}}
    merged = deep_merge_settings(base, patch)
    assert merged["general"] == {"launch_at_login": True, "keep_running": True}
    assert merged["privacy"] == {"upload_screenshots": False}


def test_scalars_and_lists_replace() -> None:
    base = {"connections": {"browser_devtools_endpoints": ["http://127.0.0.1:9222"]}}
    patch = {"connections": {"browser_devtools_endpoints": ["http://127.0.0.1:9333"]}}
    merged = deep_merge_settings(base, patch)
    assert merged["connections"]["browser_devtools_endpoints"] == ["http://127.0.0.1:9333"]


def test_null_deletes_the_key() -> None:
    base = {"appearance": {"theme": "dark", "material": "solid"}}
    patch = {"appearance": {"theme": None}}
    merged = deep_merge_settings(base, patch)
    assert "theme" not in merged["appearance"]
    assert merged["appearance"]["material"] == "solid"


def test_base_is_never_mutated() -> None:
    base = {"general": {"keep_running": True}}
    patch = {"general": {"keep_running": False}}
    merged = deep_merge_settings(base, patch)
    assert base["general"]["keep_running"] is True
    assert merged["general"]["keep_running"] is False
    assert merged is not base
