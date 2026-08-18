from __future__ import annotations

import threading
import time

from app.adapters.base import AdapterReadContext
from app.grounding.perception_cascade import resolve_structured_perception


class _Registry:
    def __init__(self, *adapters: object) -> None:
        self.adapters = list(adapters)

    def matching_adapters(self, _window: dict) -> list[object]:
        return list(self.adapters)


class _Adapter:
    def __init__(
        self,
        name: str,
        *,
        content: str | None = None,
        error: str | None = None,
        priority: int = 50,
        layer: str = "uia",
        barrier: threading.Barrier | None = None,
        delay_s: float = 0.0,
        raises: bool = False,
        calls: list[str] | None = None,
    ) -> None:
        self.name = name
        self.content = content
        self.error = error
        self.perception_priority = priority
        self.perception_layer = layer
        self.barrier = barrier
        self.delay_s = delay_s
        self.raises = raises
        self.calls = calls if calls is not None else []

    def read_context(self, window: dict, **_kwargs: object) -> AdapterReadContext:
        self.calls.append(self.name)
        if self.barrier is not None:
            self.barrier.wait(timeout=0.6)
        if self.delay_s:
            time.sleep(self.delay_s)
        if self.raises:
            raise RuntimeError("synthetic adapter crash")
        return AdapterReadContext(
            adapter=self.name,
            app="test",
            window=window,
            content=self.content,
            label=self.content,
            method=f"synthetic:{self.name}",
            error=self.error,
        )


def test_matching_adapters_are_collected_concurrently_without_first_success_shortcut() -> None:
    barrier = threading.Barrier(2)
    calls: list[str] = []
    slower_high_priority = _Adapter(
        "native",
        content="native answer",
        priority=10,
        layer="native_app",
        barrier=barrier,
        delay_s=0.08,
        calls=calls,
    )
    faster_low_priority = _Adapter(
        "uia",
        content="uia answer",
        priority=30,
        layer="uia",
        barrier=barrier,
        calls=calls,
    )

    started = time.perf_counter()
    result = resolve_structured_perception(
        {"title": "Document", "class_name": "Editor"},
        _Registry(faster_low_priority, slower_high_priority),
    )
    elapsed = time.perf_counter() - started

    assert sorted(calls) == ["native", "uia"]
    assert elapsed < 0.5
    assert result.context is not None
    assert result.context.adapter == "native"
    assert [item.adapter for item in result.observations] == ["native", "uia"]
    assert [item["adapter"] for item in result.trace["attempts"]] == ["native", "uia"]


def test_timeout_busy_and_exception_remain_distinct_when_another_source_succeeds() -> None:
    success = _Adapter("dom", content="checkout total", priority=20, layer="dom")
    timed_out = _Adapter("uia", error="UIA probe timed out", priority=30)
    busy = _Adapter("ocr", error="OCR worker busy", priority=40, layer="ocr")
    crashed = _Adapter("native", raises=True, priority=10, layer="native_app")

    result = resolve_structured_perception(
        {"title": "Checkout", "class_name": "Chrome_WidgetWin_1"},
        _Registry(timed_out, success, busy, crashed),
    )

    assert result.context is not None
    assert result.context.adapter == "dom"
    statuses = {item.adapter: item.status.value for item in result.observations}
    assert statuses == {
        "native": "error",
        "dom": "ok",
        "uia": "timeout",
        "ocr": "busy",
    }
    assert result.trace["selectedAdapter"] == "dom"


def test_all_unread_sources_never_masquerade_as_confirmed_empty() -> None:
    result = resolve_structured_perception(
        {"title": "Terminal", "class_name": "CASCADIA_HOSTING_WINDOW_CLASS"},
        _Registry(
            _Adapter("uia", error="probe timeout", priority=30),
            _Adapter("ocr", error="worker busy", priority=40, layer="ocr"),
        ),
    )

    assert result.context is None
    assert [item.status.value for item in result.observations] == ["timeout", "busy"]
    assert result.trace["selectedLayer"] is None
    assert result.trace["fallbackReason"] == "structured_context_unavailable"
    assert result.trace["readState"] == "unread"


def test_completion_order_does_not_change_observation_order_or_selection() -> None:
    low_priority_fast = _Adapter(
        "uia-fast",
        content="fast result",
        priority=30,
        delay_s=0.01,
    )
    high_priority_slow = _Adapter(
        "dom-slow",
        content="slow result",
        priority=20,
        layer="dom",
        delay_s=0.08,
    )

    for _ in range(3):
        result = resolve_structured_perception(
            {"title": "Page", "class_name": "Chrome_WidgetWin_1"},
            _Registry(low_priority_fast, high_priority_slow),
        )
        assert [item.adapter for item in result.observations] == [
            "dom-slow",
            "uia-fast",
        ]
        assert result.context is not None
        assert result.context.adapter == "dom-slow"


def test_container_name_is_retained_but_cannot_suppress_real_content() -> None:
    container = _Adapter(
        "native-container",
        content="PowerShell",
        priority=10,
        layer="native_app",
    )
    content = _Adapter(
        "uia-content",
        content="Get-ChildItem failed because the path does not exist",
        priority=30,
        layer="uia",
    )

    result = resolve_structured_perception(
        {
            "title": "PowerShell",
            "process_name": "powershell.exe",
            "class_name": "ConsoleWindowClass",
        },
        _Registry(container, content),
    )

    assert result.context is not None
    assert result.context.adapter == "uia-content"
    by_adapter = {item.adapter: item for item in result.observations}
    assert by_adapter["native-container"].container_hint is True
    assert by_adapter["native-container"].status.value == "degraded"
    assert by_adapter["uia-content"].container_hint is False


def test_clean_content_beats_higher_priority_degraded_content() -> None:
    result = resolve_structured_perception(
        {"title": "Document", "class_name": "EditorWindow"},
        _Registry(
            _Adapter(
                "native-partial",
                content="partial text",
                error="native provider returned a partial selection",
                priority=10,
                layer="native_app",
            ),
            _Adapter(
                "dom-clean",
                content="complete selected paragraph",
                priority=20,
                layer="dom",
            ),
        ),
    )

    assert result.context is not None
    assert result.context.adapter == "dom-clean"
    assert [item.status.value for item in result.observations] == ["degraded", "ok"]


def test_incompatible_successful_contents_are_reported_as_a_conflict() -> None:
    result = resolve_structured_perception(
        {"title": "Editor", "class_name": "EditorWindow"},
        _Registry(
            _Adapter("dom", content="Invoice total: 120", priority=20, layer="dom"),
            _Adapter("uia", content="Invoice total: 210", priority=30, layer="uia"),
        ),
    )

    assert result.context is not None
    assert result.context.adapter == "dom"
    assert result.trace["conflicts"] == [{
        "kind": "content_disagreement",
        "sources": ["dom", "uia"],
    }]
