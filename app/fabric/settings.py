from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from app.fabric.capture_policy import CAPTURE_MODES
from app.models.profiles import ModelProfileError, ModelProfileStore


class SettingsError(RuntimeError):
    pass


_SHORTCUT_MODIFIERS = {"control", "alt", "shift", "super", "command", "commandorcontrol"}
_RESERVED_SHORTCUTS = {
    "control+alt+enter",
    "control+alt+shift+m",
    "control+alt+d",
}


def _normalized_shortcut(value: str) -> str:
    aliases = {"ctrl": "control", "option": "alt", "cmd": "command", "cmdorctrl": "commandorcontrol"}
    parts = [part.strip().casefold() for part in str(value or "").split("+") if part.strip()]
    if len(parts) < 2:
        return ""
    key = aliases.get(parts[-1], parts[-1])
    modifiers = [aliases.get(part, part) for part in parts[:-1]]
    if not modifiers or any(part not in _SHORTCUT_MODIFIERS for part in modifiers):
        return ""
    if key in _SHORTCUT_MODIFIERS or len(set(modifiers)) != len(modifiers):
        return ""
    order = ["commandorcontrol", "command", "control", "alt", "shift", "super"]
    modifiers.sort(key=order.index)
    return "+".join([*modifiers, key])


@dataclass
class GeneralSettings:
    launch_at_login: bool = False
    keep_running: bool = True
    update_channel: str = "stable"

    def __post_init__(self) -> None:
        self.update_channel = str(self.update_channel or "").strip().casefold()
        if self.update_channel not in {"stable", "preview"}:
            raise ValueError("general.update_channel is unsupported")


@dataclass
class NotificationSettings:
    completion: bool = True
    failure: bool = True


@dataclass
class ActivationSettings:
    wake_mode: str = "wiggle_hotkey"
    wiggle_enabled: bool = True
    sensitivity: float = 0.55
    fallback_hotkey_enabled: bool = True
    fallback_hotkey: str = "Control+Alt+M"
    keep_current_app_focus: bool = True
    dashboard_focus_after_action: bool = False
    mouse_side_button: str = "none"
    disabled_apps: list[str] = field(default_factory=lambda: [
        "blender",
        "krita",
        "photoshop",
        "premiere",
        "davinci resolve",
        "unity",
        "unreal",
    ])
    cooldown_ms: int = 900
    gesture_arm_delay_ms: int = 180
    gesture_timeout_ms: int = 5000
    multi_stroke_submit_ms: int = 10000
    gesture_interaction_mode: str = "pass_through"

    def __post_init__(self) -> None:
        self.wake_mode = str(self.wake_mode or "").strip().casefold()
        self.mouse_side_button = str(self.mouse_side_button or "").strip().casefold()
        self.gesture_interaction_mode = str(
            self.gesture_interaction_mode or "pass_through"
        ).strip().casefold()
        if self.wake_mode not in {"wiggle", "wiggle_hotkey", "hotkey", "mouse_button"}:
            raise ValueError("activation.wake_mode is unsupported")
        if self.mouse_side_button not in {"none", "xbutton1", "xbutton2", "middle_hold"}:
            raise ValueError("activation.mouse_side_button is unsupported")
        if self.gesture_interaction_mode not in {"pass_through", "exclusive_overlay"}:
            raise ValueError("activation.gesture_interaction_mode is unsupported")
        if self.wake_mode == "mouse_button" and self.mouse_side_button == "none":
            raise ValueError("activation.mouse_side_button must be bound for mouse_button wake mode")
        self.wiggle_enabled = self.wake_mode in {"wiggle", "wiggle_hotkey"}
        self.fallback_hotkey_enabled = self.wake_mode in {"wiggle_hotkey", "hotkey"}
        if not 60 <= int(self.gesture_arm_delay_ms) <= 600:
            raise ValueError("activation.gesture_arm_delay_ms must be between 60 and 600")
        if not 1000 <= int(self.gesture_timeout_ms) <= 15000:
            raise ValueError("activation.gesture_timeout_ms must be between 1000 and 15000")
        if not 1000 <= int(self.multi_stroke_submit_ms) <= 30000:
            raise ValueError("activation.multi_stroke_submit_ms must be between 1000 and 30000")
        self.gesture_arm_delay_ms = int(self.gesture_arm_delay_ms)
        self.gesture_timeout_ms = int(self.gesture_timeout_ms)
        self.multi_stroke_submit_ms = int(self.multi_stroke_submit_ms)


