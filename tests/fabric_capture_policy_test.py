from __future__ import annotations

from pathlib import Path

import pytest

from app.fabric.capture_policy import CapturePolicyEngine, build_capture_policy


def _object(app: str, path: str = "", *, attestation: dict | None = None) -> dict:
    verified = {
        "status": "verified",
        "phase": "complete",
        "expected": {
            "hwnd": 42,
            "processId": 314,
            "processName": app,
            "title": f"{app} document",
            "desktopId": "desktop-1",
        },
    }
    return {
        "id": "screen-1",
        "kind": "screen_region",
        "source": {
            "app": app,
            "title": f"{app} document",
            "screenshotPath": path,
            "path": path,
            "captureAttestation": verified if attestation is None else attestation,
        },
    }


def test_sensitive_app_withholds_pixels_even_when_global_upload_is_on(tmp_path: Path) -> None:
    image = tmp_path / "capture.png"
    image.write_bytes(b"pixels")
    policy = CapturePolicyEngine(
        upload_screenshots=True,
        default_mode="follow_global",
        sensitive_apps=["1password"],
        app_modes={"1password": "upload_screenshot"},
    )
    decision = policy.decide(_object("1Password", str(image)))
    assert decision.mode == "structured_only"
    assert decision.allow_structure is True
    assert decision.allow_local_pixels is False
    assert decision.allow_upload is False
    assert decision.reason == "sensitive_app"


def test_explicit_upload_still_needs_global_switch(tmp_path: Path) -> None:
    image = tmp_path / "capture.png"
    image.write_bytes(b"pixels")
    policy = CapturePolicyEngine(
        upload_screenshots=False,
        default_mode="follow_global",
        sensitive_apps=[],
        app_modes={"figma": "upload_screenshot"},
    )
    decision = policy.decide(_object("Figma", str(image)))
    assert decision.configured_mode == "upload_screenshot"
    assert decision.mode == "local_screenshot"
    assert decision.allow_upload is False
    assert decision.reason == "global_upload_disabled"


def test_follow_global_preserves_existing_upload_switch_behavior(tmp_path: Path) -> None:
    image = tmp_path / "capture.png"
    image.write_bytes(b"pixels")
    enabled = CapturePolicyEngine(True, "follow_global", [], {})
    disabled = CapturePolicyEngine(False, "follow_global", [], {})
    assert enabled.decide(_object("Edge", str(image))).mode == "upload_screenshot"
    assert enabled.decide(_object("Edge", str(image))).allow_upload is True
    assert disabled.decide(_object("Edge", str(image))).mode == "local_screenshot"
    assert disabled.decide(_object("Edge", str(image))).allow_upload is False


def test_longest_matching_app_rule_wins_and_deny_blocks_structure() -> None:
    policy = CapturePolicyEngine(
        upload_screenshots=True,
        default_mode="follow_global",
        sensitive_apps=[],
        app_modes={"chrome": "local_ocr", "chrome incognito": "deny"},
    )
    decision = policy.decide(_object("Google Chrome Incognito"))
    assert decision.matched_rule == "chrome incognito"
    assert decision.mode == "deny"
    assert decision.allow_structure is False
    assert decision.allow_local_pixels is False
    assert decision.allow_upload is False


def test_capture_plan_only_allowlists_visual_paths_for_uploadable_objects(tmp_path: Path) -> None:
    public_image = tmp_path / "public.png"
    sensitive_image = tmp_path / "private.png"
    annotated_image = tmp_path / "annotated.png"
    note = tmp_path / "context.json"
    for path in (public_image, sensitive_image, annotated_image, note):
        path.write_bytes(b"fixture")
    engine = CapturePolicyEngine(
        upload_screenshots=True,
        default_mode="follow_global",
        sensitive_apps=["bank"],
        app_modes={},
    )
    objects = [_object("Edge", str(public_image)), _object("Bank Portal", str(sensitive_image))]
    result = build_capture_policy(
        engine,
        objects,
        attachments=[str(public_image), str(sensitive_image), str(annotated_image), str(note)],
    )
    assert result["uploadAllowedPaths"] == [str(public_image)]
    assert sorted(result["withheldVisualPaths"]) == sorted([str(sensitive_image), str(annotated_image)])
    assert result["nonVisualArtifactPaths"] == [str(note)]
    assert result["deniedObjectIds"] == []


def test_screen_region_without_target_attestation_is_never_uploadable(tmp_path: Path) -> None:
    image = tmp_path / "capture.png"
    image.write_bytes(b"pixels")
    obj = _object("Edge", str(image))
    del obj["source"]["captureAttestation"]
    engine = CapturePolicyEngine(True, "follow_global", [], {})

    decision = engine.decide(obj)
    result = build_capture_policy(engine, [obj], attachments=[str(image)])

    assert decision.mode == "local_screenshot"
    assert decision.allow_local_pixels is True
    assert decision.allow_upload is False
    assert decision.reason == "target_attestation_missing"
    assert result["uploadAllowedPaths"] == []
    assert result["withheldVisualPaths"] == [str(image)]


def test_target_mismatch_attestation_blocks_pixels_and_upload(tmp_path: Path) -> None:
    image = tmp_path / "capture.png"
    image.write_bytes(b"pixels")
    obj = _object("Edge", str(image), attestation={
        "status": "target_mismatch",
        "phase": "after_capture",
    })
    engine = CapturePolicyEngine(True, "follow_global", [], {})

    decision = engine.decide(obj)
    result = build_capture_policy(engine, [obj], attachments=[str(image)])

    assert decision.mode == "structured_only"
    assert decision.allow_local_pixels is False
    assert decision.allow_upload is False
    assert decision.reason == "target_mismatch"
    assert result["uploadAllowedPaths"] == []
    assert result["withheldVisualPaths"] == [str(image)]


def test_invalid_capture_mode_fails_closed() -> None:
    with pytest.raises(ValueError, match="capture mode"):
        CapturePolicyEngine(
            upload_screenshots=True,
            default_mode="send_everything",
            sensitive_apps=[],
            app_modes={},
        )
