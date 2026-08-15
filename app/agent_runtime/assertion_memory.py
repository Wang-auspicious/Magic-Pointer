"""Assertion memory: the O(1) working-memory layer (law III, active forgetting).

After a sub-task settles, the harness must NOT keep its transcript. It keeps
only low-dimensional assertions: deterministic receipts ("path A → 503, not
viable"), invariants, and verified post-conditions. Lookup is a constant-time
table keyed by (app|surface, object kind); relevance is recency × hit count,
not vector similarity over transcripts. The full record always remains in the
append-only run journal for replay — memory is a view, never the source.

Hard bounds: max assertions (LRU eviction), max text length, optional expiry.
No I/O, no vector search, no model. Pure data structure.
"""

from __future__ import annotations

import time
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Iterable, Mapping

MAX_ASSERTION_CHARS = 120
DEFAULT_MAX_ASSERTIONS = 200
DEFAULT_TTL_S = 24 * 3600


@dataclass(frozen=True)
class Assertion:
    """One invariant-shaped memory cell. Immutable once recorded."""

    key: str                     # stable id: f"{surface}|{object_kind}|{fingerprint}"
    kind: str                    # invariant | failure | recipe | fact
    text: str                    # ≤ MAX_ASSERTION_CHARS, assertion-shaped prose
    source_run: str              # run id that produced it
    recorded_at: float
    expires_at: float | None     # epoch seconds; None = never
    hits: int = 0

    def to_dict(self) -> dict[str, object]:
        return {
            "key": self.key,
            "kind": self.kind,
            "text": self.text,
            "source_run": self.source_run,
            "recorded_at": self.recorded_at,
            "expires_at": self.expires_at,
            "hits": self.hits,
        }

    @classmethod
    def from_dict(cls, data: Mapping[str, object]) -> "Assertion":
        return cls(
            key=str(data["key"]),
            kind=str(data["kind"]),
            text=str(data["text"])[:MAX_ASSERTION_CHARS],
            source_run=str(data["source_run"]),
            recorded_at=float(data["recorded_at"]),
            expires_at=float(data["expires_at"]) if data.get("expires_at") is not None else None,
            hits=int(data.get("hits") or 0),
        )


@dataclass
class AssertionStore:
    """Constant-space assertion ledger with LRU eviction and expiry.

    The store itself holds at most ``max_assertions`` cells; every access is a
    hash lookup + an ordered-map move — O(1). Expired cells are dropped lazily
    on access (active forgetting, not a background sweep).
    """

    max_assertions: int = DEFAULT_MAX_ASSERTIONS
    ttl_s: float = DEFAULT_TTL_S
    _cells: OrderedDict[str, Assertion] = field(default_factory=OrderedDict)

    def _purge(self, now: float) -> None:
        expired = [k for k, a in self._cells.items()
                   if a.expires_at is not None and a.expires_at <= now]
        for key in expired:
            self._cells.pop(key, None)

    def remember(
        self,
        key: str,
        kind: str,
        text: str,
        source_run: str,
        now: float | None = None,
        ttl_s: float | None = None,
    ) -> Assertion:
        """Upsert one assertion. Re-remembering the same key replaces the text
        (the new truth wins — memory holds the newest verified invariant, not
        a transcript of corrections) and bumps hits."""
        now = time.time() if now is None else now
        self._purge(now)
        if len(self._cells) >= self.max_assertions and key not in self._cells:
            self._cells.popitem(last=False)  # LRU：最久未用的先被遗忘
        expiry = now + (ttl_s if ttl_s is not None else self.ttl_s)
        previous = self._cells.get(key)
        cell = Assertion(
            key=key,
            kind=kind,
            text=text[:MAX_ASSERTION_CHARS],
            source_run=source_run,
            recorded_at=now,
            expires_at=expiry,
            hits=(previous.hits if previous is not None else 0) + 1,
        )
        self._cells[key] = cell
        self._cells.move_to_end(key)
        return cell

    def recall(
        self,
        scope: str | None = None,
        kind: str | None = None,
        limit: int = 5,
        now: float | None = None,
    ) -> list[Assertion]:
        """Top-k assertions for a scope (app/surface prefix or exact key) and
        kind, ranked by hit count × recency. Deterministic, no embeddings."""
        now = time.time() if now is None else now
        self._purge(now)
        candidates: list[Assertion] = []
        for key, cell in self._cells.items():
            if scope is not None and not key.startswith(scope):
                continue
            if kind is not None and cell.kind != kind:
                continue
            candidates.append(cell)
        candidates.sort(key=lambda a: (a.hits, a.recorded_at), reverse=True)
        return candidates[:limit]

    def forget(self, key: str) -> bool:
        return self._cells.pop(key, None) is not None

    def __len__(self) -> int:
        return len(self._cells)

    def render_for_prompt(self, scope: str | None = None, limit: int = 5) -> str:
        """The only shape that may enter a model surface: one line per cell."""
        lines = [f"- [{a.kind}] {a.text}" for a in self.recall(scope=scope, limit=limit)]
        return "\n".join(lines)


def assertion_key(surface: str, object_kind: str, fingerprint: str) -> str:
    """Stable cell id: surface | object kind | deterministic fingerprint."""
    return f"{surface}|{object_kind}|{fingerprint}"
