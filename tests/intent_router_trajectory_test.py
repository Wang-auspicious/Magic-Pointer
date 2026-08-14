"""Trajectory-compiler routing path (recipe is a cache, not a destination).

The new ``route_to_trajectory`` entry returns 0..n ranked candidates compiled
from keyword hits (L0 deterministic rules merged with the trajectory
compiler's manifest keywords, score takes the max). No match means the free
loop (``L2_FALLBACK = None``); the legacy ``IntentRouter.route`` single-winner
API is untouched and regression-pinned here.
"""

from __future__ import annotations

from pathlib import Path

from app.agent_runtime.types import Trajectory
from app.fabric.intent_router import (
    ACT_LOCAL,
    ACT_RECIPE,
    ACT_TOOLS,
    L2_FALLBACK,
    TIER_DETERMINISTIC,
    InstructionLibrary,
    IntentRouter,
    LocalActionCandidate,
    TrajectoryCandidate,
    get_trajectory_compiler,
    route_to_trajectory,
)


def test_known_keyword_returns_matching_candidate() -> None:
    candidates = route_to_trajectory("复制这段文字")
    assert [c.trajectory.recipe_id for c in candidates] == ["text.ocr_copy"]
    candidate = candidates[0]
    assert isinstance(candidate, TrajectoryCandidate)
    assert candidate.score == 1.0
    assert "复制这段文字" in candidate.matched_keywords


def test_compiler_only_keyword_is_a_source_too() -> None:
    """'翻成英文' is a manifest keyword only — not an L0 rule phrase."""
    candidates = route_to_trajectory("翻成英文")
    assert [c.trajectory.recipe_id for c in candidates] == ["text.translate_in_place"]
    assert candidates[0].score == 0.5
    assert candidates[0].matched_keywords == ["翻成英文"]


def test_multiple_candidates_sorted_by_score_descending() -> None:
    candidates = route_to_trajectory("翻译成 并复制这段文字")
    assert [c.trajectory.recipe_id for c in candidates] == [
        "text.ocr_copy",       # 1.0 (L0 deterministic)
        "text.translate_in_place",  # 0.5 (partial manifest keyword)
    ]
    scores = [c.score for c in candidates]
    assert scores == sorted(scores, reverse=True)


def test_tied_candidates_break_by_legacy_l0_rule_order() -> None:
    """旧 L0 双命中破平：按 DETERMINISTIC_RULES 顺序恢复旧 winner，再按 id。

    旧路径 `_deterministic` 按 DETERMINISTIC_RULES tuple 序返回第一个命中：
    `整理后复制这段文字` 旧 winner=ocr_copy（先于 ocr_clean 的规则）、
    `让codex识别文字` 旧 winner=ocr_copy（先于 agent.handoff 的规则）。
    """
    candidates = route_to_trajectory("整理后复制这段文字")
    assert [c.trajectory.recipe_id for c in candidates] == [
        "text.ocr_copy",
        "text.ocr_clean",
    ]
    assert candidates[0].score == candidates[1].score == 1.0

    handoff = route_to_trajectory("让codex识别文字")
    assert [c.trajectory.recipe_id for c in handoff] == [
        "text.ocr_copy",
        "agent.handoff",
    ]
    assert handoff[0].score == handoff[1].score == 1.0


def test_merged_score_takes_the_max() -> None:
    """L0 gives 1.0; the compiler's partial manifest match gives 0.5."""
    candidate = route_to_trajectory("复制这段文字")[0]
    assert candidate.score == 1.0


def test_no_match_returns_empty_list_free_loop() -> None:
    assert route_to_trajectory("帮我把这段变成小红书文案") == []
    assert L2_FALLBACK is None


def test_non_destination_recipes_are_never_returned() -> None:
    assert route_to_trajectory("晃动一下") == []          # activate.wiggle
    assert route_to_trajectory("帮我看看这段写得怎么样") == []  # ground.this


def test_lang_selects_manifest_keyword_language() -> None:
    # 默认 zh 模式 = zh+en 并集（旧 L1 语义），en 关键词不再掉进自由循环。
    default = route_to_trajectory("clipboard history")
    assert [c.trajectory.recipe_id for c in default] == ["clipboard.history"]
    assert default[0].score == 0.5
    english = route_to_trajectory("clipboard history", lang="en")
    assert [c.trajectory.recipe_id for c in english] == ["clipboard.history"]
    assert english[0].score == 0.5


