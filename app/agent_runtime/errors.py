"""Agent runtime failure vocabulary.

Ported from the CC tool-execution study note
(docs/harness-port-notes/2026-08-12-cc-tool-execution.md): every action
failure is a structured, model-visible value, never a bare process error.
Pure Python, no I/O.
"""

from __future__ import annotations

import enum

MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 3


class FailureType(enum.StrEnum):
    STALE_ANCHOR = "stale_anchor"
    FOCUS_LOST = "focus_lost"
    CONTENT_CHANGED = "content_changed"
    BLOCKED_BY_MODAL = "blocked_by_modal"
    PERMISSION_DENIED = "permission_denied"
    TIMEOUT = "timeout"
    TOOL_ERROR = "tool_error"


_RETRYABLE = frozenset({FailureType.TIMEOUT, FailureType.FOCUS_LOST})


class ActionFailure(Exception):
    """A structured action failure with a known type and recovery hint."""

    def __init__(
        self,
        failure_type: FailureType,
        message: str,
        recovery_hint: str | None = None,
    ) -> None:
        super().__init__(message)
        self.failure_type = failure_type
        self.message = message
        self.recovery_hint = recovery_hint

    def is_retryable(self) -> bool:
        """True only for timeout / focus_lost; the rest never auto-retry."""
        return self.failure_type in _RETRYABLE
