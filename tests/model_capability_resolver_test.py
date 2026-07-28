from __future__ import annotations

from app.models.capability_resolver import ModelCapabilityResolver
from app.models.profiles import ModelProfile


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


def test_manual_override_beats_probe_provider_metadata_and_catalog() -> None:
    payload = profile_payload(overrides={"visionInput": "no", "audioInput": "auto", "toolCalls": "auto"})
    profile = ModelProfile.from_dict(payload)

    resolved = ModelCapabilityResolver().resolve(
        profile,
        explicit_probe={"visionInput": "yes", "checkedAt": "2026-07-27T00:00:00Z"},
        provider_metadata={"visionInput": "yes", "evidence": "provider metadata"},
    )

    assert resolved["visionInput"] == "no"
    assert resolved["source"] == "manual_override"


def test_custom_compatible_endpoint_never_infers_vision_from_model_name() -> None:
    profile = ModelProfile.from_dict(profile_payload(
        provider="openai-compatible",
        baseUrl="https://example.invalid/v1",
        model="gpt-4.1-mini",
    ))

    resolved = ModelCapabilityResolver().resolve(profile)

    assert resolved["visionInput"] == "unknown"
    assert resolved["source"] == "unknown"


def test_explicit_probe_beats_provider_metadata_and_catalog() -> None:
    profile = ModelProfile.from_dict(profile_payload())

    resolved = ModelCapabilityResolver().resolve(
        profile,
        explicit_probe={"visionInput": "no", "checkedAt": "2026-07-27T00:00:00Z"},
        provider_metadata={"visionInput": "yes", "evidence": "provider metadata"},
    )

    assert resolved["visionInput"] == "no"
    assert resolved["source"] == "explicit_probe"


def test_persisted_successful_probe_survives_restart_and_beats_catalog() -> None:
    payload = profile_payload()
    payload["resolved"] = {
        "visionInput": "no",
        "audioInput": "unknown",
        "toolCalls": "unknown",
        "source": "explicit_probe",
        "evidence": "user-requested 1x1 image probe returned unsupported",
        "checkedAt": "2026-07-27T12:00:00Z",
    }

    resolved = ModelCapabilityResolver().resolve(ModelProfile.from_dict(payload))

    assert resolved["visionInput"] == "no"
    assert resolved["source"] == "explicit_probe"
    assert resolved["checkedAt"] == "2026-07-27T12:00:00Z"
