"""Tests for latency budget infrastructure (harness gap review L8).

Covers: enum surfaces, the six-stage default budget table with exact values
from the review, within/overrun judgement including the exact boundary,
overrun accounting, custom budget override, missing-stage errors, frozen
dataclasses, and remaining_ms semantics.
"""

import dataclasses

import pytest

from app.governance import (
    DEFAULT_BUDGETS,
    BudgetPolicy,
    BudgetResult,
    Stage,
    TimeoutAction,
    check_budget,
    remaining_ms,
)

EXPECTED_TABLE: dict[Stage, tuple[int, TimeoutAction]] = {
    Stage.WAKE_DETECTION: (50, TimeoutAction.ABANDON),
    Stage.CAPTURE_FREEZE: (100, TimeoutAction.USE_PREVIOUS_FRAME),
    Stage.STRUCTURED_PERCEPTION: (150, TimeoutAction.MARK_TIMEOUT_CONTINUE),
    Stage.FIRST_VISIBLE_FEEDBACK: (300, TimeoutAction.SHOW_PROGRESS),
    Stage.DRAFT_ANSWER: (800, TimeoutAction.SHOW_PROGRESS),
    Stage.FULL_ANSWER: (4000, TimeoutAction.STASH_BACKGROUND),
}


class TestStageEnum:
    def test_stage_has_all_six_contract_members(self) -> None:
        assert {s.value for s in Stage} == {
            "WAKE_DETECTION",
            "CAPTURE_FREEZE",
            "STRUCTURED_PERCEPTION",
            "FIRST_VISIBLE_FEEDBACK",
            "DRAFT_ANSWER",
            "FULL_ANSWER",
        }

    def test_stage_is_str_enum(self) -> None:
        assert Stage("WAKE_DETECTION") is Stage.WAKE_DETECTION
        assert Stage("FULL_ANSWER") is Stage.FULL_ANSWER


class TestTimeoutActionEnum:
    def test_timeout_action_has_all_five_contract_members(self) -> None:
        assert {a.value for a in TimeoutAction} == {
            "ABANDON",
            "USE_PREVIOUS_FRAME",
            "MARK_TIMEOUT_CONTINUE",
            "SHOW_PROGRESS",
            "STASH_BACKGROUND",
        }

    def test_timeout_action_is_str_enum(self) -> None:
        assert TimeoutAction("STASH_BACKGROUND") is TimeoutAction.STASH_BACKGROUND


class TestBudgetPolicyDataclass:
    def test_policy_fields_and_frozen(self) -> None:
        policy = BudgetPolicy(
            stage=Stage.WAKE_DETECTION, budget_ms=50, on_timeout=TimeoutAction.ABANDON
        )
        assert policy.stage is Stage.WAKE_DETECTION
        assert policy.budget_ms == 50
        assert policy.on_timeout is TimeoutAction.ABANDON
        with pytest.raises(dataclasses.FrozenInstanceError):
            policy.budget_ms = 999


class TestDefaultBudgets:
    def test_default_budgets_cover_exactly_all_six_stages(self) -> None:
        assert set(DEFAULT_BUDGETS) == set(Stage)

    def test_default_budget_values_match_review_table_exactly(self) -> None:
        for stage, (budget, action) in EXPECTED_TABLE.items():
            policy = DEFAULT_BUDGETS[stage]
            assert policy.stage is stage
            assert policy.budget_ms == budget
            assert policy.on_timeout is action

    def test_default_policies_are_budget_policy_instances(self) -> None:
        assert all(isinstance(p, BudgetPolicy) for p in DEFAULT_BUDGETS.values())


class TestCheckBudgetWithin:
    @pytest.mark.parametrize(
        ("stage", "elapsed"),
        [
            (Stage.WAKE_DETECTION, 0.0),
            (Stage.WAKE_DETECTION, 49.9),
            (Stage.CAPTURE_FREEZE, 100.0),
            (Stage.STRUCTURED_PERCEPTION, 150),
            (Stage.FIRST_VISIBLE_FEEDBACK, 0.0),
            (Stage.DRAFT_ANSWER, 799.9),
            (Stage.FULL_ANSWER, 3999.0),
        ],
    )
    def test_within_budget_fields(self, stage: Stage, elapsed: float) -> None:
        result = check_budget(stage, elapsed)
        assert result.stage is stage
        assert result.elapsed_ms == float(elapsed)
        assert result.budget_ms == DEFAULT_BUDGETS[stage].budget_ms
        assert result.within_budget is True
        assert result.action is None
        assert result.overrun_ms == 0.0

    def test_exact_boundary_is_within(self) -> None:
        result = check_budget(Stage.FULL_ANSWER, 4000)
        assert result.within_budget is True
        assert result.action is None
        assert result.overrun_ms == 0.0

    def test_negative_elapsed_is_within_with_zero_overrun(self) -> None:
        result = check_budget(Stage.WAKE_DETECTION, -5.0)
        assert result.within_budget is True
        assert result.action is None
        assert result.overrun_ms == 0.0


