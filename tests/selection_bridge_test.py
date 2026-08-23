from __future__ import annotations

import io
import inspect
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import app.perception.pixel_ocr as pixel_ocr
import scripts.action_bridge as action_bridge
import scripts.electron_bridge as electron_bridge
import scripts.selection_bridge as selection_bridge
from app.adapters.base import AdapterReadContext
from scripts.selection_bridge import (
    _calendar_response,
    _crop_roi_for_ocr,
    _route_response,
    _context_from_snapshot,
    _fuse_pixel_tier,
    _interaction_episode_context,
    _exact_readback_response,
    _reference_label_response,
    _read_target_context,
    _shopping_list_response,
    _wants_undo,
)


def _enrich_screen_region_context(target_window, app_ctx, snapshot):
    """The pixel tier as the answer stage runs it, without the fused trace."""
    context, _trace = _fuse_pixel_tier(target_window, app_ctx, snapshot)
    return context


def test_selection_bridge_wires_local_model_transform(monkeypatch) -> None:
    """Review R3: the production bridge must wire the local text model into
    FabricEngine so model.text recipes never fall back to agent.task."""
    captured = {}

    def fake_ask(
        user_prompt,
        context_text=None,
        system_prompt=None,
        *,
        timeout_s,
        attempts,
        max_tokens=None,
    ):
        captured["prompt"] = user_prompt
        captured["context"] = context_text
        captured["timeout"] = timeout_s
        captured["attempts"] = attempts
        return "本地模型的结果"

    monkeypatch.setattr(selection_bridge, "ask_text_model", fake_ask)
    answer = selection_bridge._local_model_transform(
        "总结成三点", "长文本内容", "text.summarize_route"
    )
    assert answer == "本地模型的结果"
    assert captured["prompt"] == "总结成三点"
    assert captured["context"] == "长文本内容"
    assert captured["timeout"] == selection_bridge.GENERAL_TIMEOUT_S
    assert captured["attempts"] == 1


def test_selection_bridge_engine_constructions_carry_transform() -> None:
    source = Path("scripts/selection_bridge.py").read_text(encoding="utf-8")
    assert source.count("FabricEngine(model_transform=_local_model_transform)") >= 2


def test_explorer_file_question_reads_the_actual_file_body(tmp_path) -> None:
    selected_file = tmp_path / "CHANGELOG.md"
    sentinel = "SENTINEL: release 9 removes the retired preview pipeline."
    selected_file.write_text(f"# Changes\n\n{sentinel}\n", encoding="utf-8")
    app_ctx = AdapterReadContext(
        adapter="explorer_file",
        app="explorer",
        content="",
        label=selected_file.name,
        method="explorer:test",
        artifacts={
            "local_file": {"path": str(selected_file), "kind": "file"},
        },
    )
    snapshot = {"context": app_ctx.to_dict()}
    enrich = getattr(
        selection_bridge,
        "_enrich_local_file_context",
        lambda _command, context, _snapshot: context,
    )

    enriched = enrich("这个文件是干嘛的", app_ctx, snapshot)

    assert sentinel in str(enriched.content or "")
    assert enriched.artifacts["local_file_context"]["path"] == str(selected_file)


def test_explorer_image_question_sends_the_original_file_to_vision(monkeypatch, tmp_path) -> None:
    image_file = tmp_path / "reference.png"
    image_file.write_bytes(b"original-image-file")
    app_ctx = AdapterReadContext(
        adapter="explorer_file",
        app="explorer",
        content="",
        label=image_file.name,
        method="explorer:test",
        artifacts={
            "local_file": {"path": str(image_file), "kind": "file"},
        },
    )
    seen = {}
    monkeypatch.setattr(
        selection_bridge,
        "ask_vision_model",
        lambda image, prompt, context_text=None, **_kwargs: seen.update({
            "image": Path(image), "prompt": prompt, "context": context_text,
        }) or "vision answer",
    )

    answer = selection_bridge._local_image_file_answer(
        "看懂这张图",
        app_ctx,
        {"context": app_ctx.to_dict()},
    )

    assert answer == "vision answer"
    assert seen["image"] == image_file


def test_screen_region_snapshot_is_enriched_with_local_ocr(monkeypatch, tmp_path) -> None:
    capture = tmp_path / "screen.png"
    capture.write_bytes(b"not-a-real-png-for-the-injected-reader")
    monkeypatch.setattr(
        pixel_ocr,
        "read_ocr_blocks",
        lambda path, strokes_local=None, selection_local=None: ([{"text": "Magic Pointer 1.0.0", "rect": None, "conf": None}], "test-ocr"),
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
    assert context.artifacts["ocr_full_screen"] is True


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
        pixel_ocr,
        "read_ocr_blocks",
        lambda path, strokes_local=None, selection_local=None: ([{"text": "Magic Pointer 1.0.0", "rect": None, "conf": None}], "test-ocr"),
    )

    context = _enrich_screen_region_context(
        {"title": "Magic Pointer"},
        original,
        {"source_kind": "screen_region", "capture_path": str(capture)},
    )

    assert context is not original
    assert context.content == "Magic Pointer 1.0.0"


