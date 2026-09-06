"""Explicit local knowledge catalog backed by the Stash index.

The catalog is intentionally a bounded linear scan. Stash is capped by the
user-facing collection and the original artifact remains authoritative; an
FTS database would add a second source of truth before we have measured a
need for one.
"""

from __future__ import annotations

import json
import os
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .sources import FragmentLocator, SourceRef

_DOCUMENT_EXTENSIONS = {
    ".doc", ".docx", ".pdf", ".ppt", ".pptx", ".xls", ".xlsx",
}


def default_knowledge_index() -> Path:
    root = Path(os.environ.get("MAGIC_POINTER_USER_DATA_DIR") or Path(__file__).resolve().parents[2] / "data" / "runtime")
    return root / "stash" / "index.json"


def _text(value: Any, *, limit: int) -> str:
    return str(value or "").strip()[:limit]


@dataclass(frozen=True, slots=True)
class KnowledgeEntry:
    entry_id: str
    source_id: str
    locator: FragmentLocator
    title: str
    summary: str
    user_category: str
    original_artifact_path: str
    retained_artifact_path: str
    source_time_ms: int
    added_at_ms: int
    media: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "entryId": self.entry_id,
            "sourceId": self.source_id,
            "locator": self.locator.to_dict(),
            "title": self.title,
            "summary": self.summary,
            "userCategory": self.user_category,
            "originalArtifactPath": self.original_artifact_path,
            "retainedArtifactPath": self.retained_artifact_path,
            "sourceTimeMs": self.source_time_ms,
            "addedAtMs": self.added_at_ms,
            "media": self.media,
        }


@dataclass(frozen=True, slots=True)
class KnowledgeResolution:
    entry: KnowledgeEntry
    source: SourceRef
    locator: FragmentLocator
    available: bool
    unavailable_reason: str | None
    evidence_state: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "entry": self.entry.to_dict(),
            "source": self.source.to_model_dict(),
            "locator": self.locator.to_dict(),
            "available": self.available,
            "unavailableReason": self.unavailable_reason,
            "evidenceState": self.evidence_state,
        }


