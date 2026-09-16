"""Agent runtime failure vocabulary.

Ported from the CC tool-execution study note
(docs/harness-port-notes/2026-08-12-cc-tool-execution.md): every action
failure is a structured, model-visible value, never a bare process error.
Pure Python, no I/O.
"""

from __future__ import annotations

import enum

MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 3

#: Default output ceiling for a model turn, in tokens.
#:
#: It was 4096, spelled out at four separate call sites, and that number is the
#: whole reason a long turn used to die: 4096 output tokens is roughly 4000
#: Chinese characters, so writing a 200-line file, emitting one long patch, or
#: summarising a long command's output all land in the truncated band — and the
#: recovery path re-sent the request at the same 4096 until the ceiling above
#: gave up. Claude Code's default is 8000 with escalation to 64000; this is the
#: same shape. Escalation on truncation is
#: :func:`~app.agent_runtime.model_client.escalated_max_tokens`.
#:
#: Kept as a named constant and used by every call site so the number has one
#: home. Models with a smaller hard cap are unaffected: the provider rejects the
#: request and ``ai_client`` already retries without the optional fields.
DEFAULT_MAX_OUTPUT_TOKENS = 8_192

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
