
from __future__ import annotations

import enum
from collections.abc import Mapping
from dataclasses import dataclass


class Stage(enum.StrEnum):

    WAKE_DETECTION = "WAKE_DETECTION"
    CAPTURE_FREEZE = "CAPTURE_FREEZE"
    STRUCTURED_PERCEPTION = "STRUCTURED_PERCEPTION"
    FIRST_VISIBLE_FEEDBACK = "FIRST_VISIBLE_FEEDBACK"
    DRAFT_ANSWER = "DRAFT_ANSWER"
    FULL_ANSWER = "FULL_ANSWER"


class TimeoutAction(enum.StrEnum):

    ABANDON = "ABANDON"
    USE_PREVIOUS_FRAME = "USE_PREVIOUS_FRAME"
    MARK_TIMEOUT_CONTINUE = "MARK_TIMEOUT_CONTINUE"
    SHOW_PROGRESS = "SHOW_PROGRESS"
    STASH_BACKGROUND = "STASH_BACKGROUND"


@dataclass(frozen=True, slots=True)
class BudgetPolicy:

    stage: Stage
    budget_ms: int
    on_timeout: TimeoutAction


DEFAULT_BUDGETS: dict[Stage, BudgetPolicy] = {
    Stage.WAKE_DETECTION: BudgetPolicy(
        stage=Stage.WAKE_DETECTION,
        budget_ms=50,
        on_timeout=TimeoutAction.ABANDON,
    ),
    Stage.CAPTURE_FREEZE: BudgetPolicy(
        stage=Stage.CAPTURE_FREEZE,
        budget_ms=100,
        on_timeout=TimeoutAction.USE_PREVIOUS_FRAME,
    ),
    Stage.STRUCTURED_PERCEPTION: BudgetPolicy(
        stage=Stage.STRUCTURED_PERCEPTION,
        budget_ms=150,
        on_timeout=TimeoutAction.MARK_TIMEOUT_CONTINUE,
    ),
    Stage.FIRST_VISIBLE_FEEDBACK: BudgetPolicy(
        stage=Stage.FIRST_VISIBLE_FEEDBACK,
        budget_ms=300,
        on_timeout=TimeoutAction.SHOW_PROGRESS,
    ),
    Stage.DRAFT_ANSWER: BudgetPolicy(
        stage=Stage.DRAFT_ANSWER,
        budget_ms=800,
        on_timeout=TimeoutAction.SHOW_PROGRESS,
    ),
    Stage.FULL_ANSWER: BudgetPolicy(
        stage=Stage.FULL_ANSWER,
        budget_ms=4000,
        on_timeout=TimeoutAction.STASH_BACKGROUND,
    ),
}


@dataclass(frozen=True, slots=True)
class BudgetResult:

    stage: Stage
    elapsed_ms: float
    budget_ms: int
    within_budget: bool
    action: TimeoutAction | None
    overrun_ms: float


def check_budget(
    stage: Stage, elapsed_ms: float, budgets: Mapping[Stage, BudgetPolicy] = DEFAULT_BUDGETS
) -> BudgetResult:
    policy = budgets[stage]
    elapsed = float(elapsed_ms)
    within_budget = elapsed <= policy.budget_ms
    overrun_ms = max(0.0, elapsed - policy.budget_ms)
    return BudgetResult(
        stage=stage,
        elapsed_ms=elapsed,
        budget_ms=policy.budget_ms,
        within_budget=within_budget,
        action=None if within_budget else policy.on_timeout,
        overrun_ms=overrun_ms,
    )


def remaining_ms(
    stage: Stage, elapsed_ms: float, budgets: Mapping[Stage, BudgetPolicy]
) -> int:
    policy = budgets[stage]
    return int(policy.budget_ms - float(elapsed_ms))
