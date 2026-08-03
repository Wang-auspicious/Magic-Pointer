"""The stage bubble is on screen while these calls run, so they must be bounded.

A 2026-08-03 session sat on three dots for nearly two minutes: ask_text_model
defaulted to a 120s timeout *and* retried once, so a slow relay could hold an
interactive surface for four minutes. The grounded fallback existed but only
ran after the model returned, which made it useless against a hang.
"""

from __future__ import annotations

import inspect

import app.ai_client as ai_client
import scripts.selection_bridge as selection_bridge


def test_ask_text_model_accepts_a_caller_supplied_budget() -> None:
    signature = inspect.signature(ai_client.ask_text_model)
    assert "timeout_s" in signature.parameters
    assert "attempts" in signature.parameters


def test_agent_prompt_compiler_uses_an_interactive_budget() -> None:
    assert selection_bridge.AGENT_PROMPT_MODEL_TIMEOUT_S <= 20.0, (
        "a user is watching a bubble while this runs"
    )
    source = inspect.getsource(selection_bridge._compile_agent_prompt_with_model)
    assert "timeout_s=AGENT_PROMPT_MODEL_TIMEOUT_S" in source
    assert "attempts=1" in source, "an interactive call must not silently double its wait"


def test_a_timed_out_model_still_yields_the_grounded_prompt() -> None:
    """The fallback must not depend on the model answering."""

    def _hangs_then_fails(_instruction: str, _grounded: str) -> str:
        return "AI 调用失败：ReadTimeout: timed out"

    source = inspect.getsource(selection_bridge.build_agent_prompt_draft)
    assert 'candidate.startswith("AI 调用失败")' in source
    assert '"grounded_fallback" if model_failed else "model"' in source
    assert _hangs_then_fails("x", "y").startswith("AI 调用失败")
