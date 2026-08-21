from __future__ import annotations

from typing import Any

from app.perception.broker import (
    PerceptionBroker,
    PerceptionResult,
    context_has_usable_structure,
    perception_layer,
    providers_for_registry,
)
from app.perception.providers import PerceptionRequest

_PIXEL_LAYERS = frozenset({"ocr", "screen_region", "vision"})


def _attempt(
    *,
    layer: str,
    adapter: str,
    method: str,
    status: str,
    reason: str,
) -> dict[str, str]:
    return {
        "layer": str(layer or "unknown")[:40],
        "adapter": str(adapter or "unknown")[:80],
        "method": str(method or "unknown")[:120],
        "status": str(status or "unknown")[:40],
        "reason": str(reason or "unknown")[:120],
    }


StructuredPerceptionResult = PerceptionResult


def resolve_structured_perception(
    window: dict[str, Any],
    registry: Any,
    *,
    deadline_ms: float | None = None,
    command: str = "",
    target_point: dict[str, int] | None = None,
    target_region: dict[str, int] | None = None,
    mark_bbox: tuple[int, int, int, int] | None = None,
    **kwargs: Any,
) -> StructuredPerceptionResult:
    """Structured-only entry point: every claiming adapter becomes a provider."""
    request = PerceptionRequest(
        window=dict(window),
        command=command,
        target_point=target_point,
        target_region=target_region,
        mark_bbox=mark_bbox,
        adapter_kwargs=dict(kwargs),
    )
    return PerceptionBroker().resolve(
        request,
        providers_for_registry(registry, window),
        deadline_ms=deadline_ms,
    )


def append_perception_attempt(
    trace: dict[str, Any],
    *,
    layer: str,
    adapter: str,
    method: str,
    status: str,
    reason: str,
    select: bool = False,
    policy_mode: str | None = None,
) -> dict[str, Any]:
    value = {
        "schemaVersion": 1,
        "selectedLayer": trace.get("selectedLayer"),
        "selectedAdapter": trace.get("selectedAdapter"),
        "selectedMethod": trace.get("selectedMethod"),
        "selectedProviderId": trace.get("selectedProviderId"),
        "selectedTier": trace.get("selectedTier"),
        "pixelFallbackUsed": trace.get("pixelFallbackUsed") is True,
        "fallbackReason": trace.get("fallbackReason"),
        "policyMode": policy_mode if policy_mode is not None else trace.get("policyMode"),
        "readState": trace.get("readState"),
        "marksCovered": trace.get("marksCovered"),
        "coverageReason": trace.get("coverageReason"),
        "elapsedMs": trace.get("elapsedMs"),
        "observations": [
            dict(item)
            for item in list(trace.get("observations") or [])[:12]
            if isinstance(item, dict)
        ],
        "conflicts": [
            dict(item)
            for item in list(trace.get("conflicts") or [])[:8]
            if isinstance(item, dict)
        ],
        "corroborations": [
            dict(item)
            for item in list(trace.get("corroborations") or [])[:8]
            if isinstance(item, dict)
        ],
        "notes": [
            dict(item)
            for item in list(trace.get("notes") or [])[:8]
            if isinstance(item, dict)
        ],
        "attempts": [dict(item) for item in list(trace.get("attempts") or [])[:11]],
    }
    value["attempts"].append(_attempt(
        layer=layer,
        adapter=adapter,
        method=method,
        status=status,
        reason=reason,
    ))
    if select:
        value["selectedLayer"] = str(layer or "unknown")[:40]
        value["selectedAdapter"] = str(adapter or "unknown")[:80]
        value["selectedMethod"] = str(method or "unknown")[:120]
        value["pixelFallbackUsed"] = str(layer or "").casefold() in _PIXEL_LAYERS
        value["readState"] = "resolved"
        if value["pixelFallbackUsed"]:
            value["fallbackReason"] = str(reason or "structured_context_unavailable")[:120]
    return value


__all__ = [
    "StructuredPerceptionResult",
    "append_perception_attempt",
    "context_has_usable_structure",
    "perception_layer",
    "resolve_structured_perception",
]
