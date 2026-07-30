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


class _TerminalAdapter:
    def read_context(self, window, **_kwargs):
        return AdapterReadContext(
            adapter="uia_text_selection",
            app="terminal",
            window=window,
            content="Error: broken\nProcess exited with code 7",
            method="uia:terminal-text-pattern",
            artifacts={
                "terminal_evidence": {
                    "schemaVersion": 1,
                    "state": "resolved",
                    "method": "uia:terminal-text-pattern",
                    "exitCode": 7,
                    "window": {"lineCount": 2, "text": "private log"},
                    "pixelFallbackUsed": False,
                },
            },
        )


class _TerminalRegistry:
    def matching_adapter(self, _window):
        return _TerminalAdapter()


class _BrowserAdapter:
    def read_context(self, window, **_kwargs):
        return AdapterReadContext(
            adapter="browser_devtools",
            app="browser",
            window=window,
            content="Retry",
            method="cdp:dom-point",
            artifacts={
                "browser_context": {
                    "schemaVersion": 1,
                    "state": "resolved",
                    "method": "cdp:dom-point",
                    "selector": "#retry-payment",
                    "node": {"accessibleName": "Retry payment"},
                    "coordinates": {"pointerScreenPhysical": {"x": 640, "y": 520}},
                    "networkFailures": [{"errorText": "private network error"}],
                },
            },
        )


class _BrowserRegistry:
    def matching_adapter(self, _window):
        return _BrowserAdapter()


class _GestureCandidateAdapter:
    def __init__(self) -> None:
        self.points: list[dict[str, int]] = []

    def read_context(self, window, **kwargs):
        target = dict(kwargs.get("target_point") or {})
        self.points.append(target)
        row = "B" if int(target.get("y") or 0) >= 150 else "A"
        top = 150 if row == "B" else 100
        return AdapterReadContext(
            adapter="gesture-candidate",
            app="word",
            window=window,
            content=f"Row {row}",
            label=f"Row {row}",
            method="synthetic:element-from-point",
            artifacts={
                "selection_rectangles": [[100, top, 300, 40]],
                "selection_rectangles_format": "xywh",
                "selection_rectangles_coordinate_space": "physical_screen_pixels",
            },
        )


class _GestureCandidateRegistry:
    def __init__(self) -> None:
        self.adapter = _GestureCandidateAdapter()

    def matching_adapter(self, _window):
        return self.adapter


class _FallbackOnlyAdapter:
    def read_context(self, window, **kwargs):
        target = dict(kwargs.get("target_point") or {})
        if int(target.get("y") or 0) >= 150:
            return AdapterReadContext(
                adapter="fallback-only", app="word", window=window,
                method="synthetic:element-from-point", artifacts={},
            )
        return AdapterReadContext(
            adapter="fallback-only", app="word", window=window,
            content="Wrong release-point row", label="Wrong row",
            method="synthetic:element-from-point",
            artifacts={"selection_rectangles": [[100, 100, 300, 40]]},
        )


class _FallbackOnlyRegistry:
    def matching_adapter(self, _window):
        return _FallbackOnlyAdapter()


class _MultiRectangleAdapter:
    def read_context(self, window, **_kwargs):
        return AdapterReadContext(
            adapter="multi-rectangle", app="word", window=window,
            content="Wrapped target", label="Wrapped target",
            method="synthetic:element-from-point",
            artifacts={
                "selection_rectangles": [[100, 100, 300, 40], [100, 150, 300, 40]],
                "selection_rectangles_format": "xywh",
            },
        )


class _MultiRectangleRegistry:
    def matching_adapter(self, _window):
        return _MultiRectangleAdapter()


class _ContentWithoutRectangleAdapter:
    def read_context(self, window, **_kwargs):
        return AdapterReadContext(
            adapter="no-rectangle", app="word", window=window,
            content="Text with no physical evidence", label="Unbounded text",
            method="synthetic:element-from-point", artifacts={},
        )


class _ContentWithoutRectangleRegistry:
    def matching_adapter(self, _window):
        return _ContentWithoutRectangleAdapter()


class _Audit:
    def __init__(self):
        self.events = []

    def append(self, event_type, data):
        self.events.append((event_type, data))
        return {"type": event_type, "data": data}


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