@dataclass
class InteractionSettings:
    default_input_mode: str = "voice"
    voice_auto_submit: bool = True
    voice_start_strategy: str = "auto"
    voice_silence_ms: int = 1600
    voice_language: str = "auto"
    voice_output_mode: str = "verbatim"
    voice_punctuation: str = "verbatim"
    voice_script: str = "unchanged"
    voice_mixed_spacing: str = "preserve"
    voice_hallucination_guard: bool = True
    voice_resident_enabled: bool = True
    voice_memory_limit_mb: int = 1024
    voice_idle_unload_ms: int = 0  # 0 = keep the voice model resident
    voice_glossaries: dict[str, list[str]] = field(default_factory=dict)

    def __post_init__(self) -> None:
        self.validate()

    def validate(self) -> None:
        if self.default_input_mode not in {"voice", "text"}:
            raise ValueError("default_input_mode must be voice or text")
        self.voice_start_strategy = str(self.voice_start_strategy or "").strip().casefold()
        if self.voice_start_strategy not in {"auto", "push_to_talk", "hover"}:
            raise ValueError("voice_start_strategy is unsupported")
        if not 600 <= int(self.voice_silence_ms) <= 5000:
            raise ValueError("voice_silence_ms must be between 600 and 5000")
        self.voice_language = str(self.voice_language or "").strip().casefold()
        if self.voice_language not in {"auto", "zh", "en", "ja", "ko", "fr", "de", "es", "ru"}:
            raise ValueError("voice_language is unsupported")
        self.voice_output_mode = str(self.voice_output_mode or "").strip().casefold()
        if self.voice_output_mode not in {"verbatim", "clean_spacing"}:
            raise ValueError("voice_output_mode must be verbatim or clean_spacing")
        self.voice_punctuation = str(self.voice_punctuation or "").strip().casefold()
        if self.voice_punctuation not in {"verbatim", "smart_zh"}:
            raise ValueError("voice_punctuation is unsupported")
        self.voice_script = str(self.voice_script or "").strip().casefold()
        if self.voice_script not in {"unchanged", "simplified", "traditional"}:
            raise ValueError("voice_script is unsupported")
        self.voice_mixed_spacing = str(self.voice_mixed_spacing or "").strip().casefold()
        if self.voice_mixed_spacing not in {"preserve", "compact_cjk"}:
            raise ValueError("voice_mixed_spacing is unsupported")
        if isinstance(self.voice_memory_limit_mb, bool) or not isinstance(self.voice_memory_limit_mb, int):
            raise ValueError("voice_memory_limit_mb must be an integer")
        if not 128 <= self.voice_memory_limit_mb <= 16_384:
            raise ValueError("voice_memory_limit_mb must be between 128 and 16384")
        if isinstance(self.voice_idle_unload_ms, bool) or not isinstance(self.voice_idle_unload_ms, int):
            raise ValueError("voice_idle_unload_ms must be an integer")
        if not 0 <= self.voice_idle_unload_ms <= 3_600_000:
            raise ValueError("voice_idle_unload_ms must be between 0 (resident) and 3600000")
        if not isinstance(self.voice_glossaries, dict):
            raise ValueError("voice_glossaries must be an object")
        if len(self.voice_glossaries) > 64:
            raise ValueError("voice_glossaries has too many scopes")
        normalized: dict[str, list[str]] = {}
        for raw_scope, raw_terms in self.voice_glossaries.items():
            scope = str(raw_scope or "").strip()
            if not scope:
                raise ValueError("voice glossary scope is empty")
            if not isinstance(raw_terms, list):
                raise ValueError("voice glossary terms must be a list")
            terms: list[str] = []
            seen: set[str] = set()
            for raw_term in raw_terms:
                term = str(raw_term or "").strip()
                folded = term.casefold()
                if not term or folded in seen:
                    continue
                if len(term) > 120:
                    raise ValueError("voice glossary term is too long")
                seen.add(folded)
                terms.append(term)
            if len(terms) > 64:
                raise ValueError("voice glossary has too many terms")
            normalized[scope] = terms
        self.voice_glossaries = normalized