def test_episode_screen_objects_are_locally_read_before_a_two_object_question(monkeypatch, tmp_path) -> None:
    previous = tmp_path / "previous.png"
    current = tmp_path / "current.png"
    previous.write_bytes(b"previous")
    current.write_bytes(b"current")
    payload = {
        "interactionEpisode": {
            "schemaVersion": 1,
            "episodeId": "episode-1",
            "slots": {
                "this": {"objectId": "current", "kind": "screen_region", "content": "", "source": {"path": str(current)}},
                "that": {"objectId": "previous", "kind": "screen_region", "content": "", "source": {"path": str(previous)}},
                "these": [],
                "here": None,
            },
        },
    }
    monkeypatch.setattr(
        pixel_ocr,
        "read_ocr_blocks",
        lambda path, strokes_local=None, selection_local=None: (
            [{"text": "上一处的真实文字", "rect": [1, 1, 100, 20], "conf": 0.9}],
            "test-ocr",
        ),
    )

    selection_bridge._enrich_interaction_episode_ocr(
        payload,
        AdapterReadContext(adapter="local_ocr", app="screen", content="当前处的真实文字"),
    )

    slots = payload["interactionEpisode"]["slots"]
    assert slots["this"]["content"] == "当前处的真实文字"
    assert slots["that"]["content"] == "上一处的真实文字"
    assert slots["that"]["contentMethod"] == "local:test-ocr"
    context_text = selection_bridge._interaction_episode_context(payload["interactionEpisode"])
    assert "THIS_content" in context_text and "当前处的真实文字" in context_text
    assert "THAT_content" in context_text and "上一处的真实文字" in context_text


def test_exact_readback_question_returns_grounded_text_without_a_model_call() -> None:
    context = AdapterReadContext(
        adapter="local_ocr",
        app="screen",
        content="alpha line: structural grounding should stay on this exact line",
        method="local:rapidocr-onnx",
    )

    response = _exact_readback_response(
        {"command": "What exact line did I mark? Answer only that line."},
        context,
        {"snapshot_id": "selection-1"},
    )

    assert response is not None
    assert response["answer"] == context.content
    assert response["route"] == {"tier": "L0", "reason": "exact_grounded_readback"}
    assert response["actionProposals"] == []


def test_exact_readback_hides_internal_multi_segment_labels() -> None:
    context = AdapterReadContext(
        adapter="local_ocr",
        app="screen",
        content=(
            "[segment 1] alpha line: structural grounding should stay exact\n"
            "[segment 2] delta line: waiting feedback must remain cancellable"
        ),
        method="local:rapidocr-onnx",
    )

    response = _exact_readback_response(
        {"command": "Read only the marked text"},
        context,
        {"snapshot_id": "selection-multi"},
    )

    assert response is not None
    assert response["answer"] == (
        "alpha line: structural grounding should stay exact\n"
        "delta line: waiting feedback must remain cancellable"
    )


def test_exact_readback_does_not_hijack_questions_that_need_reasoning() -> None:
    context = AdapterReadContext(adapter="local_ocr", app="screen", content="Error 0x80070005")
    assert _exact_readback_response(
        {"command": "Why did this error happen?"}, context, {"snapshot_id": "selection-1"}
    ) is None


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


def test_screen_region_enrich_filters_full_screen_ocr_by_selection_bbox(monkeypatch, tmp_path) -> None:
    capture = tmp_path / "screen.png"
    capture.write_bytes(b"png-bytes")
    seen_paths = []
    blocks = [
        {"text": "side bar menu text", "rect": [10, 10, 120, 24], "conf": 0.9},
        {"text": "marked chat line", "rect": [60, 62, 180, 26], "conf": 0.9},
        {"text": "unrelated lower row", "rect": [10, 200, 120, 24], "conf": 0.9},
    ]
    monkeypatch.setattr(
        pixel_ocr,
        "read_ocr_blocks",
        lambda path, strokes_local=None, selection_local=None: seen_paths.append(Path(path)) or (list(blocks), "test-ocr"),
    )

    context = _enrich_screen_region_context(
        {"title": "WeChat"},
        None,
        {
            "source_kind": "screen_region",
            "capture_path": str(capture),
            "capture_bbox": [0, 0, 320, 240],
            "selection_bbox": [50, 60, 200, 30],
        },
    )

    assert context is not None
    assert context.content == "marked chat line"
    assert context.artifacts["ocr_full_screen"] is True
    assert context.artifacts["ocr_block_count_total"] == 3
    assert context.artifacts["ocr_block_count_selected"] == 1
    assert len(seen_paths) == 1
    assert seen_paths[0] == capture


