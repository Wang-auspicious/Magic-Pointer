from __future__ import annotations

from typing import Any, Callable

from app.fabric.capture_policy import CapturePolicyEngine
from app.fabric.settings import FabricSettings


def context_item_object(item: dict[str, Any]) -> dict[str, Any]:
    """Translate a persisted Context Pack item into the shared capture-policy contract."""
    source = item.get("source")
    source = dict(source) if isinstance(source, dict) else {}
    window = source.get("window")
    window = dict(window) if isinstance(window, dict) else {}
    images = item.get("images")
    images = dict(images) if isinstance(images, dict) else {}
    raw_path = str(images.get("raw") or "").strip()
    pointer_path = str(images.get("pointer") or "").strip()
    visual = bool(raw_path or pointer_path or item.get("modality") == "visual_pointer")
    capture_attestation = source.get("capture_attestation") or source.get("captureAttestation")
    return {
        "id": str(item.get("item_id") or ""),
        "kind": "screen_region" if visual else "native_selection",
        "source": {
            "app": str(source.get("app") or ""),
            "processName": str(window.get("process_name") or window.get("processName") or ""),
            "title": str(window.get("title") or ""),
            "imagePath": raw_path,
            "annotatedPath": pointer_path,
            "captureAttestation": (
                dict(capture_attestation) if isinstance(capture_attestation, dict) else {}
            ),
        },
    }


def build_context_capture_policy(
    settings: FabricSettings,
) -> Callable[[dict[str, Any]], dict[str, Any]]:
    engine = CapturePolicyEngine(
        settings.privacy.upload_screenshots,
        settings.privacy.default_capture_mode,
        settings.privacy.sensitive_apps,
        settings.privacy.app_capture_modes,
    )

    def decide(item: dict[str, Any]) -> dict[str, Any]:
        return engine.decide(context_item_object(item)).to_dict()

    return decide


def stored_pointer_object(obj: dict[str, Any]) -> dict[str, Any]:
    screen_context = obj.get("screen_context")
    screen_context = dict(screen_context) if isinstance(screen_context, dict) else {}
    windows = screen_context.get("windows")
    primary_window = (
        dict(windows[0])
        if isinstance(windows, list) and windows and isinstance(windows[0], dict)
        else {}
    )
    capture_attestation = (
        screen_context.get("capture_attestation")
        or screen_context.get("captureAttestation")
    )
    return {
        "id": str(obj.get("id") or ""),
        "kind": str(obj.get("kind") or "screen_region"),
        "source": {
            "app": str(obj.get("app_title") or ""),
            "processName": str(primary_window.get("process_name") or ""),
            "title": str(primary_window.get("title") or obj.get("app_title") or ""),
            "imagePath": str(obj.get("image_path") or ""),
            "annotatedPath": str(screen_context.get("annotated_image_path") or ""),
            "captureAttestation": (
                dict(capture_attestation) if isinstance(capture_attestation, dict) else {}
            ),
        },
    }


def build_stored_object_capture_policy(
    settings: FabricSettings,
) -> Callable[[dict[str, Any]], dict[str, Any]]:
    engine = CapturePolicyEngine(
        settings.privacy.upload_screenshots,
        settings.privacy.default_capture_mode,
        settings.privacy.sensitive_apps,
        settings.privacy.app_capture_modes,
    )

    def decide(obj: dict[str, Any]) -> dict[str, Any]:
        return engine.decide(stored_pointer_object(obj)).to_dict()

    return decide
