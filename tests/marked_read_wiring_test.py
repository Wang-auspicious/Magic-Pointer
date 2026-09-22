
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import app.perception.pixel_ocr as pixel_ocr  # noqa: E402
from app.adapters.base import AdapterReadContext  # noqa: E402
from scripts.selection_bridge import _fuse_pixel_tier  # noqa: E402  (used directly below)

POWERSHELL_IDENTITY = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"


def _enrich_screen_region_context(target_window, app_ctx, snapshot):
    context, _trace = _fuse_pixel_tier(target_window, app_ctx, snapshot)
    return context


def _fake_ocr(monkeypatch, text: str = "LINE-ALPHA 第一行 hello") -> None:
    monkeypatch.setattr(
        pixel_ocr,
        "read_ocr_blocks",
        lambda path, strokes_local=None, selection_local=None: (
            [{"text": text, "rect": None, "conf": None}],
            "test-ocr",
        ),
    )


def _identity_context(capture: Path) -> AdapterReadContext:
    return AdapterReadContext(
        adapter="uia_text_selection",
        app="application",
        window={"title": "Windows PowerShell"},
        content=POWERSHELL_IDENTITY,
        method="uia:region-elements",
        artifacts={"capture_path": str(capture)},
    )


def test_a_structured_read_that_missed_the_mark_does_not_block_ocr(monkeypatch, tmp_path) -> None:
    capture = tmp_path / "screen.png"
    capture.write_bytes(b"capture")
    _fake_ocr(monkeypatch)

    context = _enrich_screen_region_context(
        {"title": "Windows PowerShell"},
        _identity_context(capture),
        {
            "source_kind": "native_selection",
            "structured_covers_mark": False,
            "structured_gap_reason": "identity_only",
            "capture_path": str(capture),
        },
    )

    assert context.content == "LINE-ALPHA 第一行 hello"
    assert context.adapter == "local_ocr"


def test_a_structured_read_that_covered_the_mark_is_left_alone(monkeypatch, tmp_path) -> None:
    capture = tmp_path / "screen.png"
    capture.write_bytes(b"capture")
    _fake_ocr(monkeypatch, "不应该出现的 OCR 结果")
    original = AdapterReadContext(
        adapter="uia_text_selection",
        app="notepad",
        window={"title": "uia-smoke.txt - Notepad"},
        content="真正被 UIA 读到的选中文字",
        method="uia:text-pattern.selection",
        artifacts={},
    )

    context = _enrich_screen_region_context(
        {"title": "uia-smoke.txt - Notepad"},
        original,
        {
            "source_kind": "screen_region",
            "structured_covers_mark": True,
            "capture_path": str(capture),
        },
    )

    assert context is original


def test_a_snapshot_without_the_coverage_field_is_judged_by_its_own_content(
    monkeypatch, tmp_path
) -> None:
    capture = tmp_path / "screen.png"
    capture.write_bytes(b"capture")
    _fake_ocr(monkeypatch)

    context = _enrich_screen_region_context(
        {"title": "Windows PowerShell"},
        _identity_context(capture),
        {"source_kind": "native_selection", "capture_path": str(capture)},
    )

    assert context.content == "LINE-ALPHA 第一行 hello"
    _, trace = _fuse_pixel_tier(
        {"title": "Windows PowerShell"},
        _identity_context(capture),
        {"source_kind": "native_selection", "capture_path": str(capture)},
    )
    assert [item["reason"] for item in trace["notes"]] == ["identity_only"]

    empty = AdapterReadContext(
        adapter="screen_region",
        app="screen",
        window={},
        content="",
        method="pointer:bounded-screen-region",
        artifacts={},
    )
    enriched = _enrich_screen_region_context(
        {},
        empty,
        {"source_kind": "screen_region", "capture_path": str(capture)},
    )
    assert enriched.content == "LINE-ALPHA 第一行 hello"


