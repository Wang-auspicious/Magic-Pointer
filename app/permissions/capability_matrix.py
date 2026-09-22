
from __future__ import annotations

import enum
import json
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any


class Capability(enum.StrEnum):

    READ_TEXT = "read_text"
    READ_STRUCTURE = "read_structure"
    WRITE_BACK = "write_back"
    PRECISE_LOCATION = "precise_location"
    OCR = "ocr"
    VISION = "vision"


KNOWN_CAPABILITIES: tuple[Capability, ...] = tuple(Capability)


class CapabilityStatus(enum.StrEnum):

    AVAILABLE = "available"
    NEEDS_UNLOCK = "needs_unlock"
    UNSUPPORTED = "unsupported"


@dataclass(frozen=True, slots=True)
class CapabilityEntry:

    app: str
    capability: Capability
    status: CapabilityStatus
    notes: str | None = None


class CapabilityMatrixError(ValueError):
    pass


def entry_dict(entry: CapabilityEntry) -> dict[str, Any]:
    return {
        "app": entry.app,
        "capability": entry.capability.value,
        "status": entry.status.value,
        "notes": entry.notes,
    }


class CapabilityMatrix:

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._entries: dict[tuple[str, Capability], CapabilityEntry] = {}

    def set(
        self,
        app: str,
        capability: Capability,
        status: CapabilityStatus,
        notes: str | None = None,
    ) -> None:
        if not isinstance(app, str) or not app.strip():
            raise ValueError("app must be a non-empty string")
        capability = Capability(capability)
        status = CapabilityStatus(status)
        entry = CapabilityEntry(app=app, capability=capability, status=status, notes=notes)
        with self._lock:
            self._entries[(app, capability)] = entry

    def get(self, app: str, capability: Capability) -> CapabilityStatus | None:
        with self._lock:
            entry = self._entries.get((app, capability))
        return None if entry is None else entry.status

    def status_for(self, app: str) -> dict[Capability, CapabilityStatus]:
        with self._lock:
            return {
                entry.capability: entry.status
                for key, entry in self._entries.items()
                if key[0] == app
            }

    def apps(self) -> list[str]:
        with self._lock:
            return sorted({app for app, _capability in self._entries})

    def save(self, path: str | Path) -> None:
        with self._lock:
            entries = [entry_dict(e) for e in self._entries.values()]
        payload = {"entries": entries}
        Path(path).write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")

    @classmethod
    def load(cls, path: str | Path) -> CapabilityMatrix:
        raw = Path(path).read_text(encoding="utf-8")
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise CapabilityMatrixError(f"matrix file is not valid JSON: {exc}") from exc
        if not isinstance(payload, dict) or not isinstance(payload.get("entries"), list):
            raise CapabilityMatrixError("matrix file must be a JSON object with an 'entries' list")
        matrix = cls()
        for index, item in enumerate(payload["entries"]):
            try:
                app = item["app"]
                if not isinstance(app, str) or not app.strip():
                    raise TypeError("app must be a non-empty string")
                capability = Capability(item["capability"])
                status = CapabilityStatus(item["status"])
            except (KeyError, TypeError, ValueError) as exc:
                raise CapabilityMatrixError(f"entry {index} is missing or has an invalid field") from exc
            notes = item.get("notes")
            if notes is not None and not isinstance(notes, str):
                raise CapabilityMatrixError(f"entry {index} 'notes' must be a string or null")
            matrix.set(app, capability, status, notes)
        return matrix
