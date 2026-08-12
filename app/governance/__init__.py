"""Governance infrastructure: latency budgets and cancellation (review L8).

Pure Python, stdlib-only. No I/O, no Electron coupling, no UI automation.
"""

from .cancellation import (
    CancellationRegistry,
    CancellationScope,
    CancellationToken,
    CancelledError,
    cancel_all_in_flight,
    get_registry,
)
from .latency_budget import (
    DEFAULT_BUDGETS,
    BudgetPolicy,
    BudgetResult,
    Stage,
    TimeoutAction,
    check_budget,
    remaining_ms,
)

__all__ = [
    "DEFAULT_BUDGETS",
    "BudgetPolicy",
    "BudgetResult",
    "Stage",
    "TimeoutAction",
    "check_budget",
    "remaining_ms",
    "CancelledError",
    "CancellationRegistry",
    "CancellationScope",
    "CancellationToken",
    "cancel_all_in_flight",
    "get_registry",
]
