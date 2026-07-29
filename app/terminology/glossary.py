"""A small, local, serializable project-glossary contract.

This module deliberately has no filesystem, settings, model, or Whisper
dependency.  It can therefore validate imported glossary JSON without
claiming that any transcription backend has consumed the selected terms.
"""

from __future__ import annotations

from dataclasses import dataclass
import ntpath
from typing import Iterable, Mapping


SCHEMA_VERSION = 1
MAX_SCOPE_LENGTH = 4_096
MAX_TERM_LENGTH = 256


@dataclass(frozen=True, slots=True)
class GlossaryEntry:
    """One term limited to a Windows project scope, or global when blank."""

    scope: str
    term: str

    def __post_init__(self) -> None:
        object.__setattr__(self, "scope", _normalize_scope(self.scope))
        object.__setattr__(self, "term", _normalize_term(self.term))


def import_glossary(payload: Mapping[str, object]) -> tuple[GlossaryEntry, ...]:
    """Validate and de-duplicate a JSON-compatible glossary document."""

    if not isinstance(payload, Mapping):
        raise TypeError("glossary payload must be a mapping")
    if payload.get("schemaVersion") != SCHEMA_VERSION:
        raise ValueError(f"unsupported glossary schemaVersion: {payload.get('schemaVersion')!r}")
    raw_entries = payload.get("entries")
    if not isinstance(raw_entries, list):
        raise TypeError("glossary entries must be a list")

    entries: list[GlossaryEntry] = []
    for index, raw_entry in enumerate(raw_entries):
        if not isinstance(raw_entry, Mapping):
            raise TypeError(f"glossary entry {index} must be a mapping")
        entries.append(GlossaryEntry(scope=raw_entry.get("scope"), term=raw_entry.get("term")))
    return _deduplicate(entries)


def export_glossary(entries: Iterable[GlossaryEntry]) -> dict[str, object]:
    """Produce a deterministic, JSON-compatible interchange document."""

    canonical = _deduplicate(entries)
    ordered = sorted(canonical, key=lambda entry: (entry.scope.casefold(), entry.term.casefold()))
    return {
        "schemaVersion": SCHEMA_VERSION,
        "entries": [{"scope": entry.scope, "term": entry.term} for entry in ordered],
    }


def terms_for_path(entries: Iterable[GlossaryEntry], document_path: str) -> tuple[str, ...]:
    """Return global plus current-project terms without prefix-collision leaks."""

    normalized_path = _normalize_scope(document_path, allow_global=False)
    selected: list[str] = []
    seen_terms: set[str] = set()
    for entry in entries:
        if not isinstance(entry, GlossaryEntry):
            raise TypeError("entries must contain GlossaryEntry values")
        if entry.scope and not _path_is_within(normalized_path, entry.scope):
            continue
        if entry.term not in seen_terms:
            seen_terms.add(entry.term)
            selected.append(entry.term)
    return tuple(selected)


def _deduplicate(entries: Iterable[GlossaryEntry]) -> tuple[GlossaryEntry, ...]:
    result: list[GlossaryEntry] = []
    seen: set[tuple[str, str]] = set()
    for entry in entries:
        if not isinstance(entry, GlossaryEntry):
            raise TypeError("entries must contain GlossaryEntry values")
        key = (entry.scope.casefold(), entry.term.casefold())
        if key not in seen:
            seen.add(key)
            result.append(entry)
    return tuple(result)


def _normalize_scope(value: object, *, allow_global: bool = True) -> str:
    if not isinstance(value, str):
        raise TypeError("scope must be a str")
    if len(value) > MAX_SCOPE_LENGTH:
        raise ValueError(f"scope exceeds maximum length of {MAX_SCOPE_LENGTH}")
    if any(character in value for character in "\r\n\x00"):
        raise ValueError("scope must not contain control characters")
    scope = value.strip()
    if not scope and allow_global:
        return ""
    if not scope or not ntpath.isabs(scope):
        raise ValueError("scope must be an absolute Windows path")
    return ntpath.normpath(scope)


def _normalize_term(value: object) -> str:
    if not isinstance(value, str):
        raise TypeError("term must be a str")
    if len(value) > MAX_TERM_LENGTH:
        raise ValueError(f"term exceeds maximum length of {MAX_TERM_LENGTH}")
    if any(character in value for character in "\r\n\x00"):
        raise ValueError("term must not contain control characters")
    term = value.strip()
    if not term:
        raise ValueError("term must not be blank")
    return term


def _path_is_within(path: str, scope: str) -> bool:
    normalized_path = ntpath.normcase(ntpath.normpath(path))
    normalized_scope = ntpath.normcase(ntpath.normpath(scope))
    if normalized_path == normalized_scope:
        return True
    separator = "" if normalized_scope.endswith("\\") else "\\"
    return normalized_path.startswith(normalized_scope + separator)
