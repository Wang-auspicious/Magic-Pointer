from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from app.fabric.settings import FabricSettings, SettingsError, SettingsStore


def test_default_settings_are_wiggle_first_and_minimum_permission(tmp_path: Path) -> None:
    store = SettingsStore(tmp_path / "settings.json")
    settings = store.load()
    assert settings.schema_version == 1
    assert settings.activation.wiggle_enabled is True
    assert settings.activation.gesture_interaction_mode == "exclusive_overlay"
    assert settings.activation.multi_stroke_submit_ms == 2500
    assert settings.activation.fallback_hotkey_enabled is True
    assert settings.interaction.default_input_mode == "text"
    assert settings.interaction.voice_auto_submit is True
    assert settings.interaction.voice_language == "auto"
    assert settings.interaction.voice_output_mode == "verbatim"
    assert settings.interaction.voice_hallucination_guard is True
    assert settings.interaction.voice_glossaries == {}
    assert settings.permissions.default_write == "confirm"
    assert settings.permissions.default_send == "confirm"
    assert settings.permissions.default_purchase == "deny"
    assert settings.privacy.upload_screenshots is False
    assert settings.privacy.default_capture_mode == "follow_global"
    assert settings.privacy.app_capture_modes == {}
    assert settings.privacy.retain_artifacts_days == 30
    assert settings.connections.browser_devtools_enabled is True
    assert settings.connections.browser_devtools_endpoints == ["http://127.0.0.1:9222"]


def test_voice_profile_settings_are_normalized_and_invalid_values_fail_closed() -> None:
    settings = FabricSettings.defaults()
    settings.interaction.voice_language = "ZH"
    settings.interaction.voice_output_mode = "clean_spacing"
    settings.interaction.voice_glossaries = {
        "*": [" Magic Pointer ", "Context Packet", "Magic Pointer"],
        r"D:\work\repo": ["TargetLease"],
    }
    settings.interaction.validate()
    assert settings.interaction.voice_language == "zh"
    assert settings.interaction.voice_glossaries["*"] == ["Magic Pointer", "Context Packet"]

    settings.interaction.voice_output_mode = "rewrite_everything"
    with pytest.raises(ValueError, match="voice_output_mode"):
        settings.interaction.validate()


def test_settings_round_trip_atomically_as_utf8(tmp_path: Path) -> None:
    path = tmp_path / "settings.json"
    store = SettingsStore(path)
    settings = store.load()
    settings.activation.disabled_apps = ["blender", "原神"]
    settings.agents.preferred = "pi"
    settings.interaction.default_input_mode = "text"
    settings.privacy.default_capture_mode = "local_ocr"
    settings.privacy.app_capture_modes = {"1password": "deny", "edge": "local_screenshot"}
    settings.connections.browser_devtools_endpoints = ["http://127.0.0.1:9333"]
    saved = store.save(settings)

    assert saved == path
    assert not path.with_suffix(".json.tmp").exists()
    raw = path.read_text(encoding="utf-8")
    assert "原神" in raw
    loaded = store.load()
    assert loaded.activation.disabled_apps == ["blender", "原神"]
    assert loaded.agents.preferred == "pi"
    assert loaded.interaction.default_input_mode == "text"
    assert loaded.privacy.default_capture_mode == "local_ocr"
    assert loaded.privacy.app_capture_modes == {"1password": "deny", "edge": "local_screenshot"}
    assert loaded.connections.browser_devtools_endpoints == ["http://127.0.0.1:9333"]


def test_browser_devtools_connections_are_loopback_only() -> None:
    payload = FabricSettings.defaults().to_dict()
    payload["connections"]["browser_devtools_endpoints"] = ["https://remote.example.test:9222"]
    with pytest.raises(SettingsError, match="loopback"):
        FabricSettings.from_dict(payload)


