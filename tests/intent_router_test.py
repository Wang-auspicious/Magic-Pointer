"""The router must never答 "unsupported".

The rigid-feel complaint has one measurable definition: a command that is a few
words away from a listed phrase used to die with `ambiguous_command`. These
tests pin the three tiers and, most importantly, that the third tier always
produces something answerable.
"""

from __future__ import annotations

from pathlib import Path

from app.fabric.intent_router import (
    ACT_LOCAL,
    ACT_MODEL,
    ACT_RECIPE,
    ACT_TOOLS,
    TIER_CLASSIFIED,
    TIER_DETERMINISTIC,
    TIER_GENERAL,
    InstructionLibrary,
    IntentRouter,
    recipe_id_from_tool_name,
    recipe_tool_schemas,
)


def _router(tmp_path: Path, **kwargs) -> IntentRouter:
    library = InstructionLibrary(tmp_path / "instructions.json")
    return IntentRouter(library=library, **kwargs)


def test_unmistakable_commands_never_touch_a_model(tmp_path: Path) -> None:
    # No classifier is configured, so anything reaching L1 would fall to L2.
    router = _router(tmp_path)
    cases = {
        "OCR一下": "text.ocr_copy",
        "ocr 这个": "text.ocr_copy",
        "把号码空格去掉": "text.ocr_clean",
        "这张表放进 Excel": "table.to_spreadsheet",
        "这张图的提示词": "image.to_prompt",
        "让 codex 修这个报错": "agent.handoff",
    }
    for command, expected in cases.items():
        decision = router.route(command, object_count=1)
        assert decision.tier == TIER_DETERMINISTIC, (command, decision)
        assert decision.action == ACT_RECIPE
        assert decision.recipe_id == expected, (command, decision)


def test_local_actions_resolve_without_any_recipe(tmp_path: Path) -> None:
    decision = _router(tmp_path).route("截图", object_count=1)
    assert decision.tier == TIER_DETERMINISTIC
    assert decision.action == ACT_LOCAL
    assert decision.local_action == "save_screenshot"


def test_screenshot_local_action_covers_synonyms(tmp_path: Path) -> None:
    router = _router(tmp_path)
    for command in ("截图", "截屏", "保存截图"):
        decision = router.route(command, object_count=1)
        assert decision.tier == TIER_DETERMINISTIC, (command, decision)
        assert decision.action == ACT_LOCAL, (command, decision)
        assert decision.local_action == "save_screenshot", (command, decision)


def test_information_questions_never_become_ocr_or_clipboard_actions(tmp_path: Path) -> None:
    classifier_calls = []

    def classifier(*args):
        classifier_calls.append(args)
        return {"recipeId": "text__ocr_copy", "confidence": 0.9}

    router = _router(tmp_path, classifier=classifier)
    for command in (
        "What exact line did I mark? Answer only that line.",
        "What is OCR?",
        "我刚才圈的是哪一行？",
        "这个内容是什么意思？",
    ):
        decision = router.route(command, object_count=1)
        assert decision.tier == TIER_DETERMINISTIC
        assert decision.action == ACT_MODEL
        assert decision.recipe_id is None
    assert classifier_calls == []


def test_short_human_analysis_commands_skip_capability_classification(tmp_path: Path) -> None:
    classifier_calls = []

    def classifier(*args):
        classifier_calls.append(args)
        return {"recipeId": "text__ocr_copy", "confidence": 0.9}

    router = _router(tmp_path, classifier=classifier)
    for command in ("对比下", "解释下", "哪个好", "有啥区别"):
        decision = router.route(command, object_count=2)
        assert decision.tier == TIER_DETERMINISTIC, (command, decision)
        assert decision.action == ACT_MODEL, (command, decision)
    summary = router.route("总结下", object_count=2)
    assert summary.action == ACT_RECIPE
    assert summary.recipe_id == "text.summarize_route"
    assert classifier_calls == []


def test_polite_action_questions_still_run_the_requested_action(tmp_path: Path) -> None:
    decision = _router(tmp_path).route("Can you copy this text?", object_count=1)
    assert decision.action == ACT_LOCAL
    assert decision.local_action == "copy_object_text"


def test_keyword_confident_commands_route_without_the_classifier(tmp_path: Path) -> None:
    decision = _router(tmp_path).route("把这段改得更正式", object_count=1)
    assert decision.recipe_id == "text.rewrite_in_place"
    assert decision.tier == TIER_CLASSIFIED
    assert decision.reason == "keyword_match"


def test_a_command_nobody_wrote_a_rule_for_still_gets_an_answer(tmp_path: Path) -> None:
    """This is the whole point. "变成小红书文案" matches no rule."""
    router = _router(tmp_path)
    for command in (
        "帮我把这段变成小红书文案",
        "这图里第三列加起来是多少",
        "这段话有没有什么逻辑问题",
        "用四川话再说一遍",
    ):
        decision = router.route(command, object_count=1)
        assert decision.action in (ACT_TOOLS, ACT_RECIPE), (command, decision)
        assert decision.tier in (TIER_GENERAL, TIER_CLASSIFIED)
        # Never a dead end: there is always something for the caller to run.
        assert decision.reason != "ambiguous_command"