def test_unbound_text_does_not_claim_the_mark() -> None:
    from app.grounding.marked_read import structured_read_covers_mark

    coverage = structured_read_covers_mark(
        content="第一段\n第二段\n第三段",
        window={"title": "草稿.docx"},
        element_rects=[],
        mark_bbox=[100, 200, 300, 20],
        has_explicit_binding=False,
    )
    assert coverage.covers is False
    assert coverage.reason == "unbound_text"


def test_a_read_that_named_something_still_covers_without_geometry() -> None:
    from app.grounding.marked_read import structured_read_covers_mark

    coverage = structured_read_covers_mark(
        content="被选中的那一段",
        window={"title": "草稿.docx"},
        element_rects=[],
        mark_bbox=[100, 200, 300, 20],
        has_explicit_binding=True,
    )
    assert coverage.covers is True


def test_the_binding_flag_defaults_to_the_previous_answer() -> None:
    from app.grounding.marked_read import structured_read_covers_mark

    assert structured_read_covers_mark(
        content="某段文字", window={"title": "任意窗口"},
        element_rects=[], mark_bbox=[100, 200, 300, 20],
    ).covers is True
    assert structured_read_covers_mark(
        content="某段文字", window={"title": "任意窗口"},
        element_rects=[], mark_bbox=None, has_explicit_binding=False,
    ).covers is True


def test_only_reads_that_name_an_object_count_as_bound() -> None:
    from app.adapters.base import AdapterReadContext
    from app.perception.providers import context_is_explicitly_bound

    def context(**artifacts):
        return AdapterReadContext(
            adapter="x", app="y", window={}, content="文字", artifacts=artifacts,
        )

    assert context_is_explicitly_bound(context(path="D:/Desktop/报告.pdf")) is True
    assert context_is_explicitly_bound(context(local_file={"path": "D:/a.html"})) is True
    assert context_is_explicitly_bound(context(cell="B7")) is True
    assert context_is_explicitly_bound(context(dom_selector="#submit")) is True
    assert context_is_explicitly_bound(context(perception_result_kind="point_element")) is True
    assert context_is_explicitly_bound(context(perception_result_kind="terminal_buffer")) is True
    assert context_is_explicitly_bound(context()) is False
    assert context_is_explicitly_bound(context(selection_text_chars=42)) is False
    assert context_is_explicitly_bound(None) is False


def test_an_unbound_structured_read_hands_the_mark_to_the_pixel_tier() -> None:
    from app.adapters.base import AdapterReadContext
    from app.evidence.contract import EvidenceStatus
    from app.perception.providers import (
        ProviderDescriptor,
        ProviderResult,
        PerceptionRequest,
        observation_from_result,
    )
    from app.perception.fusion import pixel_tier_warranted

    request = PerceptionRequest(
        window={"title": "草稿.docx", "bbox": [0, 0, 1200, 900]},
        mark_bbox=(100, 200, 300, 20),
    )
    observation = observation_from_result(
        ProviderDescriptor(id="uia_region", layer="uia"),
        ProviderResult(context=AdapterReadContext(
            adapter="uia_text_selection",
            app="application",
            window={"title": "草稿.docx"},
            content="一整篇文章的正文，恰好非空",
            method="uia:region-elements",
            artifacts={},
        )),
        request,
        index=0,
        latency_ms=12.0,
    )
    assert observation.status is EvidenceStatus.OK
    assert observation.covers_mark is False
    assert observation.coverage_reason == "unbound_text"
    warranted, reason = pixel_tier_warranted([observation])
    assert warranted is True
    assert reason == "structured_did_not_cover_mark"




def test_an_identity_only_read_reports_the_gap_and_hands_over_to_pixels() -> None:
    from scripts.selection_snapshot_bridge import _gesture_mark_bbox, structured_read_covers_mark

    gesture = {
        "schemaVersion": 2,
        "coordinateSpace": "physical_screen_pixels",
        "bbox": {"x": 429, "y": 286, "width": 1175, "height": 30},
        "strokes": [{"points": [{"x": 429, "y": 301}, {"x": 1604, "y": 301}]}],
    }
    assert _gesture_mark_bbox(gesture) == [429, 286, 1175, 30]

    coverage = structured_read_covers_mark(
        content=POWERSHELL_IDENTITY,
        window={"title": "Windows PowerShell", "bbox": [194, 196, 2544, 1421]},
        element_rects=[[196, 277, 2346, 1142]],
        mark_bbox=_gesture_mark_bbox(gesture),
    )
    assert coverage.covers is False
    assert coverage.reason == "identity_only"