def test_snapshot_can_lock_the_pre_release_window_by_hwnd() -> None:
    foreground_after_release = {"title": "Magic Pointer Stage", "hwnd": 99, "supported": True}
    source_before_release = {"title": "doc.docx - Word", "hwnd": 10, "supported": True}
    registry = _FakeRegistry()

    payload = capture_snapshot(
        [foreground_after_release, source_before_release],
        registry=registry,
        target_hwnd=10,
    )

    assert payload["selectionSnapshot"]["source_window"] == source_before_release
    assert registry.seen == [source_before_release]


def test_structured_selection_is_rejected_if_foreground_changes_during_probe() -> None:
    foreground = {
        "title": "doc.docx - Word",
        "hwnd": 10,
        "pid": 42,
        "bbox": (100, 200, 1100, 900),
    }
    changed = {
        "title": "other.exe",
        "hwnd": 11,
        "pid": 99,
        "bbox": (0, 0, 800, 600),
    }

    payload = capture_snapshot(
        [foreground],
        registry=_FakeRegistry(),
        target_point={"x": 600, "y": 500},
        identity_probe=lambda: changed,
        allow_visual_fallback=False,
    )

    snapshot = payload["selectionSnapshot"]
    assert snapshot["status"] == "target_mismatch"
    assert snapshot["context"] is None
    assert snapshot["capture_attestation"]["phase"] == "after_structured_read"
    assert snapshot["perception_trace"]["selectedLayer"] is None


def test_structured_context_prevents_visual_capture_and_records_layer(tmp_path) -> None:
    foreground = {
        "title": "doc.docx - Word",
        "hwnd": 10,
        "pid": 42,
        "bbox": (100, 200, 1100, 900),
    }
    visual_calls = []
    audit = _Audit()

    payload = capture_snapshot(
        [foreground],
        registry=_FakeRegistry(),
        target_point={"x": 600, "y": 500},
        visual_capture=lambda **kwargs: visual_calls.append(kwargs),
        capture_dir=tmp_path,
        default_capture_mode="local_screenshot",
        audit_store=audit,
    )

    trace = payload["selectionSnapshot"]["perception_trace"]
    assert trace["selectedLayer"] == "native_app"
    assert trace["pixelFallbackUsed"] is False
    assert visual_calls == []
    assert audit.events[0][0] == "perception.resolved"
    assert audit.events[0][1]["selectedLayer"] == "native_app"
    assert "doc.docx" not in str(audit.events[0][1])


def test_terminal_snapshot_audit_records_only_safe_evidence_summary(tmp_path) -> None:
    audit = _Audit()
    capture_snapshot(
        [{"title": "PowerShell", "hwnd": 10, "pid": 42}],
        registry=_TerminalRegistry(),
        target_point={"x": 600, "y": 500},
        capture_dir=tmp_path,
        default_capture_mode="structured_only",
        audit_store=audit,
    )

    assert [event[0] for event in audit.events] == ["perception.resolved", "terminal.evidence"]
    terminal = audit.events[1][1]
    assert terminal["state"] == "resolved"
    assert terminal["exitCode"] == 7
    assert terminal["windowLineCount"] == 2
    assert terminal["pixelFallbackUsed"] is False
    assert "private log" not in str(terminal)


