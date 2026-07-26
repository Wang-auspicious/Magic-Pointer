from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any


class SettingsError(RuntimeError):
    pass


@dataclass
class ActivationSettings:
    wiggle_enabled: bool = True
    sensitivity: float = 0.55
    fallback_hotkey_enabled: bool = True
    fallback_hotkey: str = "Control+Alt+M"
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


@dataclass
class InteractionSettings:
    default_input_mode: str = "voice"
    voice_auto_submit: bool = True
    voice_silence_ms: int = 1600

    def __post_init__(self) -> None:
        if self.default_input_mode not in {"voice", "text"}:
            raise ValueError("default_input_mode must be voice or text")
        if not 600 <= int(self.voice_silence_ms) <= 5000:
            raise ValueError("voice_silence_ms must be between 600 and 5000")


@dataclass
class AgentSettings:
    preferred: str = "pi"
    profiles: dict[str, dict[str, Any]] = field(default_factory=dict)


@dataclass
class PermissionSettings:
    default_read: str = "allow"
    default_write: str = "confirm"
    default_send: str = "confirm"
    default_destructive: str = "confirm"
    default_purchase: str = "deny"
    recipe_overrides: dict[str, str] = field(default_factory=dict)


@dataclass
class PrivacySettings:
    upload_screenshots: bool = False
    retain_captures_days: int = 3
    retain_audit_days: int = 30
    sensitive_apps: list[str] = field(default_factory=lambda: [
        "1password",
        "keepass",
        "bitwarden",
        "wallet",
        "银行",
    ])


@dataclass
class FabricSettings:
    schema_version: int = 1
    activation: ActivationSettings = field(default_factory=ActivationSettings)
    interaction: InteractionSettings = field(default_factory=InteractionSettings)
    agents: AgentSettings = field(default_factory=AgentSettings)
    permissions: PermissionSettings = field(default_factory=PermissionSettings)
    privacy: PrivacySettings = field(default_factory=PrivacySettings)
    recipe_enabled: dict[str, bool] = field(default_factory=dict)

    @classmethod
    def defaults(cls) -> "FabricSettings":
        return cls()

    def is_sensitive_app(self, executable_or_title: str) -> bool:
        value = str(executable_or_title or "").casefold()
        return any(item.casefold() in value for item in self.privacy.sensitive_apps if item.strip())

    def permission_for(self, recipe_id: str, risk: str) -> str:
        override = self.permissions.recipe_overrides.get(recipe_id)
        if override in {"allow", "confirm", "deny"}:
            return override
        return {
            "read": self.permissions.default_read,
            "local_write": self.permissions.default_write,
            "write": self.permissions.default_write,
            "external_send": self.permissions.default_send,
            "send": self.permissions.default_send,
            "destructive": self.permissions.default_destructive,
            "purchase": self.permissions.default_purchase,
        }.get(risk, "deny")

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "FabricSettings":
        if not isinstance(value, dict) or value.get("schema_version") != 1:
            raise SettingsError("unsupported or missing settings schema_version")
        try:
            return cls(
                schema_version=1,
                activation=ActivationSettings(**dict(value.get("activation") or {})),
                interaction=InteractionSettings(**dict(value.get("interaction") or {})),
                agents=AgentSettings(**dict(value.get("agents") or {})),
                permissions=PermissionSettings(**dict(value.get("permissions") or {})),
                privacy=PrivacySettings(**dict(value.get("privacy") or {})),
                recipe_enabled={
                    str(key): bool(enabled)
                    for key, enabled in dict(value.get("recipe_enabled") or {}).items()
                },
            )
        except (TypeError, ValueError) as exc:
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
