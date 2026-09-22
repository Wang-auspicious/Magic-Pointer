
from __future__ import annotations

from dataclasses import dataclass, field, replace
from typing import Any, Mapping, Protocol, runtime_checkable

from app.adapters.base import AdapterReadContext
from app.evidence.contract import (
    Evidence,
    EvidenceSource,
    EvidenceStatus,
    apply_container_heuristic,
    empty_confirmed,
    failed_evidence,
    is_glyph_only,
)
from app.grounding.marked_read import structured_read_covers_mark

TIER_STRUCTURED = "structured"
TIER_PIXEL = "pixel"

TIER_ORDER = (TIER_STRUCTURED, TIER_PIXEL)

DEFAULT_PRIORITIES = {
    "native_app": 10,
    "explorer": 15,
    "dom": 20,
    "surface_adapter": 25,
    "uia": 30,
    "ax": 30,
    "ocr": 40,
    "vision": 50,
}

BASE_CONFIDENCE = {
    "native_app": 0.95,
    "explorer": 0.92,
    "dom": 0.90,
    "surface_adapter": 0.85,
    "uia": 0.80,
    "ax": 0.80,
    "ocr": 0.70,
    "vision": 0.65,
}

_MEANINGFUL_ARTIFACT_KEYS = frozenset({
    "accessible_name",
    "address",
    "automation_id",
    "cell",
    "control_type",
    "css_selector",
    "dom_selector",
    "element_name",
    "local_file",
    "node",
    "object",
    "path",
    "range",
    "role",
    "rows",
    "selection_rectangles",
    "value",
})

_CONTAINER_COVERAGE_REASONS = frozenset({"container_not_selection", "identity_only"})

_BINDING_ARTIFACT_KEYS = frozenset({
    "address",
    "cell",
    "css_selector",
    "dom_selector",
    "local_file",
    "node",
    "object",
    "path",
    "range",
    "rows",
})

_BOUND_RESULT_KINDS = frozenset({
    "document_text",
    "point_element",
    "point_region",
    "terminal_buffer",
})


def perception_layer(source: Any, context: AdapterReadContext | None = None) -> str:
    explicit = str(getattr(source, "perception_layer", "") or "").strip().casefold()
    if explicit:
        return explicit[:40]
    value = " ".join((
        str(getattr(source, "name", "") or ""),
        str(getattr(source, "id", "") or ""),
        str(getattr(context, "adapter", "") or ""),
        str(getattr(context, "method", "") or ""),
    )).casefold()
    if "explorer" in value:
        return "explorer"
    if "surface" in value:
        return "surface_adapter"
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


def source_for_layer(layer: str) -> EvidenceSource:
    return {
        "native_app": EvidenceSource.COM,
        "explorer": EvidenceSource.FILE,
        "dom": EvidenceSource.CDP,
        "surface_adapter": EvidenceSource.UIA,
        "uia": EvidenceSource.UIA,
        "ax": EvidenceSource.UIA,
        "ocr": EvidenceSource.OCR,
        "vision": EvidenceSource.VISION,
    }.get(layer, EvidenceSource.FILE)


def status_for_error(error: str) -> EvidenceStatus:
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


@dataclass(frozen=True, slots=True)
class PerceptionRequest:

    window: dict[str, Any]
    command: str = ""
    target_point: dict[str, int] | None = None
    target_region: dict[str, int] | None = None
    gesture: dict[str, Any] | None = None
    mark_bbox: tuple[int, int, int, int] | None = None
    frame_lease_id: str | None = None
    frozen_artifact_path: str | None = None
    frozen_artifact_bbox: tuple[int, int, int, int] | None = None
    adapter_kwargs: Mapping[str, Any] = field(default_factory=dict)

    @property
    def has_frozen_pixels(self) -> bool:
        return bool(self.frozen_artifact_path)

    def container_like_texts(self) -> tuple[str, ...]:
        candidates = (
            self.window.get("title"),
            self.window.get("process_name"),
            self.window.get("processName"),
            self.window.get("class_name"),
            self.window.get("className"),
        )
        return tuple(
            str(value).strip() for value in candidates if str(value or "").strip()
        )


@dataclass(frozen=True, slots=True)
class ProviderDescriptor:

    id: str
    layer: str
    tier: str = TIER_STRUCTURED
    priority: int = 50
    deadline_ms: float | None = None
    requires_frozen_pixels: bool = False

    def __post_init__(self) -> None:
        if not self.id.strip():
            raise ValueError("ProviderDescriptor.id must be non-empty")
        if self.tier not in TIER_ORDER:
            raise ValueError(f"unknown perception tier: {self.tier!r}")


