"""Per-interaction cost ledger (harness gap review L13).

Every interaction produces one :class:`LedgerEntry`: token spend split into
text/vision, per-stage latency, the evidence layer that answered, confidence,
whether the visual escape hatch (look) fired, success, and egress event
references. Entries persist as versioned JSON; end-to-end latency is derived
from the started/ended timestamps and open entries (``ended_at_utc is None``)
never participate in latency statistics.

This module is pure Python with no UI, OCR, or platform dependencies; its
only I/O is the JSON ledger file.
"""

from __future__ import annotations

import json
import threading
from collections import Counter
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from datetime import datetime, timezone
from math import ceil, floor
from pathlib import Path
from typing import Any

LEDGER_SCHEMA = "interaction_ledger"
LEDGER_VERSION = 1
EVIDENCE_LAYERS = ("L0", "L1", "L2", "L3", "L4")

_REQUIRED_ENTRY_KEYS = frozenset(
    {
        "interaction_id",
        "started_at_utc",
        "ended_at_utc",
        "app_name",
        "turns",
        "tokens_text",
        "tokens_vision",
        "stage_latency_ms",
        "evidence_layer_hit",
        "confidence",
        "used_look",
        "succeeded",
        "failure_type",
        "egress_event_ids",
    }
)


class LedgerError(Exception):
    """Base error for ledger misuse and persistence failures."""


class LedgerDuplicateError(LedgerError):
    """The interaction_id was already recorded."""


@dataclass(frozen=True, slots=True)
class LedgerEntry:
    """One interaction's full cost and outcome bill.

    Validation invariants:
    - ``interaction_id`` is non-empty.
    - token counts are non-negative.
    - ``confidence`` is ``None`` or within 0..1.
    - ``evidence_layer_hit`` is ``None`` or one of L0..L4.
    """

    interaction_id: str
    started_at_utc: str
    ended_at_utc: str | None
    app_name: str | None
    turns: int
    tokens_text: int = 0
    tokens_vision: int = 0
    stage_latency_ms: dict[str, float] = field(default_factory=dict)
    evidence_layer_hit: str | None = None
    confidence: float | None = None
    used_look: bool = False
    succeeded: bool | None = None
    failure_type: str | None = None
    egress_event_ids: tuple[str, ...] = ()
    input_artifact_id: str | None = None

    def __post_init__(self) -> None:
        if not self.interaction_id.strip():
            raise ValueError("interaction_id must be non-empty")
        if self.tokens_text < 0 or self.tokens_vision < 0:
            raise ValueError("token counts must be non-negative")
        if self.confidence is not None and not 0.0 <= self.confidence <= 1.0:
            raise ValueError(f"confidence must be within 0..1, got {self.confidence!r}")
        if self.evidence_layer_hit is not None and self.evidence_layer_hit not in EVIDENCE_LAYERS:
            raise ValueError(
                f"evidence_layer_hit must be one of {EVIDENCE_LAYERS}, "
                f"got {self.evidence_layer_hit!r}"
            )

    def to_public_dict(self) -> dict[str, Any]:
        """Return the bounded GUI/CLI bill without exposing raw session events."""
        return {
            "interactionId": self.interaction_id,
            "startedAtUtc": self.started_at_utc,
            "endedAtUtc": self.ended_at_utc,
            "appName": self.app_name,
            "turns": self.turns,
            "tokensText": self.tokens_text,
            "tokensVision": self.tokens_vision,
            "stageLatencyMs": dict(self.stage_latency_ms),
            "evidenceLayerHit": self.evidence_layer_hit,
            "confidence": self.confidence,
            "usedLook": self.used_look,
            "succeeded": self.succeeded,
            "failureType": self.failure_type,
            "egressEventIds": list(self.egress_event_ids),
            "inputArtifactId": self.input_artifact_id,
        }


@dataclass(frozen=True, slots=True)
class LedgerSummary:
    """Aggregate view of all recorded interactions.

    ``success_rate`` and ``look_ratio`` are ``None`` when there is nothing to
    divide; ``latency_p50_ms``/``latency_p95_ms`` are ``None`` when no closed
    entry has a computable end-to-end latency.
    """

    total_interactions: int
    tokens_text_total: int
    tokens_vision_total: int
    success_rate: float | None
    look_ratio: float | None
    latency_p50_ms: float | None
    latency_p95_ms: float | None
    top_failure_types: tuple[tuple[str, int], ...]


