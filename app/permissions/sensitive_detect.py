
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

    pattern: str
    start: int
    end: int
    masked: str


@dataclass(frozen=True, slots=True)
class RedactionResult:

    text_redacted: str
    hits: tuple[RedactionHit, ...]


def _mask_span(text: str, start: int, end: int) -> str:
    span = text[start:end]
    keep = 4
    if len(span) <= keep * 2:
        return span
    return span[:keep] + "*" * (len(span) - keep * 2) + span[-keep:]


def _candidate_spans(text: str, pattern_name: str) -> list[tuple[int, int, str]]:
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
    return bool(redact(text).hits)
