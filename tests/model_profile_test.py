from __future__ import annotations

import pytest

from app.models.profiles import ModelProfile, ModelProfileError, ModelProfileStore


def profile_payload(**overrides: object) -> dict[str, object]:
    value: dict[str, object] = {
        "schemaVersion": 1,
        "id": "primary",
        "displayName": "工作模型",
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


def test_model_profile_round_trips_without_credential_value() -> None:
    profile = ModelProfile.from_dict(profile_payload())

    assert profile.id == "primary"
    assert profile.credential_ref == "credential:model:primary"
    assert profile.to_dict()["credentialRef"] == "credential:model:primary"
    assert "apiKey" not in profile.to_dict()


@pytest.mark.parametrize("secret_key", ["apiKey", "api_key", "token", "secret"])
def test_model_profile_rejects_plaintext_credential_fields(secret_key: str) -> None:
    payload = profile_payload(**{secret_key: "sk-do-not-store"})

    with pytest.raises(ModelProfileError, match="credential"):
        ModelProfile.from_dict(payload)


def test_model_profile_rejects_prefixed_or_suffixed_secret_field_names() -> None:
    for secret_key in ("openai_api_key", "providerTokenValue", "my-secret-copy"):
        payload = profile_payload()
        payload[secret_key] = "must-not-persist"
        with pytest.raises(ModelProfileError, match="credential"):
            ModelProfile.from_dict(payload)


def test_model_profile_store_rejects_missing_default_profile() -> None:
    with pytest.raises(ModelProfileError, match="defaultProfileId"):
        ModelProfileStore.from_dict({
            "schemaVersion": 1,
            "defaultProfileId": "missing",
            "profiles": [profile_payload()],
        })