@dataclass
class AgentSettings:
    preferred: str = "pi"
    profiles: dict[str, dict[str, Any]] = field(default_factory=dict)
    delivery_mode: str = "active_session"
    cwd_match: str = "strict"
    image_policy: str = "vision_only"
    auto_attach: bool = True
    session_bindings: dict[str, str] = field(default_factory=dict)

    def __post_init__(self) -> None:
        self.delivery_mode = str(self.delivery_mode or "").strip().casefold()
        self.cwd_match = str(self.cwd_match or "").strip().casefold()
        self.image_policy = str(self.image_policy or "").strip().casefold()
        if self.delivery_mode not in {"active_session", "managed_session", "clipboard"}:
            raise ValueError("agents.delivery_mode is unsupported")
        if self.cwd_match not in {"strict", "subtree", "confirm"}:
            raise ValueError("agents.cwd_match is unsupported")
        if self.image_policy not in {"vision_only", "never", "confirm"}:
            raise ValueError("agents.image_policy is unsupported")
        if not isinstance(self.session_bindings, dict):
            raise ValueError("agents.session_bindings must be an object")
        normalized: dict[str, str] = {}
        for provider, session_id in self.session_bindings.items():
            clean_provider = str(provider or "").strip().casefold()
            clean_session = str(session_id or "").strip()
            if not clean_provider or not clean_session or len(clean_session) > 256:
                raise ValueError("agents.session_bindings contains an invalid entry")
            normalized[clean_provider] = clean_session
        self.session_bindings = normalized


@dataclass
class ShortcutSettings:
    wake: str = "Control+Alt+M"
    text_mode: str = "Control+Alt+T"
    voice_mode: str = "Control+Alt+V"
    pause: str = "Control+Alt+P"

    def __post_init__(self) -> None:
        normalized_shortcuts: dict[str, str] = {}
        for name in ("wake", "text_mode", "voice_mode", "pause"):
            value = str(getattr(self, name, "") or "").strip()
            if not value or len(value) > 96:
                raise ValueError(f"shortcut {name} is invalid")
            normalized = _normalized_shortcut(value)
            if not normalized:
                raise ValueError(f"shortcut {name} is invalid")
            if normalized in _RESERVED_SHORTCUTS:
                raise ValueError(f"reserved shortcut {value}")
            if normalized in normalized_shortcuts:
                raise ValueError(
                    f"duplicate shortcut {value} for {normalized_shortcuts[normalized]} and {name}"
                )
            normalized_shortcuts[normalized] = name
            setattr(self, name, value)


