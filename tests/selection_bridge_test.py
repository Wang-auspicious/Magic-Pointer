from __future__ import annotations

import io
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import scripts.action_bridge as action_bridge
import scripts.electron_bridge as electron_bridge
import scripts.selection_bridge as selection_bridge
from app.adapters.base import AdapterReadContext
from scripts.selection_bridge import (
    _calendar_response,
    _crop_roi_for_ocr,
    _route_response,
    _context_from_snapshot,
    _enrich_screen_region_context,
    _interaction_episode_context,
    _reference_label_response,
    _read_target_context,
    _shopping_list_response,
    _screen_region_vision_answer,
    _wants_undo,
)


def test_screen_region_snapshot_is_enriched_with_local_ocr(monkeypatch, tmp_path) -> None:
    capture = tmp_path / "screen.png"
    capture.write_bytes(b"not-a-real-png-for-the-injected-reader")
    monkeypatch.setattr(
        selection_bridge,
        "_read_local_ocr",
        lambda path: ("Magic Pointer 1.0.0", "test-ocr"),
    )
    context = _enrich_screen_region_context(
        {"title": "Magic Pointer", "process_name": "Magic Pointer"},
        None,
        {
            "source_kind": "screen_region",
            "capture_path": str(capture),
            "annotated_path": str(tmp_path / "screen.pointer.png"),
        },
    )
    assert context is not None
    assert context.content == "Magic Pointer 1.0.0"
    assert context.method == "local:test-ocr"
    assert context.artifacts["capture_path"] == str(capture)


def test_screen_region_with_capture_artifacts_still_runs_local_ocr(monkeypatch, tmp_path) -> None:
    capture = tmp_path / "screen.png"
    capture.write_bytes(b"capture")
    original = AdapterReadContext(
        adapter="screen_region",
        app="screen",
        window={"title": "Magic Pointer"},
        content="",
        method="pointer:bounded-screen-region",
        artifacts={"capture_path": str(capture)},
    )
    monkeypatch.setattr(
        selection_bridge,
        "_read_local_ocr",
        lambda path: ("Magic Pointer 1.0.0", "test-ocr"),
    )

    context = _enrich_screen_region_context(
        {"title": "Magic Pointer"},
        original,
        {"source_kind": "screen_region", "capture_path": str(capture)},
    )

    assert context is not original
    assert context.content == "Magic Pointer 1.0.0"


def test_screen_region_vision_uses_original_and_locator_only_when_upload_is_enabled(monkeypatch, tmp_path) -> None:
    raw = tmp_path / "screen.png"
    locator = tmp_path / "screen.pointer.png"
    raw.write_bytes(b"raw")
    locator.write_bytes(b"locator")
    seen = {}

    class _Settings:
        privacy = type("Privacy", (), {"upload_screenshots": True})()

    monkeypatch.setattr(selection_bridge, "_capture_settings", lambda: _Settings())
    monkeypatch.setattr(
        selection_bridge,
        "ask_vision_model",
        lambda image, prompt, context_text=None, labeled_extra_images=None: seen.update({
            "image": image,
            "prompt": prompt,
            "context": context_text,
            "extras": labeled_extra_images,
        }) or "视觉回答",
    )

    answer = _screen_region_vision_answer(
        "这是什么版本？",
        {"title": "Magic Pointer"},
        AdapterReadContext(adapter="local_ocr", app="screen", content="Magic Pointer 1.0.0"),
        {
            "source_kind": "screen_region",
            "capture_path": str(raw),
            "annotated_path": str(locator),
            "selection_bbox": [100, 200, 160, 32],
        },
    )

    assert answer == "视觉回答"
    assert seen["image"] == raw
    assert seen["extras"] == [("IMAGE A LOCATOR / user-marked target", locator)]
    assert "Magic Pointer 1.0.0" in seen["context"]


class _FakeAdapter:
    def read_context(self, window, **kwargs):
        return {"window": window, "command": kwargs.get("command")}


class _FakeRegistry:
    def __init__(self) -> None:
        self.seen = []

    def matching_adapter(self, window):
        self.seen.append(window)
        return _FakeAdapter() if window.get("supported") else None