def test_information_questions_without_objects_go_to_free_loop() -> None:
    """知识问答（无圈选对象）绝不允许进 OCR/复制轨迹（旧 L0 守卫语义）。

    `What is OCR?` 含 L0 裸词 `ocr`，没有守卫会直接命中 OCR 轨迹并动剪贴板。
    """
    for command in ("What is OCR?", "什么是UIA", "解释一下这个协议"):
        assert route_to_trajectory(command) == [], command


def test_information_question_with_objects_is_not_restricted() -> None:
    """带圈选对象时守卫不生效：`怎么理解OCR` 可进 OCR 轨迹，无对象则自由循环。"""
    assert route_to_trajectory("怎么理解OCR") == []
    with_objects = route_to_trajectory("怎么理解OCR", objects=[{"id": 1}])
    assert [c.trajectory.recipe_id for c in with_objects] == ["text.ocr_copy"]


def test_english_keywords_are_reachable_in_default_zh_mode() -> None:
    candidates = route_to_trajectory("copy text")
    assert [c.trajectory.recipe_id for c in candidates] == ["text.ocr_copy"]
    assert candidates[0].score == 0.5
    assert "copy text" in candidates[0].matched_keywords


def test_english_keywords_are_case_insensitive() -> None:
    upper = route_to_trajectory("Copy Text")
    lower = route_to_trajectory("copy text")
    assert [(c.trajectory.recipe_id, c.score) for c in upper] == [
        (c.trajectory.recipe_id, c.score) for c in lower
    ]


def test_english_translate_keyword_reaches_translation_recipe() -> None:
    candidates = route_to_trajectory("translate")
    assert [c.trajectory.recipe_id for c in candidates] == ["text.translate_in_place"]


def test_local_action_rules_return_local_action_candidates() -> None:
    screenshot = route_to_trajectory("截图")
    assert [c.action for c in screenshot if isinstance(c, LocalActionCandidate)] == [
        "save_screenshot"
    ]
    pinyin = route_to_trajectory("截屏")
    assert [c.action for c in pinyin if isinstance(c, LocalActionCandidate)] == ["save_screenshot"]
    copy = route_to_trajectory("复制这个")
    assert [c.action for c in copy if isinstance(c, LocalActionCandidate)] == ["copy_object_text"]


def test_local_and_trajectory_candidates_can_coexist() -> None:
    candidates = route_to_trajectory("copy this text")
    actions = [c.action for c in candidates if isinstance(c, LocalActionCandidate)]
    recipes = [c.trajectory.recipe_id for c in candidates if isinstance(c, TrajectoryCandidate)]
    assert actions == ["copy_object_text"]
    assert recipes == ["text.ocr_copy"]


def test_enabled_recipes_gate_excludes_disabled() -> None:
    assert route_to_trajectory("复制这段文字") != []
    assert route_to_trajectory("复制这段文字", enabled_recipes={"text.ocr_clean"}) == []
    kept = route_to_trajectory("复制这段文字", enabled_recipes={"text.ocr_clean", "text.ocr_copy"})
    assert [c.trajectory.recipe_id for c in kept] == ["text.ocr_copy"]


def test_min_objects_gate_filters_candidates() -> None:
    # 1 个对象不够 table.merge 的 minObjects=2 → 候选被过滤
    assert route_to_trajectory("两个表合并", objects=[{"id": 1}]) == []
    merged = route_to_trajectory("两个表合并", objects=[{"id": 1}, {"id": 2}])
    assert [c.trajectory.recipe_id for c in merged] == ["table.merge"]
    # 未提供 objects（None）时不设限：调用方没有对象信息
    no_objects = route_to_trajectory("两个表合并")
    assert [c.trajectory.recipe_id for c in no_objects] == ["table.merge"]
    # 显式空列表 = 已知零对象：minObjects>0 的候选必须被过滤（review P2.11）
    assert route_to_trajectory("两个表合并", objects=[]) == []


