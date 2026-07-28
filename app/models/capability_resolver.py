from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from app.models.catalog import ModelCapabilityCatalog
from app.models.profiles import CAPABILITY_VALUES, ModelProfile


_CAPABILITIES = ("visionInput", "audioInput", "toolCalls")


def _value(source: dict[str, Any] | None, name: str) -> str | None:
    if not isinstance(source, dict):
        return None
    value = str(source.get(name) or "").casefold()
    return value if value in {"yes", "no"} else None


class ModelCapabilityResolver:
    """Resolve capability truth without treating an unknown endpoint as visual."""

    def __init__(self, catalog: ModelCapabilityCatalog | None = None) -> None:
        self.catalog = catalog or ModelCapabilityCatalog()

    def resolve(
        self,
        profile: ModelProfile,
        *,
        explicit_probe: dict[str, Any] | None = None,
        provider_metadata: dict[str, Any] | None = None,
    ) -> dict[str, str]:
        catalog_entry = self.catalog.resolve(profile)
        persisted_probe = (
            profile.resolved
            if str(profile.resolved.get("source") or "").casefold() == "explicit_probe"
            else None
        )
        result: dict[str, str] = {}
        source = "unknown"
        evidence = ""
        checked_at = ""
        for capability in _CAPABILITIES:
            manual = str(profile.overrides.get(capability) or "auto").casefold()
            active_probe = explicit_probe if isinstance(explicit_probe, dict) else persisted_probe
            probe = _value(active_probe, capability)
            metadata = _value(provider_metadata, capability)
            catalog_value = catalog_entry.capabilities.get(capability) if catalog_entry else None
            if manual in {"yes", "no"}:
                result[capability] = manual
                source = "manual_override"
                evidence = f"profile override: {capability}={manual}"
            elif probe is not None:
                result[capability] = probe
                if source != "manual_override":
                    source = "explicit_probe"
                    evidence = str((active_probe or {}).get("evidence") or "user-requested capability probe")[:500]
                    checked_at = str((active_probe or {}).get("checkedAt") or "")[:64]
            elif metadata is not None:
                result[capability] = metadata
                if source not in {"manual_override", "explicit_probe"}:
                    source = "provider_metadata"
                    evidence = str((provider_metadata or {}).get("evidence") or "provider metadata")[:500]
                    checked_at = str((provider_metadata or {}).get("checkedAt") or "")[:64]
            elif catalog_value in CAPABILITY_VALUES:
                result[capability] = str(catalog_value)
                if source == "unknown":
                    source = "catalog"
                    evidence = catalog_entry.evidence if catalog_entry else ""
                    checked_at = catalog_entry.checked_at if catalog_entry else ""
            else:
                result[capability] = "unknown"
        result.update({
            "source": source,
            "evidence": evidence,
            "checkedAt": checked_at or datetime.now(timezone.utc).isoformat(timespec="seconds"),
        })
        return result
