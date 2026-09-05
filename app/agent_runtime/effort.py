"""Canonical reasoning-effort policy shared by the Runtime and transports.

Effort controls how much work the agent should invest, not how terse or ornate
the final prose should be.  The system-prompt directive is the deterministic
semantic floor; compatible chat-completions providers also receive the native
``reasoning_effort`` field.
"""

from __future__ import annotations

from typing import Final

__all__ = ["EFFORT_LEVELS", "effort_instruction", "normalize_effort"]

EFFORT_LEVELS: Final[tuple[str, ...]] = (
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
)

_EFFORT_INSTRUCTIONS: Final[dict[str, str]] = {
    "low": (
        "Use low reasoning effort: take a quick, direct pass for simple "
        "questions and avoid optional investigation. Still satisfy every "
        "explicit requirement and verify any action you perform."
    ),
    "medium": (
        "Use medium reasoning effort for light, casual tasks. Inspect the "
        "evidence needed for a sound answer, resolve likely ambiguities, and "
        "verify performed actions without expanding the task unnecessarily."
    ),
    "high": (
        "Use high reasoning effort: apply balanced analysis for everyday "
        "work. Trace the relevant evidence, consider likely failure modes, "
        "and verify the result before concluding."
    ),
    "xhigh": (
        "Use extra-high reasoning effort. Work thoroughly on complex, "
        "detailed tasks: inspect all relevant evidence, trace interactions "
        "end to end, resolve inconsistencies, and verify the finished result."
    ),
    "max": (
        "Use maximum reasoning effort for the hardest problems. Apply the "
        "deepest available analysis, pursue every relevant line of evidence, "
        "challenge assumptions, and verify the result comprehensively. This "
        "level may take the longest."
    ),
}


def normalize_effort(value: object) -> str:
    candidate = str(value or "").strip().casefold()
    return candidate if candidate in EFFORT_LEVELS else "high"


def effort_instruction(value: object) -> str:
    return _EFFORT_INSTRUCTIONS[normalize_effort(value)]