@dataclass(frozen=True, slots=True)
class ProviderResult:

    context: AdapterReadContext | None = None
    status: EvidenceStatus | None = None
    reason: str = ""
    payload: dict[str, Any] | None = None
    limitations: tuple[str, ...] = ()
    grounding: dict[str, Any] | None = None
    provider_trace: dict[str, Any] | None = None
    selection_bbox: list[int] | None = None
    layer: str | None = None


NOT_APPLICABLE = "not_applicable"


@runtime_checkable
class PerceptionProvider(Protocol):
    descriptor: ProviderDescriptor

    def read(self, request: PerceptionRequest) -> ProviderResult: ...


@dataclass(frozen=True, slots=True)
class PerceptionObservation:

    index: int
    provider_id: str
    layer: str
    tier: str
    priority: int
    adapter: str
    method: str
    status: EvidenceStatus
    confidence: float
    latency_ms: float
    context: AdapterReadContext | None
    payload: dict[str, Any] | None
    limitations: tuple[str, ...]
    container_hint: bool
    covers_mark: bool | None
    coverage_reason: str
    reason: str
    source: EvidenceSource
    frame_lease_id: str | None
    has_content: bool = False
    grounding: dict[str, Any] | None = None
    provider_trace: dict[str, Any] | None = None
    selection_bbox: list[int] | None = None

    @property
    def usable(self) -> bool:
        return self.has_content and self.status in {
            EvidenceStatus.OK,
            EvidenceStatus.DEGRADED,
        }

    @property
    def selectable(self) -> bool:
        return self.usable and self.context is not None

    @property
    def marked_content(self) -> bool:
        return self.usable and self.covers_mark is not False

    @property
    def content(self) -> str:
        return str(getattr(self.context, "content", "") or "")

    def to_trace_dict(self) -> dict[str, Any]:
        return {
            "index": self.index,
            "providerId": self.provider_id[:80],
            "layer": self.layer[:40],
            "tier": self.tier,
            "priority": self.priority,
            "adapter": self.adapter[:80],
            "method": self.method[:120],
            "status": self.status.value,
            "confidence": round(self.confidence, 4),
            "latencyMs": round(self.latency_ms, 3),
            "containerHint": self.container_hint,
            "coversMark": self.covers_mark,
            "coverageReason": self.coverage_reason[:80],
            "hasContent": self.has_content,
            "reason": self.reason[:120],
            "frameLeaseId": self.frame_lease_id,
            "limitations": [str(item)[:80] for item in self.limitations][:6],
        }

    @classmethod
    def from_trace_dict(cls, value: Mapping[str, Any]) -> PerceptionObservation:
        status = str(value.get("status") or EvidenceStatus.ERROR.value)
        layer = str(value.get("layer") or "native_app")
        return cls(
            index=int(value.get("index") or 0),
            provider_id=str(value.get("providerId") or value.get("adapter") or "unknown"),
            layer=layer,
            tier=str(value.get("tier") or TIER_STRUCTURED),
            priority=int(value.get("priority") or DEFAULT_PRIORITIES.get(layer, 50)),
            adapter=str(value.get("adapter") or "unknown"),
            method=str(value.get("method") or "unknown"),
            status=EvidenceStatus(status),
            confidence=float(value.get("confidence") or 0.0),
            latency_ms=float(value.get("latencyMs") or 0.0),
            context=None,
            payload=None,
            limitations=tuple(str(item) for item in value.get("limitations") or ()),
            container_hint=bool(value.get("containerHint")),
            covers_mark=(
                None if value.get("coversMark") is None else bool(value.get("coversMark"))
            ),
            coverage_reason=str(value.get("coverageReason") or ""),
            reason=str(value.get("reason") or ""),
            source=source_for_layer(layer),
            frame_lease_id=(
                str(value["frameLeaseId"]) if value.get("frameLeaseId") else None
            ),
            has_content=bool(value.get("hasContent")),
        )

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


def context_rectangles(context: Any, *, limit: int = 32) -> list[list[int]]:
    artifacts = dict(getattr(context, "artifacts", {}) or {})
    raw_rectangles = artifacts.get("selection_rectangles") or artifacts.get("rectangles") or []
    fmt = str(artifacts.get("selection_rectangles_format") or "xywh")
    result: list[list[int]] = []
    for raw in list(raw_rectangles)[:limit]:
        if not isinstance(raw, (list, tuple)) or len(raw) != 4:
            continue
        try:
            left, top, third, fourth = (int(round(float(value))) for value in raw)
        except (TypeError, ValueError):
            continue
        if fmt == "ltrb":
            width, height = third - left, fourth - top
        else:
            width, height = third, fourth
        if width > 0 and height > 0:
            result.append([left, top, width, height])
    return result


