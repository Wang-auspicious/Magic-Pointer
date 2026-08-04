"""The stretch handle has to mean something specific, or it is a toy.

"Pull down three lines" must produce an instruction the model can hit, a
preview the user can read while dragging, and an honest verdict about whether
the result landed where they asked. These pin all three.
"""

from __future__ import annotations

from app.text_actions.length_target import (
    build_instruction,
    count_lines,
    describe_target,
    hit_target,
    target_from_command,
    target_from_handle,
    warning_for,
)

FIVE_LINES = "\n".join(f"第 {index} 行的内容，长度足够构成一句话。" for index in range(1, 6))
TWO_LINES = "第一句话在这里。\n第二句话也在这里。"


def test_dragging_down_three_lines_from_two_targets_five() -> None:
    target = target_from_handle(TWO_LINES, delta_lines=3)
    assert target.direction == "expand"
    assert target.source_lines == 2
    assert target.target_lines == 5
    assert target.recipe_id == "selection.expand"


def test_dragging_up_condenses_and_never_targets_zero_lines() -> None:
    target = target_from_handle(FIVE_LINES, delta_lines=-3)
    assert target.direction == "condense"
    assert target.target_lines == 2
    assert target.recipe_id == "selection.condense"

    floored = target_from_handle(TWO_LINES, delta_lines=-9)
    assert floored.target_lines == 1


def test_blank_lines_do_not_inflate_the_source_count() -> None:
    assert count_lines("一行\n\n\n二行\n   \n") == 2


def test_the_preview_string_says_both_numbers() -> None:
    text = describe_target(target_from_handle(TWO_LINES, delta_lines=3))
    assert "5 行" in text
    assert "2 行" in text


def test_the_instruction_forbids_inventing_facts_and_forbids_a_preamble() -> None:
    instruction = build_instruction(target_from_handle(TWO_LINES, delta_lines=3))
    assert "5 行" in instruction
    assert "不要引入原文没有的事实" in instruction
    assert "只输出替换后的文字本身" in instruction

    condense = build_instruction(target_from_handle(FIVE_LINES, delta_lines=-3))
    assert "保留结论、关键数字和专有名词" in condense


def test_an_extra_note_rides_along_with_the_length_target() -> None:
    instruction = build_instruction(target_from_handle(TWO_LINES, delta_lines=3), user_note="语气正式一些")
    assert "语气正式一些" in instruction


def test_impossible_targets_are_named_before_a_model_call_is_spent() -> None:
    assert warning_for(target_from_handle("短", delta_lines=5), "短")
    huge = target_from_handle(TWO_LINES, target_lines=40)
    assert "四倍" in (warning_for(huge, TWO_LINES) or "")
    # 5 lines to 1 is an ordinary "one-line summary" and must not be nagged
    # about; the warning is for targets that would destroy the content.
    assert warning_for(target_from_handle(FIVE_LINES, target_lines=1), FIVE_LINES) is None
    long_text = "\n".join(f"第 {index} 行的内容，长度足够构成一句话。" for index in range(1, 21))
    crushed = target_from_handle(long_text, target_lines=1)
    assert "六分之一" in (warning_for(crushed, long_text) or "")
    assert warning_for(target_from_handle(FIVE_LINES, delta_lines=2), FIVE_LINES) is None


def test_a_result_that_missed_the_target_is_reported_as_missed() -> None:
    target = target_from_handle(TWO_LINES, delta_lines=3)
    hit, note = hit_target(FIVE_LINES, target)
    assert hit is True
    assert "目标 5 行" in note

    missed, note = hit_target("只有一行。", target)
    assert missed is False
    assert "实际 1 行" in note


def test_typing_the_command_and_dragging_the_handle_reach_the_same_target() -> None:
    typed = target_from_command("压缩到 2 行", FIVE_LINES)
    dragged = target_from_handle(FIVE_LINES, delta_lines=-3)
    assert typed is not None
    assert typed.target_lines == dragged.target_lines
    assert typed.direction == dragged.direction

    by_chars = target_from_command("扩写到 300 字", TWO_LINES)
    assert by_chars is not None
    assert by_chars.target_chars == 300
    assert by_chars.direction == "expand"

    assert target_from_command("改得更正式", TWO_LINES) is None
