"""Clipboard history: what you copied, still there when you need it back.

A bounded, local, searchable ring of recent clipboard entries. Deliberately not
a database — the value is entirely in "the thing I copied ten minutes ago", which
is a small, recent, disposable set.

Three rules that decide the shape:

  **Never store what should not persist.** A clipboard is where passwords live
  for thirty seconds. Entries can be excluded by the same sensitive-app rules
  that gate captures, and anything marked secret by the source is dropped rather
  than truncated — a truncated password is still a password.

  **Deduplicate by content, not by time.** Copying the same snippet five times is
  one entry that moved to the top, not five. Otherwise the list fills with the
  thing you are currently working with and buries what you actually lost.

  **Bounded and self-pruning.** Both by count and by age, checked on write, so it
  cannot grow into a liability nobody remembers agreeing to.

Pure except for one JSON file — no clipboard access here, so the policy can be
argued with in a test rather than against a live desktop.
"""

from __future__ import annotations

import hashlib
import json
import os
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]

MAX_ENTRIES = 100
MAX_AGE_DAYS = 7
MAX_TEXT_CHARS = 20000


def _store_path() -> Path:
    root = Path(os.environ.get("MAGIC_POINTER_USER_DATA_DIR") or ROOT / "data" / "runtime")
    return root / "clipboard-history.json"


def _digest(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


@dataclass(frozen=True)
class ClipboardEntry:
    digest: str
    text: str
    at: float
    app: str
    formats: tuple[str, ...]
    truncated: bool

    def to_dict(self) -> dict[str, Any]:
        return {
            "digest": self.digest,
            "text": self.text,
            "at": self.at,
            "app": self.app,
            "formats": list(self.formats),
            "truncated": self.truncated,
        }

    @staticmethod
    def from_dict(value: Any) -> "ClipboardEntry | None":
        if not isinstance(value, dict):
            return None
        text = str(value.get("text") or "")
        if not text:
            return None
        try:
            at = float(value.get("at") or 0)
        except (TypeError, ValueError):
            return None
        formats = tuple(str(item) for item in list(value.get("formats") or []) if str(item))
        return ClipboardEntry(
            digest=str(value.get("digest") or _digest(text)),
            text=text,
            at=at,
            app=str(value.get("app") or ""),
            formats=formats,
            truncated=value.get("truncated") is True,
        )


class ClipboardHistory:
    def __init__(self, path: Path | str | None = None) -> None:
        self.path = Path(path) if path is not None else _store_path()

    def _load(self) -> list[ClipboardEntry]:
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return []
        entries = [ClipboardEntry.from_dict(item) for item in (raw.get("entries") or [])] if isinstance(raw, dict) else []
        return [entry for entry in entries if entry is not None]

    def _save(self, entries: list[ClipboardEntry]) -> None:
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            temp = self.path.with_suffix(".json.tmp")
            temp.write_text(
                json.dumps({"version": 1, "entries": [entry.to_dict() for entry in entries]}, ensure_ascii=False),
                encoding="utf-8",
            )
            os.replace(temp, self.path)
        except OSError:
            # Losing history is annoying; crashing a copy is not acceptable.
            pass

    def record(
        self,
        text: str,
        *,
        app: str = "",
        formats: tuple[str, ...] | list[str] = (),
        secret: bool = False,
        now: float | None = None,
    ) -> ClipboardEntry | None:
        """Add what was just copied. Returns the stored entry, or None if skipped."""
        value = str(text or "")
        if not value.strip() or secret:
            return None
        moment = time.time() if now is None else now
        truncated = len(value) > MAX_TEXT_CHARS
        if truncated:
            value = value[:MAX_TEXT_CHARS]
        entry = ClipboardEntry(
            digest=_digest(value),
            text=value,
            at=moment,
            app=str(app or ""),
            formats=tuple(str(item) for item in formats if str(item)),
            truncated=truncated,
        )
        # Same content copied again moves to the top rather than adding a row.
        remaining = [item for item in self._load() if item.digest != entry.digest]
        remaining.insert(0, entry)
        self._save(self._prune(remaining, moment))
        return entry

    def _prune(self, entries: list[ClipboardEntry], now: float) -> list[ClipboardEntry]:
        cutoff = now - (MAX_AGE_DAYS * 86400)
        fresh = [entry for entry in entries if entry.at >= cutoff]
        return fresh[:MAX_ENTRIES]

    def recent(self, limit: int = 20) -> list[ClipboardEntry]:
        return self._load()[: max(0, int(limit))]

    def search(self, query: str, *, limit: int = 20) -> list[ClipboardEntry]:
        """Substring match, case-folded. Small set, so nothing cleverer earns its keep."""
        needle = str(query or "").strip().casefold()
        if not needle:
            return self.recent(limit)
        return [entry for entry in self._load() if needle in entry.text.casefold()][: max(0, int(limit))]

    def get(self, digest: str) -> ClipboardEntry | None:
        key = str(digest or "")
        return next((entry for entry in self._load() if entry.digest == key), None)

    def clear(self) -> int:
        removed = len(self._load())
        self._save([])
        return removed