def test_extra_recipes_can_be_matched() -> None:
    extra = {
        "plugin.super_tool": {
            "id": "plugin.super_tool",
            "description": "测试插件能力",
            "inputKinds": ["text"],
            "providerStrategies": ["model_provider"],
            "risk": "read",
            "minObjects": 1,
            "keywords": {"zh": ["超能力"], "en": ["superpower"]},
        }
    }
    hits = route_to_trajectory("用超能力处理", extra_recipes=extra)
    assert [c.trajectory.recipe_id for c in hits] == ["plugin.super_tool"]
    assert hits[0].score == 1.0
    assert "超能力" in hits[0].matched_keywords
    assert route_to_trajectory("用超能力处理") == []

    en_hits = route_to_trajectory("use superpower now", extra_recipes=extra)
    assert [c.trajectory.recipe_id for c in en_hits] == ["plugin.super_tool"]


def test_extra_recipe_risk_can_be_a_list() -> None:
    """A plugin entry with risk as a list must not crash routing (review P2.6).

    Before the fix ``"external_send" in {risk, provider}`` raised TypeError
    for an unhashable list risk value and killed route_to_trajectory.
    """
    extra = {
        "plugin.risky_tool": {
            "id": "plugin.risky_tool",
            "description": "测试风险插件",
            "inputKinds": ["text"],
            "providerStrategies": ["model_provider"],
            "risk": ["external_send"],
            "minObjects": 1,
            "keywords": {"zh": ["超能力"], "en": ["superpower"]},
        }
    }
    hits = route_to_trajectory("用超能力处理", extra_recipes=extra)
    assert [c.trajectory.recipe_id for c in hits] == ["plugin.risky_tool"]
    assert not hasattr(hits[0].trajectory, "max_turns")


def test_extra_recipe_unknown_shapes_return_no_candidates() -> None:
    """Malformed plugin entries fail soft: no candidates, no exceptions."""
    assert route_to_trajectory("随便", extra_recipes={"p.bad": "not-a-dict"}) == []
    assert route_to_trajectory("随便", extra_recipes={
        "p.bad": {"id": "p.bad", "description": "", "inputKinds": [], "providerStrategies": [], "risk": ""},
    }) == []


def test_objects_parameter_is_context_not_a_match_condition() -> None:
    plain = route_to_trajectory("复制这段文字")
    with_objects = route_to_trajectory("复制这段文字", objects=[{"id": 1}, {"id": 2}])
    assert [(c.trajectory.recipe_id, c.score, c.matched_keywords) for c in with_objects] == [
        (c.trajectory.recipe_id, c.score, c.matched_keywords) for c in plain
    ]


def test_compiler_singleton_is_lazily_shared() -> None:
    assert get_trajectory_compiler() is get_trajectory_compiler()


def test_empty_and_none_text_are_safe() -> None:
    assert route_to_trajectory("") == []
    assert route_to_trajectory("   ") == []
    assert route_to_trajectory(None) == []


def test_candidate_carries_a_compiled_trajectory() -> None:
    candidate = route_to_trajectory("复制这段文字")[0]
    assert isinstance(candidate.trajectory, Trajectory)
    assert candidate.trajectory.recipe_id == "text.ocr_copy"
    assert candidate.trajectory.first_user_message
    assert candidate.trajectory.recommended_tools
    assert not hasattr(candidate.trajectory, "max_turns")


def test_legacy_route_api_is_unchanged(tmp_path: Path) -> None:
    library = InstructionLibrary(tmp_path / "instructions.json")
    router = IntentRouter(library=library)
    assert router.route("OCR一下", object_count=1).tier == TIER_DETERMINISTIC
    assert router.route("OCR一下", object_count=1).action == ACT_RECIPE
    assert router.route("OCR一下", object_count=1).recipe_id == "text.ocr_copy"
    assert router.route("截图", object_count=1).local_action == "save_screenshot"
    assert router.route("截图", object_count=1).action == ACT_LOCAL
    empty = router.route("   ")
    assert empty.action == ACT_LOCAL
    assert empty.reason == "empty_command"
    general = router.route("帮我把这段变成小红书文案")
    assert general.action in (ACT_TOOLS, ACT_RECIPE)
