"""Screen memory: "what was that paper I was reading this morning".

The useful question is never "show me everything I have seen". It is one
specific thing, half-remembered, with a rough time attached. So this stores the
minimum that answers that question and nothing more:

    when, which app, which window, and a short excerpt of what was read

Deliberately **not** screenshots. A rolling capture of the screen is a different
product with a different consent conversation, and it is not needed to answer
"what was that paper called" — the title and a few words are.

Three properties this has to keep, in order of how badly they fail:

  **Off means off.** Disabled in settings, nothing is written. Not written and
  filtered on read; not written at all.
  **Sensitive apps never enter.** The same rules that gate captures gate this.
  A password manager's window title is exactly the kind of thing that must not
  end up in a searchable local log.
  **Bounded and forgettable.** By count and by age, pruned on write, and
  clearable in one call — because a memory nobody can empty is a liability.
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

MAX_ENTRIES = 400
MAX_AGE_HOURS = 24
MAX_EXCERPT_CHARS = 400


def _store_path() -> Path:
    root = Path(os.environ.get("MAGIC_POINTER_USER_DATA_DIR") or ROOT / "data" / "runtime")
    return root / "screen-memory.json"


@dataclass(frozen=True)
class MemoryEntry:
    id: str
    at: float
    app: str
    window_title: str
    excerpt: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "at": self.at,
            "app": self.app,
            "windowTitle": self.window_title,
            "excerpt": self.excerpt,
        }

    @staticmethod
    def from_dict(value: Any) -> "MemoryEntry | None":
        if not isinstance(value, dict):
            return None
        try:
            at = float(value.get("at") or 0)
        except (TypeError, ValueError):
            return None
        excerpt = str(value.get("excerpt") or "")
        title = str(value.get("windowTitle") or "")
        if not excerpt and not title:
            return None
        return MemoryEntry(
            id=str(value.get("id") or ""),
            at=at,
            app=str(value.get("app") or ""),
            window_title=title,
            excerpt=excerpt,
        )


class ScreenMemory:
    def __init__(self, path: Path | str | None = None, *, enabled: bool = True) -> None:
        self.path = Path(path) if path is not None else _store_path()
        self.enabled = enabled is True

    def _load(self) -> list[MemoryEntry]:
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return []
        items = raw.get("entries") if isinstance(raw, dict) else None
        entries = [MemoryEntry.from_dict(item) for item in (items or [])]
        return [entry for entry in entries if entry is not None]

    def _save(self, entries: list[MemoryEntry]) -> None:
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            temp = self.path.with_suffix(".json.tmp")
            temp.write_text(
                json.dumps({"version": 1, "entries": [entry.to_dict() for entry in entries]}, ensure_ascii=False),
                encoding="utf-8",
            )
            os.replace(temp, self.path)
        except OSError:
            pass

    def record(
        self,
        *,
        app: str = "",
        window_title: str = "",
        excerpt: str = "",
        sensitive: bool = False,
        now: float | None = None,
    ) -> MemoryEntry | None:
        """Remember one thing that was on screen. None when nothing was stored."""
        if not self.enabled or sensitive:
            return None
        text = str(excerpt or "").strip()[:MAX_EXCERPT_CHARS]
        title = str(window_title or "").strip()[:200]
        if not text and not title:
            return None
        moment = time.time() if now is None else now
        entry = MemoryEntry(
            id=hashlib.sha256(f"{moment}:{title}:{text}".encode("utf-8")).hexdigest()[:16],
            at=moment,
            app=str(app or "").strip()[:80],
            window_title=title,
            excerpt=text,
        )
        entries = self._load()
        # Re-reading the same thing updates when you saw it rather than adding a
        # row; otherwise one long session buries every other memory.
        entries = [
            item for item in entries
            if not (item.window_title == entry.window_title and item.excerpt == entry.excerpt)
        ]
        entries.insert(0, entry)
        self._save(self._prune(entries, moment))
        return entry

    def _prune(self, entries: list[MemoryEntry], now: float) -> list[MemoryEntry]:
        cutoff = now - (MAX_AGE_HOURS * 3600)
        return [entry for entry in entries if entry.at >= cutoff][:MAX_ENTRIES]

    def recall(
        self,
        query: str = "",
        *,
        since: float | None = None,
        until: float | None = None,
        limit: int = 20,
        now: float | None = None,
    ) -> list[MemoryEntry]:
        """Find it again. Substring over title and excerpt, optionally in a window of time."""
        moment = time.time() if now is None else now
        entries = self._prune(self._load(), moment)
        if since is not None:
            entries = [entry for entry in entries if entry.at >= since]
        if until is not None:
            entries = [entry for entry in entries if entry.at <= until]
        needle = str(query or "").strip().casefold()
        if needle:
            entries = [
                entry for entry in entries
                if needle in entry.excerpt.casefold() or needle in entry.window_title.casefold()
            ]
        return entries[: max(0, int(limit))]

    def clear(self) -> int:
        removed = len(self._load())
        self._save([])
        return removed
