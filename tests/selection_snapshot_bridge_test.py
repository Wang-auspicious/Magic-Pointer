from __future__ import annotations

from app.adapters.base import AdapterCapability, AdapterReadContext
from scripts.selection_snapshot_bridge import capture_snapshot


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
