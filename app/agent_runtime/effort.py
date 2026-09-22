
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


def native_effort_fields(model: str, api_mode: str, value: object | None) -> dict:
    if value is None:
        return {}
    effort = normalize_effort(value)
    if api_mode == 'messages':
        name = model.lower().replace('.', '-')
        opus = 'opus-4-6' in name
        if not opus and 'sonnet-4-6' not in name:
            return {}
        applied = 'high' if effort == 'xhigh' or (effort == 'max' and not opus) else effort
        return {'thinking': {'type': 'adaptive'}, 'output_config': {'effort': applied}}
    if api_mode == 'responses':
        return {'reasoning': {'effort': effort}}
    return {'reasoning_effort': effort}