def test_browser_snapshot_audit_records_only_safe_devtools_summary(tmp_path) -> None:
    audit = _Audit()
    capture_snapshot(
        [{"title": "Checkout - Google Chrome", "hwnd": 10, "pid": 42}],
        registry=_BrowserRegistry(),
        target_point={"x": 640, "y": 520},
        capture_dir=tmp_path,
        default_capture_mode="structured_only",
        audit_store=audit,
    )

    assert [event[0] for event in audit.events] == ["perception.resolved", "browser.evidence"]
    browser = audit.events[1][1]
    assert browser["state"] == "resolved"
    assert browser["selectorObserved"] is True
    assert browser["accessibleNameObserved"] is True
    assert browser["networkFailureCount"] == 1
    assert browser["coordinatesObserved"] is True
    assert browser["pixelFallbackUsed"] is False
    assert "private network error" not in str(browser)


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
    assert snapshot["capture_bbox"] == [280, 290, 920, 710]
    assert snapshot["selection_bbox"] is None
    assert snapshot["pointer_anchor_bbox"] == [592, 492, 608, 508]
    artifacts = snapshot["context"]["artifacts"]
    assert artifacts["capture_bbox"] == [280, 290, 920, 710]
    assert artifacts["capture_bbox_coordinate_space"] == "physical_screen_pixels"
    assert artifacts["capture_bbox_format"] == "ltrb"
    assert artifacts["selection_rectangles"] == []
    assert artifacts["selection_rectangles_coordinate_space"] == "physical_screen_pixels"
    assert artifacts["selection_rectangles_format"] == "xywh"
    assert artifacts["selection_geometry_kind"] == "pointer_anchor"
    assert Path(snapshot["capture_path"]).is_file()
    annotated = Path(snapshot["annotated_path"])
    assert annotated.is_file()
    with Image.open(annotated).convert("RGB") as image:
        pointer_area = image.crop((300, 190, 360, 250))
        assert any(pixel != (255, 255, 255) for pixel in pointer_area.getdata())
    assert summary["hasVisual"] is True
    assert summary["hasContent"] is False
    assert captured == [((280, 290, 920, 710), True)]
    assert [item["label"] for item in payload["suggestedCommands"]] == [
        "生成视觉提示",
        "交给 Agent",
        "识别并复制",
    ]
    trace = snapshot["perception_trace"]
    assert trace["selectedLayer"] == "screen_region"
    assert trace["pixelFallbackUsed"] is True
    assert trace["fallbackReason"] == "structured_context_unavailable"
    assert trace["attempts"][-1]["status"] == "succeeded"


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
    assert payload["selectionSnapshot"].get("annotated_path") is None
    assert payload["captureSummary"]["hasVisual"] is False
    assert calls == []
    assert payload["suggestedCommands"] == []


def test_per_app_deny_skips_native_adapter_and_visual_capture(tmp_path) -> None:
    foreground = {
        "title": "Private Vault - 1Password",
        "hwnd": 20,
        "pid": 42,
        "process_name": "1Password.exe",
        "bbox": (100, 200, 1100, 900),
    }
    registry = _FakeRegistry()
    visual_calls = []

    payload = capture_snapshot(
        [foreground],
        registry=registry,
        target_point={"x": 600, "y": 500},
        visual_capture=lambda **kwargs: visual_calls.append(kwargs),
        capture_dir=tmp_path,
        upload_screenshots=True,
        default_capture_mode="upload_screenshot",
        app_capture_modes={"1password": "deny"},
    )

    assert payload["selectionSnapshot"]["status"] == "denied"
    assert payload["selectionSnapshot"]["context"] is None
    assert payload["selectionSnapshot"]["capture_path"] is None
    assert payload["suggestedCommands"] == []
    assert registry.seen == []
    assert visual_calls == []


def test_structured_only_rule_reads_native_but_never_uses_visual_fallback(tmp_path) -> None:
    foreground = {
        "title": "Checkout - Edge",
        "hwnd": 20,
        "pid": 42,
        "process_name": "msedge.exe",
        "bbox": (100, 200, 1100, 900),
    }
    registry = _FakeRegistry(supported=False)
    visual_calls = []

    payload = capture_snapshot(
        [foreground],
        registry=registry,
        target_point={"x": 600, "y": 500},
        visual_capture=lambda **kwargs: visual_calls.append(kwargs),
        capture_dir=tmp_path,
        upload_screenshots=True,
        default_capture_mode="upload_screenshot",
        app_capture_modes={"edge": "structured_only"},
    )

    assert payload["selectionSnapshot"]["status"] == "structured_only"
    assert payload["selectionSnapshot"]["capture_path"] is None
    assert registry.seen == [foreground]
    assert visual_calls == []
    trace = payload["selectionSnapshot"]["perception_trace"]
    assert trace["selectedLayer"] is None
    assert trace["pixelFallbackUsed"] is False
    assert trace["attempts"][-1]["layer"] == "screen_region"
    assert trace["attempts"][-1]["status"] == "blocked"
    assert trace["attempts"][-1]["reason"] == "capture_policy_structured_only"


