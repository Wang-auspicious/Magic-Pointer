"""Explicit latency budgets (harness gap review L8).

Every pipeline stage carries a hard upper budget. When a stage exceeds its
budget it degrades immediately (per :class:`TimeoutAction`) instead of
blocking the whole interaction. Budget numbers come from the L8 review table.

This module is pure Python and has no I/O or platform dependencies.
"""

from __future__ import annotations

import enum
from collections.abc import Mapping
from dataclasses import dataclass


class Stage(enum.StrEnum):
    """Pipeline stages with an explicit latency budget."""

    WAKE_DETECTION = "WAKE_DETECTION"
    CAPTURE_FREEZE = "CAPTURE_FREEZE"
    STRUCTURED_PERCEPTION = "STRUCTURED_PERCEPTION"
    FIRST_VISIBLE_FEEDBACK = "FIRST_VISIBLE_FEEDBACK"
    DRAFT_ANSWER = "DRAFT_ANSWER"
    FULL_ANSWER = "FULL_ANSWER"


class TimeoutAction(enum.StrEnum):
    """Degradation action taken when a stage exceeds its budget."""

    ABANDON = "ABANDON"
    USE_PREVIOUS_FRAME = "USE_PREVIOUS_FRAME"
    MARK_TIMEOUT_CONTINUE = "MARK_TIMEOUT_CONTINUE"
    SHOW_PROGRESS = "SHOW_PROGRESS"
    STASH_BACKGROUND = "STASH_BACKGROUND"


@dataclass(frozen=True, slots=True)
class BudgetPolicy:
    """One row of the latency budget table."""

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
    """Outcome of one budget check."""

    stage: Stage
    elapsed_ms: float
    budget_ms: int
    within_budget: bool
    action: TimeoutAction | None
    overrun_ms: float


def check_budget(
    stage: Stage, elapsed_ms: float, budgets: Mapping[Stage, BudgetPolicy] = DEFAULT_BUDGETS
) -> BudgetResult:
    """Check ``elapsed_ms`` against the stage's budget.

    Within budget: ``action`` is ``None`` and ``overrun_ms`` is ``0.0``.
    Over budget: ``action`` is the stage's ``on_timeout`` and ``overrun_ms``
    is the non-negative overrun. Raises :class:`KeyError` when the stage is
    missing from ``budgets``.
    """
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
    """Milliseconds left in the stage budget; negative when over.

    Fractional input is truncated toward zero. Raises :class:`KeyError` when
    the stage is missing from ``budgets``.
    """
    policy = budgets[stage]
    return int(policy.budget_ms - float(elapsed_ms))
