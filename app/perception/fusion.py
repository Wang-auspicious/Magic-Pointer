"""Fusion: typed observations in, one verdict plus visible uncertainty out.

Fusion is the only place allowed to decide which evidence represents the user's
mark. It is pure: no I/O, no provider calls, no clock. That is what lets the
same verdict be reached in the process that owns the frozen frame and in the
process that later adds the pixel tier.

What it replaces: the bridge chains that used to decide by control flow — an
Explorer read short-circuiting the fan-out, a surface adapter overwriting the
trace, a `structured_covers_mark` boolean sending OCR to another process where
it silently substituted the structured context.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Iterable, Sequence

from app.adapters.base import AdapterReadContext
from app.evidence.contract import EvidenceStatus
from app.perception.providers import TIER_ORDER, TIER_PIXEL, PerceptionObservation

# Two reads of the same line rarely match character for character once one of
# them came from pixels. This is the point at which "the same content, read
# imperfectly" stops being a plausible explanation.
AGREEMENT_RATIO = 0.6

_NUMBER_RE = re.compile(r"\d+(?:[.,]\d+)*")

_UNREAD_STATUSES = frozenset({
    EvidenceStatus.BUSY,
    EvidenceStatus.TIMEOUT,
    EvidenceStatus.DENIED,
    EvidenceStatus.ERROR,
})


def _normalized(text: str) -> str:
    return " ".join(str(text or "").casefold().split())


def _numbers(text: str) -> tuple[str, ...]:
    return tuple(sorted(match.group(0) for match in _NUMBER_RE.finditer(text)))


def _bigrams(text: str) -> set[str]:
    compact = text.replace(" ", "")
    return {compact[index:index + 2] for index in range(len(compact) - 1)}


def texts_agree(left: str, right: str) -> bool:
    """Could these two strings be the same content read by different sources?

    Numbers are compared exactly and first. "Invoice total: 120" and "Invoice
    total: 210" are 70% similar as text and completely different as facts, and
    a fusion layer that calls them the same is worse than no fusion at all.
    Everything else tolerates recognition noise.
    """
    first, second = _normalized(left), _normalized(right)
    if not first or not second:
        return True
    if first == second or first in second or second in first:
        return True
    if _numbers(first) != _numbers(second):
        return False
    left_grams, right_grams = _bigrams(first), _bigrams(second)
    if not left_grams or not right_grams:
        return False
    union = left_grams | right_grams
    return len(left_grams & right_grams) / len(union) >= AGREEMENT_RATIO


@dataclass(frozen=True, slots=True)
class FusedPerception:
    selected: PerceptionObservation | None
    observations: tuple[PerceptionObservation, ...]
    conflicts: tuple[dict[str, Any], ...]
    corroborations: tuple[dict[str, Any], ...]
    notes: tuple[dict[str, Any], ...]
    read_state: str
    trace: dict[str, Any]

    @property
    def context(self) -> AdapterReadContext | None:
        return self.selected.context if self.selected is not None else None

    @property
    def covers_mark(self) -> bool | None:
        if self.selected is None:
            return None
        return self.selected.covers_mark

    @property
    def coverage_reason(self) -> str:
        if self.selected is None:
            return "structured_context_unavailable"
        if self.selected.covers_mark is False:
            return self.selected.coverage_reason or "structured_did_not_cover_mark"
        return ""


def _rank_key(item: PerceptionObservation) -> tuple[Any, ...]:
    return (
        # Reading the marked thing outranks every other quality. A perfect read
        # of the wrong thing is the failure this whole layer exists to prevent.
        1 if item.covers_mark is False else 0,
        1 if item.container_hint else 0,
        1 if item.status is EvidenceStatus.DEGRADED else 0,
        TIER_ORDER.index(item.tier),
        item.priority,
        -item.confidence,
        item.provider_id,
    )


def select_observation(
    observations: Iterable[PerceptionObservation],
) -> PerceptionObservation | None:
    """Pick the observation that represents the mark, in *this* process.

    An observation rehydrated from another process can lose, corroborate or
    explain a fallback, but it cannot be selected: its payload did not travel
    with it, and a verdict without content is not a verdict.
    """
    candidates = [item for item in observations if item.selectable]
    if not candidates:
        return None
    return min(candidates, key=_rank_key)


def pixel_tier_warranted(
    observations: Sequence[PerceptionObservation],
) -> tuple[bool, str]:
    """Is the expensive tier owed an answer, and on whose account?

    Blueprint §7.3: concurrency does not mean every source always runs. The
    structured tier answering the mark cleanly is the one case where recognising
    the same pixels adds nothing but cost.
    """
    if any(
        item.marked_content and not item.container_hint
        for item in observations
    ):
        return False, "structured_marked_content"
    if not observations:
        return True, "no_structured_provider"
    if any(item.container_hint for item in observations):
        return True, "structured_container_only"
    if any(item.usable for item in observations):
        return True, "structured_did_not_cover_mark"
    if any(item.status in _UNREAD_STATUSES for item in observations):
        return True, "structured_unread"
    return True, "structured_context_unavailable"


def _content_conflicts(
    observations: Sequence[PerceptionObservation],
) -> tuple[tuple[dict[str, Any], ...], tuple[dict[str, Any], ...]]:
    candidates = [
        item
        for item in observations
        if item.marked_content
        and not item.container_hint
        and _normalized(item.content)
    ]
    if len(candidates) < 2:
        return (), ()
    disagreed = False
    for index, left in enumerate(candidates):
        for right in candidates[index + 1:]:
            if not texts_agree(left.content, right.content):
                disagreed = True
                break
        if disagreed:
            break
    sources = [item.provider_id for item in candidates]
    if disagreed:
        return ({"kind": "content_disagreement", "sources": sources},), ()
    return (), ({
        "kind": "content_agreement",
        "sources": sources,
        "layers": sorted({item.layer for item in candidates}),
    },)


def _notes(
    observations: Sequence[PerceptionObservation],
    selected: PerceptionObservation | None,
) -> tuple[dict[str, Any], ...]:
    if selected is None or selected.tier != TIER_PIXEL:
        return ()
    superseded = [
        item
        for item in observations
        if item.tier != TIER_PIXEL and item.usable and item.covers_mark is False
    ]
    if not superseded:
        return ()
    # Not a conflict: the sources do not disagree about content, one of them
    # answered about the surface instead of the mark. Calling it a conflict
    # would put a confirmation prompt in front of every pixel-only app.
    return ({
        "kind": "structured_superseded",
        "sources": [item.provider_id for item in superseded],
        "reason": superseded[0].coverage_reason or "structured_did_not_cover_mark",
    },)


def _read_state(
    observations: Sequence[PerceptionObservation],
    selected: PerceptionObservation | None,
) -> str:
    if selected is not None:
        return "resolved"
    if observations and all(
        item.status is EvidenceStatus.EMPTY_CONFIRMED for item in observations
    ):
        return "empty_confirmed"
    if any(item.status in _UNREAD_STATUSES for item in observations):
        return "unread"
    return "unavailable"


def _inner_records(
    observation: PerceptionObservation,
    key: str,
    *,
    limit: int,
) -> list[dict[str, Any]]:
    """Records a composite provider collected from its own sub-sources.

    A provider that fans out internally (the gesture strategy reads UIA, COM and
    the DOM) is the only place that per-source detail exists. Dropping it here
    would make the fused trace less informative than the serial code it
    replaces, and would silently swallow a disagreement between two readers
    inside one provider.
    """
    raw = (observation.provider_trace or {}).get(key)
    if not isinstance(raw, list):
        return []
    records: list[dict[str, Any]] = []
    for entry in raw[:limit]:
        if not isinstance(entry, dict):
            continue
        record = dict(entry)
        record.setdefault("provider", observation.provider_id)
        records.append(record)
    return records


def fuse_observations(
    observations: Sequence[PerceptionObservation],
    *,
    elapsed_ms: float = 0.0,
    policy_mode: str | None = None,
    declined: tuple[str, ...] = (),
) -> FusedPerception:
    ordered = tuple(sorted(observations, key=lambda item: item.index))
    selected = select_observation(ordered)
    conflicts, corroborations = _content_conflicts(ordered)
    notes = _notes(ordered, selected)
    for item in ordered:
        conflicts += tuple(_inner_records(item, "conflicts", limit=4))
        corroborations += tuple(_inner_records(item, "corroborations", limit=4))
    read_state = _read_state(ordered, selected)
    covered = selected.covers_mark if selected is not None else None
    coverage_reason = ""
    if selected is not None and selected.covers_mark is False:
        coverage_reason = selected.coverage_reason or "structured_did_not_cover_mark"

    attempts: list[dict[str, Any]] = []
    for item in ordered:
        attempts.append(item.to_legacy_attempt())
        attempts.extend(_inner_records(item, "attempts", limit=8))
    if not ordered:
        attempts = [{
            "layer": "structured",
            "adapter": "registry",
            "method": "none",
            "status": "unavailable",
            "reason": "no_matching_adapter",
        }]

    fallback_reason: str | None = None
    if selected is None:
        # A provider that knows *why* it found nothing outranks the generic
        # reason: "gesture_no_bounded_candidate" tells the operator the mark
        # landed on nothing, "structured_context_unavailable" tells them nothing.
        inner_reasons = [
            reason
            for item in ordered
            if (reason := str((item.provider_trace or {}).get("fallbackReason") or "").strip())
            and reason != "structured_context_unavailable"
        ]
        fallback_reason = inner_reasons[0] if inner_reasons else "structured_context_unavailable"
    elif selected.tier == TIER_PIXEL:
        fallback_reason = pixel_tier_warranted(
            [item for item in ordered if item.tier != TIER_PIXEL]
        )[1]
    elif coverage_reason:
        fallback_reason = coverage_reason

    trace = {
        "schemaVersion": 1,
        "selectedLayer": selected.layer if selected is not None else None,
        "selectedAdapter": selected.adapter if selected is not None else None,
        "selectedMethod": selected.method if selected is not None else None,
        "selectedProviderId": selected.provider_id if selected is not None else None,
        "selectedTier": selected.tier if selected is not None else None,
        "pixelFallbackUsed": selected is not None and selected.tier == TIER_PIXEL,
        "fallbackReason": fallback_reason,
        "policyMode": policy_mode,
        "readState": read_state,
        "marksCovered": covered,
        "coverageReason": coverage_reason,
        "elapsedMs": round(elapsed_ms, 3),
        "attempts": attempts,
        "observations": [item.to_trace_dict() for item in ordered],
        "conflicts": [dict(item) for item in conflicts],
        "corroborations": [dict(item) for item in corroborations],
        "notes": [dict(item) for item in notes],
    }
    if declined:
        trace["notApplicable"] = list(declined)
    return FusedPerception(
        selected=selected,
        observations=ordered,
        conflicts=conflicts,
        corroborations=corroborations,
        notes=notes,
        read_state=read_state,
        trace=trace,
    )
