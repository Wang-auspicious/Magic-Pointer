from __future__ import annotations

import json
from pathlib import Path

from app.fabric.settings import FabricSettings, SettingsStore


FIXTURE = Path(__file__).parent / "fixtures" / "model-profile-settings-v1.json"


def test_python_settings_preserve_shared_model_profile_fixture(tmp_path: Path) -> None:
    payload = json.loads(FIXTURE.read_text(encoding="utf-8"))
    settings = FabricSettings.from_dict(payload)

    assert settings.models.default_profile_id == "primary"
    assert settings.models.profile().model == "local-model"
    assert settings.to_dict()["models"] == payload["models"]

    path = SettingsStore(tmp_path / "fabric-settings.json").save(settings)
    assert json.loads(path.read_text(encoding="utf-8"))["models"] == payload["models"]
