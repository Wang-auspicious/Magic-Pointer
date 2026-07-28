from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any


CAPABILITY_VALUES = frozenset({"yes", "no", "unknown"})
OVERRIDE_VALUES = frozenset({"auto", "yes", "no"})
_PROFILE_ID = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
_SECRET_FIELDS = frozenset({"apikey", "token", "secret", "credential", "password", "authorization"})
_SECRET_REFERENCE_FIELDS = frozenset({"credentialref"})


class ModelProfileError(ValueError):
    pass


def _text(value: object, *, name: str, limit: int, required: bool = False) -> str:
    text = str(value or "").strip()
    if required and not text:
        raise ModelProfileError(f"{name} is required")
    if len(text) > limit:
        raise ModelProfileError(f"{name} is too long")
    return text


def _override(value: object, *, name: str) -> str:
    result = str(value or "auto").strip().casefold()
    if result not in OVERRIDE_VALUES:
        raise ModelProfileError(f"{name} must be auto, yes, or no")
    return result


def _capability(value: object, *, name: str) -> str:
    result = str(value or "unknown").strip().casefold()
    if result not in CAPABILITY_VALUES:
        raise ModelProfileError(f"{name} must be yes, no, or unknown")
    return result


def _reject_secret_fields(value: dict[str, Any]) -> None:
    for key in value:
        normalized = re.sub(r"[^a-z0-9]", "", str(key).casefold())
        is_secret = any(token in normalized for token in _SECRET_FIELDS)
        if is_secret and normalized not in _SECRET_REFERENCE_FIELDS:
            raise ModelProfileError("credential values must not be stored in model profiles")


@dataclass(frozen=True)
class ModelProfile:
    """Versioned, non-secret description of one user-selected model."""

    id: str
    display_name: str
    provider: str
    base_url: str
    model: str
    api_mode: str
    credential_ref: str
    enabled: bool
    overrides: dict[str, str]
    resolved: dict[str, str]
    schema_version: int = 1

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "ModelProfile":
        if not isinstance(value, dict) or value.get("schemaVersion") != 1:
            raise ModelProfileError("unsupported or missing ModelProfile schemaVersion")
        _reject_secret_fields(value)
        profile_id = _text(value.get("id"), name="id", limit=64, required=True).casefold()
        if not _PROFILE_ID.fullmatch(profile_id):
            raise ModelProfileError("id must contain only lowercase letters, digits, dot, underscore, or dash")
        display_name = _text(value.get("displayName"), name="displayName", limit=120, required=True)
        provider = _text(value.get("provider"), name="provider", limit=80, required=True).casefold()
        if not re.fullmatch(r"[a-z0-9][a-z0-9._-]*", provider):
            raise ModelProfileError("provider has invalid characters")
        api_mode = _text(value.get("apiMode"), name="apiMode", limit=80, required=True).casefold()
        if api_mode not in {"chat-completions", "responses", "messages", "local"}:
            raise ModelProfileError("apiMode is unsupported")
        raw_overrides = value.get("overrides") or {}
        if not isinstance(raw_overrides, dict):
            raise ModelProfileError("overrides must be an object")
        raw_resolved = value.get("resolved") or {}
        if not isinstance(raw_resolved, dict):
            raise ModelProfileError("resolved must be an object")
        resolved = {
            "visionInput": _capability(raw_resolved.get("visionInput"), name="resolved.visionInput"),
            "audioInput": _capability(raw_resolved.get("audioInput"), name="resolved.audioInput"),
            "toolCalls": _capability(raw_resolved.get("toolCalls"), name="resolved.toolCalls"),
            "source": _text(raw_resolved.get("source"), name="resolved.source", limit=80) or "unknown",
            "evidence": _text(raw_resolved.get("evidence"), name="resolved.evidence", limit=500),
            "checkedAt": _text(raw_resolved.get("checkedAt"), name="resolved.checkedAt", limit=64),
        }
        return cls(
            id=profile_id,
            display_name=display_name,
            provider=provider,
            base_url=_text(value.get("baseUrl"), name="baseUrl", limit=2000),
            model=_text(value.get("model"), name="model", limit=256, required=True),
            api_mode=api_mode,
            credential_ref=_text(value.get("credentialRef"), name="credentialRef", limit=160),
            enabled=value.get("enabled") is not False,
            overrides={
                "visionInput": _override(raw_overrides.get("visionInput"), name="overrides.visionInput"),
                "audioInput": _override(raw_overrides.get("audioInput"), name="overrides.audioInput"),
                "toolCalls": _override(raw_overrides.get("toolCalls"), name="overrides.toolCalls"),
            },
            resolved=resolved,
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "schemaVersion": self.schema_version,
            "id": self.id,
            "displayName": self.display_name,
            "provider": self.provider,
            "baseUrl": self.base_url,
            "model": self.model,
            "apiMode": self.api_mode,
            "credentialRef": self.credential_ref,
            "enabled": self.enabled,
            "overrides": dict(self.overrides),
            "resolved": dict(self.resolved),
        }


@dataclass(frozen=True)
class ModelProfileStore:
    """Settings-safe collection. It serializes references, never credentials."""

    profiles: tuple[ModelProfile, ...]
    default_profile_id: str | None
    schema_version: int = 1

    @classmethod
    def empty(cls) -> "ModelProfileStore":
        return cls(profiles=(), default_profile_id=None)

    @classmethod
    def from_dict(cls, value: dict[str, Any] | None) -> "ModelProfileStore":
        if value is None:
            return cls.empty()
        if not isinstance(value, dict) or value.get("schemaVersion") != 1:
            raise ModelProfileError("unsupported or missing model store schemaVersion")
        raw_profiles = value.get("profiles") or []
        if not isinstance(raw_profiles, list) or len(raw_profiles) > 32:
            raise ModelProfileError("profiles must be a list of at most 32 entries")
        profiles = tuple(ModelProfile.from_dict(dict(item)) for item in raw_profiles if isinstance(item, dict))
        if len(profiles) != len(raw_profiles):
            raise ModelProfileError("profile must be an object")
        ids = [profile.id for profile in profiles]
        if len(set(ids)) != len(ids):
            raise ModelProfileError("profile ids must be unique")
        default_id = _text(value.get("defaultProfileId"), name="defaultProfileId", limit=64) or None
        if default_id is not None and default_id not in ids:
            raise ModelProfileError("defaultProfileId must reference an existing profile")
        return cls(profiles=profiles, default_profile_id=default_id)

    def to_dict(self) -> dict[str, Any]:
        return {
            "schemaVersion": self.schema_version,
            "defaultProfileId": self.default_profile_id,
            "profiles": [profile.to_dict() for profile in self.profiles],
        }

    def profile(self, profile_id: str | None = None) -> ModelProfile | None:
        wanted = str(profile_id or self.default_profile_id or "")
        return next((profile for profile in self.profiles if profile.id == wanted), None)
