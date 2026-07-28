from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from app.adapters.base import AdapterReadContext


_PIXEL_LAYERS = frozenset({"ocr", "screen_region", "vision"})
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
    if "ax" in value or "accessibility" in value:
        return "ax"
    return "native_app"


def context_has_usable_structure(context: AdapterReadContext | None) -> bool:
    if context is None or context.error:
        return False
    if str(context.content or "").strip():
        return True
    artifacts = dict(context.artifacts or {})
    for key in _MEANINGFUL_ARTIFACT_KEYS:
        value = artifacts.get(key)
        if value not in (None, "", [], {}, ()):
            return True
    return False


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


@dataclass(frozen=True)
class StructuredPerceptionResult:
    context: AdapterReadContext | None
    trace: dict[str, Any]


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
    **kwargs: Any,
) -> StructuredPerceptionResult:
    attempts: list[dict[str, str]] = []
    best_empty: AdapterReadContext | None = None
    candidates = _matching_adapters(registry, window)
    for adapter in candidates:
        layer = perception_layer(adapter)
        adapter_name = str(getattr(adapter, "name", "") or "unknown")
        try:
            context = adapter.read_context(window, **kwargs)
        except Exception:
            attempts.append(_attempt(
                layer=layer,
                adapter=adapter_name,
                method="unknown",
                status="error",
                reason="adapter_exception",
            ))
            continue
        method = str(context.method or "unknown")
        resolved_layer = perception_layer(adapter, context)
        if context_has_usable_structure(context):
            attempts.append(_attempt(
                layer=resolved_layer,
                adapter=adapter_name,
                method=method,
                status="succeeded",
                reason="structured_context_available",
            ))
            return StructuredPerceptionResult(context, {
                "schemaVersion": 1,
                "selectedLayer": resolved_layer,
                "selectedAdapter": adapter_name,
                "selectedMethod": method,
                "pixelFallbackUsed": False,
                "fallbackReason": None,
                "policyMode": None,
                "attempts": attempts,
            })
        if best_empty is None:
            best_empty = context
        attempts.append(_attempt(
            layer=resolved_layer,
            adapter=adapter_name,
            method=method,
            status="error" if context.error else "empty",
            reason="adapter_error" if context.error else "no_usable_structure",
        ))
    if not candidates:
        attempts.append(_attempt(
            layer="structured",
            adapter="registry",
            method="none",
            status="unavailable",
            reason="no_matching_adapter",
        ))
    return StructuredPerceptionResult(best_empty, {
        "schemaVersion": 1,
        "selectedLayer": None,
        "selectedAdapter": None,
        "selectedMethod": None,
        "pixelFallbackUsed": False,
        "fallbackReason": "structured_context_unavailable",
        "policyMode": None,
        "attempts": attempts,
    })


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
        if value["pixelFallbackUsed"]:
            value["fallbackReason"] = str(reason or "structured_context_unavailable")[:120]
    return value