class _GuardedBuffer(io.BytesIO):
    def __init__(self, payload: bytes, max_read_size: int) -> None:
        super().__init__(payload)
        self.max_read_size = max_read_size
        self.read_sizes: list[int] = []

    def read(self, size: int = -1) -> bytes:
        if size < 0 or size > self.max_read_size:
            raise AssertionError("bridge attempted an unbounded binary read")
        self.read_sizes.append(size)
        return super().read(size)


class _GuardedStdin:
    def __init__(self, payload: bytes, max_read_size: int) -> None:
        self.buffer = _GuardedBuffer(payload, max_read_size)

    def read(self, _size: int = -1) -> str:
        raise AssertionError("bridge attempted an unbounded text read")


def test_chinese_undo_commands() -> None:
    assert _wants_undo("撤回上次修改")
    assert _wants_undo("请还原刚才那一步")
    assert not _wants_undo("解释这段")


def test_reference_label_command_returns_deterministic_binding_receipt() -> None:
    result = _reference_label_response({
        "command": "这是 A",
        "selectionSessionId": "selection-a",
        "interactionEpisode": {
            "version": 1,
            "episodeId": "episode-abc",
            "labels": {"A": "object-a"},
            "slots": {
                "this": {"objectId": "object-a", "referenceLabel": "A", "label": "Header"},
                "these": [{"objectId": "object-a", "referenceLabel": "A"}],
            },
        },
    })

    assert result is not None and result["ok"] is True
    assert result["intentKind"] == "reference_label_bound"
    assert result["referenceLabel"] == "A"
    assert result["objectId"] == "object-a"
    assert result["boundLabels"] == ["A"]
    assert result["actionProposals"] == []


def test_target_context_never_scans_past_foreground(monkeypatch) -> None:
    registry = _FakeRegistry()
    monkeypatch.setattr("scripts.selection_bridge.default_adapter_registry", lambda: registry)
    foreground = {"title": "Browser", "supported": False}
    background_word = {"title": "Document - Word", "supported": True}
    target, context = _read_target_context([foreground, background_word], "解释这段")
    assert target == foreground
    assert context is None
    assert registry.seen == [foreground]


def test_snapshot_context_is_consumed_without_live_window_lookup(monkeypatch) -> None:
    monkeypatch.setattr(
        "scripts.selection_bridge._window_dicts",
        lambda: (_ for _ in ()).throw(AssertionError("must not scan live windows")),
    )
    expires_at = (datetime.now(timezone.utc) + timedelta(minutes=1)).isoformat()
    payload = {
        "selectionSnapshot": {
            "snapshot_id": "snapshot-1",
            "expires_at": expires_at,
            "source_window": {"title": "doc.docx - Word", "hwnd": 123},
            "context": {
                "adapter": "office",
                "app": "word",
                "window": {"title": "doc.docx - Word", "hwnd": 123},
                "content": "Selected text",
                "label": "doc.docx",
                "method": "com:word.selection",
                "capabilities": [],
                "artifacts": {"selection_start": 1, "selection_end": 14},
                "error": None,
            },
        }
    }
    window, context, snapshot, error = _context_from_snapshot(payload)
    assert error is None
    assert window["hwnd"] == 123
    assert context.content == "Selected text"
    assert snapshot["snapshot_id"] == "snapshot-1"


def test_fabric_object_keeps_snapshot_perception_provenance() -> None:
    snapshot = {
        "snapshot_id": "snapshot-perception",
        "source_kind": "screen_region",
        "selection_bbox": [10, 20, 30, 40],
        "capture_path": r"D:\capture.png",
        "perception_trace": {
            "schemaVersion": 1,
            "selectedLayer": "screen_region",
            "selectedMethod": "pointer:bounded-screen-region",
            "pixelFallbackUsed": True,
            "fallbackReason": "structured_context_unavailable",
            "attempts": [],
        },
    }
    objects = selection_bridge._fabric_objects(
        {"command": "解释这个"},
        {"title": "Canvas", "hwnd": 8, "pid": 9},
        None,
        snapshot,
    )

    assert objects[0]["source"]["perceptionTrace"]["selectedLayer"] == "screen_region"


