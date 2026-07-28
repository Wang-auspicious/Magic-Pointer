from __future__ import annotations

from pathlib import Path
from typing import Any

from app.fabric.capture_policy import CaptureDecision
from app.models.profiles import ModelProfile


def _text(value: Any, limit: int = 2000) -> str:
    return str(value or "").replace("\r", " ").replace("\n", " ").strip()[:limit]


def _source(target: dict[str, Any]) -> dict[str, Any]:
    return dict(target.get("source") or {}) if isinstance(target.get("source"), dict) else {}


def _role(target: dict[str, Any]) -> str:
    elements = target.get("elements")
    if isinstance(elements, list):
        for element in elements:
            if isinstance(element, dict) and _text(element.get("role"), 120):
                return _text(element["role"], 120)
    return _text(target.get("role") or target.get("kind") or "unknown", 120)


def _string_list(value: Any, *, limit: int = 20, item_limit: int = 500) -> list[str]:
    if not isinstance(value, (list, tuple)):
        return []
    result: list[str] = []
    for item in value[:limit]:
        clean = _text(item, item_limit)
        if clean and clean not in result:
            result.append(clean)
    return result


def _visual_paths(target: dict[str, Any]) -> list[str]:
    source = _source(target)
    result: list[str] = []
    for raw in (
        source.get("screenshotPath"),
        source.get("imagePath"),
        source.get("capturePath"),
        source.get("annotatedPath"),
        source.get("path"),
    ):
        value = _text(raw, 4000)
        if (
            value
            and Path(value).suffix.casefold() in {
                ".png", ".jpg", ".jpeg", ".bmp", ".gif", ".tif", ".tiff", ".webp", ".heic", ".avif",
            }
            and value not in result
        ):
            result.append(value)
    return result[:2]


def _appearance(target: dict[str, Any]) -> dict[str, str]:
    raw = target.get("appearance")
    raw = dict(raw) if isinstance(raw, dict) else {}
    summary = (
        target.get("localImageSummary")
        or target.get("local_image_summary")
        or target.get("visionObservation")
        or target.get("vision_observation")
        or raw.get("localImageSummary")
    )
    return {
        "foreground": _text(raw.get("foreground") or target.get("foregroundColor") or "unknown", 80),
        "background": _text(raw.get("background") or target.get("backgroundColor") or "unknown", 80),
        "shape": _text(raw.get("shape") or target.get("shape") or "unknown", 160),
        "localImageSummary": _text(summary or "not available", 1200),
    }


def _structured_text(relay: dict[str, Any]) -> str:
    target = dict(relay["target"])
    grounding = dict(relay["grounding"])
    appearance = dict(relay["appearance"])
    spatial = dict(relay["spatial"])
    lines = [
        f"Target: {target.get('label') or 'unlabeled'}; kind={target.get('kind') or 'unknown'}; role={grounding.get('role') or 'unknown'}.",
        f"Source: app={target.get('app') or 'unknown'}; window={target.get('windowTitle') or 'unknown'}; bbox={target.get('bbox')!r}; pointer={spatial.get('relativeToPointer') or 'unknown'}.",
        f"OCR/text: {grounding.get('ocr') or 'not available'}.",
        f"Hierarchy: {' > '.join(grounding.get('hierarchy') or []) or 'not available'}.",
        (
            "Appearance: "
            f"foreground={appearance.get('foreground')}; background={appearance.get('background')}; "
            f"shape={appearance.get('shape')}; local summary={appearance.get('localImageSummary')}."
        ),
        f"Neighbors: {'; '.join(spatial.get('neighbors') or []) or 'not available'}.",
        f"Locator hints: {'; '.join(grounding.get('locatorHints') or []) or 'not available'}.",
        f"Uncertainty: {'; '.join(relay.get('uncertainty') or []) or 'none reported'}.",
        f"Provenance: {', '.join(relay.get('provenance') or []) or 'unknown'}.",
        f"User intent: {relay.get('intent') or 'not provided'}.",
    ]
    return "\n".join(lines)


class VisualRelayPlanner:
    """Build direct-visual or complete structured relay payloads from one frozen target."""

    def plan(
        self,
        *,
        profile: ModelProfile,
        resolved_capabilities: dict[str, Any],
        target: dict[str, Any],
        capture: CaptureDecision,
        intent: str,
    ) -> dict[str, Any]:
        if capture.mode == "deny" or not capture.allow_structure:
            return {
                "ok": False,
                "state": "failed",
                "error": "capture_policy_denied",
                "evidence": {"mode": "deny"},
            }
        source = _source(target)
        vision_input = _text(resolved_capabilities.get("visionInput") or "unknown", 20).casefold()
        if vision_input not in {"yes", "no", "unknown"}:
            vision_input = "unknown"
        title = _text(source.get("title") or source.get("windowTitle"), 1000)
        app = _text(source.get("app") or target.get("app"), 300)
        label = _text(target.get("label") or target.get("content") or target.get("text"), 1000)
        role = _role(target)
        hierarchy = _string_list(target.get("hierarchy"), limit=24, item_limit=300)
        if not hierarchy:
            hierarchy = [item for item in (title, label) if item]
        locator_hints = _string_list(target.get("locatorHints") or target.get("locator_hints"))
        if not locator_hints:
            locator_hints = [
                item for item in (
                    f"role={role}" if role and role != "unknown" else "",
                    f"name={label}" if label else "",
                ) if item
            ]
        base = {
            "schemaVersion": 1,
            "target": {
                "objectId": _text(target.get("id") or target.get("objectId"), 240),
                "kind": _text(target.get("kind"), 120),
                "label": label,
                "bbox": target.get("bbox"),
                "app": app,
                "windowTitle": title,
            },
            "grounding": {
                "ocr": _text(target.get("content") or target.get("text"), 8000),
                "role": role,
                "hierarchy": hierarchy,
                "locatorHints": locator_hints,
            },
            "appearance": _appearance(target),
            "spatial": {
                "relativeToPointer": _text(target.get("relativeToPointer") or "under-pointer", 120),
                "neighbors": _string_list(target.get("neighbors"), limit=20, item_limit=500),
            },
            "uncertainty": _string_list(target.get("uncertainty"), limit=20, item_limit=500),
            "provenance": _string_list(target.get("provenance") or ["grounded_object"], limit=20, item_limit=120),
            "intent": _text(intent, 6000),
            "profileId": profile.id,
        }
        visual_paths = _visual_paths(target)
        if vision_input == "yes" and capture.allow_upload and visual_paths:
            relay = {
                **base,
                "mode": "direct_visual",
                "attachments": visual_paths,
                "locatorText": "\n".join((
                    f"Object: {label or role}",
                    f"Source: {app or 'unknown'} · {title or 'unknown'}",
                    f"Pointer: {base['spatial']['relativeToPointer']}; bbox={target.get('bbox')}",
                    f"Intent: {base['intent'] or 'not provided'}",
                )),
            }
            return {"ok": True, "state": "planned", "relay": relay}
        if vision_input == "unknown":
            notice = "vision_capability_unconfirmed"
        elif vision_input == "no":
            notice = "vision_input_not_supported"
        else:
            notice = "visual_attachment_blocked_by_policy"
        relay = {
            **base,
            "mode": "structured_text",
            "attachments": [],
            "capabilityNotice": notice,
        }
        relay["structuredText"] = _structured_text(relay)
        return {"ok": True, "state": "planned", "relay": relay}
