"""Tests for the recipe manifest -> trajectory compiler (L1 recipe-as-cache).

Covers compiling all 39 builtin recipes, per-field compilation rules
(first_user_message template, providerStrategy -> tool mapping, risk
passthrough), honest skip/error recording for corrupt entries,
clear failure for a missing manifest, keyword matching scoring/sorting and
loop-consumability of the compiled Trajectory (construct-only, never run).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.agent_runtime.loop import LoopParams  # noqa: E402
from app.agent_runtime.model_client import LoopModelClient  # noqa: E402
from app.agent_runtime.recipe_cache import (  # noqa: E402
    BUILTIN_RECIPES_PATH,
    TrajectoryCompiler,
)
from app.agent_runtime.tool_registry import ToolRegistry  # noqa: E402

_BUILTIN_COUNT = 39
_VALID_RISKS = {"read", "local_write", "external_send"}


class _NoopBackend:
    """ModelBackend duck-type that never produces events (never invoked)."""

    def generate(self, messages, tools, budget_ms=None, cancel_scope=None):
        yield from ()


def _write_manifest(path: Path, recipes: list) -> Path:
    path.write_text(
        json.dumps({"schemaVersion": 1, "recipes": recipes}, ensure_ascii=False),
        encoding="utf-8",
    )
    return path


def _tmp_compiler(tmp_path: Path, recipes: list) -> TrajectoryCompiler:
    return TrajectoryCompiler(_write_manifest(tmp_path / "recipes.json", recipes))


def test_builtin_compile_all_succeeds_39():
    compiler = TrajectoryCompiler()
    compiled = compiler.compile_all()

    assert len(compiled) == _BUILTIN_COUNT
    assert compiler.errors == []
    ids = compiler.all_ids()
    assert len(ids) == _BUILTIN_COUNT
    assert len(set(ids)) == _BUILTIN_COUNT
    assert "text.ocr_copy" in ids
    assert "memory.recall" in ids


def test_every_trajectory_field_is_valid():
    compiler = TrajectoryCompiler()
    compiled = compiler.compile_all()

    for trajectory in compiled.values():
        assert trajectory.recipe_id in compiled
        assert "目标：" in trajectory.first_user_message
        assert "请执行该任务" in trajectory.first_user_message
        assert trajectory.recommended_tools
        assert "describe_capabilities" in trajectory.recommended_tools
        assert not hasattr(trajectory, "max_turns")
        assert trajectory.risk in _VALID_RISKS


def test_unknown_recipe_id_returns_none():
    compiler = TrajectoryCompiler()
    compiler.compile_all()

    assert compiler.compile_trajectory("no.such.recipe") is None


def test_compile_trajectory_lazy_compiles_without_compile_all():
    compiler = TrajectoryCompiler()

    trajectory = compiler.compile_trajectory("text.ocr_copy")

    assert trajectory is not None
    assert trajectory.recipe_id == "text.ocr_copy"
    assert compiler.compile_trajectory("no.such.recipe") is None


def test_match_keywords_full_hit_scores_1_0():
    compiler = TrajectoryCompiler()
    compiler.compile_all()

    results = compiler.match_keywords("复制这段文字，识别文字，提取文字，复制这段")

    assert ("text.ocr_copy", 1.0) in results
    assert results[0] == ("text.ocr_copy", 1.0)


def test_match_keywords_partial_hit_scores_0_5():
    compiler = TrajectoryCompiler()
    compiler.compile_all()

    results = compiler.match_keywords("帮我复制这段文字吧")

    assert ("text.ocr_copy", 0.5) in results


def test_match_keywords_no_hit_returns_empty():
    compiler = TrajectoryCompiler()
    compiler.compile_all()

    assert compiler.match_keywords("你好世界") == []
    assert compiler.match_keywords("") == []


def test_match_keywords_sorted_descending_by_score():
    compiler = TrajectoryCompiler()
    compiler.compile_all()

    results = compiler.match_keywords("复制这段文字，识别文字，提取文字，复制这段")

    scores = [score for _, score in results]
    assert scores == sorted(scores, reverse=True)
    assert ("ground.this", 0.5) in results


def test_match_keywords_english_lang():
    compiler = TrajectoryCompiler()
    compiler.compile_all()

    assert ("text.ocr_copy", 1.0) in compiler.match_keywords("copy text ocr", lang="en")
    assert ("text.ocr_copy", 0.5) in compiler.match_keywords("please copy text now", lang="en")
    assert compiler.match_keywords("nothing relevant", lang="en") == []


def test_match_keywords_default_lang_is_zh_plus_en_union():
    """默认 zh 模式必须保留旧 L1 的 zh+en 并集打分（en 关键词不再丢失）。"""
    compiler = TrajectoryCompiler()
    compiler.compile_all()

    assert ("text.ocr_copy", 0.5) in compiler.match_keywords("copy text")
    assert ("text.translate_in_place", 1.0) in compiler.match_keywords("translate")
    assert ("clipboard.history", 0.5) in compiler.match_keywords("clipboard history")


def test_match_keywords_en_matching_is_case_insensitive():
    compiler = TrajectoryCompiler()
    compiler.compile_all()

    assert ("text.ocr_copy", 0.5) in compiler.match_keywords("Copy Text")
    assert ("text.translate_in_place", 1.0) in compiler.match_keywords("Translate")


def test_corrupt_entry_missing_id_skipped_and_recorded(tmp_path):
    recipes = [
        {
            "title": "missing id",
            "description": "该条目缺 id，应跳过。",
            "inputKinds": ["text"],
            "providerStrategies": ["native_ocr"],
            "risk": "read",
        },
        {
            "id": "ok.one",
            "title": "ok",
            "description": "正常条目",
            "inputKinds": ["text"],
            "providerStrategies": ["native_ocr"],
            "risk": "read",
            "minObjects": 1,
            "provider": "internal",
        },
    ]
    compiler = _tmp_compiler(tmp_path, recipes)
    compiled = compiler.compile_all()

    assert list(compiled) == ["ok.one"]
    assert len(compiler.errors) == 1
    assert "id" in compiler.errors[0]
    assert compiler.compile_trajectory("ok.one") is not None


def test_missing_file_raises_clear_error(tmp_path):
    missing = tmp_path / "missing.recipes.json"

    with pytest.raises(FileNotFoundError, match="missing.recipes.json"):
        TrajectoryCompiler(missing)


def test_manifest_without_recipes_list_raises_value_error(tmp_path):
    path = _write_manifest(tmp_path / "bad.json", [])
    path.write_text(json.dumps({"schemaVersion": 1}), encoding="utf-8")

    with pytest.raises(ValueError, match="recipes"):
        TrajectoryCompiler(path)


def test_recipe_metadata_cannot_define_agent_loop_lifetime():
    compiler = TrajectoryCompiler()
    compiled = compiler.compile_all()

    assert all(not hasattr(trajectory, "max_turns") for trajectory in compiled.values())


def test_recommended_tools_provider_mapping():
    compiler = TrajectoryCompiler()
    compiled = compiler.compile_all()

    assert compiled["ground.this"].recommended_tools == (
        "describe_capabilities",
        "read_around",
        "look",
    )
    assert compiled["text.ocr_copy"].recommended_tools == (
        "describe_capabilities",
        "read_around",
    )
    assert compiled["text.rewrite_in_place"].recommended_tools == ("describe_capabilities",)


def test_first_user_message_template():
    compiler = TrajectoryCompiler()
    compiled = compiler.compile_all()

    assert compiled["text.ocr_copy"].first_user_message == (
        "目标：从不可复制的屏幕区域识别文字并直接复制。"
        "对象：image、screen_region。"
        "请执行该任务，必要时使用感知工具确认对象。"
    )


def test_risk_passthrough():
    compiler = TrajectoryCompiler()
    compiled = compiler.compile_all()

    assert compiled["activate.wiggle"].risk == "read"
    assert compiled["text.ocr_copy"].risk == "local_write"
    assert compiled["agent.handoff"].risk == "external_send"


def test_compile_all_idempotent_and_errors_reset():
    compiler = TrajectoryCompiler()
    first = compiler.compile_all()
    second = compiler.compile_all()

    assert first == second
    assert compiler.errors == []
    assert compiler.all_ids() == list(second)


def test_trajectory_consumable_by_loop_params():
    compiler = TrajectoryCompiler()
    compiled = compiler.compile_all()
    trajectory = compiled["text.ocr_copy"]

    params = LoopParams(
        user_input=trajectory.first_user_message,
        registry=ToolRegistry(),
        client=LoopModelClient(_NoopBackend()),
        trajectory=trajectory,
    )

    assert params.trajectory is trajectory
    assert params.user_input == trajectory.first_user_message
    assert "describe_capabilities" in params.trajectory.recommended_tools


def test_builtin_path_points_at_manifest():
    assert BUILTIN_RECIPES_PATH.is_file()
    data = json.loads(BUILTIN_RECIPES_PATH.read_text(encoding="utf-8"))
    assert len(data["recipes"]) == _BUILTIN_COUNT