def test_configuration_center_fields_round_trip_without_loss(tmp_path: Path) -> None:
    path = tmp_path / "settings.json"
    payload = FabricSettings.defaults().to_dict()
    payload["general"] = {
        "launch_at_login": True,
        "keep_running": True,
        "update_channel": "preview",
    }
    payload["notifications"] = {"completion": False, "failure": True}
    payload["activation"].update({
        "wake_mode": "hotkey",
        "keep_current_app_focus": True,
        "dashboard_focus_after_action": False,
        "mouse_side_button": "none",
    })
    payload["interaction"]["voice_start_strategy"] = "push_to_talk"
    payload["shortcuts"] = {
        "wake": "Control+Alt+M",
        "text_mode": "Control+Alt+T",
        "voice_mode": "Control+Alt+V",
        "pause": "Control+Alt+P",
    }
    payload["appearance"] = {
        "theme": "dark",
        "material": "solid",
        "selection_visual": "soft_glow",
    }
    payload["accessibility"] = {
        "reduce_motion": True,
        "reduce_transparency": True,
        "high_contrast_controls": False,
    }
    payload["agents"].update({
        "delivery_mode": "active_session",
        "cwd_match": "strict",
        "image_policy": "vision_only",
    })
    path.write_text(json.dumps(payload), encoding="utf-8")

    settings = SettingsStore(path).load()
    SettingsStore(path).save(settings)
    saved = json.loads(path.read_text(encoding="utf-8"))

    assert saved["general"]["launch_at_login"] is True
    assert saved["notifications"]["completion"] is False
    assert saved["activation"]["wake_mode"] == "hotkey"
    assert saved["interaction"]["voice_start_strategy"] == "push_to_talk"
    assert saved["shortcuts"]["text_mode"] == "Control+Alt+T"
    assert saved["appearance"] == {
        "theme": "dark",
        "material": "solid",
        "selection_visual": "soft_glow",
        "sweep_height_ratio": 0.52,
        "sweep_min_height_dip": 10.0,
        "sweep_max_height_dip": 24.0,
        "sweep_duration_ms": 292.0,
        "sweep_fade_ms": 96.0,
        "capsule_spawn_ms": 417.0,
        "capsule_expand_ms": 292.0,
        "capsule_voice_width_dip": 40.0,
        "capsule_text_width_dip": 144.0,
        "capsule_max_width_dip": 440.0,
        "capsule_inline_gap_dip": 18.0,
        "gesture_line_style": "demo6_band",
        "gesture_line_width_dip": 22.0,
    }
    assert saved["accessibility"]["reduce_motion"] is True
    assert saved["agents"]["cwd_match"] == "strict"


def test_agent_session_binding_is_normalized_and_persisted(tmp_path: Path) -> None:
    value = FabricSettings.defaults().to_dict()
    value["agents"]["session_bindings"] = {"Codex": " session-123 "}
    value["agents"]["auto_attach"] = False

    settings = FabricSettings.from_dict(value)
    store = SettingsStore(tmp_path / "settings.json")
    store.save(settings)
    loaded = store.load()

    assert loaded.agents.session_bindings == {"codex": "session-123"}
    assert loaded.agents.auto_attach is False


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


def test_legacy_activation_migrates_without_reenabling_wiggle(tmp_path: Path) -> None:
    path = tmp_path / "settings.json"
    payload = FabricSettings.defaults().to_dict()
    payload["activation"].pop("wake_mode")
    payload.pop("shortcuts")
    payload["activation"]["wiggle_enabled"] = False
    payload["activation"]["fallback_hotkey_enabled"] = True
    payload["activation"]["fallback_hotkey"] = "Control+Shift+Space"
    path.write_text(json.dumps(payload), encoding="utf-8")

    settings = SettingsStore(path).load()

    assert settings.activation.wake_mode == "hotkey"
    assert settings.activation.wiggle_enabled is False
    assert settings.shortcuts.wake == "Control+Shift+Space"


def test_shortcuts_reject_duplicates_reserved_and_modifier_only_values() -> None:
    payload = FabricSettings.defaults().to_dict()
    payload["shortcuts"]["text_mode"] = payload["shortcuts"]["wake"]
    with pytest.raises(SettingsError, match="duplicate shortcut"):
        FabricSettings.from_dict(payload)

    payload = FabricSettings.defaults().to_dict()
    payload["shortcuts"]["pause"] = "Control+Alt+D"
    with pytest.raises(SettingsError, match="reserved shortcut"):
        FabricSettings.from_dict(payload)

    payload = FabricSettings.defaults().to_dict()
    payload["shortcuts"]["pause"] = "Control+Alt"
    with pytest.raises(SettingsError, match="shortcut pause is invalid"):
        FabricSettings.from_dict(payload)

    payload = FabricSettings.defaults().to_dict()
    payload["activation"]["wake_mode"] = "mouse_button"
    payload["activation"]["mouse_side_button"] = "none"
    with pytest.raises(SettingsError, match="mouse_side_button must be bound"):
        FabricSettings.from_dict(payload)


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


