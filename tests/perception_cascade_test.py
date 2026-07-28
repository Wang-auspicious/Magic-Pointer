from __future__ import annotations

from app.adapters.base import AdapterReadContext, AppAdapter
from app.adapters.registry import AppAdapterRegistry
from app.grounding.perception_cascade import (
    append_perception_attempt,
    resolve_structured_perception,
)


class _Adapter(AppAdapter):
    def __init__(
        self,
        name: str,
        layer: str,
        priority: int,
        context: AdapterReadContext,
        calls: list[str],
    ) -> None:
        self.name = name
        self.perception_layer = layer
        self.perception_priority = priority
        self._context = context
        self._calls = calls

    def match_window(self, _window):
        return True

    def read_context(self, _window, **_kwargs):
        self._calls.append(self.name)
        return self._context


def _context(adapter: str, method: str, *, content: str = "", error: str | None = None):
    return AdapterReadContext(
        adapter=adapter,
        app="browser",
        window={"hwnd": 8, "title": "private title"},
        content=content,
        method=method,
        artifacts={},
        error=error,
    )


def test_structured_cascade_uses_priority_and_stops_before_lower_layers() -> None:
    calls: list[str] = []
    registry = AppAdapterRegistry(adapters=[
        _Adapter("uia", "uia", 30, _context("uia", "uia:text", content="UIA text"), calls),
        _Adapter("dom", "dom", 20, _context("dom", "dom:selection", content="DOM text"), calls),
        _Adapter("ax", "ax", 40, _context("ax", "ax:selected-text", content="AX text"), calls),
    ])

    result = resolve_structured_perception({"hwnd": 8}, registry)

    assert result.context is not None
    assert result.context.content == "DOM text"
    assert calls == ["dom"]
    assert result.trace["selectedLayer"] == "dom"
    assert result.trace["pixelFallbackUsed"] is False
    assert result.trace["attempts"] == [{
        "layer": "dom",
        "adapter": "dom",
        "method": "dom:selection",
        "status": "succeeded",
        "reason": "structured_context_available",
    }]


def test_structured_cascade_records_error_then_uses_next_adapter() -> None:
    calls: list[str] = []
    registry = AppAdapterRegistry(adapters=[
        _Adapter("dom", "dom", 20, _context("dom", "dom:selection", error="secret failure body"), calls),
        _Adapter("uia", "uia", 30, _context("uia", "uia:element-from-point", content="Save"), calls),
    ])

    result = resolve_structured_perception({"hwnd": 8}, registry)

    assert result.context is not None
    assert result.context.content == "Save"
    assert calls == ["dom", "uia"]
    assert [attempt["status"] for attempt in result.trace["attempts"]] == ["error", "succeeded"]
    assert result.trace["attempts"][0]["reason"] == "adapter_error"
    assert "secret failure body" not in str(result.trace)


def test_empty_structured_layers_produce_explicit_fallback_reason() -> None:
    calls: list[str] = []
    registry = AppAdapterRegistry(adapters=[
        _Adapter("uia", "uia", 30, _context("uia", "uia:text"), calls),
    ])

    result = resolve_structured_perception({"hwnd": 8}, registry)
    trace = append_perception_attempt(
        result.trace,
        layer="screen_region",
        adapter="screen-capture",
        method="pointer:bounded-screen-region",
        status="succeeded",
        reason="structured_context_unavailable",
        select=True,
        policy_mode="local_screenshot",
    )

    assert result.context is not None
    assert result.context.content in (None, "")
    assert result.trace["selectedLayer"] is None
    assert result.trace["fallbackReason"] == "structured_context_unavailable"
    assert trace["selectedLayer"] == "screen_region"
    assert trace["pixelFallbackUsed"] is True
    assert trace["policyMode"] == "local_screenshot"
