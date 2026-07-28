from __future__ import annotations

from app.fabric.capture_policy import CaptureDecision
from app.models.profiles import ModelProfile
from app.models.visual_relay import VisualRelayPlanner


def profile_payload(**overrides: object) -> dict[str, object]:
    value: dict[str, object] = {
        "schemaVersion": 1,
        "id": "primary",
        "displayName": "Primary",
        "provider": "openai",
        "baseUrl": "https://api.openai.com/v1",
        "model": "gpt-4.1-mini",
        "apiMode": "chat-completions",
        "credentialRef": "credential:model:primary",
        "enabled": True,
        "overrides": {"visionInput": "auto", "audioInput": "auto", "toolCalls": "auto"},
    }
    value.update(overrides)
    return value


def target() -> dict[str, object]:
    return {
        "id": "save-button",
        "kind": "ui-control",
        "label": "Save",
        "bbox": [812, 124, 884, 158],
        "content": "Save",
        "elements": [{"role": "button", "name": "Save"}],
        "hierarchy": ["Settings", "Model profile", "Actions"],
        "appearance": {"foreground": "#1266D4", "background": "#FFFFFF", "shape": "rounded-rectangle"},
        "neighbors": ["Cancel is 12px left"],
        "uncertainty": ["disabled state not confirmed"],
        "provenance": ["UIA", "RapidOCR"],
        "localImageSummary": "Blue rounded Save button under the pointer.",
        "source": {
            "app": "code.exe",
            "title": "Settings",
            "screenshotPath": "D:/captures/save.png",
            "captureAttestation": {"status": "verified"},
        },
    }


def decision(*, mode: str, upload: bool, structure: bool = True) -> CaptureDecision:
    return CaptureDecision(
        object_id="save-button",
        configured_mode=mode,
        mode=mode,
        allow_structure=structure,
        allow_local_pixels=True,
        allow_upload=upload,
        reason="test",
    )


def test_vision_profile_gets_only_allowed_local_crop_and_concise_locator() -> None:
    result = VisualRelayPlanner().plan(
        profile=ModelProfile.from_dict(profile_payload()),
        resolved_capabilities={"visionInput": "yes", "source": "catalog"},
        target=target(),
        capture=decision(mode="upload_screenshot", upload=True),
        intent="click this after checking the setting",
    )

    assert result["ok"] is True
    assert result["relay"]["mode"] == "direct_visual"
    assert result["relay"]["attachments"] == ["D:/captures/save.png"]
    assert "Settings" in result["relay"]["locatorText"]
    assert len(result["relay"]["locatorText"].splitlines()) <= 5


def test_unknown_model_receives_complete_text_relay_without_attachment() -> None:
    result = VisualRelayPlanner().plan(
        profile=ModelProfile.from_dict(profile_payload(provider="openai-compatible", baseUrl="https://example.invalid/v1")),
        resolved_capabilities={"visionInput": "unknown", "source": "unknown"},
        target=target(),
        capture=decision(mode="local_screenshot", upload=False),
        intent="explain this button",
    )

    assert result["ok"] is True
    assert result["relay"]["mode"] == "structured_text"
    assert result["relay"]["attachments"] == []
    assert result["relay"]["grounding"]["role"] == "button"
    assert result["relay"]["grounding"]["hierarchy"] == ["Settings", "Model profile", "Actions"]
    assert result["relay"]["appearance"] == {
        "foreground": "#1266D4",
        "background": "#FFFFFF",
        "shape": "rounded-rectangle",
        "localImageSummary": "Blue rounded Save button under the pointer.",
    }
    assert result["relay"]["spatial"]["neighbors"] == ["Cancel is 12px left"]
    assert result["relay"]["uncertainty"] == ["disabled state not confirmed"]
    assert result["relay"]["provenance"] == ["UIA", "RapidOCR"]
    assert "Save" in result["relay"]["structuredText"]
    assert "rounded-rectangle" in result["relay"]["structuredText"]
    assert ".png" not in result["relay"]["structuredText"]
    assert result["relay"]["capabilityNotice"] == "vision_capability_unconfirmed"


def test_non_visual_model_has_distinct_capability_notice() -> None:
    result = VisualRelayPlanner().plan(
        profile=ModelProfile.from_dict(profile_payload()),
        resolved_capabilities={"visionInput": "no", "source": "explicit_probe"},
        target=target(),
        capture=decision(mode="upload_screenshot", upload=True),
        intent="explain this button",
    )

    assert result["relay"]["mode"] == "structured_text"
    assert result["relay"]["attachments"] == []
    assert result["relay"]["capabilityNotice"] == "vision_input_not_supported"


def test_denied_capture_fails_before_creating_any_relay() -> None:
    result = VisualRelayPlanner().plan(
        profile=ModelProfile.from_dict(profile_payload()),
        resolved_capabilities={"visionInput": "yes", "source": "catalog"},
        target=target(),
        capture=decision(mode="deny", upload=False, structure=False),
        intent="explain this",
    )

    assert result == {"ok": False, "state": "failed", "error": "capture_policy_denied", "evidence": {"mode": "deny"}}
