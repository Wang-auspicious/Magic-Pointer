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

import re
import unicodedata

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

# Unicode 15.0 EastAsianWidth W/F ranges, compiled once so scanning stays in
# the regex engine instead of crossing Python -> unicodedata for every codepoint.
# This deliberately includes fullwidth forms and the wide emoji ranges: the
# estimator historically counted both, and dropping them would delay compaction.
_WIDE_RUN_RE = re.compile(
    "["
    r"\u1100-\u115F\u231A-\u231B\u2329-\u232A\u23E9-\u23EC\u23F0\u23F3\u25FD-\u25FE\u2614-\u2615"
    r"\u2648-\u2653\u267F\u2693\u26A1\u26AA-\u26AB\u26BD-\u26BE\u26C4-\u26C5\u26CE\u26D4\u26EA"
    r"\u26F2-\u26F3\u26F5\u26FA\u26FD\u2705\u270A-\u270B\u2728\u274C\u274E\u2753-\u2755\u2757"
    r"\u2795-\u2797\u27B0\u27BF\u2B1B-\u2B1C\u2B50\u2B55\u2E80-\u2E99\u2E9B-\u2EF3\u2F00-\u2FD5"
    r"\u2FF0-\u2FFB\u3000-\u303E\u3041-\u3096\u3099-\u30FF\u3105-\u312F\u3131-\u318E\u3190-\u31E3"
    r"\u31F0-\u321E\u3220-\u3247\u3250-\u4DBF\u4E00-\uA48C\uA490-\uA4C6\uA960-\uA97C\uAC00-\uD7A3"
    r"\uF900-\uFAFF\uFE10-\uFE19\uFE30-\uFE52\uFE54-\uFE66\uFE68-\uFE6B\uFF01-\uFF60\uFFE0-\uFFE6"
    r"\U00016FE0-\U00016FE4\U00016FF0-\U00016FF1\U00017000-\U000187F7\U00018800-\U00018CD5"
    r"\U00018D00-\U00018D08\U0001AFF0-\U0001AFF3\U0001AFF5-\U0001AFFB\U0001AFFD-\U0001AFFE"
    r"\U0001B000-\U0001B122\U0001B132\U0001B150-\U0001B152\U0001B155\U0001B164-\U0001B167"
    r"\U0001B170-\U0001B2FB\U0001F004\U0001F0CF\U0001F18E\U0001F191-\U0001F19A"
    r"\U0001F200-\U0001F202\U0001F210-\U0001F23B\U0001F240-\U0001F248\U0001F250-\U0001F251"
    r"\U0001F260-\U0001F265\U0001F300-\U0001F320\U0001F32D-\U0001F335\U0001F337-\U0001F37C"
    r"\U0001F37E-\U0001F393\U0001F3A0-\U0001F3CA\U0001F3CF-\U0001F3D3\U0001F3E0-\U0001F3F0"
    r"\U0001F3F4\U0001F3F8-\U0001F43E\U0001F440\U0001F442-\U0001F4FC\U0001F4FF-\U0001F53D"
    r"\U0001F54B-\U0001F54E\U0001F550-\U0001F567\U0001F57A\U0001F595-\U0001F596\U0001F5A4"
    r"\U0001F5FB-\U0001F64F\U0001F680-\U0001F6C5\U0001F6CC\U0001F6D0-\U0001F6D2"
    r"\U0001F6D5-\U0001F6D7\U0001F6DC-\U0001F6DF\U0001F6EB-\U0001F6EC\U0001F6F4-\U0001F6FC"
    r"\U0001F7E0-\U0001F7EB\U0001F7F0\U0001F90C-\U0001F93A\U0001F93C-\U0001F945"
    r"\U0001F947-\U0001F9FF\U0001FA70-\U0001FA7C\U0001FA80-\U0001FA88\U0001FA90-\U0001FABD"
    r"\U0001FABF-\U0001FAC5\U0001FACE-\U0001FADB\U0001FAE0-\U0001FAE8\U0001FAF0-\U0001FAF8"
    r"\U00020000-\U0002FFFD\U00030000-\U0003FFFD"
    "]+"
)

_FRAGMENT_SAMPLE_CHARS = 1024
_FRAGMENT_TRANSITION_LIMIT = 64
_MESSAGE_BATCH_CHARS = 64 * 1024


def _count_wide_legacy(text: str) -> int:
    return sum(
        1
        for character in text
        if unicodedata.east_asian_width(character) in ("W", "F")
    )


def _has_fragmented_wide_runs(text: str) -> bool:
    """Sample three local windows before choosing the regex fast path.

    A regex is fast for prose-sized wide runs but slower for alternating
    ``a中a中...`` because every one-character run becomes a match. Sampling is
    bounded; fragmented text falls back to the legacy scan instead of paying
    that allocation cost across the full context.
    """
    width = _FRAGMENT_SAMPLE_CHARS
    middle = max(0, len(text) // 2 - width // 2)
    sample = text[:width] + text[middle:middle + width] + text[-width:]
    previous: bool | None = None
    transitions = 0
    for character in sample:
        current = unicodedata.east_asian_width(character) in ("W", "F")
        if previous is not None and current != previous:
            transitions += 1
            if transitions >= _FRAGMENT_TRANSITION_LIMIT:
                return True
        previous = current
    return False


def _count_cjk(text: str) -> int:
    if text.isascii():
        return 0
    if len(text) < _FRAGMENT_SAMPLE_CHARS * 3 or _has_fragmented_wide_runs(text):
        return _count_wide_legacy(text)
    # ``sub`` materializes one final string, not one Python object per match.
    # The sampled path above keeps highly fragmented text away from regex.
    return len(text) - len(_WIDE_RUN_RE.sub("", text))


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


def _message_text(message: Any) -> str:
    """Text counted for one message, including tool-call envelopes."""
    content = getattr(message, "content", None) or ""
    tool_calls = getattr(message, "tool_calls", ()) or ()
    if tool_calls:
        content = f"{content}{list(tool_calls)}"
    return content


def estimate_messages_tokens(messages: Iterable[Any]) -> int:
    """Rough token count for a message list, including tool-call envelopes."""
    cjk_total = 0
    other_total = 0
    batch: list[str] = []
    batch_chars = 0
    for message in messages:
        text = _message_text(message)
        if not text:
            continue
        batch.append(text)
        batch_chars += len(text)
        if batch_chars < _MESSAGE_BATCH_CHARS:
            continue
        joined = "".join(batch)
        cjk = _count_cjk(joined)
        cjk_total += cjk
        other_total += len(joined) - cjk
        batch.clear()
        batch_chars = 0
    if batch:
        joined = "".join(batch)
        cjk = _count_cjk(joined)
        cjk_total += cjk
        other_total += len(joined) - cjk
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