class TestCheckBudgetOver:
    @pytest.mark.parametrize(
        ("stage", "elapsed", "expected_overrun"),
        [
            (Stage.WAKE_DETECTION, 50.5, 0.5),
            (Stage.WAKE_DETECTION, 60, 10),
            (Stage.CAPTURE_FREEZE, 150, 50),
            (Stage.STRUCTURED_PERCEPTION, 151.0, 1.0),
            (Stage.FIRST_VISIBLE_FEEDBACK, 300.001, 0.001),
            (Stage.DRAFT_ANSWER, 900, 100),
            (Stage.FULL_ANSWER, 4000.5, 0.5),
        ],
    )
    def test_over_budget_returns_timeout_action_and_overrun(
        self, stage: Stage, elapsed: float, expected_overrun: float
    ) -> None:
        result = check_budget(stage, elapsed)
        assert result.within_budget is False
        assert result.action is DEFAULT_BUDGETS[stage].on_timeout
        assert result.overrun_ms == pytest.approx(expected_overrun)
        assert result.budget_ms == DEFAULT_BUDGETS[stage].budget_ms

    def test_overrun_is_never_negative(self) -> None:
        result = check_budget(Stage.DRAFT_ANSWER, 1000)
        assert result.overrun_ms == pytest.approx(200)


class TestCustomBudgets:
    def test_custom_budget_overrides_stage_and_others_fallback(self) -> None:
        custom = dict(DEFAULT_BUDGETS)
        custom[Stage.WAKE_DETECTION] = BudgetPolicy(
            stage=Stage.WAKE_DETECTION,
            budget_ms=5000,
            on_timeout=TimeoutAction.SHOW_PROGRESS,
        )
        inside = check_budget(Stage.WAKE_DETECTION, 1000, budgets=custom)
        assert inside.within_budget is True
        assert inside.action is None
        outside = check_budget(Stage.WAKE_DETECTION, 6000, budgets=custom)
        assert outside.within_budget is False
        assert outside.action is TimeoutAction.SHOW_PROGRESS
        assert outside.overrun_ms == pytest.approx(1000)
        untouched = check_budget(Stage.CAPTURE_FREEZE, 101, budgets=custom)
        assert untouched.action is TimeoutAction.USE_PREVIOUS_FRAME


class TestMissingStage:
    def test_check_budget_raises_keyerror_when_table_empty(self) -> None:
        with pytest.raises(KeyError):
            check_budget(Stage.FULL_ANSWER, 1.0, budgets={})

    def test_check_budget_raises_keyerror_when_stage_absent(self) -> None:
        partial = {Stage.WAKE_DETECTION: DEFAULT_BUDGETS[Stage.WAKE_DETECTION]}
        with pytest.raises(KeyError):
            check_budget(Stage.CAPTURE_FREEZE, 1.0, budgets=partial)

    def test_remaining_ms_raises_keyerror_when_stage_absent(self) -> None:
        with pytest.raises(KeyError):
            remaining_ms(Stage.FULL_ANSWER, 1.0, budgets={})


class TestRemainingMs:
    def test_positive_remaining(self) -> None:
        assert remaining_ms(Stage.WAKE_DETECTION, 20, DEFAULT_BUDGETS) == 30

    def test_negative_remaining(self) -> None:
        assert remaining_ms(Stage.WAKE_DETECTION, 80, DEFAULT_BUDGETS) == -30

    def test_zero_at_boundary(self) -> None:
        assert remaining_ms(Stage.FULL_ANSWER, 4000, DEFAULT_BUDGETS) == 0

    def test_respects_custom_budgets(self) -> None:
        custom = dict(DEFAULT_BUDGETS)
        custom[Stage.CAPTURE_FREEZE] = BudgetPolicy(
            stage=Stage.CAPTURE_FREEZE,
            budget_ms=250,
            on_timeout=TimeoutAction.USE_PREVIOUS_FRAME,
        )
        assert remaining_ms(Stage.CAPTURE_FREEZE, 100, custom) == 150

    def test_truncates_fractional_elapsed(self) -> None:
        assert remaining_ms(Stage.WAKE_DETECTION, 20.5, DEFAULT_BUDGETS) == 29


class TestBudgetResult:
    def test_result_is_frozen(self) -> None:
        result = check_budget(Stage.WAKE_DETECTION, 60)
        with pytest.raises(dataclasses.FrozenInstanceError):
            result.within_budget = True

    def test_result_is_budget_result_instance(self) -> None:
        assert isinstance(check_budget(Stage.WAKE_DETECTION, 10), BudgetResult)
