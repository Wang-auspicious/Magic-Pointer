"""Request-level rough token estimation.

Ported from HermesAgent ``agent/model_metadata.py``
(``estimate_tokens_rough`` / ``estimate_messages_tokens_rough`` /
``estimate_request_tokens_rough``, MIT, Copyright (c) 2025 Nous Research).

Two things carried over from Hermes and one thing deliberately left behind:

- **Ceiling division at ~4 chars/token.** Floor division makes a turn full of
  short tool results estimate as nothing, which systematically under-counts
  exactly when compaction matters most.
- **The request is three buckets, not one.** System prompt and tool schemas
  are part of what the provider bills and what fills the window. Magic
  Pointer's system prompt carries memory (up to 4000 chars) and skills (up to
  12000); the desktop tool schemas add more. Counting messages alone made the
  compaction threshold fire far too late.
- Hermes also prices image parts at a flat 1500 tokens each. Magic Pointer's
  :class:`~app.agent_runtime.types.AgentMessage` carries ``content: str``, and
  vision results reach the loop as text, so there is no image branch here.

These are pre-flight estimates. Where a provider reports real ``prompt_tokens``
that number wins; this is for deciding when to compact before the call.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from typing import Any

__all__ = [
    "estimate_text_tokens",
    "estimate_messages_tokens",
    "estimate_request_tokens",
]

_CHARS_PER_TOKEN = 4


def estimate_text_tokens(text: str | None) -> int:
    """Rough token count for a blob of text, rounding up."""
    if not text:
        return 0
    return (len(text) + _CHARS_PER_TOKEN - 1) // _CHARS_PER_TOKEN


def _message_chars(message: Any) -> int:
    chars = len(getattr(message, "content", None) or "")
    tool_calls = getattr(message, "tool_calls", ()) or ()
    if tool_calls:
        chars += len(str(list(tool_calls)))
    return chars


def estimate_messages_tokens(messages: Iterable[Any]) -> int:
    """Rough token count for a message list, including tool-call envelopes."""
    total_chars = sum(_message_chars(m) for m in messages)
    if total_chars <= 0:
        return 0
    return (total_chars + _CHARS_PER_TOKEN - 1) // _CHARS_PER_TOKEN


def estimate_request_tokens(
    messages: Iterable[Any],
    *,
    system_prompt: str | None = None,
    tools: Sequence[dict[str, Any]] | None = None,
) -> int:
    """Rough token count for everything the loop sends in one model call."""
    total = estimate_messages_tokens(messages)
    total += estimate_text_tokens(system_prompt)
    if tools:
        total += estimate_text_tokens(str(list(tools)))
    return total
