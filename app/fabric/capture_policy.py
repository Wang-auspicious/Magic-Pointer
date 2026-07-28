from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable


CAPTURE_MODES = frozenset({
    "follow_global",
    "structured_only",
    "local_ocr",
    "local_screenshot",
    "upload_screenshot",
    "deny",
})
_VISUAL_SUFFIXES = {
    ".png",
    ".jpg",
    ".jpeg",
    ".bmp",
    ".gif",
    ".tif",
    ".tiff",
    ".webp",
    ".heic",
    ".avif",
}


def _validate_mode(mode: str) -> str:
    value = str(mode or "").strip().casefold()
    if value not in CAPTURE_MODES:
        raise ValueError(f"unsupported capture mode: {mode or '<empty>'}")
    return value


def _identity(obj: dict[str, Any]) -> str:
    source = obj.get("source")
    source = dict(source) if isinstance(source, dict) else {}
    return " ".join(
        str(item or "").strip()
        for item in (
            obj.get("app"),
            source.get("app"),
            source.get("processName"),
            source.get("process_name"),
            source.get("executable"),
            source.get("title"),
        )
        if str(item or "").strip()
    ).casefold()


def _visual_path(value: str) -> bool:
    return Path(str(value or "")).suffix.casefold() in _VISUAL_SUFFIXES


def _object_paths(obj: dict[str, Any]) -> list[str]:
    source = obj.get("source")
    source = dict(source) if isinstance(source, dict) else {}
    values: list[str] = []
    for candidate in (
        obj.get("path"),
        source.get("imagePath"),
        source.get("screenshotPath"),
        source.get("capturePath"),
        source.get("annotatedPath"),
        source.get("path"),
    ):
        value = str(candidate or "").strip()
        if value and value not in values:
            values.append(value)
    return values


def _capture_attestation(obj: dict[str, Any]) -> dict[str, Any]:
    source = obj.get("source")
    source = dict(source) if isinstance(source, dict) else {}
    value = source.get("captureAttestation") or source.get("capture_attestation")
    return dict(value) if isinstance(value, dict) else {}


def _requires_target_attestation(obj: dict[str, Any]) -> bool:
    source = obj.get("source")
    source = dict(source) if isinstance(source, dict) else {}
    kind = str(obj.get("kind") or source.get("kind") or "").strip().casefold()
    explicit_capture_path = any(
        str(source.get(key) or "").strip()
        for key in ("screenshotPath", "capturePath", "annotatedPath")
    )
    return bool(_object_paths(obj)) and (
        explicit_capture_path
        or kind in {"screen_region", "ui-control", "canvas", "video_frame"}
    )


@dataclass(frozen=True)
class CaptureDecision:
    object_id: str
    configured_mode: str
    mode: str
    allow_structure: bool
    allow_local_pixels: bool
    allow_upload: bool
    reason: str
    matched_rule: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "objectId": self.object_id,
            "configuredMode": self.configured_mode,
            "mode": self.mode,
            "allowStructure": self.allow_structure,
            "allowLocalPixels": self.allow_local_pixels,
            "allowUpload": self.allow_upload,
            "reason": self.reason,
            "matchedRule": self.matched_rule,
        }


