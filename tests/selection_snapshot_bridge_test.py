from __future__ import annotations

from app.adapters.base import AdapterCapability, AdapterReadContext
from scripts.selection_snapshot_bridge import _suggested_commands, _summary_for, capture_snapshot
from scripts.selection_snapshot_bridge import _window_dicts


class _FakeAdapter:
    def read_context(self, window, **_kwargs):
        return AdapterReadContext(
            adapter="fake-office",
            app="word",
            window=window,
            content="Selected text",
            label=r"C:\demo\doc.docx",
            method="fake:selection",
            capabilities=[
                AdapterCapability(
                    "replace_selection",
                    "Replace selected text",
                    "high",
                    True,
                    True,
                )
            ],
            artifacts={
                "document": r"C:\demo\doc.docx",
                "document_name": "doc.docx",
                "selection_text_chars": 13,
                "selection_start": 4,
                "selection_end": 17,
            },
        )


class _FakeRegistry:
    def __init__(self, supported=True):
        self.supported = supported
        self.seen = []

    def matching_adapter(self, window):
        self.seen.append(window)
        return _FakeAdapter() if self.supported else None


class _ErrorAdapter:
    def read_context(self, window, **_kwargs):
        return AdapterReadContext(
            adapter="uia_text_selection",
            app="browser",
            window=window,
            method="uia:text-pattern.selection",
            capabilities=[],
            artifacts={"source_hwnd": window.get("hwnd")},
            error="UI Automation selection probe failed: TimeoutExpired",
        )


class _ErrorRegistry:
    def matching_adapter(self, _window):
        return _ErrorAdapter()


def test_snapshot_locks_only_the_foreground_window() -> None:
    foreground = {"title": "doc.docx - Word", "hwnd": 10, "supported": True}
    background = {"title": "other.docx - Word", "hwnd": 11, "supported": True}
    registry = _FakeRegistry()
    payload = capture_snapshot([foreground, background], registry=registry)
    snapshot = payload["selectionSnapshot"]
    assert payload["ok"] is True
    assert snapshot["source_window"] == foreground
    assert snapshot["context"]["content"] == "Selected text"
    assert registry.seen == [foreground]
    assert payload["captureSummary"]["label"] == "THIS · Word/WPS 选区"
    assert payload["captureSummary"]["canRewrite"] is True
    assert [item["label"] for item in payload["suggestedCommands"]] == ["解释", "改写", "翻译"]


def test_unsupported_foreground_fails_closed_without_scanning_background() -> None:
    foreground = {"title": "Browser", "hwnd": 20}
    background = {"title": "doc.docx - Word", "hwnd": 21}
    registry = _FakeRegistry(supported=False)
    payload = capture_snapshot([foreground, background], registry=registry)
    assert payload["selectionSnapshot"]["status"] == "unsupported"
    assert payload["selectionSnapshot"]["context"] is None
    assert payload["suggestedCommands"] == []
    assert registry.seen == [foreground]


def test_browser_selection_summary_stays_read_only() -> None:
    context = AdapterReadContext(
        adapter="uia_text_selection",
        app="browser",
        window={"title": "Example - Microsoft Edge", "hwnd": 30},
        content="Selected browser text",
        label="Example - Microsoft Edge",
        method="uia:text-pattern.selection",
        capabilities=[
            AdapterCapability(
                "read_selection",
                "Read native selected text",
                "read_only",
            )
        ],
        artifacts={"selection_text_chars": 21},
    )
    summary = _summary_for(context.window, context)
    assert summary["label"] == "THIS \u00b7 \u6d4f\u89c8\u5668 \u9009\u533a"
    assert summary["canRewrite"] is False
    assert [item["label"] for item in _suggested_commands(summary)] == [
        "\u89e3\u91ca",
        "\u603b\u7ed3",
        "\u7ffb\u8bd1",
    ]


def test_window_filter_excludes_only_exact_magic_pointer_windows(monkeypatch) -> None:
    monkeypatch.setattr(
        "scripts.selection_snapshot_bridge.get_foreground_window_handle",
        lambda: 3,
    )
    monkeypatch.setattr(
        "scripts.selection_snapshot_bridge.list_visible_windows",
        lambda: [
            {"title": "Magic Pointer Overlay", "hwnd": 1},
            {"title": "Magic Pointer Panel", "hwnd": 2},
            {"title": "Magic Pointer research notes - Microsoft Edge", "hwnd": 3},
        ],
    )
    assert _window_dicts() == [
        {"title": "Magic Pointer research notes - Microsoft Edge", "hwnd": 3}
    ]


def test_window_filter_fails_closed_without_foreground_handle(monkeypatch) -> None:
    monkeypatch.setattr(
        "scripts.selection_snapshot_bridge.get_foreground_window_handle",
        lambda: 0,
    )
    monkeypatch.setattr(
        "scripts.selection_snapshot_bridge.list_visible_windows",
        lambda: [{"title": "Top Z-order window", "hwnd": 11}],
    )
    assert _window_dicts() == []


def test_window_filter_uses_exact_foreground_handle(monkeypatch) -> None:
    monkeypatch.setattr(
        "scripts.selection_snapshot_bridge.get_foreground_window_handle",
        lambda: 22,
    )
    monkeypatch.setattr(
        "scripts.selection_snapshot_bridge.list_visible_windows",
        lambda: [
            {"title": "Always-on-top utility", "hwnd": 11},
            {"title": "Selected page - Microsoft Edge", "hwnd": 22},
            {"title": "Background document - Word", "hwnd": 33},
        ],
    )
    assert _window_dicts() == [
        {"title": "Selected page - Microsoft Edge", "hwnd": 22}
    ]


def test_window_filter_does_not_fall_back_behind_magic_pointer(monkeypatch) -> None:
    monkeypatch.setattr(
        "scripts.selection_snapshot_bridge.get_foreground_window_handle",
        lambda: 11,
    )
    monkeypatch.setattr(
        "scripts.selection_snapshot_bridge.list_visible_windows",
        lambda: [
            {"title": "Magic Pointer Panel", "hwnd": 11},
            {"title": "Background document - Word", "hwnd": 22},
        ],
    )
    assert _window_dicts() == []


def test_probe_error_is_not_reported_as_empty_native_selection() -> None:
    context = AdapterReadContext(
        adapter="uia_text_selection",
        app="browser",
        window={"title": "Example - Microsoft Edge", "hwnd": 30},
        content=None,
        method="uia:text-pattern.selection",
        capabilities=[],
        artifacts={"source_hwnd": 30},
        error="UI Automation selection probe failed: TimeoutExpired",
    )
    summary = _summary_for(context.window, context)
    assert summary["state"] == "error"
    assert summary["label"] == "\u6d4f\u89c8\u5668 \u00b7 \u9009\u533a\u8bfb\u53d6\u5931\u8d25"
    assert summary["hasContent"] is False


def test_probe_error_snapshot_does_not_claim_native_selection() -> None:
    payload = capture_snapshot(
        [{"title": "Example - Microsoft Edge", "hwnd": 30}],
        registry=_ErrorRegistry(),
    )
    assert payload["selectionSnapshot"]["status"] == "error"
    assert payload["selectionSnapshot"]["source_kind"] == "foreground_window"
    assert payload["suggestedCommands"] == []
