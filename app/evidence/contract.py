"""Evidence contract: perception sources never return bare values.

Every perception result is an :class:`Evidence` carrying a status that
distinguishes "confirmed empty" from "did not read" (busy/timeout), a
confidence, a source identity, and timing metadata. Fusion and decision
layers consume only this shape.

This module is pure Python and has no I/O or platform dependencies.
"""

from __future__ import annotations

import enum
from dataclasses import dataclass
from typing import Any, Iterable

MIN_CONFIDENCE_FOR_TRUST = 0.5


class EvidenceStatus(str, enum.Enum):
    OK = "ok"
    DEGRADED = "degraded"
    EMPTY_CONFIRMED = "empty_confirmed"
    BUSY = "busy"
    TIMEOUT = "timeout"
    UNSUPPORTED = "unsupported"
    DENIED = "denied"
    ERROR = "error"


class EvidenceSource(str, enum.Enum):
    UIA = "uia"
    CDP = "cdp"
    COM = "com"
    OCR = "ocr"
    VISION = "vision"
    CACHE = "cache"
    FILE = "file"
    TEST = "test"


@dataclass(frozen=True, slots=True)
class Evidence:
    """A single perception result from one source.

    Validation invariants:
    - ``confidence`` is always within 0..1.
    - ``value is None`` is forbidden for ``status=ok``.
    - ``status=ok`` requires ``confidence >= MIN_CONFIDENCE_FOR_TRUST``.
    """

    value: str | None
    status: EvidenceStatus
    confidence: float
    source: EvidenceSource
    latency_ms: float | None = None
    captured_at_utc: str | None = None
    container_hint: bool = False
    note: str | None = None

    def __post_init__(self) -> None:
        if not 0.0 <= self.confidence <= 1.0:
            raise ValueError(f"confidence must be within 0..1, got {self.confidence!r}")
        if self.value is None and self.status is EvidenceStatus.OK:
            raise ValueError("value must not be None when status is ok")
        if self.status is EvidenceStatus.OK and self.confidence < MIN_CONFIDENCE_FOR_TRUST:
            raise ValueError(
                f"status=ok requires confidence >= {MIN_CONFIDENCE_FOR_TRUST}, "
                f"got {self.confidence!r}"
            )


def ok_evidence(value: str | None, source: EvidenceSource, **kwargs: Any) -> Evidence:
    """Build an ok Evidence; defaults confidence to 1.0."""
    confidence = kwargs.pop("confidence", 1.0)
    return Evidence(
        value=value,
        status=EvidenceStatus.OK,
        confidence=confidence,
        source=source,
        **kwargs,
    )


def empty_confirmed(source: EvidenceSource, **kwargs: Any) -> Evidence:
    """Build an empty_confirmed Evidence (the spot is confirmed empty)."""
    confidence = kwargs.pop("confidence", 1.0)
    return Evidence(
        value=None,
        status=EvidenceStatus.EMPTY_CONFIRMED,
        confidence=confidence,
        source=source,
        **kwargs,
    )


def busy_evidence(source: EvidenceSource, latency_ms: float | None, **kwargs: Any) -> Evidence:
    """Build a busy Evidence (did not read: worker occupied)."""
    confidence = kwargs.pop("confidence", 0.0)
    return Evidence(
        value=None,
        status=EvidenceStatus.BUSY,
        confidence=confidence,
        source=source,
        latency_ms=latency_ms,
        **kwargs,
    )


def failed_evidence(
    source: EvidenceSource,
    status: EvidenceStatus,
    note: str | None,
    **kwargs: Any,
) -> Evidence:
    """Build a failed Evidence for timeout/unsupported/denied/error."""
    confidence = kwargs.pop("confidence", 0.0)
    return Evidence(
        value=None,
        status=status,
        confidence=confidence,
        source=source,
        note=note,
        **kwargs,
    )


