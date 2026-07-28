from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]


def invoke(root: Path, payload: dict[str, Any]) -> dict[str, Any]:
    env = os.environ.copy()
    env["MAGIC_POINTER_USER_DATA_DIR"] = str(root)
    completed = subprocess.run(
        [sys.executable, "scripts/fabric_bridge.py"],
        cwd=ROOT,
        env=env,
        input=json.dumps(payload, ensure_ascii=False),
        text=True,
        encoding="utf-8",
        capture_output=True,
        check=False,
    )
    return json.loads(completed.stdout)


def profile() -> dict[str, Any]:
    return {
        "schemaVersion": 1,
        "id": "primary",
        "displayName": "工作模型",
        "provider": "openai-compatible",
        "baseUrl": "https://example.invalid/v1",
        "model": "local-model",
        "apiMode": "chat-completions",
        "credentialRef": "credential:model:primary",
        "enabled": True,
        "overrides": {"visionInput": "yes", "audioInput": "auto", "toolCalls": "auto"},
        "resolved": {"visionInput": "unknown", "audioInput": "unknown", "toolCalls": "unknown", "source": "unknown", "evidence": "", "checkedAt": ""},
    }


def test_model_bridge_persists_profile_resolves_capability_and_plans_visual_relay(tmp_path: Path) -> None:
    saved = invoke(tmp_path, {"operation": "models.save", "profile": profile()})
    assert saved["ok"] is True
    assert saved["state"] == "saved"
    assert saved["profile"]["resolved"]["visionInput"] == "yes"
    assert saved["profile"]["resolved"]["source"] == "manual_override"

    defaulted = invoke(tmp_path, {"operation": "models.set_default", "profileId": "primary"})
    assert defaulted == {"ok": True, "state": "saved", "defaultProfileId": "primary", "evidence": {"profileId": "primary"}}

    inspected = invoke(tmp_path, {"operation": "models.inspect", "profileId": "primary"})
    assert inspected["ok"] is True
    assert inspected["profile"]["credentialRef"] == "credential:model:primary"
    assert "apiKey" not in json.dumps(inspected)

    settings = invoke(tmp_path, {"operation": "settings.get"})["settings"]
    settings["privacy"]["upload_screenshots"] = True
    settings["privacy"]["app_capture_modes"] = {"code.exe": "upload_screenshot"}
    assert invoke(tmp_path, {"operation": "settings.save", "settings": settings})["ok"] is True

    relay = invoke(tmp_path, {
        "operation": "visual_relay.plan",
        "profileId": "primary",
        "intent": "检查这个保存按钮",
        "target": {
            "id": "save-button",
            "kind": "ui-control",
            "label": "Save",
            "bbox": [812, 124, 884, 158],
            "content": "Save",
            "elements": [{"role": "button", "name": "Save"}],
            "source": {
                "app": "code.exe",
                "title": "Settings",
                "screenshotPath": "D:/capture/save.png",
                "captureAttestation": {"status": "verified"},
            },
        },
    })
    assert relay["ok"] is True
    assert relay["relay"]["mode"] == "direct_visual"
    assert relay["relay"]["attachments"] == ["D:/capture/save.png"]
    assert relay["evidence"]["captureMode"] == "upload_screenshot"


def test_model_test_without_ephemeral_credential_fails_without_echoing_secret(tmp_path: Path) -> None:
    assert invoke(tmp_path, {"operation": "models.save", "profile": profile()})["ok"] is True

    result = invoke(tmp_path, {"operation": "models.test", "profileId": "primary"})

    assert result == {
        "ok": False,
        "state": "failed",
        "error": "credential_missing",
        "evidence": {"profileId": "primary", "apiMode": "chat-completions"},
    }
