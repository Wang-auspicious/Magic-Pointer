from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from app.models.profiles import CAPABILITY_VALUES, ModelProfile


@dataclass(frozen=True)
class ModelCatalogEntry:
    provider: str
    model_prefix: str
    base_url_hosts: tuple[str, ...]
    capabilities: dict[str, str]
    evidence: str
    checked_at: str

    def matches(self, profile: ModelProfile) -> bool:
        if profile.provider != self.provider or not profile.model.casefold().startswith(self.model_prefix.casefold()):
            return False
        if not self.base_url_hosts:
            return True
        host = (urlparse(profile.base_url).hostname or "").casefold()
        return host in self.base_url_hosts


class ModelCapabilityCatalog:
    def __init__(self, path: Path | str | None = None) -> None:
        self.path = Path(path) if path is not None else Path(__file__).resolve().parents[2] / "data" / "model_capabilities.v1.json"

    def entries(self) -> tuple[ModelCatalogEntry, ...]:
        try:
            value = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise ValueError(f"could not read model capability catalog: {type(exc).__name__}") from exc
        if not isinstance(value, dict) or value.get("schemaVersion") != 1:
            raise ValueError("unsupported model capability catalog schema")
        result: list[ModelCatalogEntry] = []
        for raw in value.get("entries") or []:
            if not isinstance(raw, dict):
                continue
            capabilities = {
                name: str(dict(raw.get("capabilities") or {}).get(name) or "unknown").casefold()
                for name in ("visionInput", "audioInput", "toolCalls")
            }
            if not all(item in CAPABILITY_VALUES for item in capabilities.values()):
                continue
            result.append(ModelCatalogEntry(
                provider=str(raw.get("provider") or "").casefold(),
                model_prefix=str(raw.get("modelPrefix") or "").casefold(),
                base_url_hosts=tuple(str(item).casefold() for item in raw.get("baseUrlHosts") or []),
                capabilities=capabilities,
                evidence=str(raw.get("evidence") or "")[:500],
                checked_at=str(raw.get("checkedAt") or "")[:64],
            ))
        return tuple(result)

    def resolve(self, profile: ModelProfile) -> ModelCatalogEntry | None:
        matches = [entry for entry in self.entries() if entry.matches(profile)]
        return max(matches, key=lambda entry: len(entry.model_prefix), default=None)