def test_visual_capture_rejects_target_change_before_grab_with_zero_files(tmp_path) -> None:
    expected = {
        "title": "Design A",
        "hwnd": 20,
        "pid": 42,
        "process_name": "design.exe",
        "desktop_id": "desktop-1",
        "bbox": (100, 200, 1100, 900),
    }
    calls = []

    def grabber(**kwargs):
        calls.append(kwargs)
        return Image.new("RGB", (640, 420), "white")

    payload = capture_snapshot(
        [expected],
        registry=_FakeRegistry(supported=False),
        target_point={"x": 600, "y": 500},
        visual_capture=grabber,
        capture_dir=tmp_path,
        identity_probe=lambda: {**expected, "hwnd": 99, "title": "Design B"},
    )

    snapshot = payload["selectionSnapshot"]
    assert snapshot["status"] == "target_mismatch"
    assert snapshot["capture_path"] is None
    assert snapshot["annotated_path"] is None
    assert snapshot["capture_attestation"]["status"] == "target_mismatch"
    assert calls == []
    assert list(tmp_path.glob("*.png")) == []
    assert payload["suggestedCommands"] == []


def test_visual_capture_rejects_target_change_after_grab_before_writing_files(tmp_path) -> None:
    expected = {
        "title": "Design A",
        "hwnd": 20,
        "pid": 42,
        "process_name": "design.exe",
        "desktop_id": "desktop-1",
        "bbox": (100, 200, 1100, 900),
    }
    probes = iter([expected, {**expected, "desktop_id": "desktop-2"}])
    calls = []

    def grabber(*, bbox, all_screens):
        calls.append((bbox, all_screens))
        return Image.new("RGB", (bbox[2] - bbox[0], bbox[3] - bbox[1]), "white")

    payload = capture_snapshot(
        [expected],
        registry=_FakeRegistry(supported=False),
        target_point={"x": 600, "y": 500},
        visual_capture=grabber,
        capture_dir=tmp_path,
        identity_probe=lambda: next(probes),
    )

    snapshot = payload["selectionSnapshot"]
    assert snapshot["status"] == "target_mismatch"
    assert snapshot["capture_attestation"]["phase"] == "after_capture"
    assert calls == [((280, 290, 920, 710), True)]
    assert list(tmp_path.glob("*.png")) == []


def test_visual_capture_records_verified_target_attestation(tmp_path) -> None:
    expected = {
        "title": "Design A",
        "hwnd": 20,
        "pid": 42,
        "process_name": "design.exe",
        "desktop_id": "desktop-1",
        "bbox": (100, 200, 1100, 900),
    }

    payload = capture_snapshot(
        [expected],
        registry=_FakeRegistry(supported=False),
        target_point={"x": 600, "y": 500},
        visual_capture=lambda *, bbox, all_screens: Image.new(
            "RGB", (bbox[2] - bbox[0], bbox[3] - bbox[1]), "white"
        ),
        capture_dir=tmp_path,
        identity_probe=lambda: dict(expected),
    )

    attestation = payload["selectionSnapshot"]["capture_attestation"]
    assert attestation["status"] == "verified"
    assert attestation["expected"]["desktopId"] == "desktop-1"
    assert attestation["before"] == attestation["after"]


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


def test_completed_pointer_gesture_is_preserved_with_snapshot() -> None:
    gesture = {
        "kind": "line",
        "coordinateSpace": "electron_dip_screen",
        "releasePoint": {"x": 620, "y": 440},
        "semanticPoint": {"x": 510, "y": 438},
        "bbox": {"x": 400, "y": 430, "width": 220, "height": 16},
        "points": [
            {"x": 400, "y": 432, "t": 0},
            {"x": 510, "y": 438, "t": 60},
            {"x": 620, "y": 440, "t": 120},
        ],
    }
    payload = capture_snapshot(
        [{"title": "Gesture target", "hwnd": 901, "process_id": 902}],
        registry=_FakeRegistry(supported=False),
        target_point={"x": 510, "y": 438},
        gesture=gesture,
    )

    assert payload["selectionSnapshot"]["selection_gesture"] == gesture


