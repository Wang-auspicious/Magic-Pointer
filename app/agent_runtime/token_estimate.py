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
_CJK_CHARS_PER_TOKEN = 1
"""CJK scripts tokenize at roughly one token per character (mimo/deepseek/
gpt families all land near 1.0-1.5); English averages ~4 chars/token. The
real-machine notepad-edit run proved the flat 4-char rate underestimates an
all-Chinese desktop context by ~2x (real prompt_tokens 86k while the
estimator said ~48k), which delayed compaction by whole rounds. Text is
therefore counted in two buckets: CJK codepoints at 1 token each, everything
else at 4 chars per token."""


def _count_cjk(text: str) -> int:
    import unicodedata

    return sum(
        1
        for ch in text
        if unicodedata.east_asian_width(ch) in ("W", "F")
    )


def estimate_text_tokens(text: str | None) -> int:
    """Rough token count for a blob of text, rounding up."""
    if not text:
        return 0
    cjk = _count_cjk(text)
    other = len(text) - cjk
    tokens = cjk * _CJK_CHARS_PER_TOKEN
    if other:
        tokens += (other + _CHARS_PER_TOKEN - 1) // _CHARS_PER_TOKEN
    return tokens


def _message_chars(message: Any) -> tuple[int, int]:
    """(cjk_chars, other_chars) for one message, tool-call envelopes included."""
    content = getattr(message, "content", None) or ""
    tool_calls = getattr(message, "tool_calls", ()) or ()
    if tool_calls:
        content = f"{content}{list(tool_calls)}"
    cjk = _count_cjk(content)
    return cjk, len(content) - cjk


def estimate_messages_tokens(messages: Iterable[Any]) -> int:
    """Rough token count for a message list, including tool-call envelopes."""
    cjk_total = 0
    other_total = 0
    for message in messages:
        cjk, other = _message_chars(message)
        cjk_total += cjk
        other_total += other
    tokens = cjk_total * _CJK_CHARS_PER_TOKEN
    if other_total:
        tokens += (other_total + _CHARS_PER_TOKEN - 1) // _CHARS_PER_TOKEN
    return tokens


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
