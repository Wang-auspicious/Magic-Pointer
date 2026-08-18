"""Concurrent structured-perception broker.

Every matching adapter is an evidence provider. Providers run against the
same already-bound target and are collected as typed observations; completion
order never decides which result wins. The broker deliberately does not read
pixels or create a FrameLease. Its caller must freeze/bind the interaction
before invoking this module.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, wait
from dataclasses import dataclass
from time import perf_counter
from typing import Any, Iterable

from app.adapters.base import AdapterReadContext
from app.evidence.contract import (
    Evidence,
    EvidenceSource,
    EvidenceStatus,
    apply_container_heuristic,
    empty_confirmed,
    failed_evidence,
)

_MEANINGFUL_ARTIFACT_KEYS = frozenset({
    "accessible_name",
    "address",
    "automation_id",
    "cell",
    "control_type",
    "css_selector",
    "dom_selector",
    "element_name",
    "node",
    "object",
    "range",
    "role",
    "rows",
    "selection_rectangles",
    "value",
})

_DEFAULT_PRIORITIES = {
    "native_app": 10,
    "dom": 20,
    "uia": 30,
    "ax": 30,
    "ocr": 40,
    "vision": 50,
}

# A UIA probe against an unresponsive window can block for as long as that
# window stays wedged. Two seconds clears every healthy provider measured on
# this machine (UIA cold start ~573ms, steady 200-250ms) while keeping a
# wedged one from owning the interaction.
DEFAULT_DEADLINE_MS = 2000.0

_BASE_CONFIDENCE = {
    "native_app": 0.95,
    "dom": 0.90,
    "uia": 0.80,
    "ax": 0.80,
    "ocr": 0.70,
    "vision": 0.65,
}


def perception_layer(adapter: Any, context: AdapterReadContext | None = None) -> str:
    explicit = str(getattr(adapter, "perception_layer", "") or "").strip().casefold()
    if explicit:
        return explicit[:40]
    value = " ".join((
        str(getattr(adapter, "name", "") or ""),
        str(getattr(context, "adapter", "") or ""),
        str(getattr(context, "method", "") or ""),
    )).casefold()
    if "dom" in value or "cdp" in value or "playwright" in value:
        return "dom"
    if "uia" in value or "automation" in value or "textpattern" in value:
        return "uia"
    if "ocr" in value:
        return "ocr"
    if "vision" in value:
        return "vision"
    if "ax" in value or "accessibility" in value:
        return "ax"
    return "native_app"


def context_has_usable_structure(context: AdapterReadContext | None) -> bool:
    if context is None:
        return False
    if str(context.content or "").strip():
        return True
    artifacts = dict(context.artifacts or {})
    for key in _MEANINGFUL_ARTIFACT_KEYS:
        value = artifacts.get(key)
        if value not in (None, "", [], {}, ()):
            return True
    return False


def _source_for(layer: str) -> EvidenceSource:
    return {
        "native_app": EvidenceSource.COM,
        "dom": EvidenceSource.CDP,
        "uia": EvidenceSource.UIA,
        "ax": EvidenceSource.UIA,
        "ocr": EvidenceSource.OCR,
        "vision": EvidenceSource.VISION,
    }.get(layer, EvidenceSource.FILE)


def _error_status(error: str) -> EvidenceStatus:
    value = error.casefold()
    if "timed out" in value or "timeout" in value:
        return EvidenceStatus.TIMEOUT
    if "busy" in value or "occupied" in value:
        return EvidenceStatus.BUSY
    if "denied" in value or "permission" in value:
        return EvidenceStatus.DENIED
    if "unsupported" in value or "not supported" in value:
        return EvidenceStatus.UNSUPPORTED
    return EvidenceStatus.ERROR


def _context_value(context: AdapterReadContext) -> str:
    content = str(context.content or "").strip()
    if content:
        return content
    label = str(context.label or "").strip()
    if label:
        return label
    return "<structured-context>"


def _container_like_texts(window: dict[str, Any]) -> tuple[str, ...]:
    candidates = (
        window.get("title"),
        window.get("process_name"),
        window.get("processName"),
        window.get("class_name"),
        window.get("className"),
    )
    return tuple(str(value).strip() for value in candidates if str(value or "").strip())


@dataclass(frozen=True, slots=True)
class StructuredObservation:
    """One adapter result, kept independently from the fused selection."""

    index: int
    priority: int
    layer: str
    adapter: str
    method: str
    status: EvidenceStatus
    confidence: float
    latency_ms: float
    context: AdapterReadContext | None
    container_hint: bool
    reason: str
    source: EvidenceSource

    @property
    def usable(self) -> bool:
        return (
            self.context is not None
            and context_has_usable_structure(self.context)
            and self.status in {EvidenceStatus.OK, EvidenceStatus.DEGRADED}
        )

    def to_trace_dict(self) -> dict[str, Any]:
        return {
            "layer": self.layer,
            "adapter": self.adapter,
            "method": self.method,
            "status": self.status.value,
            "confidence": round(self.confidence, 4),
            "latencyMs": round(self.latency_ms, 3),
            "containerHint": self.container_hint,
            "reason": self.reason,
        }

    def to_legacy_attempt(self) -> dict[str, str]:
        if self.status is EvidenceStatus.OK:
            status = "succeeded"
        elif self.status is EvidenceStatus.DEGRADED:
            status = "degraded"
        elif self.status is EvidenceStatus.EMPTY_CONFIRMED:
            status = "empty"
        elif self.status is EvidenceStatus.UNSUPPORTED:
            status = "unavailable"
        else:
            status = "error"
        return {
            "layer": self.layer[:40],
            "adapter": self.adapter[:80],
            "method": self.method[:120],
            "status": status,
            "reason": self.reason[:120],
        }


@dataclass(frozen=True, slots=True)
class PerceptionBrokerResult:
    context: AdapterReadContext | None
    observations: tuple[StructuredObservation, ...]
    trace: dict[str, Any]


class ConcurrentPerceptionBroker:
    """Collect all selected structured providers and fuse after collection."""

    def __init__(self, *, max_workers: int = 4) -> None:
        if max_workers <= 0:
            raise ValueError("max_workers must be positive")
        self.max_workers = max_workers

    def resolve(
        self,
        window: dict[str, Any],
        candidates: Iterable[Any],
        *,
        deadline_ms: float | None = None,
        **kwargs: Any,
    ) -> PerceptionBrokerResult:
        ordered = list(candidates)
        started = perf_counter()
        observations = self._collect(ordered, window, kwargs, deadline_ms)
        selected = self._select(observations)
        conflicts = _content_conflicts(observations)
        elapsed_ms = (perf_counter() - started) * 1000.0
        trace = _trace_for(observations, selected, conflicts, elapsed_ms)
        return PerceptionBrokerResult(
            context=selected.context if selected is not None else None,
            observations=observations,
            trace=trace,
        )

    def _collect(
        self,
        ordered: list[Any],
        window: dict[str, Any],
        kwargs: dict[str, Any],
        deadline_ms: float | None,
    ) -> tuple[StructuredObservation, ...]:
        """Read every provider, but let the deadline decide when to rule.

        A provider that misses the deadline becomes a TIMEOUT observation and
        the verdict is made from whatever did arrive. Its thread is left to
        finish on its own: this bounds the interaction, not the thread, so
        adapters still owe their own internal timeouts.
        """
        if not ordered:
            return ()
        budget_s = (
            DEFAULT_DEADLINE_MS if deadline_ms is None else float(deadline_ms)
        ) / 1000.0
        pool = ThreadPoolExecutor(
            max_workers=min(self.max_workers, len(ordered)),
            thread_name_prefix="mp-perception",
        )
        try:
            started = perf_counter()
            futures = {
                pool.submit(self._read_one, index, adapter, window, kwargs): index
                for index, adapter in enumerate(ordered)
            }
            done, overdue = wait(futures, timeout=budget_s)
            elapsed_ms = (perf_counter() - started) * 1000.0
            collected = {futures[future]: future.result() for future in done}
            for future in overdue:
                index = futures[future]
                collected[index] = _deadline_observation(
                    index, ordered[index], elapsed_ms
                )
            return tuple(collected[index] for index in range(len(ordered)))
        finally:
            pool.shutdown(wait=False)

    @staticmethod
    def _read_one(
        index: int,
        adapter: Any,
        window: dict[str, Any],
        kwargs: dict[str, Any],
    ) -> StructuredObservation:
        adapter_name = str(getattr(adapter, "name", "") or "unknown")
        declared_layer = perception_layer(adapter)
        priority = int(getattr(
            adapter,
            "perception_priority",
            _DEFAULT_PRIORITIES.get(declared_layer, 50),
        ))
        started = perf_counter()
        try:
            context = adapter.read_context(window, **kwargs)
        except Exception as exc:  # one provider must not erase the others
            latency_ms = (perf_counter() - started) * 1000.0
            return StructuredObservation(
                index=index,
                priority=priority,
                layer=declared_layer,
                adapter=adapter_name,
                method="unknown",
                status=EvidenceStatus.ERROR,
                confidence=0.0,
                latency_ms=latency_ms,
                context=None,
                container_hint=False,
                reason=f"adapter_exception:{type(exc).__name__}",
                source=_source_for(declared_layer),
            )

        latency_ms = (perf_counter() - started) * 1000.0
        if not isinstance(context, AdapterReadContext):
            return StructuredObservation(
                index=index,
                priority=priority,
                layer=declared_layer,
                adapter=adapter_name,
                method="unknown",
                status=EvidenceStatus.ERROR,
                confidence=0.0,
                latency_ms=latency_ms,
                context=None,
                container_hint=False,
                reason="invalid_adapter_result",
                source=_source_for(declared_layer),
            )

        layer = perception_layer(adapter, context)
        source = _source_for(layer)
        method = str(context.method or "unknown")
        usable = context_has_usable_structure(context)
        error = str(context.error or "").strip()
        if usable:
            status = EvidenceStatus.DEGRADED if error else EvidenceStatus.OK
            confidence = _BASE_CONFIDENCE.get(layer, 0.70)
            if error:
                confidence = min(confidence, 0.60)
            evidence = Evidence(
                value=_context_value(context),
                status=status,
                confidence=confidence,
                source=source,
                latency_ms=latency_ms,
                note=error or None,
            )
            evidence = apply_container_heuristic(
                evidence,
                _container_like_texts(window),
            )
            reason = (
                "container_like_content"
                if evidence.container_hint
                else "structured_context_degraded"
                if evidence.status is EvidenceStatus.DEGRADED
                else "structured_context_available"
            )
        elif error:
            status = _error_status(error)
            evidence = failed_evidence(source, status, error, latency_ms=latency_ms)
            reason = {
                EvidenceStatus.TIMEOUT: "adapter_timeout",
                EvidenceStatus.BUSY: "adapter_busy",
                EvidenceStatus.DENIED: "adapter_denied",
                EvidenceStatus.UNSUPPORTED: "adapter_unsupported",
            }.get(status, "adapter_error")
        else:
            evidence = empty_confirmed(source, latency_ms=latency_ms)
            reason = "no_usable_structure"

        return StructuredObservation(
            index=index,
            priority=priority,
            layer=layer,
            adapter=adapter_name,
            method=method,
            status=evidence.status,
            confidence=evidence.confidence,
            latency_ms=latency_ms,
            context=context,
            container_hint=evidence.container_hint,
            reason=reason,
            source=source,
        )

    @staticmethod
    def _select(
        observations: tuple[StructuredObservation, ...],
    ) -> StructuredObservation | None:
        usable = [item for item in observations if item.usable]
        if not usable:
            return None
        return min(
            usable,
            key=lambda item: (
                item.container_hint,
                item.status is EvidenceStatus.DEGRADED,
                item.priority,
                -item.confidence,
                item.adapter,
            ),
        )


def _deadline_observation(
    index: int,
    adapter: Any,
    elapsed_ms: float,
) -> StructuredObservation:
    layer = perception_layer(adapter)
    return StructuredObservation(
        index=index,
        priority=int(getattr(
            adapter,
            "perception_priority",
            _DEFAULT_PRIORITIES.get(layer, 50),
        )),
        layer=layer,
        adapter=str(getattr(adapter, "name", "") or "unknown"),
        method="unknown",
        status=EvidenceStatus.TIMEOUT,
        confidence=0.0,
        latency_ms=elapsed_ms,
        context=None,
        container_hint=False,
        reason="deadline_exceeded",
        source=_source_for(layer),
    )


def _normalized_content(context: AdapterReadContext | None) -> str:
    return " ".join(str(getattr(context, "content", "") or "").casefold().split())


def _content_conflicts(
    observations: tuple[StructuredObservation, ...],
) -> list[dict[str, Any]]:
    text_observations = [
        item
        for item in observations
        if item.usable and not item.container_hint and _normalized_content(item.context)
    ]
    incompatible = False
    for index, left in enumerate(text_observations):
        left_text = _normalized_content(left.context)
        for right in text_observations[index + 1:]:
            right_text = _normalized_content(right.context)
            if left_text == right_text or left_text in right_text or right_text in left_text:
                continue
            incompatible = True
            break
        if incompatible:
            break
    if not incompatible:
        return []
    return [{
        "kind": "content_disagreement",
        "sources": [item.adapter for item in text_observations],
    }]


def _trace_for(
    observations: tuple[StructuredObservation, ...],
    selected: StructuredObservation | None,
    conflicts: list[dict[str, Any]],
    elapsed_ms: float,
) -> dict[str, Any]:
    if selected is not None:
        read_state = "resolved"
    elif observations and all(
        item.status is EvidenceStatus.EMPTY_CONFIRMED for item in observations
    ):
        read_state = "empty_confirmed"
    elif any(item.status in {
        EvidenceStatus.BUSY,
        EvidenceStatus.TIMEOUT,
        EvidenceStatus.DENIED,
        EvidenceStatus.ERROR,
    } for item in observations):
        read_state = "unread"
    else:
        read_state = "unavailable"
    attempts = [item.to_legacy_attempt() for item in observations]
    if not observations:
        attempts = [{
            "layer": "structured",
            "adapter": "registry",
            "method": "none",
            "status": "unavailable",
            "reason": "no_matching_adapter",
        }]
    return {
        "schemaVersion": 1,
        "selectedLayer": selected.layer if selected is not None else None,
        "selectedAdapter": selected.adapter if selected is not None else None,
        "selectedMethod": selected.method if selected is not None else None,
        "pixelFallbackUsed": False,
        "fallbackReason": None if selected is not None else "structured_context_unavailable",
        "policyMode": None,
        "readState": read_state,
        "elapsedMs": round(elapsed_ms, 3),
        "attempts": attempts,
        "observations": [item.to_trace_dict() for item in observations],
        "conflicts": conflicts,
    }