@dataclass
class AppearanceSettings:
    theme: str = "system"
    material: str = "auto"
    selection_visual: str = "sweep_band"
    sweep_height_ratio: float = 0.52
    sweep_min_height_dip: float = 10
    sweep_max_height_dip: float = 24
    sweep_duration_ms: float = 292
    sweep_fade_ms: float = 96
    capsule_spawn_ms: float = 417
    capsule_expand_ms: float = 292
    capsule_voice_width_dip: float = 40
    capsule_text_width_dip: float = 144
    capsule_max_width_dip: float = 440
    capsule_inline_gap_dip: float = 18
    gesture_line_style: str = "demo6_band"
    gesture_line_width_dip: float = 22

    def __post_init__(self) -> None:
        self.theme = str(self.theme or "").strip().casefold()
        self.material = str(self.material or "").strip().casefold()
        self.selection_visual = str(self.selection_visual or "").strip().casefold()
        self.gesture_line_style = str(self.gesture_line_style or "").strip().casefold()
        if self.theme not in {"system", "light", "dark"}:
            raise ValueError("appearance.theme is unsupported")
        if self.material not in {"auto", "translucent", "solid"}:
            raise ValueError("appearance.material is unsupported")
        if self.selection_visual not in {"sweep_band", "soft_glow", "outline"}:
            raise ValueError("appearance.selection_visual is unsupported")
        if self.gesture_line_style not in {"demo6_band", "thin"}:
            raise ValueError("appearance.gesture_line_style is unsupported")
        ranges = {
            "sweep_height_ratio": (0.15, 1.5),
            "sweep_min_height_dip": (4, 48),
            "sweep_max_height_dip": (6, 96),
            "sweep_duration_ms": (60, 1500),
            "sweep_fade_ms": (60, 1500),
            "capsule_spawn_ms": (60, 1500),
            "capsule_expand_ms": (60, 1500),
            "capsule_voice_width_dip": (28, 180),
            "capsule_text_width_dip": (40, 560),
            "capsule_max_width_dip": (80, 900),
            "capsule_inline_gap_dip": (4, 96),
            "gesture_line_width_dip": (3, 40),
        }
        for name, (minimum, maximum) in ranges.items():
            value = float(getattr(self, name))
            if not minimum <= value <= maximum:
                raise ValueError(f"appearance.{name} must be between {minimum} and {maximum}")
            setattr(self, name, value)
        if self.sweep_min_height_dip > self.sweep_max_height_dip:
            raise ValueError("appearance sweep minimum must not exceed maximum")
        if self.capsule_max_width_dip < max(
            self.capsule_voice_width_dip,
            self.capsule_text_width_dip,
        ):
            raise ValueError("appearance capsule maximum width is too small")


@dataclass
class AccessibilitySettings:
    reduce_motion: bool = False
    reduce_transparency: bool = False
    high_contrast_controls: bool = False