def test_full_gesture_trace_drives_structured_grounding_instead_of_fallback_point() -> None:
    registry = _GestureCandidateRegistry()
    gesture = {
        "schemaVersion": 2,
        "coordinateSpace": "physical_screen_pixels",
        "releasePoint": {"x": 390, "y": 172},
        "bbox": {"x": 110, "y": 154, "width": 280, "height": 27},
        "strokes": [{
            "points": [
                {"x": 110, "y": 164, "t": 0},
                {"x": 155, "y": 176, "t": 20},
                {"x": 145, "y": 158, "t": 41},
                {"x": 230, "y": 171, "t": 65},
                {"x": 310, "y": 160, "t": 88},
                {"x": 390, "y": 172, "t": 120},
            ],
        }],
    }
    payload = capture_snapshot(
        [{"title": "Gesture target", "hwnd": 901, "process_id": 902}],
        registry=registry,
        target_point={"x": 150, "y": 120},  # Deliberately points at row A.
        gesture=gesture,
    )

    assert len(registry.adapter.points) >= 3
    assert payload["selectionSnapshot"]["context"]["content"] == "Row B"
    assert payload["selectionSnapshot"]["selection_bbox"] == [100, 150, 300, 40]
    assert payload["selectionSnapshot"]["gesture_grounding"]["candidate_count"] >= 1


def test_gesture_grounding_never_falls_back_to_an_unvisited_release_point_candidate() -> None:
    gesture = {
        "schemaVersion": 2,
        "coordinateSpace": "physical_screen_pixels",
        "releasePoint": {"x": 390, "y": 172},
        "bbox": {"x": 110, "y": 154, "width": 280, "height": 27},
        "strokes": [{"points": [
            {"x": 110, "y": 164, "t": 0}, {"x": 230, "y": 171, "t": 60},
            {"x": 390, "y": 172, "t": 120},
        ]}],
    }
    payload = capture_snapshot(
        [{"title": "Gesture target", "hwnd": 901, "process_id": 902}],
        registry=_FallbackOnlyRegistry(),
        target_point={"x": 150, "y": 120},
        gesture=gesture,
        allow_visual_fallback=False,
    )

    assert payload["selectionSnapshot"]["context"] is None
    assert payload["selectionSnapshot"]["selection_bbox"] is None
    assert payload["selectionSnapshot"]["gesture_grounding"]["state"] == "unresolved"
    assert payload["selectionSnapshot"]["perception_trace"]["selectedLayer"] is None


def test_best_scoring_rectangle_is_frozen_not_first_rectangle() -> None:
    gesture = {
        "schemaVersion": 2,
        "coordinateSpace": "physical_screen_pixels",
        "releasePoint": {"x": 390, "y": 172},
        "bbox": {"x": 110, "y": 154, "width": 280, "height": 27},
        "strokes": [{"points": [
            {"x": 110, "y": 164, "t": 0}, {"x": 230, "y": 171, "t": 60},
            {"x": 390, "y": 172, "t": 120},
        ]}],
    }
    payload = capture_snapshot(
        [{"title": "Gesture target", "hwnd": 901, "process_id": 902}],
        registry=_MultiRectangleRegistry(),
        target_point={"x": 390, "y": 172},
        gesture=gesture,
    )

    assert payload["selectionSnapshot"]["selection_bbox"] == [100, 150, 300, 40]


def test_structured_text_without_a_physical_rectangle_is_not_claimed_as_gesture_target() -> None:
    gesture = {
        "schemaVersion": 2,
        "coordinateSpace": "physical_screen_pixels",
        "releasePoint": {"x": 390, "y": 172},
        "bbox": {"x": 110, "y": 154, "width": 280, "height": 27},
        "strokes": [{"points": [
            {"x": 110, "y": 164, "t": 0}, {"x": 390, "y": 172, "t": 120},
        ]}],
    }
    payload = capture_snapshot(
        [{"title": "Gesture target", "hwnd": 901, "process_id": 902}],
        registry=_ContentWithoutRectangleRegistry(),
        target_point={"x": 390, "y": 172},
        gesture=gesture,
        allow_visual_fallback=False,
    )

    assert payload["selectionSnapshot"]["context"] is None
    assert payload["selectionSnapshot"]["gesture_grounding"]["state"] == "unresolved"


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