class InteractionLedger:
    """Thread-safe store of interaction bills with query, summary, JSON I/O."""

    def __init__(self) -> None:
        self._entries: dict[str, LedgerEntry] = {}
        self._lock = threading.Lock()

    @classmethod
    def from_session(cls, session: Any) -> "InteractionLedger":
        """Project a ledger from the EventSession log; never writes another file."""
        ledger = cls()
        for entry in project_session(session):
            ledger.record(entry)
        return ledger

    def record(self, entry: LedgerEntry) -> None:
        """Add ``entry``; rejects a duplicate ``interaction_id``."""
        with self._lock:
            if entry.interaction_id in self._entries:
                raise LedgerDuplicateError(
                    f"interaction_id {entry.interaction_id!r} already recorded"
                )
            self._entries[entry.interaction_id] = entry

    def get(self, interaction_id: str) -> LedgerEntry:
        """Return the entry; raises :class:`LedgerError` when unknown."""
        with self._lock:
            try:
                return self._entries[interaction_id]
            except KeyError:
                raise LedgerError(f"unknown interaction_id {interaction_id!r}") from None

    def query(
        self,
        app_name: str | None = None,
        succeeded: bool | None = None,
        min_tokens: int | None = None,
    ) -> list[LedgerEntry]:
        """Return entries in insertion order matching all provided filters.

        ``min_tokens`` compares against the text+vision token total. ``None``
        filters are ignored.
        """
        with self._lock:
            entries = list(self._entries.values())
        matched = []
        for entry in entries:
            if app_name is not None and entry.app_name != app_name:
                continue
            if succeeded is not None and entry.succeeded is not succeeded:
                continue
            if min_tokens is not None and entry.tokens_text + entry.tokens_vision < min_tokens:
                continue
            matched.append(entry)
        return matched

    def summarize(self) -> LedgerSummary:
        """Aggregate all entries; see :class:`LedgerSummary` for honesty rules."""
        with self._lock:
            entries = list(self._entries.values())
        total = len(entries)
        decided = [e for e in entries if e.succeeded is not None]
        latencies = [ms for ms in (_e2e_ms(e) for e in entries) if ms is not None]
        counted = Counter(e.failure_type for e in entries if e.failure_type is not None)
        return LedgerSummary(
            total_interactions=total,
            tokens_text_total=sum(e.tokens_text for e in entries),
            tokens_vision_total=sum(e.tokens_vision for e in entries),
            success_rate=sum(e.succeeded for e in decided) / len(decided) if decided else None,
            look_ratio=sum(e.used_look for e in entries) / total if total else None,
            latency_p50_ms=_percentile(latencies, 50) if latencies else None,
            latency_p95_ms=_percentile(latencies, 95) if latencies else None,
            top_failure_types=tuple(
                sorted(counted.items(), key=lambda kv: (-kv[1], kv[0]))[:3]
            ),
        )

    def save(self, path: str | Path) -> None:
        """Write all entries as a versioned JSON file."""
        with self._lock:
            entries = list(self._entries.values())
        payload = {
            "schema": LEDGER_SCHEMA,
            "version": LEDGER_VERSION,
            "entries": [_entry_to_dict(e) for e in entries],
        }
        Path(path).write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")

    def load(self, path: str | Path) -> list[LedgerEntry]:
        """Adopt entries from a JSON ledger file.

        The file must match the ledger schema; any malformed, wrong-version,
        or invalid entry raises :class:`LedgerError`. Duplicate interaction
        ids inside the file are rejected.
        """
        try:
            raw = json.loads(Path(path).read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise LedgerError(f"cannot read ledger file {path}: {exc}") from exc
        if not isinstance(raw, dict):
            raise LedgerError(f"{path} is not a ledger object")
        if raw.get("schema") != LEDGER_SCHEMA or raw.get("version") != LEDGER_VERSION:
            raise LedgerError(f"{path} is not a {LEDGER_SCHEMA} v{LEDGER_VERSION} file")
        raw_entries = raw.get("entries")
        if not isinstance(raw_entries, list):
            raise LedgerError(f"{path} has no entries list")
        try:
            entries = [_entry_from_dict(e) for e in raw_entries]
        except (KeyError, TypeError, ValueError) as exc:
            raise LedgerError(f"{path} contains an invalid entry: {exc}") from exc
        seen: set[str] = set()
        for entry in entries:
            if entry.interaction_id in seen:
                raise LedgerError(f"{path} contains duplicate interaction_id {entry.interaction_id!r}")
            seen.add(entry.interaction_id)
        with self._lock:
            self._entries = {e.interaction_id: e for e in entries}
        return entries


def _e2e_ms(entry: LedgerEntry) -> float | None:
    """Milliseconds between started and ended timestamps.

    Returns ``None`` for open entries, unparseable timestamps, or a negative
    interval (the data cannot be trusted; keep it out of the statistics).
    """
    if entry.ended_at_utc is None:
        return None
    try:
        start = datetime.fromisoformat(entry.started_at_utc)
        end = datetime.fromisoformat(entry.ended_at_utc)
        delta_ms = (end - start).total_seconds() * 1000.0
    except (ValueError, TypeError):
        return None
    return delta_ms if delta_ms >= 0 else None


def _iso_utc(time_ms: int) -> str:
    return datetime.fromtimestamp(time_ms / 1000.0, tz=timezone.utc).isoformat()


def _usage_tokens(usage: Mapping[str, Any]) -> tuple[int, int]:
    def number(*names: str) -> int:
        for name in names:
            value = usage.get(name)
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                return max(0, int(value))
        return 0

    vision = number("vision_tokens", "image_tokens", "visionTokens", "imageTokens")
    total = number("total_tokens", "totalTokens")
    if total == 0:
        total = number("input_tokens", "prompt_tokens", "inputTokens", "promptTokens")
        total += number(
            "output_tokens", "completion_tokens", "outputTokens", "completionTokens"
        )
    return max(0, total - vision), vision


def project_session(session: Any) -> tuple[LedgerEntry, ...]:
    """Derive interaction bills from one verified EventSession event stream."""
    events = tuple(session.events)
    starts = [event for event in events if event.type == "interaction/start"]
    entries: list[LedgerEntry] = []
    for start in starts:
        turn = int(start.data.get("turn") or 0)
        relevant = [
            event
            for event in events[start.seq + 1 :]
            if int(event.data.get("turn") or turn) == turn
        ]
        end = next(
            (
                event
                for event in relevant
                if event.type == "turn/end"
                and int(event.data.get("turn") or 0) == turn
            ),
            None,
        )
        if end is not None:
            relevant = [event for event in relevant if event.seq <= end.seq]

        tokens_text = 0
        tokens_vision = 0
        model_latency = 0.0
        model_requests: dict[int, int] = {}
        tool_latency = 0.0
        used_look = start.data.get("usedLook") is True
        egress_ids: list[str] = []
        operation_effects: dict[str, str] = {}
        model_turns = 0
        for event in relevant:
            step = int(event.data.get("step") or 0)
            if event.type == "model/request":
                model_requests[step] = event.time_ms
            elif event.type == "model/response":
                model_turns += 1
                text, vision = _usage_tokens(dict(event.data.get("usage") or {}))
                tokens_text += text
                tokens_vision += vision
                requested_at = model_requests.pop(step, None)
                if requested_at is not None:
                    model_latency += max(0, event.time_ms - requested_at)
            elif event.type == "operation/prepared":
                operation_id = str(event.data.get("operationId") or "")
                effect = str(event.data.get("effect") or "")
                operation_effects[operation_id] = effect
                name = str(event.data.get("name") or "").casefold()
                used_look = used_look or name == "look" or name.endswith("_look")
            elif event.type == "operation/settled":
                latency = event.data.get("latencyMs")
                if isinstance(latency, (int, float)) and not isinstance(latency, bool):
                    tool_latency += max(0.0, float(latency))
                operation_id = str(event.data.get("operationId") or "")
                if (
                    event.data.get("outcome") == "succeeded"
                    and operation_effects.get(operation_id)
                    in {"local_irreversible", "external_send", "destructive", "purchase"}
                ):
                    egress_ids.append(operation_id)

        stage_latency: dict[str, float] = {
            "model": model_latency,
            "tool": tool_latency,
        }
        if end is not None:
            stage_latency["e2e"] = max(0, end.time_ms - start.time_ms)
        reason = str(end.data.get("reason") or "") if end is not None else ""
        if end is None or reason in {"awaiting_user_input", "pending_user_input"}:
            succeeded = None
            failure_type = None
        elif reason == "completed":
            succeeded = True
            failure_type = None
        else:
            succeeded = False
            failure_type = reason or "unknown"
        confidence = start.data.get("confidence")
        entries.append(LedgerEntry(
            interaction_id=str(start.data.get("interactionId") or f"{session.id}:{turn}"),
            started_at_utc=_iso_utc(start.time_ms),
            ended_at_utc=_iso_utc(end.time_ms) if end is not None else None,
            app_name=(str(start.data.get("appName")) if start.data.get("appName") else None),
            turns=model_turns,
            tokens_text=tokens_text,
            tokens_vision=tokens_vision,
            stage_latency_ms=stage_latency,
            evidence_layer_hit=(
                str(start.data.get("evidenceLayerHit"))
                if start.data.get("evidenceLayerHit")
                else None
            ),
            confidence=(float(confidence) if isinstance(confidence, (int, float)) else None),
            used_look=used_look,
            succeeded=succeeded,
            failure_type=failure_type,
            egress_event_ids=tuple(egress_ids),
            input_artifact_id=(
                str(start.data.get("inputArtifactId"))
                if start.data.get("inputArtifactId")
                else None
            ),
        ))
    return tuple(entries)


def _percentile(values: Iterable[float], p: float) -> float:
    """Linear-interpolated percentile; requires a non-empty iterable."""
    ordered = sorted(values)
    if not ordered:
        raise ValueError("cannot compute percentile of empty sequence")
    k = (len(ordered) - 1) * (p / 100.0)
    low = floor(k)
    high = ceil(k)
    if low == high:
        return ordered[low]
    return ordered[low] * (high - k) + ordered[high] * (k - low)


def _entry_to_dict(entry: LedgerEntry) -> dict[str, Any]:
    return {
        "interaction_id": entry.interaction_id,
        "started_at_utc": entry.started_at_utc,
        "ended_at_utc": entry.ended_at_utc,
        "app_name": entry.app_name,
        "turns": entry.turns,
        "tokens_text": entry.tokens_text,
        "tokens_vision": entry.tokens_vision,
        "stage_latency_ms": dict(entry.stage_latency_ms),
        "evidence_layer_hit": entry.evidence_layer_hit,
        "confidence": entry.confidence,
        "used_look": entry.used_look,
        "succeeded": entry.succeeded,
        "failure_type": entry.failure_type,
        "egress_event_ids": list(entry.egress_event_ids),
        "input_artifact_id": entry.input_artifact_id,
    }


def _entry_from_dict(d: Mapping[str, Any]) -> LedgerEntry:
    """Reconstruct an entry with strict schema validation (load)."""
    if not isinstance(d, dict):
        raise TypeError(f"entry is {type(d).__name__}, expected dict")
    missing = _REQUIRED_ENTRY_KEYS - d.keys()
    if missing:
        raise KeyError(f"entry missing fields {sorted(missing)}")
    stage_latency_ms = dict(d["stage_latency_ms"])
    if not isinstance(d["stage_latency_ms"], dict) or any(
        not isinstance(k, str) or isinstance(v, bool) or not isinstance(v, (int, float))
        for k, v in stage_latency_ms.items()
    ):
        raise TypeError("stage_latency_ms must map stage names to numbers")
    egress_ids = tuple(d["egress_event_ids"])
    if not isinstance(d["egress_event_ids"], list) or any(
        not isinstance(i, str) for i in egress_ids
    ):
        raise TypeError("egress_event_ids must be a list of strings")
    if not isinstance(d["interaction_id"], str):
        raise TypeError("interaction_id must be a string")
    if not isinstance(d["started_at_utc"], str):
        raise TypeError("started_at_utc must be a string")
    if not (d["ended_at_utc"] is None or isinstance(d["ended_at_utc"], str)):
        raise TypeError("ended_at_utc must be a string or null")
    if not (d["app_name"] is None or isinstance(d["app_name"], str)):
        raise TypeError("app_name must be a string or null")
    if not (d["evidence_layer_hit"] is None or isinstance(d["evidence_layer_hit"], str)):
        raise TypeError("evidence_layer_hit must be a string or null")
    if not (d["failure_type"] is None or isinstance(d["failure_type"], str)):
        raise TypeError("failure_type must be a string or null")
    for name in ("turns", "tokens_text", "tokens_vision"):
        if isinstance(d[name], bool) or not isinstance(d[name], int):
            raise TypeError(f"{name} must be an int")
    if isinstance(d["confidence"], bool) or not (
        d["confidence"] is None or isinstance(d["confidence"], (int, float))
    ):
        raise TypeError("confidence must be a number or null")
    if not isinstance(d["used_look"], bool):
        raise TypeError("used_look must be a bool")
    if not (d["succeeded"] is None or isinstance(d["succeeded"], bool)):
        raise TypeError("succeeded must be a bool or null")
    return LedgerEntry(
        interaction_id=d["interaction_id"],
        started_at_utc=d["started_at_utc"],
        ended_at_utc=d["ended_at_utc"],
        app_name=d["app_name"],
        turns=d["turns"],
        tokens_text=d["tokens_text"],
        tokens_vision=d["tokens_vision"],
        stage_latency_ms=stage_latency_ms,
        evidence_layer_hit=d["evidence_layer_hit"],
        confidence=d["confidence"],
        used_look=d["used_look"],
        succeeded=d["succeeded"],
        failure_type=d["failure_type"],
        egress_event_ids=egress_ids,
        input_artifact_id=(
            str(d.get("input_artifact_id"))
            if d.get("input_artifact_id") is not None
            else None
        ),
    )
