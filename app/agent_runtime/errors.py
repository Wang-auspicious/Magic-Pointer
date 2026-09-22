
from __future__ import annotations

import enum

MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 3

DEFAULT_MAX_OUTPUT_TOKENS = 8_192

CONTEXT_OVERFLOW_REASON = "context_overflow"

CONTEXT_OVERFLOW_MARKERS = (
    "context_length_exceeded",
    "maximum context length",
    "reduce the length of the messages",
    "please reduce the length",
    "prompt is too long",
    "input length and `max_tokens` exceed context limit",
    "exceed context limit",
    "context window",
    "too many tokens",
    "max_tokens is too large",
    "input is too long",
    "exceeds the maximum",
    "上下文长度",
    "超出最大",
    "input token count",
    "exceeds the maximum number of tokens",
)


def is_context_overflow_error(body: object) -> bool:
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

    def __init__(
        self,
        failure_type: FailureType,
        message: str,
        recovery_hint: str | None = None,
        *,
        partial_result: object = None,
    ) -> None:
        super().__init__(message)
        self.failure_type = failure_type
        self.message = message
        self.recovery_hint = recovery_hint
        self.partial_result = partial_result

    def is_retryable(self) -> bool:
        return self.failure_type in _RETRYABLE
