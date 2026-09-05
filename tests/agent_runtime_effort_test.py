from __future__ import annotations

from app.agent_runtime.effort import EFFORT_LEVELS, effort_instruction, normalize_effort


def test_effort_catalog_and_fallback() -> None:
    assert EFFORT_LEVELS == ("low", "medium", "high", "xhigh", "max")
    assert normalize_effort("xhigh") == "xhigh"
    assert normalize_effort(" XHIGH ") == "xhigh"
    assert normalize_effort("bogus") == "high"
    assert normalize_effort(None) == "high"


def test_each_effort_level_has_a_semantic_runtime_directive() -> None:
    directives = {level: effort_instruction(level) for level in EFFORT_LEVELS}

    assert all(directives.values())
    assert len(set(directives.values())) == len(EFFORT_LEVELS)
    assert "quick" in directives["low"].casefold()
    assert "balanced" in directives["high"].casefold()
    assert "thorough" in directives["xhigh"].casefold()
    assert "deepest available analysis" in directives["max"].casefold()