def test_legacy_bounded_crop_without_coordinate_mapping_is_not_filtered_by_screen_bbox(monkeypatch, tmp_path) -> None:
    capture = tmp_path / "screen.png"
    capture.write_bytes(b"png-bytes")
    monkeypatch.setattr(
        pixel_ocr,
        "read_ocr_blocks",
        lambda path, strokes_local=None, selection_local=None: (
            [{"text": "有界截图里的真实文字", "rect": [10, 20, 180, 24], "conf": 0.9}],
            "test-ocr",
        ),
    )

    context = _enrich_screen_region_context(
        {"title": "Self-drawn app"},
        None,
        {
            "source_kind": "screen_region",
            "capture_path": str(capture),
            "selection_bbox": [872, 489, 16, 16],
            # Old/public episode objects did not retain capture_bbox. The OCR
            # box above is crop-local, so comparing it to screen coordinates
            # would incorrectly erase the only grounded text.
        },
    )

    assert context is not None
    assert context.content == "有界截图里的真实文字"


def test_ocr_touching_bounded_crop_edge_is_marked_incomplete(monkeypatch, tmp_path) -> None:
    from PIL import Image

    capture = tmp_path / "screen.png"
    Image.new("RGB", (320, 180), "white").save(capture)
    monkeypatch.setattr(
        pixel_ocr,
        "read_ocr_blocks",
        lambda path, strokes_local=None, selection_local=None: (
            [{"text": "包进文件夹了，所", "rect": [6, 136, 302, 32], "conf": 0.9}],
            "test-ocr",
        ),
    )

    context = _enrich_screen_region_context(
        {"title": "Self-drawn app"}, None,
        {"source_kind": "screen_region", "capture_path": str(capture)},
    )

    assert context is not None
    assert context.artifacts["ocr_edge_clipped"] is True
    assert context.artifacts["ocr_capture_size"] == [320, 180]


def test_clipped_two_object_comparison_refuses_to_invent_missing_text() -> None:
    payload = {
        "command": "对比下",
        "interactionEpisode": {
            "schemaVersion": 1,
            "slots": {
                "this": {"objectId": "a", "content": "包进文件夹了，所", "contentClipped": True},
                "that": {"objectId": "b", "content": "两个地方仍需外网", "contentClipped": True},
                "these": [],
                "here": None,
            },
        },
    }

    answer = selection_bridge._clipped_multi_object_answer(payload)

    assert answer is not None
    assert "不能可靠比较" in answer
    assert "包进文件夹了，所" in answer
    assert "两个地方仍需外网" in answer
    assert "不会用残句补猜" in answer


def test_screen_region_enrich_falls_back_to_full_capture_without_selection_bbox(monkeypatch, tmp_path) -> None:
    capture = tmp_path / "screen.png"
    capture.write_bytes(b"png-bytes")
    seen = []
    monkeypatch.setattr(
        pixel_ocr,
        "read_ocr_blocks",
        lambda path, strokes_local=None, selection_local=None: seen.append(Path(path)) or ([{"text": "FULL TEXT", "rect": None, "conf": None}], "test-ocr"),
    )

    context = _enrich_screen_region_context(
        {"title": "WeChat"},
        None,
        {"source_kind": "screen_region", "capture_path": str(capture)},
    )

    assert context is not None
    assert context.content == "FULL TEXT"
    assert context.artifacts.get("ocr_full_screen") is True
    assert context.artifacts.get("ocr_block_count_selected") == 1
    assert seen == [capture]


