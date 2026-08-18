from __future__ import annotations

from typing import Any

from app.perception.broker import (
    ConcurrentPerceptionBroker,
    PerceptionBrokerResult,
    context_has_usable_structure,
    perception_layer,
)


_PIXEL_LAYERS = frozenset({"ocr", "screen_region", "vision"})
_DEFAULT_PRIORITIES = {
    "native_app": 10,
    "dom": 20,
    "uia": 30,
    "ax": 30,
}


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


StructuredPerceptionResult = PerceptionBrokerResult


def _matching_adapters(registry: Any, window: dict[str, Any]) -> list[Any]:
    matcher = getattr(registry, "matching_adapters", None)
    if callable(matcher):
        candidates = list(matcher(window) or [])
    else:
        adapter = registry.matching_adapter(window)
        candidates = [adapter] if adapter is not None else []
    return sorted(
        candidates,
        key=lambda adapter: (
            int(getattr(adapter, "perception_priority", _DEFAULT_PRIORITIES.get(
                perception_layer(adapter), 50
            ))),
            str(getattr(adapter, "name", "")),
        ),
    )


def resolve_structured_perception(
    window: dict[str, Any],
    registry: Any,
    *,
    deadline_ms: float | None = None,
    **kwargs: Any,
) -> StructuredPerceptionResult:
    candidates = _matching_adapters(registry, window)
    return ConcurrentPerceptionBroker().resolve(
        window,
        candidates,
        deadline_ms=deadline_ms,
        **kwargs,
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
        "pixelFallbackUsed": trace.get("pixelFallbackUsed") is True,
        "fallbackReason": trace.get("fallbackReason"),
        "policyMode": policy_mode if policy_mode is not None else trace.get("policyMode"),
        "readState": trace.get("readState"),
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
