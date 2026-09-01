from __future__ import annotations

from types import SimpleNamespace

from app.agent_runtime.loop import _over_compact_threshold
from app.agent_runtime.model_profiles import context_budget_for, context_window_for


def test_context_window_uses_longest_known_family_prefix() -> None:
    assert context_window_for("gpt-4o-mini") == 128_000
    assert context_window_for("qwen3-coder-plus") == 256_000


def test_current_frontier_model_windows_are_not_collapsed_to_legacy_defaults() -> None:
    assert context_window_for("gpt-5.1") == 400_000
    assert context_window_for("gpt-5.4-mini") == 400_000
    assert context_window_for("gpt-5.4") == 1_050_000
    assert context_window_for("gpt-5.5") == 1_050_000
    assert context_window_for("gpt-5.6-sol") == 1_050_000
    assert context_window_for("claude-opus-5") == 1_000_000
    assert context_window_for("claude-sonnet-5") == 1_000_000
    assert context_window_for("claude-haiku-4-5") == 200_000


def test_provider_qualified_model_ids_match_their_model_family_suffix() -> None:
    assert context_window_for("openai/gpt-5.6-sol") == 1_050_000
    assert context_window_for("anthropic/claude-sonnet-5-20260801") == 1_000_000
    assert context_window_for("gateway/deepseek-v4-flash") == 128_000
    assert context_window_for("vendor/unknown-model") == 64_000


def test_context_budget_is_the_real_window_not_a_second_safety_discount() -> None:
    assert context_budget_for("claude-sonnet-5") == 1_000_000
    assert context_budget_for("gpt-5.1") == 400_000


def test_only_the_loop_owns_the_compaction_safety_margin() -> None:
    params = SimpleNamespace(
        token_estimator=lambda _messages: 750,
        context_budget_tokens=1_000,
    )
    assert _over_compact_threshold(params, [], 0) is False

    params.token_estimator = lambda _messages: 850
    assert _over_compact_threshold(params, [], 0) is True
