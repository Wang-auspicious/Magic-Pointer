"""这一条链断在哪儿，就在哪儿钉住。

2026-08-04 实机复现（PowerShell 窗口，一条 1175×30 的下划线）：

  UIA region 读回 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
    → 非空，判为"结构层已成功"
    → source_kind = native_selection
    → OCR 富化的两道门（source_kind 必须是 screen_region、content 必须为空）双双关死
    → 用户看到"我知道这是哪个窗口，但没读到你划的那一行"

同一张截图事后单跑 OCR，53 个块里精确命中 1 个，把那行原样读了出来。像素一直都在。

另外同一次里选区被从 1175×30 扩成 2346×1142——笔画穿过的是覆盖整窗的容器元素，
"穿过了"被当成了"选中了"。
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import scripts.selection_bridge as selection_bridge  # noqa: E402
from app.adapters.base import AdapterReadContext  # noqa: E402
from scripts.selection_bridge import _enrich_screen_region_context  # noqa: E402

POWERSHELL_IDENTITY = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"


def _fake_ocr(monkeypatch, text: str = "LINE-ALPHA 第一行 hello") -> None:
    monkeypatch.setattr(
        selection_bridge,
        "_read_local_ocr_boxes",
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
    """核心回归：非空 content 不再是"已经读到了"的证明。"""
    capture = tmp_path / "screen.png"
    capture.write_bytes(b"capture")
    _fake_ocr(monkeypatch)

    context = _enrich_screen_region_context(
        {"title": "Windows PowerShell"},
        _identity_context(capture),
        {
            # 注意：source_kind 不是 screen_region，且 content 非空——旧代码在这里
            # 两道门都会直接放行原样返回。
            "source_kind": "native_selection",
            "structured_covers_mark": False,
            "structured_gap_reason": "identity_only",
            "capture_path": str(capture),
        },
    )

    assert context.content == "LINE-ALPHA 第一行 hello"
    assert context.adapter == "local_ocr"


def test_a_structured_read_that_covered_the_mark_is_left_alone(monkeypatch, tmp_path) -> None:
    """Notepad / Word 这类本来就读得到的应用不能被这个修复误伤。"""
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


def test_snapshots_written_before_this_field_existed_keep_the_old_rule(monkeypatch, tmp_path) -> None:
    capture = tmp_path / "screen.png"
    capture.write_bytes(b"capture")
    _fake_ocr(monkeypatch)

    # 老快照 + 非 screen_region：仍按旧规则跳过，不会因为字段缺失就改变行为。
    untouched = _identity_context(capture)
    assert _enrich_screen_region_context(
        {"title": "Windows PowerShell"},
        untouched,
        {"source_kind": "native_selection", "capture_path": str(capture)},
    ) is untouched

    # 老快照 + screen_region + 空 content：仍会跑 OCR。
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


# --- 快照桥一侧 -------------------------------------------------------------


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
    """A perfectly horizontal underline must not collapse into a 16px pointer."""
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
    """穿过 ≠ 选中。覆盖整窗的容器被每一条画在它里面的线穿过。"""
    from app.grounding.marked_read import rect_is_container

    window = {"title": "Windows PowerShell", "bbox": [194, 196, 2544, 1421]}
    assert rect_is_container([196, 277, 2346, 1142], window=window, mark_bbox=[429, 286, 1175, 30]) is True
    # 一段普通的段落元素不是容器。
    assert rect_is_container([200, 300, 800, 120], window=window, mark_bbox=[429, 286, 1175, 30]) is False


def test_the_grounding_keeps_the_drawn_mark_when_only_a_container_was_crossed() -> None:
    """接线检查：光有策略没接上等于没修。"""
    source = Path(__file__).resolve().parents[1] / "scripts" / "selection_snapshot_bridge.py"
    text = source.read_text(encoding="utf-8")
    assert "rect_is_container(resolved_bbox" in text, "容器判定没接进手势接地"
    assert '"only_container_elements_crossed"' in text
    assert '"stroke_crossed_no_element"' in text, "笔画一个元素都没穿过时仍会宣称已解析"
    assert "structured_read_covers_mark(" in text
    assert '"structured_covers_mark": bool(mark_coverage.covers)' in text, "判断没写进快照"

    bridge = (Path(__file__).resolve().parents[1] / "scripts" / "selection_bridge.py").read_text(encoding="utf-8")
    assert 'snapshot.get("structured_covers_mark")' in bridge, "命令桥没有读这个判断"


# --- 模型挂掉时 -------------------------------------------------------------


def test_a_dead_gateway_still_shows_the_line_that_was_read() -> None:
    """读到了却只显示"AI 调用失败"，和根本没读到长得一模一样。

    2026-08-04 网关维护期间实测到的形态：气泡说"已跳过模型调用，用本地能力尽力
    回答"，然后什么也没回答——而那一行明明已经 OCR 出来了。
    """
    from scripts.selection_bridge import answer_with_read_text_on_model_failure

    read = "LINE-ALPHA 第一行 hello"
    answer = answer_with_read_text_on_model_failure(
        "AI 调用失败：连不上模型端点。已跳过模型调用，用本地能力尽力回答。",
        read,
    )
    assert read in answer
    # 原因也要留着，否则用户不知道为什么只有原文没有回答。
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
