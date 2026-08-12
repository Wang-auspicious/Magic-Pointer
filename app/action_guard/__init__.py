"""Action guard: fail-closed preconditions and egress checks that gate actions."""

from app.action_guard.egress_gate import (
    EgressAudit,
    EgressDecision,
    EgressDeniedError,
    EgressEvent,
    EgressGate,
    EgressScope,
)
from app.action_guard.preconditions import (
    ContentUnchanged,
    NoModalSince,
    Precondition,
    PreconditionContext,
    ResolvedExact,
    TargetFocused,
    check_all,
)

__all__ = [
    "Precondition",
    "PreconditionContext",
    "ResolvedExact",
    "TargetFocused",
    "ContentUnchanged",
    "NoModalSince",
    "check_all",
    "EgressAudit",
    "EgressDecision",
    "EgressDeniedError",
    "EgressEvent",
    "EgressGate",
    "EgressScope",
]