def context_is_explicitly_bound(context: AdapterReadContext | None) -> bool:
    artifacts = dict(getattr(context, "artifacts", {}) or {})
    for key in _BINDING_ARTIFACT_KEYS:
        if artifacts.get(key) not in (None, "", [], {}, ()):
            return True
    kind = str(artifacts.get("perception_result_kind") or "").strip()
    return kind in _BOUND_RESULT_KINDS


def _coverage(
    context: AdapterReadContext,
    request: PerceptionRequest,
) -> tuple[bool | None, str]:
    coverage = structured_read_covers_mark(
        content=str(context.content or ""),
        window=request.window,
        element_rects=context_rectangles(context),
        mark_bbox=list(request.mark_bbox) if request.mark_bbox is not None else None,
        has_explicit_binding=context_is_explicitly_bound(context),
    )
    return coverage.covers, coverage.reason


def _descriptor_priority(descriptor: ProviderDescriptor) -> int:
    if descriptor.priority:
        return int(descriptor.priority)
    return DEFAULT_PRIORITIES.get(descriptor.layer, 50)


def observation_from_result(
    descriptor: ProviderDescriptor,
    result: ProviderResult,
    request: PerceptionRequest,
    *,
    index: int,
    latency_ms: float,
) -> PerceptionObservation:
    context = result.context
    layer = (
        str(result.layer or "").strip().casefold()
        or descriptor.layer
        or perception_layer(descriptor, context)
    )
    source = source_for_layer(layer)
    priority = _descriptor_priority(descriptor)
    method = str(getattr(context, "method", "") or "unknown")
    error = str(getattr(context, "error", "") or "").strip()
    usable = context_has_usable_structure(context)
    covers_mark: bool | None = None
    coverage_reason = ""

    if usable and context is not None:
        covers_mark, coverage_reason = _coverage(context, request)
        if "ocr_geometry_unavailable" in result.limitations:
            covers_mark, coverage_reason = False, "ocr_geometry_unavailable"
        status = result.status or (
            EvidenceStatus.DEGRADED if error else EvidenceStatus.OK
        )
        confidence = BASE_CONFIDENCE.get(layer, 0.70)
        if error or status is EvidenceStatus.DEGRADED:
            confidence = min(confidence, 0.60)
        evidence = Evidence(
            value=str(context.content or "").strip() or str(context.label or "") or "<structured>",
            status=status,
            confidence=confidence,
            source=source,
            latency_ms=latency_ms,
            note=error or None,
        )
        evidence = apply_container_heuristic(evidence, request.container_like_texts())
        glyph_only = is_glyph_only(context.content)
        container_hint = bool(evidence.container_hint) or glyph_only or (
            coverage_reason in _CONTAINER_COVERAGE_REASONS
        )
        if container_hint and evidence.status is EvidenceStatus.OK:
            evidence = Evidence(
                value=evidence.value,
                status=EvidenceStatus.DEGRADED,
                confidence=min(evidence.confidence, 0.2),
                source=source,
                latency_ms=latency_ms,
                container_hint=True,
                note=evidence.note,
            )
        reason = result.reason or (
            "container:glyph_only_content"
            if glyph_only
            else f"container:{coverage_reason or 'container_like_content'}"
            if container_hint
            else "structured_context_degraded"
            if evidence.status is EvidenceStatus.DEGRADED
            else "structured_context_available"
        )
        final_status = evidence.status
        final_confidence = evidence.confidence
    elif result.status is not None and result.status not in {
        EvidenceStatus.OK,
        EvidenceStatus.DEGRADED,
    }:
        evidence = failed_evidence(
            source,
            result.status,
            result.reason or error or None,
            latency_ms=latency_ms,
        )
        final_status = evidence.status
        final_confidence = evidence.confidence
        container_hint = False
        reason = result.reason or _reason_for_status(result.status)
    elif error:
        status = status_for_error(error)
        evidence = failed_evidence(source, status, error, latency_ms=latency_ms)
        final_status = status
        final_confidence = evidence.confidence
        container_hint = False
        reason = result.reason or _reason_for_status(status)
    else:
        evidence = empty_confirmed(source, latency_ms=latency_ms)
        final_status = evidence.status
        final_confidence = evidence.confidence
        container_hint = False
        reason = result.reason or "no_usable_structure"

    return PerceptionObservation(
        index=index,
        provider_id=descriptor.id,
        layer=layer,
        tier=descriptor.tier,
        priority=priority,
        adapter=str(getattr(context, "adapter", "") or descriptor.id),
        method=method,
        status=final_status,
        confidence=final_confidence,
        latency_ms=latency_ms,
        context=context,
        payload=dict(result.payload) if result.payload else None,
        limitations=tuple(result.limitations),
        container_hint=container_hint,
        covers_mark=covers_mark,
        coverage_reason=coverage_reason,
        reason=reason,
        source=source,
        frame_lease_id=request.frame_lease_id,
        has_content=usable,
        grounding=result.grounding,
        provider_trace=result.provider_trace,
        selection_bbox=result.selection_bbox,
    )