def test_zero_height_line_keeps_a_real_gesture_region() -> None:
    from scripts.selection_snapshot_bridge import _bounded_gesture_capture_bbox, _gesture_mark_bbox

    gesture = {
        "schemaVersion": 2,
        "coordinateSpace": "physical_screen_pixels",
        "bbox": {"x": 474, "y": 723, "width": 220, "height": 0},
        "geometry": {"type": "band_corridor", "widthPx": 16},
        "strokes": [{"points": [{"x": 474, "y": 723}, {"x": 694, "y": 723}]}],
    }

    mark = _gesture_mark_bbox(gesture)

    assert mark == [474, 715, 220, 16]
    assert _bounded_gesture_capture_bbox(
        gesture,
        {"bbox": [0, 0, 1920, 1080]},
        (0, 0, 1920, 1080),
    ) is not None


def test_a_stroke_through_a_full_window_element_does_not_select_the_whole_window() -> None:
    from app.grounding.marked_read import rect_is_container

    window = {"title": "Windows PowerShell", "bbox": [194, 196, 2544, 1421]}
    assert rect_is_container([196, 277, 2346, 1142], window=window, mark_bbox=[429, 286, 1175, 30]) is True
    assert rect_is_container([200, 300, 800, 120], window=window, mark_bbox=[429, 286, 1175, 30]) is False


def test_the_grounding_keeps_the_drawn_mark_when_only_a_container_was_crossed() -> None:
    source = Path(__file__).resolve().parents[1] / "scripts" / "selection_snapshot_bridge.py"
    text = source.read_text(encoding="utf-8")
    assert "rect_is_container(resolved_bbox" in text, "容器判定没接进手势接地"
    assert '"only_container_elements_crossed"' in text
    assert '"stroke_crossed_no_element"' in text, "笔画一个元素都没穿过时仍会宣称已解析"
    assert "structured_read_covers_mark(" in text
    assert '"structured_covers_mark": bool(mark_coverage.covers)' in text, "判断没写进快照"




def test_a_dead_gateway_still_shows_the_line_that_was_read() -> None:
    from scripts.selection_bridge import answer_with_read_text_on_model_failure

    read = "LINE-ALPHA 第一行 hello"
    answer = answer_with_read_text_on_model_failure(
        "AI 调用失败：连不上模型端点。已跳过模型调用，用本地能力尽力回答。",
        read,
    )
    assert read in answer
    assert "连不上模型端点" in answer


def test_a_successful_answer_is_never_padded_with_the_raw_text() -> None:
    from scripts.selection_bridge import answer_with_read_text_on_model_failure

    answer = answer_with_read_text_on_model_failure("这行是一句问候语。", "LINE-ALPHA 第一行 hello")
    assert answer == "这行是一句问候语。"


def test_nothing_was_read_means_nothing_to_add() -> None:
    from scripts.selection_bridge import answer_with_read_text_on_model_failure

    failure = "AI 调用失败：连不上模型端点。"
    assert answer_with_read_text_on_model_failure(failure, "") == failure
    assert answer_with_read_text_on_model_failure(failure, "   \n ") == failure


def test_a_very_long_read_is_trimmed_rather_than_dumped() -> None:
    from scripts.selection_bridge import MODEL_FAILURE_EXCERPT_CHARS, answer_with_read_text_on_model_failure

    answer = answer_with_read_text_on_model_failure("AI 调用失败：超时。", "长文。" * 2000)
    assert len(answer) < MODEL_FAILURE_EXCERPT_CHARS + 200
    assert "已截断" in answer