def test_fabric_object_keeps_structured_terminal_evidence() -> None:
    context = AdapterReadContext(
        adapter="uia_text_selection",
        app="terminal",
        window={"title": "PowerShell", "hwnd": 8},
        content="Error: broken\nProcess exited with code 7",
        method="uia:terminal-text-pattern",
        artifacts={
            "terminal_evidence": {
                "schemaVersion": 1,
                "state": "resolved",
                "method": "uia:terminal-text-pattern",
                "command": "python verify.py",
                "exitCode": 7,
                "anchor": {"line": 2, "text": "Error: broken"},
                "window": {"startLine": 1, "endLine": 3, "lineCount": 3, "text": "Error: broken"},
                "pixelFallbackUsed": False,
                "uncertainty": [],
            },
        },
    )
    objects = selection_bridge._fabric_objects(
        {"command": "fix this error"},
        {"title": "PowerShell", "hwnd": 8, "pid": 9},
        context,
        {"snapshot_id": "terminal-1", "source_kind": "native_selection"},
    )

    assert objects[0]["source"]["terminalEvidence"]["exitCode"] == 7


def test_fabric_object_keeps_structured_browser_devtools_evidence() -> None:
    browser_context = {
        "schemaVersion": 1,
        "state": "resolved",
        "method": "cdp:dom-point",
        "page": {"title": "Checkout", "url": "https://example.test/checkout"},
        "node": {"tag": "button", "role": "button", "accessibleName": "Retry", "text": "Retry"},
        "selector": "#retry-payment",
        "coordinates": {"pointerScreenPhysical": {"x": 640, "y": 520}},
        "networkFailures": [{"url": "https://api.example.test/pay", "errorText": "net::ERR_FAILED", "source": "devtools_log"}],
        "provenance": {"structural": True},
    }
    context = AdapterReadContext(
        adapter="browser_devtools",
        app="browser",
        window={"title": "Checkout", "hwnd": 8},
        content="Retry",
        method="cdp:dom-point",
        artifacts={"browser_context": browser_context},
    )
    objects = selection_bridge._fabric_objects(
        {"command": "fix this browser issue"},
        {"title": "Checkout", "hwnd": 8, "pid": 9},
        context,
        {"snapshot_id": "browser-1", "source_kind": "native_selection"},
    )

    assert objects[0]["source"]["browserContext"]["selector"] == "#retry-payment"