def _reason_for_status(status: EvidenceStatus) -> str:
    return {
        EvidenceStatus.TIMEOUT: "provider_timeout",
        EvidenceStatus.BUSY: "provider_busy",
        EvidenceStatus.DENIED: "provider_denied",
        EvidenceStatus.UNSUPPORTED: "provider_unsupported",
    }.get(status, "provider_error")


def synthetic_observation(
    descriptor: ProviderDescriptor,
    request: PerceptionRequest,
    *,
    index: int,
    status: EvidenceStatus,
    reason: str,
    latency_ms: float = 0.0,
) -> PerceptionObservation:
    layer = descriptor.layer or perception_layer(descriptor)
    return PerceptionObservation(
        index=index,
        provider_id=descriptor.id,
        layer=layer,
        tier=descriptor.tier,
        priority=_descriptor_priority(descriptor),
        adapter=descriptor.id,
        method="unknown",
        status=status,
        confidence=0.0,
        latency_ms=latency_ms,
        context=None,
        payload=None,
        limitations=(),
        container_hint=False,
        covers_mark=None,
        coverage_reason="",
        reason=reason,
        source=source_for_layer(layer),
        frame_lease_id=request.frame_lease_id,
    )


def observations_from_trace(
    trace: Mapping[str, Any],
    *,
    selected_context: AdapterReadContext | None = None,
    request: PerceptionRequest | None = None,
) -> tuple[PerceptionObservation, ...]:
    selected_id = str(trace.get("selectedProviderId") or "")
    restored: list[PerceptionObservation] = []
    for index, raw in enumerate(list(trace.get("observations") or [])):
        if not isinstance(raw, Mapping):
            continue
        item = PerceptionObservation.from_trace_dict(raw)
        if raw.get("index") is None:
            item = replace(item, index=index)
        if selected_context is not None and item.provider_id == selected_id:
            item = replace(item, context=selected_context, has_content=True)
        restored.append(item)
    if selected_context is not None and not any(item.selectable for item in restored):
        layer = str(trace.get("selectedLayer") or "").strip().casefold()
        descriptor = ProviderDescriptor(
            id=str(
                trace.get("selectedProviderId")
                or trace.get("selectedAdapter")
                or "structured"
            ),
            layer=layer or perception_layer(None, selected_context),
        )
        bound = request or PerceptionRequest(
            window=dict(getattr(selected_context, "window", {}) or {})
        )
        restored.append(observation_from_result(
            descriptor,
            ProviderResult(context=selected_context),
            bound,
            index=len(restored),
            latency_ms=0.0,
        ))
    return tuple(restored)


class AdapterProvider:

    def __init__(self, adapter: Any, *, tier: str = TIER_STRUCTURED) -> None:
        self.adapter = adapter
        layer = perception_layer(adapter)
        name = str(getattr(adapter, "name", "") or layer)
        self.descriptor = ProviderDescriptor(
            id=name,
            layer=layer,
            tier=tier,
            priority=int(getattr(
                adapter,
                "perception_priority",
                DEFAULT_PRIORITIES.get(layer, 50),
            )),
        )

    def read(self, request: PerceptionRequest) -> ProviderResult:
        kwargs = dict(request.adapter_kwargs)
        kwargs.setdefault("command", request.command)
        if request.target_point is not None:
            kwargs.setdefault("target_point", request.target_point)
        if request.target_region is not None:
            kwargs.setdefault("target_region", request.target_region)
        context = self.adapter.read_context(request.window, **kwargs)
        if not isinstance(context, AdapterReadContext):
            return ProviderResult(
                context=None,
                status=EvidenceStatus.ERROR,
                reason="invalid_adapter_result",
            )
        return ProviderResult(context=context)


class CallableProvider:

    def __init__(
        self,
        descriptor: ProviderDescriptor,
        read: Any,
    ) -> None:
        self.descriptor = descriptor
        self._read = read

    def read(self, request: PerceptionRequest) -> ProviderResult:
        result = self._read(request)
        if result is None:
            return ProviderResult(context=None)
        if not isinstance(result, ProviderResult):
            raise TypeError(
                f"provider {self.descriptor.id} returned {type(result).__name__}, "
                "expected ProviderResult"
            )
        return result
