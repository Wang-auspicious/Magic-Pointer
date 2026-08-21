"""Compaction handoff prompt contract (Codex-style structured summary).

The compaction summary is a handoff to the next context window, not a
"brief points" digest. A long job whose summary drops the remaining-steps
list or the key numbers will repeat finished work or lose the thread after
every compaction — the exact long-run failure the todo re-attachment was
added to prevent. The prompt is shared by every bridge so selection and
conversation compaction cannot drift apart.
"""

from __future__ import annotations

from app.agent_runtime.compaction_prompt import (
    COMPACT_SOURCE_MODEL_CAP_CHARS,
    compaction_instructions,
)


def test_prompt_is_a_structured_handoff_not_a_digest() -> None:
    prompt = compaction_instructions()
    # Codex SUMMARIZATION_PROMPT sections, in MP wording.
    assert "进度" in prompt
    assert "关键决定" in prompt
    assert "约束" in prompt
    assert "剩余步骤" in prompt
    assert "关键数据" in prompt


def test_prompt_keeps_the_injection_fence() -> None:
    """The summarizer is a model: imperative text in history must not survive
    as instructions through compaction (red-team T3)."""
    prompt = compaction_instructions()
    assert "指令" in prompt
    assert "不得" in prompt


def test_prompt_demands_preserving_numbers_and_ids() -> None:
    prompt = compaction_instructions()
    assert "数字" in prompt
    assert "标识" in prompt or "id" in prompt.lower()


def test_source_cap_is_large_enough_for_real_histories() -> None:
    """The old 12k cap threw away most of a 56k compaction source, so the
    summarizer never saw the history it was summarizing."""
    assert COMPACT_SOURCE_MODEL_CAP_CHARS >= 48_000