def test_classifier_result_is_used_when_confident_and_ignored_when_not(tmp_path: Path) -> None:
    def confident(command, summary, tools):
        return {"recipeId": "text__summarize_route", "confidence": 0.82, "parameters": {"bullets": 3}}

    # A phrasing no keyword rule covers, so the classifier is what decides.
    decision = _router(tmp_path, classifier=confident).route("弄成三条给老板看", object_count=1)
    assert decision.tier == TIER_CLASSIFIED
    assert decision.reason == "model_classified"
    assert decision.recipe_id == "text.summarize_route"
    assert decision.parameters == {"bullets": 3}

    def unsure(command, summary, tools):
        return {"recipeId": "text__summarize_route", "confidence": 0.11}

    fallback = _router(tmp_path, classifier=unsure).route("弄成那种样子", object_count=1)
    assert fallback.tier == TIER_GENERAL


def test_a_classifier_that_raises_does_not_surface_an_error(tmp_path: Path) -> None:
    def broken(command, summary, tools):
        raise RuntimeError("gateway exploded")

    decision = _router(tmp_path, classifier=broken).route("看看这段有什么问题", object_count=1)
    assert decision.tier == TIER_GENERAL
    assert decision.action == ACT_TOOLS


def test_no_model_available_still_produces_an_answerable_decision(tmp_path: Path) -> None:
    router = _router(tmp_path)
    assert router.route("OCR一下", allow_model=False).recipe_id == "text.ocr_copy"
    offline = router.route("帮我看看这段写得怎么样", allow_model=False)
    assert offline.tier == TIER_GENERAL
    assert offline.action == "model_answer"


def test_disabled_recipes_are_not_routed_to(tmp_path: Path) -> None:
    router = _router(tmp_path, recipe_enabled={"text.ocr_copy": False})
    decision = router.route("OCR一下", object_count=1)
    assert decision.recipe_id != "text.ocr_copy"


def test_repeated_general_commands_are_offered_for_saving_then_become_fast(tmp_path: Path) -> None:
    router = _router(tmp_path)
    command = "帮我把这段变成小红书文案"
    for _ in range(2):
        assert router.route(command).suggest_saving is False
    third = router.route(command)
    assert third.suggest_saving is True

    router.library.save(command, recipe_id="text.rewrite_in_place", parameters={"style": "xiaohongshu"})
    saved = router.route(command)
    assert saved.tier == TIER_DETERMINISTIC
    assert saved.recipe_id == "text.rewrite_in_place"
    assert saved.parameters == {"style": "xiaohongshu"}
    assert saved.saved_instruction_id


def test_saved_instruction_matching_tolerates_polite_prefixes(tmp_path: Path) -> None:
    library = InstructionLibrary(tmp_path / "instructions.json")
    library.save("变成小红书文案", recipe_id="text.rewrite_in_place")
    router = IntentRouter(library=library)
    assert router.route("请变成小红书文案").recipe_id == "text.rewrite_in_place"


def test_empty_command_explains_the_object_rather_than_failing(tmp_path: Path) -> None:
    decision = _router(tmp_path).route("   ")
    assert decision.action == ACT_LOCAL
    assert decision.reason == "empty_command"


def test_recipe_tools_are_offered_to_the_model_and_map_back(tmp_path: Path) -> None:
    tools = recipe_tool_schemas()
    assert tools
    names = {tool["function"]["name"] for tool in tools}
    assert "text__ocr_copy" in names
    # System plumbing is not something a model should invoke mid-command.
    assert "activate__wiggle" not in names
    assert "governance__dashboard" not in names
    assert recipe_id_from_tool_name("text__ocr_copy") == "text.ocr_copy"
    assert recipe_id_from_tool_name("nonsense__tool") is None


def test_tool_list_respects_the_users_capability_switches() -> None:
    tools = recipe_tool_schemas(enabled={"text.ocr_copy": False})
    assert "text__ocr_copy" not in {tool["function"]["name"] for tool in tools}


def test_l0_does_not_steal_the_explicit_prefix_commands(tmp_path: Path) -> None:
    """These phrases belong to the context-pack / review features.

    "生成提示词：修复结账错误" is the compile command; an image-prompt rule that
    claimed "生成提示词" hijacked it, and the e2e test caught it. L0 must leave
    every prefix-owned command shape alone.
    """
    router = _router(tmp_path)
    for command in (
        "生成提示词：修复结账错误并运行测试",
        "收集：这是当前实现入口",
        "验收：这里的间距不对",
        "整理验收意见",
        "把验收意见填到这里",
    ):
        decision = router.route(command, object_count=1)
        assert decision.tier != TIER_DETERMINISTIC or decision.action != ACT_RECIPE, (command, decision)


def test_every_recipe_the_router_can_pick_has_a_provider() -> None:
    """A recipe in the catalog with no provider was a KeyError at run time.

    The provider now lives on the recipe in the manifest, so this checks the two
    can no longer drift apart.
    """
    from app.fabric.catalog import RECIPE_CATALOG
    from app.fabric.engine import provider_for_recipe

    for recipe in RECIPE_CATALOG:
        provider = provider_for_recipe(recipe.id)
        assert provider, recipe.id
        # "unavailable:<reason>" is a legitimate answer; a bare "unavailable" is not.
        if provider.startswith("unavailable"):
            assert provider.startswith("unavailable:"), (recipe.id, provider)
            assert len(provider.split(":", 1)[1]) > 3, (recipe.id, provider)
