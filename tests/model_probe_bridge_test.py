from __future__ import annotations

import json

from app.fabric.settings import FabricSettings, SettingsStore
from app.models.capability_resolver import ModelCapabilityResolver
from app.models.profiles import ModelProfile, ModelProfileStore
from scripts.fabric_bridge import _test_model_profile


def _profile() -> ModelProfile:
    return ModelProfile.from_dict({
        "schemaVersion": 1,
        "id": "custom",
        "displayName": "Custom text model",
        "provider": "openai-compatible",
        "baseUrl": "https://example.invalid/v1",
        "model": "custom-model",
        "apiMode": "chat-completions",
        "credentialRef": "credential:model:custom",
        "enabled": True,
        "overrides": {"visionInput": "auto", "audioInput": "auto", "toolCalls": "auto"},
    })


class _ProbeClient:
    def complete_text(self, *_args, **_kwargs):
        return {"ok": True, "state": "completed", "text": "OK"}

    def probe_vision(self, *_args, **_kwargs):
        return {"ok": True, "state": "completed", "visionInput": "no", "evidence": {}}


def test_user_requested_probe_persists_non_visual_capability_without_secret(tmp_path) -> None:
    profile = _profile()
    settings = FabricSettings.defaults()
    settings.models = ModelProfileStore(profiles=(profile,), default_profile_id=profile.id)
    store = SettingsStore(tmp_path / "fabric-settings.json")
    store.save(settings)

    result = _test_model_profile(
        store=store,
        settings=settings,
        profile=profile,
        credential="ephemeral-secret",
        client=_ProbeClient(),  # type: ignore[arg-type]
        resolver=ModelCapabilityResolver(),
    )

    persisted = store.load().models.profile("custom")
    assert result["ok"] is True
    assert result["visionInput"] == "no"
    assert persisted is not None
    assert persisted.resolved["visionInput"] == "no"
    assert persisted.resolved["source"] == "explicit_probe"
    assert "ephemeral-secret" not in json.dumps(result)
    assert "ephemeral-secret" not in (tmp_path / "fabric-settings.json").read_text(encoding="utf-8")