class CapturePolicyEngine:
    def __init__(
        self,
        upload_screenshots: bool,
        default_mode: str,
        sensitive_apps: Iterable[str],
        app_modes: dict[str, str],
    ) -> None:
        self.upload_screenshots = upload_screenshots is True
        self.default_mode = _validate_mode(default_mode)
        self.sensitive_apps = tuple(
            str(item).strip().casefold()
            for item in sensitive_apps
            if str(item).strip()
        )
        self.app_modes = {
            str(pattern).strip().casefold(): _validate_mode(mode)
            for pattern, mode in dict(app_modes or {}).items()
            if str(pattern).strip()
        }

    def _rule(self, identity: str) -> tuple[str | None, str]:
        matches = [
            (pattern, mode)
            for pattern, mode in self.app_modes.items()
            if pattern in identity
        ]
        if not matches:
            return None, self.default_mode
        pattern, mode = sorted(matches, key=lambda item: (-len(item[0]), item[0]))[0]
        return pattern, mode

    def decide(self, obj: dict[str, Any]) -> CaptureDecision:
        identity = _identity(obj)
        matched_rule, configured_mode = self._rule(identity)
        sensitive = next(
            (pattern for pattern in self.sensitive_apps if pattern in identity),
            None,
        )
        if sensitive:
            resolved = "deny" if configured_mode == "deny" else "structured_only"
            reason = "sensitive_app"
        elif configured_mode == "follow_global":
            resolved = "upload_screenshot" if self.upload_screenshots else "local_screenshot"
            reason = "global_upload_enabled" if self.upload_screenshots else "global_upload_disabled"
        elif configured_mode == "upload_screenshot" and not self.upload_screenshots:
            resolved = "local_screenshot"
            reason = "global_upload_disabled"
        else:
            resolved = configured_mode
            reason = "app_rule" if matched_rule else "default_rule"

        if resolved == "upload_screenshot" and _requires_target_attestation(obj):
            attestation_status = str(_capture_attestation(obj).get("status") or "").casefold()
            if attestation_status != "verified":
                if attestation_status == "target_mismatch":
                    resolved = "structured_only"
                    reason = "target_mismatch"
                else:
                    resolved = "local_screenshot"
                    reason = "target_attestation_missing"

        return CaptureDecision(
            object_id=str(obj.get("id") or obj.get("objectId") or ""),
            configured_mode=configured_mode,
            mode=resolved,
            allow_structure=resolved != "deny",
            allow_local_pixels=resolved in {
                "local_ocr",
                "local_screenshot",
                "upload_screenshot",
            },
            allow_upload=resolved == "upload_screenshot" and self.upload_screenshots,
            reason=reason,
            matched_rule=matched_rule,
        )

    def decide_all(self, objects: Iterable[dict[str, Any]]) -> list[CaptureDecision]:
        return [self.decide(dict(item)) for item in objects if isinstance(item, dict)]


def build_capture_policy(
    engine: CapturePolicyEngine,
    objects: Iterable[dict[str, Any]],
    *,
    attachments: Iterable[str] = (),
) -> dict[str, Any]:
    clean_objects = [dict(item) for item in objects if isinstance(item, dict)]
    decisions = engine.decide_all(clean_objects)
    decisions_by_path: dict[str, CaptureDecision] = {}
    for obj, decision in zip(clean_objects, decisions):
        for path in _object_paths(obj):
            decisions_by_path[str(Path(path).expanduser()).casefold()] = decision

    upload_allowed: list[str] = []
    withheld_visual: list[str] = []
    nonvisual: list[str] = []
    all_objects_uploadable = bool(decisions) and all(
        decision.allow_upload for decision in decisions
    )
    for raw in attachments:
        value = str(raw or "").strip()
        if not value:
            continue
        if not _visual_path(value):
            if value not in nonvisual:
                nonvisual.append(value)
            continue
        linked = decisions_by_path.get(str(Path(value).expanduser()).casefold())
        allowed = linked.allow_upload if linked is not None else all_objects_uploadable
        target = upload_allowed if allowed else withheld_visual
        if value not in target:
            target.append(value)

    return {
        "schemaVersion": 1,
        "globalScreenshotUploadEnabled": engine.upload_screenshots,
        "decisions": [decision.to_dict() for decision in decisions],
        "uploadAllowedPaths": upload_allowed,
        "withheldVisualPaths": withheld_visual,
        "withheldVisualCount": len(withheld_visual),
        "nonVisualArtifactPaths": nonvisual,
        "deniedObjectIds": [
            decision.object_id
            for decision in decisions
            if decision.mode == "deny"
        ],
        "requiresExplicitConfirmation": bool(upload_allowed),
    }