def apply_container_heuristic(
    evidence: Evidence,
    container_like_texts: Iterable[str],
) -> Evidence:
    """Flag values that merely repeat a container/window/control-type name.

    If ``evidence.value`` is non-empty and its stripped text matches any
    entry of ``container_like_texts``, return a new Evidence with
    ``container_hint=True``, confidence capped at 0.2, and status downgraded
    from ok to degraded. Otherwise the original immutable Evidence is
    returned unchanged.
    """
    if evidence.value is None:
        return evidence
    stripped = evidence.value.strip()
    if not stripped or stripped not in set(container_like_texts):
        return evidence
    status = EvidenceStatus.DEGRADED if evidence.status is EvidenceStatus.OK else evidence.status
    return Evidence(
        value=evidence.value,
        status=status,
        confidence=min(evidence.confidence, 0.2),
        source=evidence.source,
        latency_ms=evidence.latency_ms,
        captured_at_utc=evidence.captured_at_utc,
        container_hint=True,
        note=evidence.note,
    )


_SEVERE_PRIORITY = (
    EvidenceStatus.ERROR,
    EvidenceStatus.DENIED,
    EvidenceStatus.TIMEOUT,
    EvidenceStatus.BUSY,
    EvidenceStatus.UNSUPPORTED,
)


def merge_for_decision(evidences: Iterable[Evidence]) -> Evidence:
    """Fuse all source evidence into a single decision input.

    Rules, in order:
    - no evidence at all -> synthetic empty_confirmed
    - any trustworthy ok (status=ok, not container_hint) -> highest confidence
    - any severe status (error > denied > timeout > busy > unsupported) with
      no ok -> most severe, value None
    - only container hints -> degraded, keep best value
    - only empty_confirmed -> empty_confirmed
    - anything else -> degraded with value when a container hint exists,
      otherwise empty_confirmed
    """
    items = list(evidences)
    note = " ".join(f"{e.source.value}:{e.status.value}" for e in items)

    if not items:
        return Evidence(
            value=None,
            status=EvidenceStatus.EMPTY_CONFIRMED,
            confidence=1.0,
            source=EvidenceSource.CACHE,
            note="no-evidence",
        )

    trustworthy = [
        e for e in items if e.status is EvidenceStatus.OK and not e.container_hint
    ]
    if trustworthy:
        best = max(trustworthy, key=lambda e: e.confidence)
        return Evidence(
            value=best.value,
            status=EvidenceStatus.OK,
            confidence=best.confidence,
            source=best.source,
            latency_ms=best.latency_ms,
            captured_at_utc=best.captured_at_utc,
            container_hint=False,
            note=note,
        )

    severe = [e for e in items if e.status in _SEVERE_PRIORITY]
    if severe:
        worst = min(severe, key=lambda e: _SEVERE_PRIORITY.index(e.status))
        return Evidence(
            value=None,
            status=worst.status,
            confidence=worst.confidence,
            source=worst.source,
            latency_ms=worst.latency_ms,
            captured_at_utc=worst.captured_at_utc,
            note=note,
        )

    hints = [e for e in items if e.container_hint]
    if hints and len(hints) == len(items):
        best = max(hints, key=lambda e: e.confidence)
        return Evidence(
            value=best.value,
            status=EvidenceStatus.DEGRADED,
            confidence=best.confidence,
            source=best.source,
            latency_ms=best.latency_ms,
            captured_at_utc=best.captured_at_utc,
            container_hint=True,
            note=note,
        )

    if all(e.status is EvidenceStatus.EMPTY_CONFIRMED for e in items):
        best = max(items, key=lambda e: e.confidence)
        return Evidence(
            value=None,
            status=EvidenceStatus.EMPTY_CONFIRMED,
            confidence=best.confidence,
            source=best.source,
            latency_ms=best.latency_ms,
            captured_at_utc=best.captured_at_utc,
            note=note,
        )

    if hints:
        best = max(hints, key=lambda e: e.confidence)
        return Evidence(
            value=best.value,
            status=EvidenceStatus.DEGRADED,
            confidence=best.confidence,
            source=best.source,
            latency_ms=best.latency_ms,
            captured_at_utc=best.captured_at_utc,
            container_hint=True,
            note=note,
        )

    return Evidence(
        value=None,
        status=EvidenceStatus.EMPTY_CONFIRMED,
        confidence=1.0,
        source=EvidenceSource.CACHE,
        note=note,
    )


def is_trustworthy(evidence: Evidence) -> bool:
    """True only for ok evidence above the trust threshold, not a container hint."""
    return (
        evidence.status is EvidenceStatus.OK
        and evidence.confidence >= MIN_CONFIDENCE_FOR_TRUST
        and not evidence.container_hint
    )