def test_screen_region_enrich_uses_stroke_collision_not_union_bbox(monkeypatch, tmp_path) -> None:
    capture = tmp_path / "screen.png"
    capture.write_bytes(b"png-bytes")
    blocks = [
        {"text": "李明瑄", "rect": [120, 100, 80, 26], "conf": 0.9},      # thumbnail text, not crossed
        {"text": "first marked sentence", "rect": [100, 300, 300, 26], "conf": 0.9},
        {"text": "unrelated middle paragraph", "rect": [100, 340, 300, 26], "conf": 0.9},
        {"text": "second marked sentence", "rect": [100, 500, 300, 26], "conf": 0.9},
    ]
    monkeypatch.setattr(
        pixel_ocr,
        "read_ocr_blocks",
        lambda path, strokes_local=None, selection_local=None: (list(blocks), "test-ocr"),
    )
    gesture = {
        "schemaVersion": 2,
        "coordinateSpace": "physical_screen_pixels",
        "bbox": {"x": 100, "y": 300, "width": 300, "height": 226},  # union is huge
        "strokes": [
            {"points": [{"x": 100, "y": 308}, {"x": 300, "y": 310}, {"x": 400, "y": 308}]},
            {"points": [{"x": 100, "y": 508}, {"x": 250, "y": 510}, {"x": 400, "y": 508}]},
        ],
    }
    context = _enrich_screen_region_context(
        {"title": "WeChat"},
        None,
        {
            "source_kind": "screen_region",
            "capture_path": str(capture),
            "selection_bbox": [100, 300, 300, 226],
            "selection_gesture": gesture,
        },
    )

    assert context is not None
    assert context.content == "[segment 1] first marked sentence\n[segment 2] second marked sentence"
    assert "李明瑄" not in context.content
    assert "unrelated middle paragraph" not in context.content
    assert context.artifacts["ocr_stroke_filter"] is True
    assert context.artifacts["ocr_segment_count"] == 2
    assert context.artifacts["ocr_block_count_selected"] == 2


def test_underline_between_rows_belongs_only_to_the_row_above(monkeypatch, tmp_path) -> None:
    capture = tmp_path / "screen.png"
    capture.write_bytes(b"png-bytes")
    blocks = [
        {"text": "alpha line: structural", "rect": [32, 58, 290, 30], "conf": 0.9},
        {"text": "grounding should stay exact", "rect": [316, 58, 516, 32], "conf": 0.9},
        {"text": "beta line", "rect": [32, 98, 810, 30], "conf": 0.9},
    ]
    monkeypatch.setattr(
        pixel_ocr,
        "read_ocr_blocks",
        lambda path, strokes_local=None, selection_local=None: (list(blocks), "test-ocr"),
    )
    gesture = {
        "schemaVersion": 2,
        "coordinateSpace": "physical_screen_pixels",
        "bbox": {"x": 32, "y": 82, "width": 800, "height": 16},
        "strokes": [{"points": [{"x": 32, "y": 90}, {"x": 832, "y": 90}]}],
    }

    context = _enrich_screen_region_context(
        {"title": "Notepad"},
        None,
        {
            "source_kind": "screen_region",
            "capture_path": str(capture),
            "selection_bbox": [32, 82, 800, 16],
            "selection_gesture": gesture,
        },
    )

    assert context is not None
    assert context.content == "alpha line: structural grounding should stay exact"
    assert context.artifacts["ocr_block_count_selected"] == 2


def test_enclosed_loop_collects_all_blocks_in_region_not_just_crossed_lines(monkeypatch, tmp_path) -> None:
    capture = tmp_path / "screen.png"
    capture.write_bytes(b"png-bytes")
    blocks = [
        {"text": "first line", "rect": [100, 100, 300, 26], "conf": 0.9},
        {"text": "middle nested line that used to vanish", "rect": [120, 140, 340, 26], "conf": 0.9},
        {"text": "third line", "rect": [100, 180, 300, 26], "conf": 0.9},
        {"text": "outside unrelated", "rect": [800, 800, 200, 26], "conf": 0.9},
    ]
    monkeypatch.setattr(
        pixel_ocr,
        "read_ocr_blocks",
        lambda path, strokes_local=None, selection_local=None: (list(blocks), "test-ocr"),
    )
    # A closed loop around the first three lines (first point near last point).
    gesture = {
        "schemaVersion": 2,
        "coordinateSpace": "physical_screen_pixels",
        "bbox": {"x": 100, "y": 100, "width": 360, "height": 106},
        "strokes": [
            {"points": [
                {"x": 100, "y": 100}, {"x": 460, "y": 102}, {"x": 462, "y": 206},
                {"x": 98, "y": 204}, {"x": 100, "y": 100},
            ]},
        ],
    }
    context = _enrich_screen_region_context(
        {"title": "X/Twitter"},
        None,
        {
            "source_kind": "screen_region",
            "capture_path": str(capture),
            "selection_bbox": [100, 100, 360, 106],
            "selection_gesture": gesture,
        },
    )
    assert context is not None
    assert "middle nested line that used to vanish" in context.content
    assert "first line" in context.content
    assert "third line" in context.content
    assert "outside unrelated" not in context.content