@dataclass
class PermissionSettings:
    default_read: str = "allow"
    default_write: str = "confirm"
    default_send: str = "confirm"
    default_destructive: str = "confirm"
    default_purchase: str = "deny"
    recipe_overrides: dict[str, str] = field(default_factory=dict)
    scoped_grants: list[dict[str, Any]] = field(default_factory=list)

    def __post_init__(self) -> None:
        self.validate()

    def validate(self) -> None:
        allowed = {"allow", "confirm", "deny"}
        for name in (
            "default_read",
            "default_write",
            "default_send",
            "default_destructive",
            "default_purchase",
        ):
            if str(getattr(self, name, "")) not in allowed:
                raise ValueError(f"invalid permission default: {name}")
        if not isinstance(self.recipe_overrides, dict):
            raise ValueError("recipe_overrides must be an object")
        normalized_overrides: dict[str, str] = {}
        for recipe, decision in self.recipe_overrides.items():
            clean_recipe = str(recipe or "").strip()
            clean_decision = str(decision or "").strip().casefold()
            if not clean_recipe or clean_decision not in allowed:
                raise ValueError("invalid recipe permission override")
            normalized_overrides[clean_recipe] = clean_decision
        if not isinstance(self.scoped_grants, list):
            raise ValueError("scoped permission grants must be a list")
        normalized_grants: list[dict[str, Any]] = []
        for raw in self.scoped_grants:
            if not isinstance(raw, dict):
                raise ValueError("scoped permission grant must be an object")
            decision = str(raw.get("decision") or "").strip().casefold()
            if decision not in allowed:
                raise ValueError(f"invalid scoped permission decision: {decision or '<empty>'}")
            recipe = str(raw.get("recipe") or "*").strip() or "*"
            risk = str(raw.get("risk") or "*").strip().casefold() or "*"
            app = str(raw.get("app") or "").strip()
            project = str(raw.get("project") or "").strip()
            expires_at = str(raw.get("expires_at") or raw.get("expiresAt") or "").strip()
            if expires_at:
                try:
                    parsed = datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
                except ValueError as exc:
                    raise ValueError("invalid scoped permission expiry") from exc
                if parsed.tzinfo is None:
                    raise ValueError("scoped permission expiry must include timezone")
            normalized_grants.append({
                "id": str(raw.get("id") or "").strip(),
                "decision": decision,
                "recipe": recipe,
                "risk": risk,
                "app": app,
                "project": project,
                "expires_at": expires_at,
            })
        self.recipe_overrides = normalized_overrides
        self.scoped_grants = normalized_grants

    @staticmethod
    def _project_matches(expected: str, current: str) -> bool:
        if not expected:
            return True
        expected_norm = expected.replace("/", "\\").rstrip("\\").casefold()
        current_norm = str(current or "").replace("/", "\\").rstrip("\\").casefold()
        return current_norm == expected_norm or current_norm.startswith(expected_norm + "\\")

    def scoped_decision(
        self,
        recipe_id: str,
        risk: str,
        *,
        app: str = "",
        project: str = "",
        now: datetime | None = None,
    ) -> dict[str, Any] | None:
        current = now or datetime.now(timezone.utc)
        if current.tzinfo is None:
            current = current.replace(tzinfo=timezone.utc)
        app_folded = str(app or "").casefold()
        matches: list[tuple[int, int, int, dict[str, Any]]] = []
        decision_priority = {"allow": 1, "confirm": 2, "deny": 3}
        for index, grant in enumerate(self.scoped_grants):
            expires_at = str(grant.get("expires_at") or "")
            if expires_at:
                expiry = datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
                if expiry <= current:
                    continue
            recipe_scope = str(grant.get("recipe") or "*")
            risk_scope = str(grant.get("risk") or "*")
            app_scope = str(grant.get("app") or "")
            project_scope = str(grant.get("project") or "")
            if recipe_scope not in {"*", recipe_id}:
                continue
            if risk_scope not in {"*", risk}:
                continue
            if app_scope and app_scope.casefold() not in app_folded:
                continue
            if not self._project_matches(project_scope, project):
                continue
            specificity = (
                (100 if recipe_scope != "*" else 0)
                + (20 if risk_scope != "*" else 0)
                + (40 if project_scope else 0)
                + (30 if app_scope else 0)
            )
            matches.append((
                specificity,
                decision_priority[str(grant["decision"])],
                -index,
                grant,
            ))
        if not matches:
            return None
        grant = max(matches, key=lambda item: item[:3])[3]
        return {
            "decision": str(grant["decision"]),
            "source": "scoped_grant",
            "scope": dict(grant),
        }


@dataclass
class PrivacySettings:
    upload_screenshots: bool = False
    default_capture_mode: str = "follow_global"
    app_capture_modes: dict[str, str] = field(default_factory=dict)
    retain_captures_days: int = 3
    retain_artifacts_days: int = 30
    retain_audit_days: int = 30
    sensitive_apps: list[str] = field(default_factory=lambda: [
        "1password",
        "keepass",
        "bitwarden",
        "wallet",
        "银行",
    ])
    anonymous_usage: bool = False

    def __post_init__(self) -> None:
        self.retain_captures_days = max(0, min(int(self.retain_captures_days), 30))
        self.retain_artifacts_days = max(0, min(int(self.retain_artifacts_days), 3650))
        self.retain_audit_days = max(1, min(int(self.retain_audit_days), 3650))
        self.default_capture_mode = str(self.default_capture_mode or "").strip().casefold()
        if self.default_capture_mode not in CAPTURE_MODES:
            raise ValueError(f"unsupported capture mode: {self.default_capture_mode or '<empty>'}")
        if not isinstance(self.app_capture_modes, dict):
            raise ValueError("app_capture_modes must be an object")
        normalized: dict[str, str] = {}
        for pattern, mode in self.app_capture_modes.items():
            clean_pattern = str(pattern or "").strip()
            clean_mode = str(mode or "").strip().casefold()
            if not clean_pattern:
                raise ValueError("capture policy app pattern is empty")
            if clean_mode not in CAPTURE_MODES:
                raise ValueError(f"unsupported capture mode: {clean_mode or '<empty>'}")
            normalized[clean_pattern] = clean_mode
        self.app_capture_modes = normalized


