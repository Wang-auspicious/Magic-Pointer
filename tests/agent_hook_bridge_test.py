from __future__ import annotations

import json
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

from app.fabric.hooks import build_hook_response, prompt_references_pointer
from app.fabric.settings import FabricSettings, SettingsStore


def _write_episode(root: Path, *, expires: datetime, attested: bool = False) -> None:
    (root / "current-object.json").write_text(json.dumps({
        "schemaVersion": 1,
        "episodeId": "ep-1",
        "expiresAt": expires.isoformat(),
        "slots": {"this": {"objectId": "screen-1"}},
        "objects": [{
            "id": "screen-1",
            "kind": "screen_region",
            "label": "THIS · design",
            "bbox": [10, 20, 300, 240],
            "source": {
                "app": "screen",
                "title": "Design review",
                "path": r"D:\captures\screen.png",
                **({"captureAttestation": {
                    "status": "verified",
                    "phase": "complete",
                    "expected": {
                        "hwnd": 42,
                        "processId": 314,
                        "title": "Design review",
                        "desktopId": "desktop-1",
                    },
                }} if attested else {}),
            },
        }],
    }), encoding="utf-8")


def test_reference_detection_is_explicit_not_every_prompt() -> None:
    assert prompt_references_pointer("修这个")
    assert prompt_references_pointer("explain @pointer and fix it")
    assert not prompt_references_pointer("run all unit tests")
    assert prompt_references_pointer("比较这些对象")


def test_claude_user_prompt_hook_injects_frozen_object(tmp_path: Path) -> None:
    now = datetime(2026, 7, 26, tzinfo=timezone.utc)
    _write_episode(tmp_path, expires=now + timedelta(minutes=3))
    response = build_hook_response(
        "claude",
        {"hook_event_name": "UserPromptSubmit", "prompt": "修这个"},
        root=tmp_path,
        now=now,
    )
    output = response["hookSpecificOutput"]
    assert output["hookEventName"] == "UserPromptSubmit"
    assert "screen-1" in output["additionalContext"]
    assert r"D:\captures\screen.png" not in output["additionalContext"]
    assert "withheld visual objects: 1" in output["additionalContext"]
    assert "Context Packet:" in output["additionalContext"]
    assert "Relevant capabilities (bounded search)" in output["additionalContext"]
    assert response["suppressOutput"] is True


def test_gemini_before_agent_hook_injects_context_but_expired_object_does_not(tmp_path: Path) -> None:
    now = datetime(2026, 7, 26, tzinfo=timezone.utc)
    _write_episode(tmp_path, expires=now + timedelta(seconds=1))
    live = build_hook_response(
        "gemini",
        {"hook_event_name": "BeforeAgent", "prompt": "Use this screen to diagnose the issue"},
        root=tmp_path,
        now=now,
    )
    assert live["hookSpecificOutput"]["hookEventName"] == "BeforeAgent"

    expired = build_hook_response(
        "gemini",
        {"hook_event_name": "BeforeAgent", "prompt": "Use this screen"},
        root=tmp_path,
        now=now + timedelta(seconds=2),
    )
    assert expired == {}


def test_unrelated_event_or_prompt_does_not_silently_inject(tmp_path: Path) -> None:
    now = datetime(2026, 7, 26, tzinfo=timezone.utc)
    _write_episode(tmp_path, expires=now + timedelta(minutes=3))
    assert build_hook_response(
        "claude",
        {"hook_event_name": "PreToolUse", "prompt": "修这个"},
        root=tmp_path,
        now=now,
    ) == {}
    assert build_hook_response(
        "claude",
        {"hook_event_name": "UserPromptSubmit", "prompt": "run tests"},
        root=tmp_path,
        now=now,
    ) == {}


