"""Sensitive content detection and in-place redaction (harness gap review L10).

Sensitive text is redacted **at the source**: the redacted form is what goes
into the context packet, the original is never forwarded. Detection is
conservative:

- credit card: 16 digits (optionally space/hyphen separated) that pass the
  Luhn checksum;
- ID card: 18-character ``\\d{17}[\\dXx]`` pattern (no checksum);
- phone: exactly 11 consecutive digits matching ``1[3-9]\\d{9}``.

Every hit keeps the first 4 and last 4 characters of the matched span and
masks the middle with ``*``. Overlapping hits are merged into one span.

``PASSWORD_FIELD_MARKER`` is the future hook point for the UIA ``IsPassword``
property; no real UIA wiring happens in this batch.

This module is pure Python and has no I/O or platform dependencies.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

PASSWORD_FIELD_MARKER = "is_password"

CREDIT_CARD_PATTERN = "credit_card"
ID_CARD_PATTERN = "id_card"
PHONE_PATTERN = "phone"

_CREDIT_CARD_RE = re.compile(r"(?<!\d)(?:\d[ -]?){15}\d(?!\d)")
_ID_CARD_RE = re.compile(r"(?<!\d)\d{17}[\dXx](?!\d)")
_PHONE_RE = re.compile(r"(?<!\d)1[3-9]\d{9}(?!\d)")

_REMOVE_SEPARATORS = re.compile(r"[ -]")


def _luhn_valid(digits: str) -> bool:
    """Standard Luhn checksum over a digit-only string."""
    total = 0
    for i, char in enumerate(reversed(digits)):
        value = int(char)
        if i % 2 == 1:
            value *= 2
            if value > 9:
                value -= 9
        total += value
    return total % 10 == 0


@dataclass(frozen=True, slots=True)
class RedactionHit:
    """One redacted span within the source text."""

    pattern: str
    start: int
    end: int
    masked: str


@dataclass(frozen=True, slots=True)
class RedactionResult:
    """Redacted text plus every hit that was masked."""

    text_redacted: str
    hits: tuple[RedactionHit, ...]


def _mask_span(text: str, start: int, end: int) -> str:
    """Keep the first 4 and last 4 chars of ``text[start:end]``, mask the middle."""
    span = text[start:end]
    keep = 4
    if len(span) <= keep * 2:
        return span
    return span[:keep] + "*" * (len(span) - keep * 2) + span[-keep:]


def _candidate_spans(text: str, pattern_name: str) -> list[tuple[int, int, str]]:
    """Raw (start, end, pattern_name) spans; Luhn gate applied for cards."""
    spans: list[tuple[int, int, str]] = []
    if pattern_name == CREDIT_CARD_PATTERN:
        for match in _CREDIT_CARD_RE.finditer(text):
            digits = _REMOVE_SEPARATORS.sub("", match.group(0))
            if not _luhn_valid(digits):
                continue
            spans.append((*match.span(), pattern_name))
    elif pattern_name == ID_CARD_PATTERN:
        for match in _ID_CARD_RE.finditer(text):
            spans.append((*match.span(), pattern_name))
    else:
        for match in _PHONE_RE.finditer(text):
            spans.append((*match.span(), pattern_name))
    return spans


def redact(text: str) -> RedactionResult:
    """Return a new text with all sensitive spans masked.

    The input string is never modified; a fresh :class:`RedactionResult` is
    returned. When nothing is sensitive, ``text_redacted`` equals the input
    and ``hits`` is empty. Hits are reported in ascending source order and
    never overlap.
    """
    raw = [
        *_candidate_spans(text, CREDIT_CARD_PATTERN),
        *_candidate_spans(text, ID_CARD_PATTERN),
        *_candidate_spans(text, PHONE_PATTERN),
    ]
    merged: list[tuple[int, int, str]] = []
    for start, end, pattern in sorted(raw, key=lambda item: item[0]):
        if merged and start < merged[-1][1]:
            prev_start, prev_end, prev_pattern = merged[-1]
            merged[-1] = (prev_start, max(prev_end, end), prev_pattern)
        else:
            merged.append((start, end, pattern))

    redacted = text
    hits: list[RedactionHit] = []
    for start, end, pattern in sorted(merged, key=lambda item: item[0], reverse=True):
        masked = _mask_span(text, start, end)
        hits.append(RedactionHit(pattern=pattern, start=start, end=end, masked=masked))
        redacted = redacted[:start] + masked + redacted[end:]
    hits.reverse()
    return RedactionResult(text_redacted=redacted, hits=tuple(hits))


def contains_sensitive(text: str) -> bool:
    """True when ``redact`` would mask at least one span."""
    return bool(redact(text).hits)
