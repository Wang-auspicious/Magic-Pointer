from __future__ import annotations

import os
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image

from app.adapters.base import AdapterCapability, AdapterReadContext
from scripts.selection_snapshot_bridge import (
    _capture_visual_region,
    _prune_capture_dir,
    _suggested_commands,
    _summary_for,
    _is_enclosed_gesture,
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


class _CountingErrorAdapter(_ErrorAdapter):
    def __init__(self) -> None:
        self.requests = []

    def read_context(self, window, **kwargs):
        self.requests.append(dict(kwargs))
        return super().read_context(window, **kwargs)


class _CountingErrorRegistry:
    def __init__(self) -> None:
        self.adapter = _CountingErrorAdapter()

    def matching_adapter(self, _window):
        return self.adapter


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


class _TerminalRegionAdapter:
    def __init__(self) -> None:
        self.region_requests = []
        self.point_requests = []

    def read_context(self, window, **kwargs):
        if kwargs.get("target_region") is not None:
            self.region_requests.append(dict(kwargs["target_region"]))
        elif kwargs.get("target_point") is not None:
            self.point_requests.append(dict(kwargs["target_point"]))
        return AdapterReadContext(
            adapter="uia_text_selection",
            app="terminal",
            window=window,
            content="terminal alpha exact line",
            method="uia:terminal-text-pattern",
            artifacts={
                "perception_result_kind": "terminal_buffer",
                "selection_rectangles": [[163, 281, 2280, 37]],
                "selection_rectangles_format": "xywh",
                "selection_rectangles_coordinate_space": "physical_screen_pixels",
            },
        )


class _TerminalRegionRegistry:
    def __init__(self) -> None:
        self.adapter = _TerminalRegionAdapter()

    def matching_adapter(self, _window):
        return self.adapter


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


class _ClosedRegionAdapter:
    def __init__(self) -> None:
        self.region_requests: list[dict[str, int]] = []
        self.point_requests: list[dict[str, int]] = []

    def read_context(self, window, **kwargs):
        target_region = kwargs.get("target_region")
        if isinstance(target_region, dict):
            self.region_requests.append(dict(target_region))
            return AdapterReadContext(
                adapter="uia_text_selection",
                app="application",
                window=window,
                content="当前版本\nMagic Pointer 1.0.0",
                label="Circled settings block",
                method="uia:region-elements",
                artifacts={
                    "perception_result_kind": "region_elements",
                    "selection_rectangles": [
                        [600, 430, 120, 28],
                        [600, 468, 190, 28],
                    ],
                    "selection_rectangles_format": "xywh",
                    "selection_rectangles_coordinate_space": "physical_screen_pixels",
                    "region_elements": [
                        {"text": "当前版本", "rect": [600, 430, 120, 28]},
                        {"text": "Magic Pointer 1.0.0", "rect": [600, 468, 190, 28]},
                    ],
                },
            )
        target = dict(kwargs.get("target_point") or {})
        self.point_requests.append(target)
        return AdapterReadContext(
            adapter="uia_text_selection",
            app="application",
            window=window,
            content="更新服务接入前固定为稳定版。",
            label="Wrong boundary row",
            method="uia:element-from-point",
            artifacts={
                "selection_rectangles": [[600, 390, 260, 28]],
                "selection_rectangles_format": "xywh",
                "selection_rectangles_coordinate_space": "physical_screen_pixels",
            },
        )


class _ClosedRegionRegistry:
    def __init__(self) -> None:
        self.adapter = _ClosedRegionAdapter()

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
    trace = snapshot["perception_trace"]
    assert trace["selectedLayer"] == "screen_region"
    assert trace["pixelFallbackUsed"] is True
    assert trace["fallbackReason"] == "structured_context_unavailable"
    assert trace["attempts"][-1]["status"] == "succeeded"
    assert [item["label"] for item in payload["suggestedCommands"]] == [
        "生成视觉提示",
        "交给 Agent",
        "识别并复制",
    ]


def test_gesture_snapshot_captures_only_bounded_evidence_around_the_mark(tmp_path) -> None:
    foreground = {
        "title": "Magic Pointer",
        "hwnd": 20,
        "pid": 42,
        "bbox": (100, 200, 1100, 900),
    }
    calls = []
    gesture = {
        "schemaVersion": 2,
        "coordinateSpace": "physical_screen_pixels",
        "releasePoint": {"x": 650, "y": 520},
        "bbox": {"x": 520, "y": 470, "width": 180, "height": 64},
        "strokes": [{"points": [
            {"x": 520, "y": 490}, {"x": 620, "y": 470},
            {"x": 700, "y": 520}, {"x": 550, "y": 534},
        ]}],
    }

    def grabber(*, bbox, all_screens):
        calls.append((bbox, all_screens))
        return Image.new("RGB", (bbox[2] - bbox[0], bbox[3] - bbox[1]), "white")

    payload = capture_snapshot(
        [foreground],
        registry=_FakeRegistry(supported=False),
        target_point={"x": 650, "y": 520},
        gesture=gesture,
        visual_capture=grabber,
        global_capture_bbox=(0, 0, 1920, 1080),
        capture_dir=tmp_path,
    )

    snapshot = payload["selectionSnapshot"]
    assert calls == [((424, 406, 796, 598), True)]
    assert snapshot["capture_bbox"] == [424, 406, 796, 598]
    assert snapshot["selection_bbox"] == [520, 470, 180, 64]
    artifacts = snapshot["context"]["artifacts"]
    assert artifacts["selection_rectangles"] == [[520, 470, 180, 64]]
    assert artifacts["selection_geometry_kind"] == "gesture_region"
    assert Path(snapshot["capture_path"]).is_file()
    assert Path(snapshot["annotated_path"]).is_file()


class _WholeWindowContainerAdapter:
    def __init__(self):
        self.calls = 0

    def read_context(self, window, **_kwargs):
        self.calls += 1
        left, top, right, bottom = window["bbox"]
        return AdapterReadContext(
            adapter="uia_text_selection",
            app="application",
            window=window,
            content="every line in the document",
            label="document",
            method="uia:element-from-point",
            capabilities=[],
            artifacts={
                "selection_rectangles": [[left, top, right - left, bottom - top]],
                "selection_rectangles_format": "xywh",
                "selection_rectangles_coordinate_space": "physical_screen_pixels",
            },
        )


class _WholeWindowContainerRegistry:
    def __init__(self):
        self.adapter = _WholeWindowContainerAdapter()

    def matching_adapter(self, _window):
        return self.adapter


def test_rejected_structured_container_falls_back_to_the_user_mark_bbox(tmp_path) -> None:
    foreground = {
        "title": "notes.txt - Notepad",
        "hwnd": 20,
        "pid": 42,
        "bbox": (0, 100, 1600, 1000),
    }
    gesture = {
        "schemaVersion": 2,
        "coordinateSpace": "physical_screen_pixels",
        "releasePoint": {"x": 900, "y": 330},
        "bbox": {"x": 300, "y": 330, "width": 600, "height": 0},
        "strokes": [{"points": [
            {"x": 300, "y": 330}, {"x": 600, "y": 330}, {"x": 900, "y": 330},
        ]}],
    }

    registry = _WholeWindowContainerRegistry()
    payload = capture_snapshot(
        [foreground],
        registry=registry,
        target_point={"x": 900, "y": 330},
        gesture=gesture,
        visual_capture=lambda *, bbox, all_screens: Image.new(
            "RGB", (bbox[2] - bbox[0], bbox[3] - bbox[1]), "white"
        ),
        global_capture_bbox=(0, 0, 1920, 1080),
        capture_dir=tmp_path,
    )

    snapshot = payload["selectionSnapshot"]
    assert snapshot["structured_covers_mark"] is False
    assert snapshot["structured_gap_reason"] == "container_not_selection"
    assert snapshot["selection_bbox"] == [300, 326, 600, 8]
    assert snapshot["capture_bbox"] == [204, 240, 996, 420]
    assert snapshot["context"]["content"] == ""
    assert registry.adapter.calls == 1


def test_visual_capture_retries_full_desktop_when_window_capture_is_black(tmp_path, monkeypatch) -> None:
    calls = []
    window = {
        "title": "Magic Pointer",
        "hwnd": 20,
        "pid": 42,
        "bbox": (100, 200, 1100, 900),
    }

    def grab(*, window=None, bbox=None, all_screens=False):
        calls.append({"window": window, "bbox": bbox, "all_screens": all_screens})
        if window is not None:
            return Image.new("RGB", (1000, 700), "black")
        return Image.new("RGB", (bbox[2] - bbox[0], bbox[3] - bbox[1]), "white")

    monkeypatch.setattr("scripts.selection_snapshot_bridge.ImageGrab.grab", grab)
    capture = _capture_visual_region(
        window,
        {"x": 600, "y": 500},
        capture_dir=tmp_path,
    )

    assert capture is not None
    assert calls[0]["window"] == 20
    assert calls[1]["bbox"] == (280, 290, 920, 710)
    with Image.open(capture["path"]).convert("RGB") as image:
        assert image.getextrema() == ((255, 255), (255, 255), (255, 255))


def test_visual_capture_retries_desktop_when_only_the_requested_window_crop_is_blank(tmp_path, monkeypatch) -> None:
    calls = []
    window = {
        "title": "notes.txt - Notepad",
        "hwnd": 20,
        "pid": 42,
        "bbox": (0, 0, 1000, 700),
    }

    def grab(*, window=None, bbox=None, all_screens=False):
        calls.append({"window": window, "bbox": bbox, "all_screens": all_screens})
        if window is not None:
            image = Image.new("RGB", (1000, 700), "black")
            # PrintWindow returned a title-bar icon, so the whole frame is not
            # blank, but the requested content crop still is.
            image.putpixel((10, 10), (255, 255, 255))
            return image
        return Image.new("RGB", (bbox[2] - bbox[0], bbox[3] - bbox[1]), "white")

    monkeypatch.setattr("scripts.selection_snapshot_bridge.ImageGrab.grab", grab)
    capture = _capture_visual_region(
        window,
        {"x": 600, "y": 500},
        capture_bbox=(300, 300, 900, 600),
        capture_dir=tmp_path,
    )

    assert capture is not None
    assert calls == [
        {"window": 20, "bbox": None, "all_screens": False},
        {"window": None, "bbox": (300, 300, 900, 600), "all_screens": True},
    ]
    with Image.open(capture["path"]).convert("RGB") as image:
        assert image.getextrema() == ((255, 255), (255, 255), (255, 255))


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


def test_committed_window_handle_wins_over_overlapping_point_geometry(monkeypatch) -> None:
    monkeypatch.setattr(
        "scripts.selection_snapshot_bridge.list_visible_windows",
        lambda: [
            {"title": "Background full-screen browser", "hwnd": 11, "bbox": [0, 0, 1920, 1080]},
            {"title": "Committed Notepad", "hwnd": 22, "bbox": [0, 100, 1600, 900]},
        ],
    )
    monkeypatch.setattr(
        "scripts.selection_snapshot_bridge.get_foreground_window_handle",
        lambda: 11,
    )

    assert _window_dicts(22, {"x": 600, "y": 300}) == [
        {"title": "Committed Notepad", "hwnd": 22, "bbox": [0, 100, 1600, 900]}
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


def test_closed_gesture_reads_the_enclosed_component_set_not_the_top_boundary_row() -> None:
    registry = _ClosedRegionRegistry()
    gesture = {
        "schemaVersion": 2,
        "kind": "freeform",
        "coordinateSpace": "physical_screen_pixels",
        "releasePoint": {"x": 585, "y": 425},
        "semanticPoint": {"x": 695, "y": 463},
        "bbox": {"x": 580, "y": 410, "width": 240, "height": 110},
        "strokes": [{"points": [
            {"x": 585, "y": 425, "t": 0},
            {"x": 700, "y": 410, "t": 25},
            {"x": 815, "y": 445, "t": 50},
            {"x": 805, "y": 510, "t": 75},
            {"x": 690, "y": 520, "t": 100},
            {"x": 580, "y": 485, "t": 125},
            {"x": 585, "y": 425, "t": 150},
        ]}],
    }

    payload = capture_snapshot(
        [{"title": "Magic Pointer", "hwnd": 901, "process_id": 902}],
        registry=registry,
        target_point={"x": 585, "y": 425},
        gesture=gesture,
        allow_visual_fallback=False,
    )

    snapshot = payload["selectionSnapshot"]
    assert snapshot["context"]["content"] == "当前版本\nMagic Pointer 1.0.0"
    assert snapshot["gesture_grounding"]["mode"] == "enclosed_region"
    assert snapshot["selection_bbox"] == [600, 430, 190, 66]
    assert registry.adapter.region_requests == [{"x": 580, "y": 410, "width": 240, "height": 110}]
    assert registry.adapter.point_requests == []


def test_open_stroke_prefers_one_bounded_region_read_over_overlay_point_sampling() -> None:
    registry = _ClosedRegionRegistry()
    gesture = {
        "schemaVersion": 2,
        "kind": "line",
        "coordinateSpace": "physical_screen_pixels",
        "releasePoint": {"x": 790, "y": 468},
        "bbox": {"x": 590, "y": 452, "width": 210, "height": 24},
        "strokes": [{"points": [
            {"x": 590, "y": 462}, {"x": 680, "y": 468}, {"x": 790, "y": 468},
        ]}],
    }

    payload = capture_snapshot(
        [{"title": "Magic Pointer", "hwnd": 901, "process_id": 902}],
        registry=registry,
        target_point={"x": 790, "y": 468},
        gesture=gesture,
        allow_visual_fallback=False,
    )

    snapshot = payload["selectionSnapshot"]
    assert snapshot["context"]["content"].endswith("Magic Pointer 1.0.0")
    assert snapshot["gesture_grounding"]["mode"] == "stroke_region"
    assert registry.adapter.region_requests == [{"x": 590, "y": 452, "width": 210, "height": 24}]
    assert registry.adapter.point_requests == []


def test_terminal_line_region_does_not_repeat_the_same_textpattern_probe_at_sample_points() -> None:
    registry = _TerminalRegionRegistry()
    gesture = {
        "schemaVersion": 2,
        "kind": "line",
        "coordinateSpace": "physical_screen_pixels",
        "releasePoint": {"x": 680, "y": 288},
        "bbox": {"x": 160, "y": 280, "width": 520, "height": 16},
        "strokes": [{"points": [
            {"x": 160, "y": 288}, {"x": 420, "y": 288}, {"x": 680, "y": 288},
        ]}],
    }

    payload = capture_snapshot(
        [{"title": "Terminal fixture", "hwnd": 901, "process_id": 902, "bbox": [0, 0, 2500, 1400]}],
        registry=registry,
        target_point={"x": 680, "y": 288},
        gesture=gesture,
        allow_visual_fallback=False,
    )

    snapshot = payload["selectionSnapshot"]
    assert snapshot["context"]["content"] == "terminal alpha exact line"
    assert snapshot["gesture_grounding"]["mode"] == "terminal_line"
    assert snapshot["selection_bbox"] == [160, 280, 520, 16]
    assert registry.adapter.region_requests == [{"x": 160, "y": 280, "width": 520, "height": 16}]
    assert registry.adapter.point_requests == []


def test_hard_region_adapter_failure_is_not_retried_at_every_stroke_sample() -> None:
    registry = _CountingErrorRegistry()
    gesture = {
        "schemaVersion": 2,
        "kind": "line",
        "coordinateSpace": "physical_screen_pixels",
        "releasePoint": {"x": 680, "y": 288},
        "bbox": {"x": 160, "y": 280, "width": 520, "height": 16},
        "strokes": [{"points": [
            {"x": 160, "y": 288}, {"x": 420, "y": 288}, {"x": 680, "y": 288},
        ]}],
    }

    payload = capture_snapshot(
        [{"title": "Slow UIA fixture", "hwnd": 901, "process_id": 902}],
        registry=registry,
        target_point={"x": 680, "y": 288},
        gesture=gesture,
        allow_visual_fallback=False,
    )

    snapshot = payload["selectionSnapshot"]
    assert len(registry.adapter.requests) == 1
    assert registry.adapter.requests[0]["target_region"] == {
        "x": 160, "y": 280, "width": 520, "height": 16,
    }
    assert snapshot["gesture_grounding"]["reason"] == "structured_region_hard_failure"
    assert snapshot["perception_trace"]["attempts"][0]["status"] == "error"


def test_enclosed_gesture_allows_a_short_tail_after_the_loop_closes() -> None:
    gesture = {
        "bbox": {"x": 80, "y": 80, "width": 240, "height": 120},
        "strokes": [{"points": [
            {"x": 90, "y": 120},
            {"x": 110, "y": 88},
            {"x": 220, "y": 82},
            {"x": 310, "y": 112},
            {"x": 300, "y": 170},
            {"x": 205, "y": 194},
            {"x": 112, "y": 170},
            {"x": 90, "y": 120},
            {"x": 65, "y": 145},
            {"x": 48, "y": 162},
        ]}],
    }

    points = [(point["x"], point["y"]) for point in gesture["strokes"][0]["points"]]
    assert _is_enclosed_gesture(gesture, points) is True


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
    assert payload["selectionSnapshot"]["selection_bbox"] == [110, 154, 280, 27]
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


class _StrokeRegionAdapter:
    name = "uia_text_selection"
    perception_layer = "uia"

    def __init__(self) -> None:
        self.region_requests: list[dict[str, int]] = []

    def read_context(self, window, **kwargs):
        target_region = kwargs.get("target_region")
        if isinstance(target_region, dict):
            self.region_requests.append(dict(target_region))
        rows = [
            {"text": "Formula A", "control_type": "Text", "rect": [100, 100, 300, 30]},
            {"text": "The size of this range", "control_type": "Text", "rect": [100, 140, 300, 30]},
            {"text": "Formula B", "control_type": "Text", "rect": [100, 180, 300, 30]},
        ]
        return AdapterReadContext(
            adapter="uia_text_selection",
            app="application",
            window=window,
            content="Formula A\nThe size of this range\nFormula B",
            label="PDF rows",
            method="uia:region-elements",
            artifacts={
                "perception_result_kind": "region_elements",
                "selection_rectangles": [[100, 100, 300, 30], [100, 140, 300, 30], [100, 180, 300, 30]],
                "selection_rectangles_format": "xywh",
                "selection_rectangles_coordinate_space": "physical_screen_pixels",
                "region_elements": rows,
            },
        )


class _StrokeRegionRegistry:
    def __init__(self) -> None:
        self.adapter = _StrokeRegionAdapter()

    def matching_adapter(self, _window):
        return self.adapter


def test_multi_stroke_selects_only_crossed_rows_as_segments() -> None:
    registry = _StrokeRegionRegistry()
    gesture = {
        "schemaVersion": 2,
        "coordinateSpace": "physical_screen_pixels",
        "kind": "multi",
        "releasePoint": {"x": 400, "y": 190},
        "bbox": {"x": 100, "y": 100, "width": 300, "height": 110},
        "strokes": [
            {"points": [
                {"x": 100, "y": 110}, {"x": 200, "y": 112}, {"x": 400, "y": 110},
            ]},
            {"points": [
                {"x": 100, "y": 190}, {"x": 250, "y": 192}, {"x": 400, "y": 190},
            ]},
        ],
    }

    payload = capture_snapshot(
        [{"title": "PDF", "hwnd": 901, "process_id": 902}],
        registry=registry,
        target_point={"x": 300, "y": 150},
        gesture=gesture,
        allow_visual_fallback=False,
    )

    snapshot = payload["selectionSnapshot"]
    assert snapshot["context"]["content"] == "[segment 1] Formula A\n[segment 2] Formula B"
    assert "size of this range" not in snapshot["context"]["content"]
    assert snapshot["gesture_grounding"]["mode"] == "stroke_region"
    assert snapshot["gesture_grounding"]["segment_count"] == 2
    assert snapshot["selection_segments"] == [[100, 100, 300, 30], [100, 180, 300, 30]]
    assert snapshot["selection_bbox"] == [100, 100, 300, 110]


def test_single_open_stroke_keeps_only_crossed_element() -> None:
    registry = _StrokeRegionRegistry()
    gesture = {
        "schemaVersion": 2,
        "coordinateSpace": "physical_screen_pixels",
        "kind": "line",
        "releasePoint": {"x": 400, "y": 190},
        "bbox": {"x": 100, "y": 100, "width": 300, "height": 110},
        "strokes": [
            {"points": [
                {"x": 100, "y": 110}, {"x": 200, "y": 112}, {"x": 400, "y": 110},
            ]},
        ],
    }

    payload = capture_snapshot(
        [{"title": "PDF", "hwnd": 901, "process_id": 902}],
        registry=registry,
        target_point={"x": 300, "y": 150},
        gesture=gesture,
        allow_visual_fallback=False,
    )

    snapshot = payload["selectionSnapshot"]
    assert snapshot["context"]["content"] == "Formula A"
    assert snapshot["gesture_grounding"]["segment_count"] == 1
    assert snapshot["selection_segments"] == [[100, 100, 300, 30]]


def test_bounded_visual_evidence_does_not_relabel_a_structured_gesture_as_pixel_fallback(tmp_path) -> None:
    gesture = {
        "schemaVersion": 2,
        "coordinateSpace": "physical_screen_pixels",
        "kind": "line",
        "releasePoint": {"x": 400, "y": 110},
        "bbox": {"x": 100, "y": 100, "width": 300, "height": 20},
        "strokes": [{"points": [
            {"x": 100, "y": 110}, {"x": 250, "y": 112}, {"x": 400, "y": 110},
        ]}],
    }

    payload = capture_snapshot(
        [{"title": "PDF", "hwnd": 901, "process_id": 902, "bbox": [0, 0, 800, 600]}],
        registry=_StrokeRegionRegistry(),
        target_point={"x": 300, "y": 110},
        gesture=gesture,
        visual_capture=lambda *, bbox, all_screens: Image.new(
            "RGB", (bbox[2] - bbox[0], bbox[3] - bbox[1]), "white"
        ),
        capture_dir=tmp_path,
    )

    snapshot = payload["selectionSnapshot"]
    trace = snapshot["perception_trace"]
    assert snapshot["source_kind"] == "native_selection"
    assert snapshot["context"]["content"] == "Formula A"
    assert snapshot["capture_path"]
    assert trace["selectedLayer"] == "uia"
    assert trace["selectedAdapter"] == "uia_text_selection"
    assert trace["pixelFallbackUsed"] is False
    assert trace["attempts"][-1]["reason"] == "bounded_visual_evidence"
