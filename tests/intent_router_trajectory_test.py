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


def test_tied_candidates_break_by_recipe_id_ascending() -> None:
    candidates = route_to_trajectory("整理后复制这段文字")
    assert [c.trajectory.recipe_id for c in candidates] == [
        "text.ocr_clean",
        "text.ocr_copy",
    ]
    assert candidates[0].score == candidates[1].score == 1.0


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
    assert route_to_trajectory("clipboard history") == []
    english = route_to_trajectory("clipboard history", lang="en")
    assert [c.trajectory.recipe_id for c in english] == ["clipboard.history"]
    assert english[0].score == 0.5


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
    assert candidate.trajectory.max_turns >= 3


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
