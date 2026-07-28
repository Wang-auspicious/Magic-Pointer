from __future__ import annotations

from copy import deepcopy

from app.context_pack.capture_policy import build_context_capture_policy
from app.context_pack.compiler import compile_context_prompt
from app.fabric.settings import FabricSettings


def context_session() -> dict:
    return {
        "session_id": "context-policy",
        "items": [
            {
                "item_id": "native",
                "sequence": 1,
                "modality": "native_selection",
                "instruction": "native evidence",
                "source": {"app": "code", "window": {"title": "Editor"}},
                "selected_text": "selected",
                "surrounding_context": "surrounding",
                "geometry": {},
                "images": {},
                "grounding": {},
                "vision_observation": "",
            }
        ],
    }


def _visual_item(*, item_id: str, app: str, title: str, stem: str) -> dict:
    return {
        "item_id": item_id,
        "sequence": 1,
        "modality": "visual_pointer",
        "instruction": f"evidence from {app}",
        "source": {
            "app": app,
            "window": {"title": title, "process_name": app},
            "capture_attestation": {"status": "verified"},
        },
        "selected_text": "",
        "surrounding_context": "",
        "geometry": {"point": [10, 20]},
        "images": {
            "raw": rf"D:\captures\{stem}-raw.png",
            "pointer": rf"D:\captures\{stem}-pointer.png",
        },
        "grounding": {"label": f"{stem}-grounding"},
        "vision_observation": f"{stem}-private-visual-observation",
        "file_context": {},
        "app_context": {},
    }


def _settings() -> FabricSettings:
    settings = FabricSettings.defaults()
    settings.privacy.upload_screenshots = True
    settings.privacy.default_capture_mode = "structured_only"
    settings.privacy.app_capture_modes = {
        "edge": "upload_screenshot",
        "1password": "deny",
        "figma": "local_screenshot",
    }
    return settings


def test_context_pack_applies_per_app_policy_to_each_item() -> None:
    session = deepcopy(context_session())
    session["items"] = [
        _visual_item(item_id="edge", app="msedge.exe", title="Checkout - Edge", stem="edge"),
        _visual_item(item_id="vault", app="1Password.exe", title="Private Vault", stem="vault"),
        _visual_item(item_id="figma", app="Figma.exe", title="Draft - Figma", stem="figma"),
    ]
    for sequence, item in enumerate(session["items"], 1):
        item["sequence"] = sequence

    prompt = compile_context_prompt(
        session,
        task_instruction="inspect allowed evidence",
        capture_policy=build_context_capture_policy(_settings()),
    )

    assert r"D:\captures\edge-raw.png" in prompt
    assert r"D:\captures\edge-pointer.png" in prompt
    assert "edge-private-visual-observation" in prompt
    assert "vault" not in prompt.casefold()
    assert "vault-private-visual-observation" not in prompt
    assert r"D:\captures\figma-raw.png" not in prompt
    assert "figma-private-visual-observation" in prompt
    assert "per-app capture policy" in prompt


def test_structured_only_visual_item_drops_pixel_derived_content() -> None:
    settings = _settings()
    settings.privacy.app_capture_modes = {"edge": "structured_only"}
    session = {"session_id": "structured", "items": [
        _visual_item(item_id="edge", app="msedge.exe", title="Checkout - Edge", stem="edge")
    ]}

    prompt = compile_context_prompt(
        session,
        task_instruction="inspect structure",
        capture_policy=build_context_capture_policy(settings),
    )

    assert "Checkout - Edge" in prompt
    assert "edge-private-visual-observation" not in prompt
    assert "edge-grounding" not in prompt
    assert ".png" not in prompt


def test_missing_capture_attestation_fails_closed_for_upload_rule() -> None:
    item = _visual_item(item_id="edge", app="msedge.exe", title="Checkout - Edge", stem="edge")
    item["source"].pop("capture_attestation")
    session = {"session_id": "unverified", "items": [item]}

    prompt = compile_context_prompt(
        session,
        task_instruction="inspect evidence",
        capture_policy=build_context_capture_policy(_settings()),
    )

    assert ".png" not in prompt
    assert "edge-private-visual-observation" in prompt
    assert "per-app capture policy" in prompt