class KnowledgeCatalog:
    def __init__(self, index_path: Path | str | None = None) -> None:
        self.index_path = Path(index_path) if index_path is not None else default_knowledge_index()

    def _raw_entries(self) -> list[dict[str, Any]]:
        try:
            raw = json.loads(self.index_path.read_text(encoding="utf-8"))
        except (OSError, ValueError, TypeError):
            return []
        return [dict(item) for item in raw if isinstance(item, Mapping)] if isinstance(raw, list) else []

    def _entry(self, raw: Mapping[str, Any]) -> KnowledgeEntry | None:
        entry_id = _text(raw.get("id"), limit=200)
        if not entry_id:
            return None
        locator_raw = raw.get("locator")
        try:
            locator = FragmentLocator.from_dict(locator_raw) if isinstance(locator_raw, Mapping) else FragmentLocator(
                "text", {"knowledgeEntryId": entry_id}
            )
        except ValueError:
            locator = FragmentLocator("text", {"knowledgeEntryId": entry_id})
        original = _text(raw.get("originalArtifactPath"), limit=4000)
        rel_path = _text(raw.get("relPath"), limit=1000)
        retained = str((self.index_path.parent / rel_path).resolve()) if rel_path else ""
        try:
            added_at = int(raw.get("capturedAt") or 0)
        except (TypeError, ValueError):
            added_at = 0
        try:
            source_time = int(raw.get("sourceTimeMs") or added_at)
        except (TypeError, ValueError):
            source_time = added_at
        title = _text(raw.get("desc") or raw.get("elementName") or Path(original).name, limit=500)
        summary = _text(raw.get("summary") or raw.get("text"), limit=4000)
        return KnowledgeEntry(
            entry_id=entry_id,
            source_id=_text(raw.get("sourceId"), limit=300) or f"knowledge:{entry_id}",
            locator=locator,
            title=title or "收藏材料",
            summary=summary,
            user_category=_text(raw.get("userCategory") or raw.get("kind"), limit=80),
            original_artifact_path=original,
            retained_artifact_path=retained,
            source_time_ms=source_time,
            added_at_ms=added_at,
            media=_text(raw.get("media"), limit=40) or "file",
        )

    def entries(self) -> list[KnowledgeEntry]:
        result = [self._entry(raw) for raw in self._raw_entries()]
        return sorted(
            (entry for entry in result if entry is not None),
            key=lambda entry: entry.added_at_ms,
            reverse=True,
        )

    def search(
        self,
        query: str = "",
        *,
        category: str | None = None,
        limit: int = 20,
    ) -> list[KnowledgeEntry]:
        needle = str(query or "").strip().casefold()
        requested_category = str(category or "").strip().casefold()
        matches: list[KnowledgeEntry] = []
        for entry in self.entries():
            if requested_category and entry.user_category.casefold() != requested_category:
                continue
            haystack: Iterable[str] = (
                entry.title,
                entry.summary,
                entry.user_category,
                entry.original_artifact_path,
            )
            if needle and not any(needle in value.casefold() for value in haystack):
                continue
            matches.append(entry)
            if len(matches) >= max(0, min(int(limit), 100)):
                break
        return matches

    def get(self, entry_id: str) -> KnowledgeEntry | None:
        key = str(entry_id or "").strip()
        return next((entry for entry in self.entries() if entry.entry_id == key), None)

    @staticmethod
    def _readable_path(entry: KnowledgeEntry) -> tuple[str, str]:
        if entry.original_artifact_path and Path(entry.original_artifact_path).is_file():
            return entry.original_artifact_path, "original"
        if entry.retained_artifact_path and Path(entry.retained_artifact_path).is_file():
            return entry.retained_artifact_path, "retained_evidence"
        return entry.original_artifact_path or entry.retained_artifact_path, "missing"

    def resolve(self, entry_id: str, *, task_id: str) -> KnowledgeResolution:
        entry = self.get(entry_id)
        if entry is None:
            raise KeyError(f"unknown knowledge entry: {entry_id}")
        artifact_path, evidence_state = self._readable_path(entry)
        extension = Path(artifact_path).suffix.casefold() if artifact_path else ""
        kind = "document" if extension in _DOCUMENT_EXTENSIONS else "file"
        available = evidence_state != "missing"
        source = SourceRef(
            source_id=entry.source_id,
            task_id=str(task_id),
            kind=kind,
            title=entry.title,
            identity={
                "absolutePath": artifact_path,
                "knowledgeEntryId": entry.entry_id,
                "originalArtifactPath": entry.original_artifact_path,
                "evidenceState": evidence_state,
            },
            revision={
                "sourceTimeMs": entry.source_time_ms,
                "addedAtMs": entry.added_at_ms,
            },
            capabilities=("read", "search"),
            origin="user-attached",
            parent_source_id=None,
        )
        return KnowledgeResolution(
            entry=entry,
            source=source,
            locator=entry.locator,
            available=available,
            unavailable_reason=None if available else "artifact_missing",
            evidence_state=evidence_state,
        )

    def availability(self, source: SourceRef) -> dict[str, Any]:
        entry_id = str(source.identity.get("knowledgeEntryId") or "")
        entry = self.get(entry_id)
        if entry is None:
            return {"available": False, "reason": "knowledge_entry_deleted"}
        _path, state = self._readable_path(entry)
        if state == "missing":
            return {"available": False, "reason": "artifact_missing"}
        return {"available": True, "reason": None, "evidenceState": state}

    def remove(self, entry_id: str) -> bool:
        raw_entries = self._raw_entries()
        target = next((item for item in raw_entries if str(item.get("id") or "") == entry_id), None)
        if target is None:
            return False
        next_entries = [item for item in raw_entries if str(item.get("id") or "") != entry_id]
        self.index_path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.index_path.with_suffix(".json.tmp")
        temporary.write_text(json.dumps(next_entries, ensure_ascii=False), encoding="utf-8")
        os.replace(temporary, self.index_path)

        rel_path = _text(target.get("relPath"), limit=1000)
        original = Path(_text(target.get("originalArtifactPath"), limit=4000)) if target.get("originalArtifactPath") else None
        if rel_path:
            stored = (self.index_path.parent / rel_path).resolve()
            if original is None or stored != original.resolve():
                try:
                    if stored.is_file() and (stored == self.index_path.parent.resolve() or self.index_path.parent.resolve() in stored.parents):
                        stored.unlink()
                except OSError:
                    pass
        return True


__all__ = [
    "KnowledgeCatalog",
    "KnowledgeEntry",
    "KnowledgeResolution",
    "default_knowledge_index",
]
