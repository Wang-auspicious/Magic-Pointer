"""Action guard: fail-closed preconditions that gate action execution."""

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
]
