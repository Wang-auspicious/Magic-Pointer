
from __future__ import annotations

from app.grounding.marked_read import structured_read_covers_mark

WINDOW = {"title": "Windows PowerShell", "bbox": [194, 196, 2544, 1421]}
UNDERLINE = [429, 286, 1175, 30]


def test_the_real_powershell_failure_is_not_counted_as_a_successful_read() -> None:
    coverage = structured_read_covers_mark(
        content="C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        window=WINDOW,
        element_rects=[[196, 277, 2346, 1142]],
        mark_bbox=UNDERLINE,
    )
    assert coverage.covers is False
    assert coverage.reason == "identity_only"


def test_the_window_title_echoed_back_is_identity_not_content() -> None:
    assert structured_read_covers_mark(content="Windows PowerShell", window=WINDOW).reason == "identity_only"
    assert structured_read_covers_mark(content="  windows powershell ", window=WINDOW).covers is False


def test_an_executable_path_is_identity_even_for_an_unknown_window() -> None:
    coverage = structured_read_covers_mark(content="C:/Program Files/WeChat/WeChat.exe", window={})
    assert coverage.covers is False and coverage.reason == "identity_only"


def test_empty_and_whitespace_content_report_the_plain_reason() -> None:
    assert structured_read_covers_mark(content="").reason == "no_structured_text"
    assert structured_read_covers_mark(content="   \n\t ").reason == "no_structured_text"


def test_a_stroke_that_crosses_no_element_did_not_select_anything() -> None:
    coverage = structured_read_covers_mark(
        content="某个别处的文字",
        window=WINDOW,
        element_rects=[[400, 100, 600, 40], [400, 900, 600, 40]],
        mark_bbox=UNDERLINE,
    )
    assert coverage.covers is False
    assert coverage.reason == "mark_crossed_no_element"


def test_an_element_taller_than_half_the_window_is_the_container_not_the_line() -> None:
    coverage = structured_read_covers_mark(
        content="聊天记录里所有人的所有消息……",
        window=WINDOW,
        element_rects=[[200, 210, 2300, 1180]],
        mark_bbox=UNDERLINE,
    )
    assert coverage.covers is False
    assert coverage.reason == "container_not_selection"


def test_a_paragraph_element_is_still_a_legitimate_read() -> None:
    coverage = structured_read_covers_mark(
        content="这是真正被读到的一整段文字，用户划的那行就在其中。",
        window={"title": "Word", "bbox": [0, 0, 1200, 1000]},
        element_rects=[[100, 200, 800, 300]],
        mark_bbox=[120, 260, 600, 20],
    )
    assert coverage.covers is True
    assert coverage.reason == "structured_text"


def test_an_element_the_mark_actually_crosses_is_a_read() -> None:
    coverage = structured_read_covers_mark(
        content="今上午我不用",
        window={"title": "微信", "bbox": [700, 400, 1500, 1200]},
        element_rects=[[760, 500, 300, 60]],
        mark_bbox=[780, 520, 200, 16],
    )
    assert coverage.covers is True


def test_no_geometry_at_all_falls_back_to_trusting_real_text() -> None:
    coverage = structured_read_covers_mark(content="一段真实的选中文字", window=WINDOW, mark_bbox=UNDERLINE)
    assert coverage.covers is True


def test_malformed_geometry_never_raises() -> None:
    assert structured_read_covers_mark(
        content="文字",
        window={"bbox": "nonsense"},
        element_rects=[[1, 2], None, "x", [1, 2, 3, 4]],
        mark_bbox=[0, 0],
    ).covers is True