def test_open_stroke_blocks_are_sorted_in_reading_order(monkeypatch, tmp_path) -> None:
    capture = tmp_path / "screen.png"
    capture.write_bytes(b"png-bytes")
    blocks = [
        {"text": "line B bottom", "rect": [100, 500, 300, 26], "conf": 0.9},
        {"text": "line A top", "rect": [100, 100, 300, 26], "conf": 0.9},
        {"text": "line A right", "rect": [420, 100, 200, 26], "conf": 0.9},
    ]
    monkeypatch.setattr(
        pixel_ocr,
        "read_ocr_blocks",
        lambda path, strokes_local=None, selection_local=None: (list(blocks), "test-ocr"),
    )
    # Two open underline strokes crossing both rows.
    gesture = {
        "schemaVersion": 2,
        "coordinateSpace": "physical_screen_pixels",
        "bbox": {"x": 100, "y": 100, "width": 520, "height": 426},
        "strokes": [
            {"points": [{"x": 100, "y": 108}, {"x": 620, "y": 108}]},
            {"points": [{"x": 100, "y": 508}, {"x": 620, "y": 508}]},
        ],
    }
    context = _enrich_screen_region_context(
        {"title": "X/Twitter"},
        None,
        {
            "source_kind": "screen_region",
            "capture_path": str(capture),
            "selection_bbox": [100, 100, 520, 426],
            "selection_gesture": gesture,
        },
    )
    assert context is not None
    top = context.content.find("line A")
    bottom = context.content.find("line B")
    assert top != -1 and bottom != -1 and top < bottom


# ── 回答形态判定：deliver（要发出去）────────────────────────────────
def test_deliver_request_detection() -> None:
    from scripts.selection_bridge import _is_deliver_request

    for command in ('帮我回复一下', '这段话润色一下', '改写得客气点', '语气委婉一点', '扩写这段', '帮我写一段回信'):
        assert _is_deliver_request(command), f'{command} 应判 deliver'
    for command in ('这是什么', '解释一下', '为什么会这样', '帮我画一张图', '总结这段'):
        assert not _is_deliver_request(command), f'{command} 不应判 deliver'


def test_deliver_system_prompt_forbids_markdown() -> None:
    from scripts.selection_bridge import DELIVER_SYSTEM_PROMPT

    assert 'markdown' in DELIVER_SYSTEM_PROMPT
    assert '纯文字' in DELIVER_SYSTEM_PROMPT


# ── 自动记忆（Vida 式主动层）：敏感挡、去重、非敏感记 ──────────────
def test_record_auto_memory_sensitive_and_dedupe(tmp_path, monkeypatch) -> None:
    import json

    from app.adapters.base import AdapterReadContext
    from scripts.selection_bridge import _record_auto_memory

    monkeypatch.setenv('MAGIC_POINTER_USER_DATA_DIR', str(tmp_path))
    ctx = AdapterReadContext(adapter='uia', app='Weixin.exe', method='selection', content='x', window={'title': '微信'})
    _record_auto_memory('这段代码在干嘛', ctx, {'title': '微信'}, '这是超时逻辑。', enabled=False)
    assert not (tmp_path / 'screen-memory.json').exists(), '未明确开启时不得自动记忆'
    _record_auto_memory('这段代码在干嘛', ctx, {'title': '微信'}, '这是超时逻辑。', enabled=True)
    _record_auto_memory('这段代码在干嘛', ctx, {'title': '微信'}, '这是超时逻辑。', enabled=True)  # 去重
    _record_auto_memory('帮我查一下密码是什么', ctx, {'title': '微信'}, '密码是 abc', enabled=True)  # 敏感挡
    data = json.loads((tmp_path / 'screen-memory.json').read_text(encoding='utf-8'))
    entries = data['entries']
    assert len(entries) == 1, f'期望 1 条（去重+敏感挡），实际 {len(entries)}'
    assert entries[0]['excerpt'] == '这段代码在干嘛'

# --- Batch-4 loop answer path (MAGIC_POINTER_LOOP_ANSWER gate) -----------------


def _fake_terminal(reason_value="completed", message="循环答案", local_action=None):
    from app.agent_runtime.types import Terminal, TransitionReason

    return Terminal(
        reason=TransitionReason(reason_value),
        message=message,
        turns=1,
        results=(),
        local_action=local_action,
    )


