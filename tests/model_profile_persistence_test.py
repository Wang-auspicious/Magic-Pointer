from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys

import pytest

from app.fabric.settings import FabricSettings, SettingsStore
from app.models.profiles import ModelProfile, ModelProfileError, ModelProfileStore
from scripts.fabric_bridge import _set_default_model


def _profile() -> ModelProfile:
    return ModelProfile.from_dict({
        "schemaVersion": 1,
        "id": "audit-local",
        "displayName": "Local audit profile",
        "provider": "local",
        "baseUrl": "http://127.0.0.1:11434/v1",
        "model": "audit-model",
        "apiMode": "local",
        "credentialRef": "",
    })


def test_saved_model_settings_reload_their_own_token_limits(tmp_path: Path) -> None:
    settings = FabricSettings.defaults()
    settings.models = ModelProfileStore((_profile(),), "audit-local")
    store = SettingsStore(tmp_path / "fabric-settings.json")
    store.save(settings)

    reloaded = store.load()

    assert reloaded.models == settings.models
    assert reloaded.models.profile().default_max_tokens == 32_768


def test_fabric_bridge_lists_persisted_model_settings(tmp_path: Path) -> None:
    settings = FabricSettings.defaults()
    settings.models = ModelProfileStore((_profile(),), "audit-local")
    SettingsStore(tmp_path / "fabric-settings.json").save(settings)
    root = Path(__file__).resolve().parents[1]

    result = subprocess.run(
        [sys.executable, "-B", str(root / "scripts" / "fabric_bridge.py")],
        input=json.dumps({"operation": "models.list"}) + "\n",
        text=True,
        capture_output=True,
        cwd=root,
        env={**os.environ, "MAGIC_POINTER_USER_DATA_DIR": str(tmp_path)},
        timeout=20,
        check=False,
    )
    response = json.loads(result.stdout)

    assert response["ok"] is True, response
    assert response["defaultProfileId"] == "audit-local"
    assert response["models"][0]["defaultMaxTokens"] == 32_768


def test_model_change_preserves_stash_and_context_trackers(tmp_path: Path) -> None:
    value = FabricSettings.defaults().to_dict()
    value["models"] = ModelProfileStore((_profile(),), None).to_dict()
    value["stash"] = {"clipboard": True, "text": False, "dir": str(tmp_path / "stash")}
    value["context_trackers"] = [{
        "trackerId": "tracker-audit",
        "task": "Read the updated notes and prepare a draft.",
        "sourceIds": ["source:attachment:D:/work/notes.txt"],
        "folderRoot": "",
        "outputType": "draft",
        "enabled": True,
        "trigger": {"kind": "filesystem", "paths": ["D:/work/notes.txt"], "debounceMs": 200},
        "lastObserved": None,
        "lastRun": None,
        "authorizationRevision": 1,
    }]
    settings_path = tmp_path / "fabric-settings.json"
    settings_path.write_text(json.dumps(value), encoding="utf-8")
    store = SettingsStore(settings_path)

    _set_default_model(store=store, settings=store.load(), profile_id="audit-local")

    persisted = json.loads(settings_path.read_text(encoding="utf-8"))
    assert persisted.get("stash") == value["stash"]
    assert persisted.get("context_trackers") == value["context_trackers"]
    assert persisted["models"]["defaultProfileId"] == "audit-local"


@pytest.mark.parametrize("field", ["apiKey", "apiToken", "secret", "credential", "password", "authorization"])
def test_token_limit_exception_keeps_rejecting_credentials(field: str) -> None:
    value = _profile().to_dict()
    value[field] = "not-a-real-secret"

    with pytest.raises(ModelProfileError, match="credential values"):
        ModelProfile.from_dict(value)
