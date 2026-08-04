"""悬浮翻译：译文要落在原句上，而不是跳进气泡里。

难的不是翻译，是**把一个长度不一样的字符串塞进别人定好的矩形**。
这里钉三件在真实界面上必然发生的事：放不下怎么办、译文和原文一样时怎么办、
以及绝不能悄悄把句子截一半——那会在屏幕上留下一个看起来很自信的错译。
"""

from __future__ import annotations

from app.vision.overlay_translation import (
    MIN_FONT_PX,
    coverage_summary,
    fit_block,
    measure_width,
    plan_overlay,
)


def _block(x, y, w, h, text):
    return {"rect": [x, y, w, h], "text": text}


def test_a_translation_lands_on_the_line_it_replaces() -> None:
    [item] = plan_overlay([_block(100, 200, 400, 30, "Hello world")], ["你好世界"])
    assert item.rect == [100, 200, 400, 30]
    assert item.text == "你好世界"
    assert item.truncated is False


def test_text_already_in_the_target_language_is_left_alone() -> None:
    """用相同的文字盖住原文只会制造噪音，还可能对不齐。"""
    assert plan_overlay([_block(100, 200, 400, 30, "你好")], ["你好"]) == []


def test_an_empty_translation_leaves_the_original_visible() -> None:
    assert plan_overlay([_block(100, 200, 400, 30, "Hello")], [""]) == []
    assert plan_overlay([_block(100, 200, 400, 30, "Hello")], [None]) == []


def test_pairing_is_positional_so_a_short_reply_never_shifts_the_rest() -> None:
    blocks = [_block(0, 0, 300, 30, "one"), _block(0, 40, 300, 30, "two"), _block(0, 80, 300, 30, "three")]
    planned = plan_overlay(blocks, ["一"])
    assert [item.text for item in planned] == ["一"]
    assert planned[0].rect == [0, 0, 300, 30]


def test_a_long_translation_shrinks_before_it_truncates() -> None:
    small = fit_block([0, 0, 200, 40], "这是一段明显比原文长得多的译文内容需要缩小才放得下")
    assert small is not None
    assert small.truncated is False
    assert small.font_px < 40 * 0.78


def test_text_that_cannot_fit_at_all_says_so_instead_of_lying() -> None:
    fitted = fit_block([0, 0, 60, 16], "这是一段远远超出这个小方框能容纳范围的很长很长的译文")
    assert fitted is not None
    assert fitted.truncated is True
    assert fitted.font_px == MIN_FONT_PX
    # 完整原文仍然保留着，界面可以据此提示"还有更多"。
    assert len(fitted.text) > sum(len(line) for line in fitted.lines)


def test_the_overlay_never_renders_below_a_readable_size() -> None:
    fitted = fit_block([0, 0, 40, 12], "很长很长很长的译文")
    assert fitted is not None and fitted.font_px >= MIN_FONT_PX


def test_wrapping_works_without_spaces() -> None:
    """中文没有空格，按空格换行会得到一行到底。"""
    fitted = fit_block([0, 0, 120, 200], "第一行第二行第三行第四行第五行第六行")
    assert fitted is not None
    assert len(fitted.lines) > 1


def test_explicit_newlines_are_respected() -> None:
    fitted = fit_block([0, 0, 400, 200], "第一段\n第二段")
    assert fitted is not None
    assert fitted.lines[0] == "第一段"


def test_cjk_is_measured_wider_than_latin() -> None:
    assert measure_width("中文", 20) > measure_width("ab", 20)


def test_junk_input_produces_no_overlay() -> None:
    assert plan_overlay(None, None) == []
    assert plan_overlay([], ["x"]) == []
    assert plan_overlay([{}, {"rect": [1, 2]}], ["a", "b"]) == []
    assert plan_overlay([_block(0, 0, 10, 10, "  ")], ["x"]) == []
    assert fit_block([0, 0, 100, 30], "   ") is None


def test_the_block_count_is_bounded() -> None:
    from app.vision.overlay_translation import MAX_OVERLAY_BLOCKS

    blocks = [_block(0, index * 40, 300, 30, f"line {index}") for index in range(MAX_OVERLAY_BLOCKS + 20)]
    planned = plan_overlay(blocks, [f"第{index}行" for index in range(len(blocks))])
    assert len(planned) == MAX_OVERLAY_BLOCKS


# --- 说给人听的一句话 -------------------------------------------------------


def test_the_summary_counts_what_was_covered() -> None:
    blocks = [_block(0, 0, 300, 30, "one"), _block(0, 40, 300, 30, "two")]
    planned = plan_overlay(blocks, ["一", "二"])
    line = coverage_summary(blocks, planned)
    assert "2 / 2" in line


def test_the_summary_admits_when_nothing_needed_translating() -> None:
    blocks = [_block(0, 0, 300, 30, "你好")]
    assert "已经是目标语言" in coverage_summary(blocks, plan_overlay(blocks, ["你好"]))


def test_the_summary_admits_an_empty_region() -> None:
    assert "没有读到文字" in coverage_summary([], [])


def test_the_summary_reports_truncation() -> None:
    blocks = [_block(0, 0, 60, 16, "x")]
    planned = plan_overlay(blocks, ["这是一段远远超出这个小方框能容纳范围的很长很长的译文"])
    assert "截断" in coverage_summary(blocks, planned)