def test_loop_router_maps_terminal_to_answer(monkeypatch):
    from app.agent_runtime.tool_registry import Effect
    from app.fabric import engine as engine_module

    recorded = {}

    def fake_run(user_input, objects=None, registry=None, *, client, **kwargs):
        recorded["input"] = user_input
        recorded["objects"] = objects
        recorded["allowed"] = kwargs.get("allowed_effects")
        recorded["evidence"] = kwargs.get("evidence_input")
        recorded["local_action_input"] = kwargs.get("local_action_input")
        recorded["keepalive"] = kwargs.get("keepalive")
        recorded["todo_store"] = kwargs.get("todo_store")
        return _fake_terminal(message="循环给出的回答")

    monkeypatch.setattr(engine_module, "run_agent_turn", fake_run)

    clock = selection_bridge.PhaseClock("test", enabled=False)
    result = selection_bridge._loop_router(
        "帮我看看", [{"id": "o1"}], None, None, None, None, "sess-1", "snap-1",
        clock=clock,
    )

    assert recorded["input"] == "帮我看看"
    # The evidence block travels as a separate origin=data message, never
    # inside the instruction channel (invariant ⑤).
    assert recorded["evidence"] and "[本次圈选对象证据]" in recorded["evidence"]
    assert "帮我看看" not in (recorded["evidence"] or "")
    assert recorded["local_action_input"] == "帮我看看"
    assert recorded["objects"] == [{"id": "o1"}]
    assert recorded["allowed"] == tuple(Effect)
    # Stage path rides the same idle-deadline heartbeat + partial delivery
    # as the conversation path (B1.3/§12.1) — both must reach run_agent_turn.
    assert callable(recorded["keepalive"])
    assert recorded["todo_store"] is not None
    assert result["ok"] is True
    assert result["answer"] == "循环给出的回答"
    assert result["route"]["action"] == "model_loop"
    assert result["usedBackend"]
    assert result["selectionSessionId"] == "sess-1"


def test_loop_effect_ceiling_keeps_permission_modes_functional() -> None:
    from app.agent_runtime.tool_registry import Effect

    assert selection_bridge._agent_effect_ceiling("default") == tuple(Effect)
    assert selection_bridge._agent_effect_ceiling("bypass") == tuple(Effect)


def test_selection_budget_never_kills_a_normal_answer() -> None:
    from app.governance.latency_budget import Stage

    policy = selection_bridge.SELECTION_BUDGETS[Stage.FULL_ANSWER]
    assert policy.budget_ms >= 5 * 60 * 1000, (
        "划线问答也不能背 4 秒 FULL_ANSWER 预算：普通 3-6 秒模型回答会被误杀成 "
        "'full answer budget exhausted'。"
    )


def test_screen_region_without_explicit_image_path_never_uses_local_image_route(
    monkeypatch, tmp_path
) -> None:
    """A frozen screen capture is evidence, not a selected local image file."""
    from PIL import Image

    capture = tmp_path / "screen.png"
    Image.new("RGB", (160, 100), "white").save(capture)
    calls: list[Path] = []

    def fake_vision(path, *_args, **_kwargs):
        calls.append(Path(path))
        return "should not run"

    monkeypatch.setattr(selection_bridge, "ask_vision_model", fake_vision)
    app_ctx = AdapterReadContext(
        adapter="local_ocr",
        app="screen",
        content="Q2 median latency 3.6s",
        label="THIS",
        method="local:test",
        artifacts={"capture_path": str(capture)},
    )

    answer = selection_bridge._local_image_file_answer(
        "Q2 是多少？",
        app_ctx,
        {
            "capture_path": str(capture),
            "selection_bbox": [20, 20, 80, 40],
            "capture_bbox": [0, 0, 160, 100],
            "context": {
                "adapter": "screen_region",
                "path": str(capture),
                "artifacts": {"capture_path": str(capture)},
            },
        },
    )

    assert answer is None
    assert calls == []


def test_main_has_one_agent_route_and_no_post_loop_model_fallback() -> None:
    """Normal commands get one Agent state machine, not stacked routers."""
    module_source = inspect.getsource(selection_bridge)
    source = inspect.getsource(selection_bridge.main)
    assert source.count("loop_result = _loop_router") == 1
    after_loop = source[source.index("loop_result = _loop_router") :]
    assert "vision_answer = _screen_region_vision_answer" not in after_loop
    assert "ask_text_model(" not in after_loop
    assert "ask_text_model_with_tools(" not in after_loop
    assert "IntentRouter(" not in source
    assert "def _classify_with_model" not in module_source
    assert "def _general_fallback_answer" not in module_source
    # The dead screen-region vision helper grabbed the LIVE screen via
    # ImageGrab (frozen-frame invariant violation if ever rewired) — removed.
    assert "def _screen_region_vision_answer" not in module_source
    assert "_shopping_list_response(" not in source
    assert "_calendar_response(" not in source
    assert "_route_response(" not in source
    assert "_length_target_response(" not in source


def test_frozen_frame_crop_translates_physical_coordinates_to_image_local(
    tmp_path,
) -> None:
    from PIL import Image, ImageDraw

    capture = tmp_path / "window.png"
    image = Image.new("RGB", (100, 80), "white")
    ImageDraw.Draw(image).rectangle((20, 10, 59, 39), fill="red")
    image.save(capture)

    cropped_bytes = selection_bridge._crop_frozen_frame_bytes(
        capture,
        (1020, 2010, 1060, 2040),
        (1000, 2000, 1100, 2080),
    )

    with Image.open(io.BytesIO(cropped_bytes)) as cropped:
        assert cropped.size == (40, 30)
        assert cropped.convert("RGB").getpixel((10, 10)) == (255, 0, 0)


