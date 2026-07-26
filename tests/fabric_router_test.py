from __future__ import annotations

from app.fabric.router import RecipeRouter


def test_routes_high_value_short_commands_without_a_model() -> None:
    router = RecipeRouter()
    cases = {
        "复制这段文字": "text.ocr_copy",
        "把号码空格去掉再复制": "text.ocr_clean",
        "把这段改得更正式": "text.rewrite_in_place",
        "翻成英文放回这里": "text.translate_in_place",
        "把这张表放进 Excel": "table.to_spreadsheet",
        "把这两个表合并": "table.merge",
        "复制这个公式的 LaTeX": "formula.to_latex",
        "把这个活动加到日历": "calendar.create_from_screen",
        "从这里到那个地方怎么走": "map.route",
        "让 Codex 修这个": "agent.handoff",
        "在后台交给 Pi 处理": "agent.background_task",
        "把这段和图保存到项目笔记": "research.evidence_card",
    }
    for command, expected in cases.items():
        match = router.route(command, object_count=2)
        assert match.recipe_id == expected, (command, match)
        assert match.confidence >= 0.62


def test_reference_mode_is_bound_separately_from_recipe() -> None:
    router = RecipeRouter()
    assert router.route("比较这个和刚才那个", object_count=2).reference_mode == "that"
    assert router.route("比较这些", object_count=3).reference_mode == "these"
    assert router.route("把这个移动到这里", object_count=2).reference_mode == "here"
    assert router.route("解释这个", object_count=1).reference_mode == "this"


def test_ambiguous_or_object_incompatible_command_fails_closed() -> None:
    router = RecipeRouter()
    ambiguous = router.route("处理一下")
    assert ambiguous.recipe_id is None
    assert ambiguous.confidence < 0.5
    assert ambiguous.reason == "ambiguous_command"

    needs_two = router.route("把这两个表合并", object_count=1)
    assert needs_two.recipe_id is None
    assert needs_two.reason == "insufficient_objects"


def test_explicit_recipe_id_is_validated_not_blindly_accepted() -> None:
    router = RecipeRouter()
    assert router.route("recipe: text.ocr_copy").recipe_id == "text.ocr_copy"
    unknown = router.route("recipe: system.delete_everything")
    assert unknown.recipe_id is None
    assert unknown.reason == "unknown_recipe"

