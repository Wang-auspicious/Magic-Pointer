from __future__ import annotations

import os
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image

from app.adapters.base import AdapterCapability, AdapterReadContext
from scripts.selection_snapshot_bridge import (
    _prune_capture_dir,
    _suggested_commands,
    _summary_for,
    capture_snapshot,
)
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
    assert [item["label"] for item in payload["suggestedCommands"]] == [
        "原位改写",
        "翻译并写回",
        "交给 Agent",
    ]


def test_unsupported_foreground_fails_closed_without_scanning_background() -> None:
    foreground = {"title": "Browser", "hwnd": 20}
    background = {"title": "doc.docx - Word", "hwnd": 21}
    registry = _FakeRegistry(supported=False)
    payload = capture_snapshot([foreground, background], registry=registry)
    assert payload["selectionSnapshot"]["status"] == "unsupported"
    assert payload["selectionSnapshot"]["context"] is None
    assert payload["suggestedCommands"] == []
    assert registry.seen == [foreground]


def test_unsupported_foreground_becomes_local_visual_object_at_pointer(tmp_path) -> None:
    foreground = {
        "title": "Design review - Acme",
        "hwnd": 20,
        "pid": 42,
        "bbox": (100, 200, 1100, 900),
    }
    captured = []

    def grabber(*, bbox, all_screens):
        captured.append((bbox, all_screens))
        return Image.new("RGB", (bbox[2] - bbox[0], bbox[3] - bbox[1]), "white")

    payload = capture_snapshot(
        [foreground],
        registry=_FakeRegistry(supported=False),
        target_point={"x": 600, "y": 500},
        visual_capture=grabber,
        capture_dir=tmp_path,
    )

    snapshot = payload["selectionSnapshot"]
    summary = payload["captureSummary"]
    assert snapshot["status"] == "ready"
    assert snapshot["source_kind"] == "screen_region"
    assert snapshot["selection_bbox"] == [280, 290, 920, 710]
    assert Path(snapshot["capture_path"]).is_file()
    assert summary["hasVisual"] is True
    assert summary["hasContent"] is False
    assert captured == [((280, 290, 920, 710), True)]
    assert [item["label"] for item in payload["suggestedCommands"]] == [
        "生成视觉提示",
        "交给 Agent",
        "识别并复制",
    ]


def test_sensitive_foreground_never_uses_visual_capture(tmp_path) -> None:
    foreground = {
        "title": "1Password - Private Vault",
        "hwnd": 20,
        "pid": 42,
        "bbox": (100, 200, 1100, 900),
    }
    calls = []

    def grabber(**kwargs):
        calls.append(kwargs)
        return Image.new("RGB", (10, 10), "white")

    payload = capture_snapshot(
        [foreground],
        registry=_FakeRegistry(supported=False),
        target_point={"x": 600, "y": 500},
        visual_capture=grabber,
        capture_dir=tmp_path,
        sensitive_apps=["1password"],
    )

    assert payload["selectionSnapshot"]["status"] == "sensitive"
    assert payload["selectionSnapshot"]["capture_path"] is None
    assert payload["captureSummary"]["hasVisual"] is False
    assert calls == []
    assert payload["suggestedCommands"] == []


def test_capture_retention_removes_only_expired_owned_pngs(tmp_path) -> None:
    old_capture = tmp_path / "screen-old.png"
    recent_capture = tmp_path / "screen-recent.png"
    unrelated = tmp_path / "keep-me.png"
    nested = tmp_path / "nested"
    nested.mkdir()
    nested_capture = nested / "screen-nested.png"
    for path in (old_capture, recent_capture, unrelated, nested_capture):
        path.write_bytes(b"test")
    reference = datetime(2026, 7, 26, tzinfo=timezone.utc)
    old_timestamp = reference.timestamp() - (4 * 86400)
    os.utime(old_capture, (old_timestamp, old_timestamp))

    removed = _prune_capture_dir(tmp_path, 3, now=reference)

    assert removed == 1
    assert not old_capture.exists()
    assert recent_capture.exists()
    assert unrelated.exists()
    assert nested_capture.exists()


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
        "保存证据卡",
        "交给 Agent",
        "复制原文",
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


def test_active_review_turns_empty_foreground_into_delivery_target() -> None:
    foreground = {"title": "Agent conversation", "hwnd": 88, "process_id": 99}
    payload = capture_snapshot(
        [foreground],
        registry=_FakeRegistry(supported=False),
        target_point={"x": 440, "y": 820},
        active_review={"session_id": "review-1", "anchor_count": 3},
    )

    assert payload["selectionSnapshot"]["target_point"] == {"x": 440, "y": 820}
    assert payload["selectionSnapshot"]["target_point_space"] == "physical_screen_pixels"
    assert payload["captureSummary"]["hasActiveReview"] is True
    assert payload["captureSummary"]["activeReviewAnchorCount"] == 3
    assert payload["suggestedCommands"] == [{
        "label": "填入 3 条验收意见",
        "command": "把验收意见填到这里",
        "autoRun": True,
    }]


def test_active_context_pack_takes_priority_as_agent_delivery_target() -> None:
    foreground = {"title": "Codex", "hwnd": 188, "process_id": 199, "process_name": "Codex.exe"}
    payload = capture_snapshot(
        [foreground],
        registry=_FakeRegistry(supported=False),
        target_point={"x": 540, "y": 920},
        active_context={"session_id": "context-1", "item_count": 4},
        active_review={"session_id": "review-1", "anchor_count": 3},
    )

    assert payload["captureSummary"]["hasActiveContext"] is True
    assert payload["selectionSnapshot"]["target_point_space"] == "physical_screen_pixels"
    assert payload["captureSummary"]["activeContextItemCount"] == 4
    assert payload["suggestedCommands"] == [{
        "label": "发送 4 条上下文",
        "command": "发送到这里",
        "autoRun": True,
    }]


def test_runtime_issue_is_presented_as_one_agent_task_not_generic_context() -> None:
    foreground = {"title": "Codex", "hwnd": 288, "process_id": 299, "process_name": "Codex.exe"}
    payload = capture_snapshot(
        [foreground],
        registry=_FakeRegistry(supported=False),
        active_context={
            "session_id": "runtime-1",
            "workflow_kind": "runtime_issue",
            "item_count": 3,
        },
    )

    assert payload["captureSummary"]["activeContextWorkflowKind"] == "runtime_issue"
    assert payload["suggestedCommands"] == [{
        "label": "填入现场任务（3 条证据）",
        "command": "发送到这里",
        "autoRun": True,
    }]
