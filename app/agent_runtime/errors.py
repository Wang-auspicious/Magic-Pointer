"""Agent runtime failure vocabulary.

Ported from the CC tool-execution study note
(docs/harness-port-notes/2026-08-12-cc-tool-execution.md): every action
failure is a structured, model-visible value, never a bare process error.
Pure Python, no I/O.
"""

from __future__ import annotations

import enum

MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 3

#: Withhold reason for "the request did not fit in the model's context window".
#:
#: Distinct from a generic ``backend_error:http_400`` on purpose: the two need
#: opposite responses. A malformed request will be malformed again; an oversized
#: one becomes sendable as soon as the history is compacted. Before this existed
#: every 400 — including the one that means "your conversation is too long" —
#: fell through to a terminal ``PROVIDER_UNAVAILABLE``, so a long task died at
#: the exact moment compaction existed to save it.
CONTEXT_OVERFLOW_REASON = "context_overflow"

#: Substrings providers use to say "too many tokens". Deliberately matched
#: case-insensitively against the raw error body, because every vendor words it
#: differently and none of them guarantees a machine-readable code. Grouped by
#: vendor where the wording is distinctive.
CONTEXT_OVERFLOW_MARKERS = (
    # OpenAI / OpenAI-compatible
    "context_length_exceeded",
    "maximum context length",
    "reduce the length of the messages",
    "please reduce the length",
    # Anthropic
    "prompt is too long",
    "input length and `max_tokens` exceed context limit",
    "exceed context limit",
    # DeepSeek / Moonshot / Qwen / GLM family
    "context window",
    "too many tokens",
    "max_tokens is too large",
    "input is too long",
    "exceeds the maximum",
    "上下文长度",
    "超出最大",
    # Google / Vertex
    "input token count",
    "exceeds the maximum number of tokens",
)


def is_context_overflow_error(body: object) -> bool:
    """Does this provider error body mean "the request was too large"?

    Pure and total: any non-string-ish input is simply not a match.
    """
    text = str(body or "").casefold()
    if not text:
        return False
    return any(marker in text for marker in CONTEXT_OVERFLOW_MARKERS)


class FailureType(enum.StrEnum):
    STALE_ANCHOR = "stale_anchor"
    FOCUS_LOST = "focus_lost"
    CONTENT_CHANGED = "content_changed"
    BLOCKED_BY_MODAL = "blocked_by_modal"
    PERMISSION_DENIED = "permission_denied"
    TIMEOUT = "timeout"
    TOOL_ERROR = "tool_error"
    STALE_SNAPSHOT = "stale_snapshot"
    COMPUTER_USE_BUSY = "computer_use_busy"
    STEER_PENDING = "steer_pending"


_RETRYABLE = frozenset({
    FailureType.TIMEOUT,
    FailureType.FOCUS_LOST,
    FailureType.COMPUTER_USE_BUSY,
})


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