def test_expired_snapshot_fails_closed() -> None:
    expires_at = (datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat()
    _, context, _, error = _context_from_snapshot({
        "selectionSnapshot": {
            "snapshot_id": "expired",
            "expires_at": expires_at,
            "source_window": {"title": "doc.docx - Word"},
            "context": None,
        }
    })
    assert context is None
    assert error == "selection snapshot expired"


def test_interaction_episode_context_exposes_only_bound_slots() -> None:
    text = _interaction_episode_context({
        "version": 1,
        "episodeId": "episode-1",
        "slots": {
            "this": {"objectId": "selection:b", "label": "B", "content": "Beta"},
            "that": {"objectId": "selection:a", "label": "A", "content": "Alpha"},
            "these": [
                {"objectId": "selection:a", "label": "A", "content": "Alpha"},
                {"objectId": "selection:b", "label": "B", "content": "Beta"},
            ],
            "here": {"objectId": "selection:d", "label": "Draft", "app": "word"},
        },
    })
    assert "Interaction episode v1" in text
    assert "THIS" in text and "THAT" in text and "THESE[1]" in text and "HERE" in text
    assert "Alpha" in text and "Beta" in text
    assert "global history" in text


def test_shopping_list_response_is_local_typed_action() -> None:
    expires_at = (datetime.now(timezone.utc) + timedelta(minutes=1)).isoformat()
    payload = {
        "command": "Add this",
        "selectionSessionId": "session-1",
        "selectionSnapshot": {
            "snapshot_id": "snapshot-1",
            "expires_at": expires_at,
            "source_window": {"title": "Recipe.pdf - Microsoft Edge", "hwnd": 123},
            "context": {
                "adapter": "uia_text_selection",
                "app": "pdf",
                "window": {"title": "Recipe.pdf - Microsoft Edge", "hwnd": 123},
                "content": "1 lb Spaghetti",
                "label": "Recipe.pdf",
                "method": "uia:text-pattern.selection",
                "capabilities": [],
                "artifacts": {},
                "error": None,
            },
        },
    }
    target, app_ctx, snapshot, error = _context_from_snapshot(payload)
    assert error is None
    output = _shopping_list_response(payload, target, app_ctx, snapshot)
    assert output is not None
    assert output["ok"] is True
    assert output["intentKind"] == "shopping_list_add"
    assert output["answer"] == "正在加入购物清单…"
    assert output["autoExecuteProposalId"] == output["actionProposals"][0]["id"]
    assert output["actionProposals"][0]["action_type"] == "shopping_list_add"
    assert output["selectionSnapshotId"] == "snapshot-1"

    assert _shopping_list_response({**payload, "command": "Explain this"}, target, app_ctx, snapshot) is None


def test_calendar_response_opens_reviewable_draft_without_action() -> None:
    expires_at = (datetime.now(timezone.utc) + timedelta(minutes=1)).isoformat()
    payload = {
        "command": "添加到日历",
        "selectionSessionId": "session-calendar",
        "selectionSnapshot": {
            "snapshot_id": "snapshot-calendar",
            "expires_at": expires_at,
            "source_window": {"title": "活动.pdf - Microsoft Edge", "hwnd": 123},
            "context": {
                "adapter": "uia_text_selection",
                "app": "pdf",
                "window": {"title": "活动.pdf - Microsoft Edge", "hwnd": 123},
                "content": "设计评审\n2026年7月20日 10:00-11:00\n地点：A 会议室",
                "label": "活动.pdf",
                "method": "uia:text-pattern.selection",
                "capabilities": [],
                "artifacts": {},
                "error": None,
            },
        },
    }
    target, app_ctx, snapshot, error = _context_from_snapshot(payload)
    assert error is None
    output = _calendar_response(payload, target, app_ctx, snapshot)
    assert output["intentKind"] == "calendar_event_draft"
    assert output["calendarDraft"]["event"]["title"] == "设计评审"
    assert output["actionProposals"] == []


def test_route_response_uses_bound_episode_without_model_action() -> None:
    output = _route_response({
        "command": "规划路线",
        "selectionSessionId": "session-route",
        "interactionEpisode": {
            "episodeId": "episode-route",
            "slots": {
                "that": {"objectId": "a", "content": "上海博物馆"},
                "this": {"objectId": "b", "content": "上海虹桥站"},
                "these": [],
            },
        },
    })
    assert output["ok"] is True
    assert output["intentKind"] == "route_draft"
    assert output["routeDraft"]["origin"] == "上海博物馆"
    assert output["routeDraft"]["destination"] == "上海虹桥站"
    assert output["actionProposals"] == []


def test_selection_bridge_source_has_no_question_mark_corruption() -> None:
    source = (Path(__file__).resolve().parents[1] / "scripts" / "selection_bridge.py").read_text(encoding="utf-8")
    assert "????????" not in source


def test_bridges_accept_utf8_bom(monkeypatch) -> None:
    payload = '\ufeff{"command":"explain"}'
    monkeypatch.setattr(selection_bridge.sys, "stdin", io.StringIO(payload))
    assert selection_bridge.read_payload()["command"] == "explain"
    monkeypatch.setattr(action_bridge.sys, "stdin", io.StringIO(payload))
    assert action_bridge.read_payload()["command"] == "explain"
    monkeypatch.setattr(electron_bridge.sys, "stdin", io.StringIO(payload))
    assert electron_bridge._read_payload()["command"] == "explain"


@pytest.mark.parametrize(
    "reader",
    [selection_bridge.read_payload, electron_bridge._read_payload],
    ids=["selection", "electron"],
)
def test_reviewed_bridges_reject_oversized_utf8_payload_with_bounded_read(
    monkeypatch,
    reader,
) -> None:
    max_payload_bytes = 64 * 1024
    encoded = b'{"command":"' + ("\u754c" * max_payload_bytes).encode("utf-8") + b'"}'

    stdin = _GuardedStdin(encoded, max_payload_bytes + 1)
    monkeypatch.setattr(selection_bridge.sys, "stdin", stdin)

    with pytest.raises(ValueError, match="65536 UTF-8 bytes"):
        reader()

    assert stdin.buffer.tell() == len(encoded)
    assert max(stdin.buffer.read_sizes) <= max_payload_bytes + 1


@pytest.mark.parametrize(
    "bridge",
    [selection_bridge, electron_bridge],
    ids=["selection", "electron"],
)
def test_reviewed_bridge_main_reports_payload_limit_without_processing(
    monkeypatch,
    capsys,
    bridge,
) -> None:
    max_payload_bytes = 64 * 1024
    encoded = b'{"command":"' + ("\u754c" * max_payload_bytes).encode("utf-8") + b'"}'

    stdin = _GuardedStdin(encoded, max_payload_bytes + 1)
    monkeypatch.setattr(bridge.sys, "stdin", stdin)
    if bridge is selection_bridge:
        monkeypatch.setattr(bridge, "_configure_stdio", lambda: None)

    assert bridge.main() == 2
    assert json.loads(capsys.readouterr().out) == {
        "ok": False,
        "error": "payload_too_large",
        "maxPayloadBytes": max_payload_bytes,
    }
    assert stdin.buffer.tell() == len(encoded)
    assert max(stdin.buffer.read_sizes) <= max_payload_bytes + 1


def test_crop_roi_for_ocr_crops_selection_bbox_with_padding(tmp_path) -> None:
    from PIL import Image, ImageDraw

    capture = tmp_path / "screen.png"
    image = Image.new("RGB", (100, 100), "white")
    draw = ImageDraw.Draw(image)
    draw.rectangle((10, 10, 30, 30), fill="black")  # outside ROI
    draw.rectangle((40, 40, 60, 60), fill="black")  # inside ROI
    image.save(capture)

    roi = _crop_roi_for_ocr(capture, [40, 40, 20, 20], [0, 0, 100, 100], padding=4)
    assert roi is not None
    try:
        with Image.open(roi) as cropped:
            assert cropped.size == (28, 28)
    finally:
        roi.unlink(missing_ok=True)


def test_crop_roi_for_ocr_returns_none_without_geometry(tmp_path) -> None:
    capture = tmp_path / "screen.png"
    capture.write_bytes(b"not-an-image")
    assert _crop_roi_for_ocr(capture, None, [0, 0, 100, 100]) is None
    assert _crop_roi_for_ocr(capture, [10, 10, 20, 20], None) is None


def test_screen_region_enrich_uses_selection_roi_for_ocr(monkeypatch, tmp_path) -> None:
    from PIL import Image

    capture = tmp_path / "screen.png"
    Image.new("RGB", (200, 200), "white").save(capture)
    seen_paths = []
    monkeypatch.setattr(
        selection_bridge,
        "_read_local_ocr",
        lambda path: seen_paths.append(Path(path)) or ("ROI TEXT", "test-ocr"),
    )

    context = _enrich_screen_region_context(
        {"title": "WeChat"},
        None,
        {
            "source_kind": "screen_region",
            "capture_path": str(capture),
            "selection_bbox": [50, 60, 40, 20],
            "capture_bbox": [0, 0, 200, 200],
        },
    )

    assert context is not None
    assert context.content == "ROI TEXT"
    assert context.artifacts["ocr_roi_applied"] is True
    assert context.artifacts["ocr_roi_bbox"] == [50, 60, 40, 20]
    assert len(seen_paths) == 1
    assert seen_paths[0].name.startswith("screen-roi-")
    assert seen_paths[0].parent == capture.parent


def test_screen_region_enrich_falls_back_to_full_capture_without_selection_bbox(monkeypatch, tmp_path) -> None:
    capture = tmp_path / "screen.png"
    capture.write_bytes(b"png-bytes")
    seen = []
    monkeypatch.setattr(
        selection_bridge,
        "_read_local_ocr",
        lambda path: seen.append(Path(path)) or ("FULL TEXT", "test-ocr"),
    )

    context = _enrich_screen_region_context(
        {"title": "WeChat"},
        None,
        {"source_kind": "screen_region", "capture_path": str(capture)},
    )

    assert context is not None
    assert context.artifacts.get("ocr_roi_applied") is False
    assert seen == [capture]