@dataclass
class ConnectionSettings:
    browser_devtools_enabled: bool = True
    browser_devtools_endpoints: list[str] = field(
        default_factory=lambda: ["http://127.0.0.1:9222"]
    )

    def __post_init__(self) -> None:
        if not isinstance(self.browser_devtools_endpoints, list) or len(self.browser_devtools_endpoints) > 8:
            raise ValueError("connections.browser_devtools_endpoints must be a bounded list")
        normalized: list[str] = []
        for raw in self.browser_devtools_endpoints:
            value = str(raw or "").strip().rstrip("/")
            try:
                parsed = urlsplit(value)
                port = parsed.port
            except ValueError as exc:
                raise ValueError("browser DevTools endpoint is invalid") from exc
            if parsed.scheme not in {"http", "https"} or parsed.hostname not in {"127.0.0.1", "localhost", "::1"}:
                raise ValueError("browser DevTools endpoints must use a loopback host")
            if port is None or not 1024 <= port <= 65535 or parsed.path not in {"", "/"} or parsed.query or parsed.fragment:
                raise ValueError("browser DevTools endpoint must be an origin with an explicit user port")
            host = f"[{parsed.hostname}]" if parsed.hostname == "::1" else parsed.hostname
            canonical = f"{parsed.scheme}://{host}:{port}"
            if canonical not in normalized:
                normalized.append(canonical)
        self.browser_devtools_endpoints = normalized