def test_the_loop_backend_names_the_reader_that_actually_read(monkeypatch) -> None:
    """`read_around` must not sign OCR's work with UIA's name.

    The loop weighs evidence by where it came from, and after fusion the winner
    is often not the structured tier. A backend that answers "source: uia,
    confidence: 1.0" for a recognised line hands the model a certainty nobody
    produced.
    """
    app_ctx = AdapterReadContext(
        adapter="local_ocr",
        app="screen",
        window={"title": "Windows PowerShell"},
        content="PS D:\\Desktop> npm run sync",
        label="划中的一行",
        method="ocr:frozen-frame",
        artifacts={"selection_rectangles": [[429, 290, 1175, 26]]},
    )
    snapshot = {
        "source_kind": "screen_region",
        "perception_trace": {
            "selectedLayer": "ocr",
            "selectedAdapter": "local_ocr",
            "observations": [
                {"layer": "ocr", "adapter": "local_ocr", "status": "ok", "confidence": 0.7},
            ],
        },
    }

    backend = selection_bridge._BridgePerceptionBackend(
        app_ctx, {"title": "Windows PowerShell"}, snapshot
    )
    read = backend.read_around("", 3)[0]

    assert read["source"] == "ocr"
    assert read["confidence"] == 0.7


def test_loop_router_crash_falls_back(monkeypatch):
    from app.fabric import engine as engine_module

    def boom(*_args, **_kwargs):
        raise RuntimeError("loop exploded")

    monkeypatch.setattr(engine_module, "run_agent_turn", boom)

    result = selection_bridge._loop_router(
        "帮我看看", [], None, None, None, None, None, None
    )

    assert result["ok"] is False
    assert result["loopError"] == "RuntimeError"


def test_only_completed_loop_terminal_can_become_the_user_answer() -> None:
    assert selection_bridge._loop_result_is_answer({
        "ok": True,
        "answer": "done",
        "loopTerminated": False,
    }) is True
    assert selection_bridge._loop_result_is_answer({
        "ok": False,
        "answer": "full answer budget exhausted",
        "loopTerminated": True,
        "loopTerminatedReason": "budget_exhausted",
    }) is False
    # 部分交付：终止但携带实质完成内容（notepad-edit 教训）——
    # 活干完了不得只报一句错误。
    assert selection_bridge._loop_result_is_answer({
        "ok": True,
        "answer": "模型连接中断，未能生成最终答复。此前已完成的操作：\n1. click\n2. type_text\n（以上操作已真实执行）",
        "loopTerminated": True,
        "loopTerminatedReason": "provider_unavailable",
    }) is True
    # 终止且没有实质内容的仍然走失败路径。
    assert selection_bridge._loop_result_is_answer({
        "ok": True,
        "answer": "",
        "loopTerminated": True,
        "loopTerminatedReason": "provider_unavailable",
    }) is False


def test_loop_interaction_metadata_preserves_usage_and_user_suspension() -> None:
    metadata = selection_bridge._loop_interaction_metadata({
        "modelUsage": {"inputTokens": 12, "outputTokens": 4, "totalTokens": 16},
        "awaitingUserInput": True,
        "pendingInput": {"question": "Which one?", "options": ["A", "B"]},
    })

    assert metadata == {
        "modelUsage": {"inputTokens": 12, "outputTokens": 4, "totalTokens": 16},
        "awaitingUserInput": True,
        "pendingInput": {"question": "Which one?", "options": ["A", "B"]},
    }


def test_input_artifact_ledger_metadata_keeps_grounded_source_and_identity() -> None:
    artifact = SimpleNamespace(
        id="input-42",
        target=SimpleNamespace(sources=("UIA", "OCR")),
        display=SimpleNamespace(confidence=0.87),
    )

    metadata = selection_bridge._input_artifact_ledger_metadata(
        artifact,
        {"process_name": "notepad.exe"},
        SimpleNamespace(app="Notepad"),
    )

    assert metadata == {
        "appName": "notepad.exe",
        "evidenceLayerHit": "L2",
        "confidence": 0.87,
        "inputArtifactId": "input-42",
    }


