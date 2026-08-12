"""Tests for target-conditioned capability hints (harness gap review L16).

Hints derive from a target-type -> actions mapping, are clamped to 3-8,
reference trajectories by id keyword, and are filtered by the tool registry.
"""

from __future__ import annotations

import dataclasses

import pytest

import app.failure_flow.capability_hints as ch
from app.failure_flow.capability_hints import Hint, hints_for


class _Trajectory:
    """Minimal stand-in for a trajectory object carrying an id."""

    def __init__(self, id: str) -> None:
        self.id = id


class _RecipeTrajectory:
    """Trajectory-shaped object exposing recipe_id instead of id."""

    def __init__(self, recipe_id: str) -> None:
        self.recipe_id = recipe_id


_TEXT_TOOLS = [
    "text.translate_in_place",
    "text.explain",
    "text.rewrite",
    "text.expand",
    "text.compress",
]


def _actions(result: tuple[Hint, ...]) -> list[str]:
    return [hint.action for hint in result]


def test_text_selection_mapping_order():
    result = hints_for("text_selection", [], _TEXT_TOOLS)
    assert _actions(result) == ["翻译", "解释", "改写", "扩写", "压缩"]


def test_table_region_mapping():
    tools = ["table.to_markdown", "table.sum", "table.sort"]
    result = hints_for("table_region", [], tools)
    assert _actions(result) == ["转表格", "求和", "排序"]


def test_file_line_mapping():
    tools = ["file.open", "file.rename", "mail.send"]
    result = hints_for("file_line", [], tools)
    assert _actions(result) == ["打开", "重命名", "发给"]


def test_image_mapping():
    tools = ["image.image_prompt", "vision.describe", "ocr.copy"]
    result = hints_for("image", [], tools)
    assert _actions(result) == ["图转提示词", "描述", "OCR 复制"]


@pytest.mark.parametrize("target_type", ["url", "email", "phone"])
def test_url_email_phone_mapping(target_type):
    tools = ["browser.open_link", "mail.email", "phone.dial"]
    result = hints_for(target_type, [], tools)
    assert _actions(result) == ["打开链接", "发邮件", "拨号"]


def test_unknown_target_type_falls_back_to_defaults():
    result = hints_for("unknown_thing", [], ["text.explain", "text.translate", "text.summarize"])
    assert _actions(result) == ["解释", "翻译", "总结"]


def test_min_clamp_all_skipped_returns_defaults():
    result = hints_for("text_selection", [], [])
    assert len(result) == 3
    assert _actions(result) == ["解释", "翻译", "总结"]


def test_min_clamp_pads_with_defaults_after_filtering():
    result = hints_for("text_selection", [], ["text.translate"])
    assert _actions(result) == ["翻译", "解释", "总结"]


def test_max_clamp_truncates_overlong_mapping(monkeypatch):
    long_map = tuple(ch.HintSpec(f"动作{i}", f"keyword{i}", f"描述{i}") for i in range(10))
    monkeypatch.setattr(ch, "_TARGET_ACTIONS", {"boom": long_map})
    tools = [f"tool.keyword{i}" for i in range(10)]
    result = hints_for("boom", [], tools)
    assert len(result) == ch.MAX_HINTS


def test_length_bound_every_target_type():
    for target_type in ("text_selection", "table_region", "file_line", "image", "url", "email", "phone", "zzz"):
        for tools in ([], _TEXT_TOOLS):
            result = hints_for(target_type, [], tools)
            assert ch.MIN_HINTS <= len(result) <= ch.MAX_HINTS


def test_trajectory_id_linked_by_action_keyword():
    trajectories = [_Trajectory("traj_translate_v1"), _Trajectory("traj_compress_2")]
    result = hints_for("text_selection", trajectories, _TEXT_TOOLS)
    by_action = {hint.action: hint for hint in result}
    assert by_action["翻译"].trajectory_id == "traj_translate_v1"
    assert by_action["压缩"].trajectory_id == "traj_compress_2"
    assert by_action["解释"].trajectory_id is None


def test_trajectory_id_none_when_no_match():
    result = hints_for("text_selection", [_Trajectory("traj_unrelated")], _TEXT_TOOLS)
    assert all(hint.trajectory_id is None for hint in result)


def test_trajectories_as_plain_string_ids():
    result = hints_for("text_selection", ["translate_recipe_9"], _TEXT_TOOLS)
    by_action = {hint.action: hint for hint in result}
    assert by_action["翻译"].trajectory_id == "translate_recipe_9"


def test_trajectory_recipe_id_attribute_is_read():
    result = hints_for("text_selection", [_RecipeTrajectory("recipe_translate_ok")], _TEXT_TOOLS)
    by_action = {hint.action: hint for hint in result}
    assert by_action["翻译"].trajectory_id == "recipe_translate_ok"


def test_hint_is_frozen_with_description():
    hint = Hint(action="翻译", description="把这段文字翻译成其他语言")
    assert dataclasses.is_dataclass(hint)
    assert hint.description.strip()
    with pytest.raises(dataclasses.FrozenInstanceError):
        hint.action = "改写"  # type: ignore[misc]


def test_hint_actions_deduplicated_after_padding():
    result = hints_for("table_region", [], ["table.to_markdown"])
    actions = _actions(result)
    assert len(actions) == len(set(actions))
    assert "转表格" in actions


def test_registry_tool_names_matched_case_insensitively():
    result = hints_for("text_selection", [], ["TEXT.TRANSLATE"])
    assert "翻译" in _actions(result)