@dataclass
class FabricSettings:
    schema_version: int = 1
    general: GeneralSettings = field(default_factory=GeneralSettings)
    notifications: NotificationSettings = field(default_factory=NotificationSettings)
    activation: ActivationSettings = field(default_factory=ActivationSettings)
    interaction: InteractionSettings = field(default_factory=InteractionSettings)
    agents: AgentSettings = field(default_factory=AgentSettings)
    models: ModelProfileStore = field(default_factory=ModelProfileStore.empty)
    permissions: PermissionSettings = field(default_factory=PermissionSettings)
    privacy: PrivacySettings = field(default_factory=PrivacySettings)
    connections: ConnectionSettings = field(default_factory=ConnectionSettings)
    shortcuts: ShortcutSettings = field(default_factory=ShortcutSettings)
    appearance: AppearanceSettings = field(default_factory=AppearanceSettings)
    accessibility: AccessibilitySettings = field(default_factory=AccessibilitySettings)
    recipe_enabled: dict[str, bool] = field(default_factory=dict)

    @classmethod
    def defaults(cls) -> "FabricSettings":
        return cls()

    def is_sensitive_app(self, executable_or_title: str) -> bool:
        value = str(executable_or_title or "").casefold()
        return any(item.casefold() in value for item in self.privacy.sensitive_apps if item.strip())

    def permission_decision(
        self,
        recipe_id: str,
        risk: str,
        *,
        app: str = "",
        project: str = "",
        now: datetime | None = None,
    ) -> dict[str, Any]:
        scoped = self.permissions.scoped_decision(
            recipe_id,
            risk,
            app=app,
            project=project,
            now=now,
        )
        if scoped is not None:
            return scoped
        override = self.permissions.recipe_overrides.get(recipe_id)
        if override in {"allow", "confirm", "deny"}:
            return {
                "decision": override,
                "source": "recipe_override",
                "scope": {"recipe": recipe_id},
            }
        decision = {
            "read": self.permissions.default_read,
            "local_write": self.permissions.default_write,
            "write": self.permissions.default_write,
            "external_send": self.permissions.default_send,
            "send": self.permissions.default_send,
            "destructive": self.permissions.default_destructive,
            "purchase": self.permissions.default_purchase,
        }.get(risk, "deny")
        return {
            "decision": decision,
            "source": "risk_default",
            "scope": {"risk": risk},
        }

    def permission_for(
        self,
        recipe_id: str,
        risk: str,
        *,
        app: str = "",
        project: str = "",
        now: datetime | None = None,
    ) -> str:
        return str(self.permission_decision(
            recipe_id,
            risk,
            app=app,
            project=project,
            now=now,
        )["decision"])

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "general": asdict(self.general),
            "notifications": asdict(self.notifications),
            "activation": asdict(self.activation),
            "interaction": asdict(self.interaction),
            "agents": asdict(self.agents),
            "models": self.models.to_dict(),
            "permissions": asdict(self.permissions),
            "privacy": asdict(self.privacy),
            "connections": asdict(self.connections),
            "shortcuts": asdict(self.shortcuts),
            "appearance": asdict(self.appearance),
            "accessibility": asdict(self.accessibility),
            "recipe_enabled": dict(self.recipe_enabled),
        }

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "FabricSettings":
        if not isinstance(value, dict) or value.get("schema_version") != 1:
            raise SettingsError("unsupported or missing settings schema_version")
        try:
            activation_value = dict(value.get("activation") or {})
            if "wake_mode" not in activation_value:
                activation_value["wake_mode"] = (
                    "wiggle_hotkey"
                    if activation_value.get("wiggle_enabled", True)
                    and activation_value.get("fallback_hotkey_enabled", True)
                    else "wiggle"
                    if activation_value.get("wiggle_enabled", True)
                    else "hotkey"
                )
            shortcut_value = dict(value.get("shortcuts") or {})
            if "wake" not in shortcut_value:
                shortcut_value["wake"] = str(
                    activation_value.get("fallback_hotkey") or "Control+Alt+M"
                )
            appearance_value = dict(value.get("appearance") or {})
            if "gesture_line_style" not in appearance_value:
                appearance_value["gesture_line_style"] = "demo6_band"
                appearance_value["gesture_line_width_dip"] = 22
            return cls(
                schema_version=1,
                general=GeneralSettings(**dict(value.get("general") or {})),
                notifications=NotificationSettings(**dict(value.get("notifications") or {})),
                activation=ActivationSettings(**activation_value),
                interaction=InteractionSettings(**dict(value.get("interaction") or {})),
                agents=AgentSettings(**dict(value.get("agents") or {})),
                models=ModelProfileStore.from_dict(value.get("models")),
                permissions=PermissionSettings(**dict(value.get("permissions") or {})),
                privacy=PrivacySettings(**dict(value.get("privacy") or {})),
                connections=ConnectionSettings(**dict(value.get("connections") or {})),
                shortcuts=ShortcutSettings(**shortcut_value),
                appearance=AppearanceSettings(**appearance_value),
                accessibility=AccessibilitySettings(**dict(value.get("accessibility") or {})),
                recipe_enabled={
                    str(key): bool(enabled)
                    for key, enabled in dict(value.get("recipe_enabled") or {}).items()
                },
            )
        except (TypeError, ValueError, ModelProfileError) as exc:
            raise SettingsError(f"invalid settings: {exc}") from exc


class SettingsStore:
    def __init__(self, path: Path | str | None = None) -> None:
        default_root = Path(os.environ.get("MAGIC_POINTER_USER_DATA_DIR") or Path.cwd() / "data" / "runtime")
        self.path = Path(path) if path is not None else default_root / "fabric-settings.json"

    def load(self) -> FabricSettings:
        if not self.path.exists():
            return FabricSettings.defaults()
        try:
            value = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise SettingsError(f"could not read settings: {type(exc).__name__}: {exc}") from exc
        return FabricSettings.from_dict(value)

    def save(self, settings: FabricSettings) -> Path:
        if settings.schema_version != 1:
            raise SettingsError("refusing to write unsupported settings schema")
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temp = self.path.with_suffix(self.path.suffix + ".tmp")
        encoded = json.dumps(settings.to_dict(), ensure_ascii=False, indent=2) + "\n"
        try:
            temp.write_text(encoded, encoding="utf-8", newline="\n")
            os.replace(temp, self.path)
        except OSError as exc:
            try:
                temp.unlink(missing_ok=True)
            except OSError:
                pass
            raise SettingsError(f"could not save settings: {type(exc).__name__}: {exc}") from exc
        return self.path