def test_invalid_capture_policy_mode_fails_closed(tmp_path: Path) -> None:
    path = tmp_path / "settings.json"
    payload = FabricSettings.defaults().to_dict()
    payload["privacy"]["app_capture_modes"] = {"edge": "send_everything"}
    path.write_text(json.dumps(payload), encoding="utf-8")
    with pytest.raises(SettingsError, match="capture mode"):
        SettingsStore(path).load()


def test_scoped_permission_only_applies_to_matching_recipe_app_and_project() -> None:
    settings = FabricSettings.defaults()
    settings.permissions.scoped_grants = [{
        "decision": "allow",
        "recipe": "agent.handoff",
        "app": "code.exe",
        "project": r"D:\work\magic-pointer",
        "risk": "external_send",
    }]
    settings.permissions.validate()
    now = datetime(2026, 7, 27, tzinfo=timezone.utc)

    matching = settings.permission_decision(
        "agent.handoff",
        "external_send",
        app="Code.exe app.py - Visual Studio Code",
        project=r"D:\work\magic-pointer\packages\desktop",
        now=now,
    )
    other_project = settings.permission_decision(
        "agent.handoff",
        "external_send",
        app="Code.exe app.py - Visual Studio Code",
        project=r"D:\work\another-repo",
        now=now,
    )
    other_app = settings.permission_decision(
        "agent.handoff",
        "external_send",
        app="Microsoft Edge",
        project=r"D:\work\magic-pointer",
        now=now,
    )

    assert matching["decision"] == "allow"
    assert matching["source"] == "scoped_grant"
    assert matching["scope"]["project"] == r"D:\work\magic-pointer"
    assert other_project["decision"] == "confirm"
    assert other_project["source"] == "risk_default"
    assert other_app["decision"] == "confirm"


def test_expired_scope_is_ignored_and_deny_wins_equal_specificity() -> None:
    now = datetime(2026, 7, 27, tzinfo=timezone.utc)
    settings = FabricSettings.defaults()
    settings.permissions.scoped_grants = [
        {
            "decision": "allow",
            "recipe": "agent.handoff",
            "app": "code",
            "expires_at": (now - timedelta(seconds=1)).isoformat(),
        },
        {
            "decision": "allow",
            "recipe": "agent.handoff",
            "app": "code",
        },
        {
            "decision": "deny",
            "recipe": "agent.handoff",
            "app": "code",
        },
    ]
    settings.permissions.validate()
    decision = settings.permission_decision(
        "agent.handoff",
        "external_send",
        app="Visual Studio Code",
        project="",
        now=now,
    )
    assert decision["decision"] == "deny"
    assert decision["source"] == "scoped_grant"


def test_invalid_scoped_permission_fails_closed(tmp_path: Path) -> None:
    path = tmp_path / "settings.json"
    payload = FabricSettings.defaults().to_dict()
    payload["permissions"]["scoped_grants"] = [{
        "decision": "always",
        "recipe": "agent.handoff",
    }]
    path.write_text(json.dumps(payload), encoding="utf-8")
    with pytest.raises(SettingsError, match="scoped permission"):
        SettingsStore(path).load()


def test_invalid_selection_visual_fails_closed(tmp_path: Path) -> None:
    path = tmp_path / "settings.json"
    payload = FabricSettings.defaults().to_dict()
    payload["appearance"]["selection_visual"] = "neon_box"
    path.write_text(json.dumps(payload), encoding="utf-8")
    with pytest.raises(SettingsError, match="selection_visual"):
        SettingsStore(path).load()


def test_invalid_gesture_interaction_mode_fails_closed(tmp_path: Path) -> None:
    path = tmp_path / "settings.json"
    payload = FabricSettings.defaults().to_dict()
    payload["activation"]["gesture_interaction_mode"] = "steal_everything"
    path.write_text(json.dumps(payload), encoding="utf-8")
    with pytest.raises(SettingsError, match="gesture_interaction_mode"):
        SettingsStore(path).load()