def test_loop_router_local_action_is_reported(monkeypatch):
    from app.fabric import engine as engine_module

    monkeypatch.setattr(
        engine_module,
        "run_agent_turn",
        lambda *a, **k: _fake_terminal(
            reason_value="local_action", message="save_screenshot", local_action="save_screenshot"
        ),
    )

    result = selection_bridge._loop_router(
        "截图", [], None, None, None, None, None, None
    )

    assert result["localAction"] == "save_screenshot"
    assert result["route"]["tier"] == "L0"


def test_loop_router_collects_capability_proposals(monkeypatch):
    from app.agent_runtime.types import Terminal, ToolResult, TransitionReason
    from app.fabric import engine as engine_module

    signed_plan = {
        "id": "plan-1",
        "recipeId": "text.summarize_route",
        "integrityToken": "sig-1",
        "risk": "local_write",
        "requiresConfirmation": True,
        "preview": {"title": "摘要并路由", "description": "把选区摘要写入草稿"},
    }
    terminal = Terminal(
        reason=TransitionReason.COMPLETED,
        message="已生成方案，请确认。",
        turns=2,
        results=(
            ToolResult(
                tool_call_id="c1",
                value=json.dumps({
                    "ok": True,
                    "recipeId": "text.summarize_route",
                    "requiresConfirmation": True,
                    "plan": signed_plan,
                }, ensure_ascii=False),
                is_error=False,
                failure_type=None,
                used_backend="fabric.plan_proposal",
                latency_ms=5.0,
            ),
        ),
    )
    monkeypatch.setattr(engine_module, "run_agent_turn", lambda *a, **k: terminal)

    result = selection_bridge._loop_router(
        "总结成三点放到邮件", [], None, None, None, None, None, None
    )

    proposals = result["actionProposals"]
    assert len(proposals) == 1
    assert proposals[0]["action_type"] == "fabric_recipe_execute"
    assert proposals[0]["target"]["metadata"]["recipe_id"] == "text.summarize_route"
    assert proposals[0]["confirmation_required"] is True
    assert result["answer"] == "已生成方案，请确认。"


def test_loop_router_binds_profile_default_workspace_not_process_cwd(monkeypatch, tmp_path):
    """Stage 的 coding 工作区必须来自持久化默认（/cwd 写的那份）。

    安装版里 Path.cwd() 是安装目录：硬编码让手势任务 `ls` 列出的是
    Magic Pointer 自己的文件，而不是用户绑定的工作区（用户实测）。
    """
    from app.agent_runtime.tool_registry import Effect
    from app.fabric import engine as engine_module
    from types import SimpleNamespace

    default_ws = tmp_path / "profile-ws"
    default_ws.mkdir()
    monkeypatch.setattr(selection_bridge, "read_workspace", lambda root: default_ws)

    captured = {}

    class _Ctx:
        def unload(self):
            pass

        def get(self, key):
            if key == "tools":
                from app.agent_runtime.tool_registry import ToolRegistry
                return ToolRegistry()
            if key == "todo_store":
                class _T:
                    on_update = None
                    def read(self):
                        return []
                    def has_items(self):
                        return False
                return _T()
            if key == "sessions":
                class _S:
                    def open_or_create(self, *a, **k):
                        class _Sess:
                            events = ()

                            def interrupted_turn_summary(self):
                                return None
                            def enqueue_inbox(self, *a, **k):
                                pass
                            def claim_inbox(self, *a, **k):
                                return []
                        return _Sess()
                return _S()
            if key == "context_budget":
                return 64000
            return SimpleNamespace()

    report = SimpleNamespace(ctx=_Ctx(), rows=[
        SimpleNamespace(id="model-client", resolved_config={"permission_mode": "default"}),
    ])

    import app.harness.builtin_bundle as builtin_bundle
    monkeypatch.setattr(
        builtin_bundle, "boot_loop_context",
        lambda runtime, root=None: captured.update(runtime=dict(runtime)) or report,
    )

    def fake_run(user_input, objects=None, registry=None, *, client, **kwargs):
        from app.agent_runtime.loop import TransitionReason
        from app.agent_runtime.types import Terminal
        return Terminal(reason=TransitionReason.COMPLETED, message="好", turns=1, results=())

    monkeypatch.setattr(engine_module, "run_agent_turn", fake_run)
    import app.fabric.loop_answer as loop_answer
    monkeypatch.setattr(loop_answer, "terminal_to_answer", lambda t, p: {"ok": True, "answer": "好"})

    clock = selection_bridge.PhaseClock("test", enabled=False)
    result = selection_bridge._loop_router(
        "看看工作区", [{"id": "o1"}], None, None, None, None, "sess-ws", "snap-ws",
        clock=clock,
    )
    assert result["ok"] is True
    assert captured["runtime"]["workspace_root"] == str(default_ws), (
        "Stage 必须绑定持久化默认工作区，而不是进程 cwd（安装目录）"
    )