def test_hook_bridge_cli_roundtrips_utf8_on_windows(tmp_path: Path) -> None:
    now = datetime.now(timezone.utc)
    _write_episode(tmp_path, expires=now + timedelta(minutes=3))
    episode_path = tmp_path / "current-object.json"
    episode = json.loads(episode_path.read_text(encoding="utf-8"))
    episode["objects"][0]["label"] = "THIS · 中文屏幕对象"
    episode["objects"][0]["source"]["title"] = "个人\u200b Edge"
    episode_path.write_text(json.dumps(episode, ensure_ascii=False), encoding="utf-8")

    completed = subprocess.run(
        [
            sys.executable,
            str(Path(__file__).resolve().parents[1] / "scripts" / "agent_hook_bridge.py"),
            "--provider",
            "claude",
            "--root",
            str(tmp_path),
        ],
        input=json.dumps({
            "hook_event_name": "UserPromptSubmit",
            "prompt": "修这个屏幕对象",
        }, ensure_ascii=False).encode("utf-8"),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )

    assert completed.returncode == 0, completed.stderr.decode("utf-8", errors="replace")
    payload = json.loads(completed.stdout.decode("utf-8"))
    context = payload["hookSpecificOutput"]["additionalContext"]
    assert "中文屏幕对象" in context
    assert "个人\u200b Edge" in context


def test_hook_only_exposes_visual_path_when_app_and_global_policy_allow_it(tmp_path: Path) -> None:
    now = datetime(2026, 7, 26, tzinfo=timezone.utc)
    _write_episode(tmp_path, expires=now + timedelta(minutes=3), attested=True)
    settings = FabricSettings.defaults()
    settings.privacy.upload_screenshots = True
    settings.privacy.app_capture_modes = {"screen": "upload_screenshot"}
    SettingsStore(tmp_path / "fabric-settings.json").save(settings)

    response = build_hook_response(
        "claude",
        {
            "hook_event_name": "UserPromptSubmit",
            "prompt": "修这个屏幕对象",
            "cwd": str(tmp_path),
        },
        root=tmp_path,
        now=now,
    )
    context = response["hookSpecificOutput"]["additionalContext"]
    assert r"D:\captures\screen.png" in context
    assert "uploadable visual objects: 1" in context


def test_sensitive_app_hook_withholds_visual_even_under_explicit_upload_rule(tmp_path: Path) -> None:
    now = datetime(2026, 7, 26, tzinfo=timezone.utc)
    _write_episode(tmp_path, expires=now + timedelta(minutes=3))
    episode_path = tmp_path / "current-object.json"
    episode = json.loads(episode_path.read_text(encoding="utf-8"))
    episode["objects"][0]["source"]["app"] = "1Password"
    episode["objects"][0]["source"]["title"] = "Vault"
    episode_path.write_text(json.dumps(episode), encoding="utf-8")
    settings = FabricSettings.defaults()
    settings.privacy.upload_screenshots = True
    settings.privacy.app_capture_modes = {"1password": "upload_screenshot"}
    SettingsStore(tmp_path / "fabric-settings.json").save(settings)

    response = build_hook_response(
        "gemini",
        {
            "hookEventName": "BeforeAgent",
            "prompt": "Use this screen",
            "cwd": str(tmp_path),
        },
        root=tmp_path,
        now=now,
    )
    context = response["hookSpecificOutput"]["additionalContext"]
    assert r"D:\captures\screen.png" not in context
    assert "withheld visual objects: 1" in context


def test_denied_app_is_not_silently_injected_into_agent_hook(tmp_path: Path) -> None:
    now = datetime(2026, 7, 26, tzinfo=timezone.utc)
    _write_episode(tmp_path, expires=now + timedelta(minutes=3))
    settings = FabricSettings.defaults()
    settings.privacy.app_capture_modes = {"screen": "deny"}
    SettingsStore(tmp_path / "fabric-settings.json").save(settings)
    response = build_hook_response(
        "claude",
        {"hook_event_name": "UserPromptSubmit", "prompt": "修这个"},
        root=tmp_path,
        now=now,
    )
    assert response == {}
