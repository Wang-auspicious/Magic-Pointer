"""Aggregate bound on one round's tool results.

The defect this covers: ``_MAX_TOOL_RESULT_CHARS`` bounds each tool result
individually, but a round can carry ``max_parallel_tool_calls`` of them — eight
since the ceiling was raised. Eight parallel reads each just under the cap is
half a million characters
entering the history in a single step — the budget of an entire conversation,
in the step that pushes the next request over the model's window. The measured
estimate for CJK is roughly one token per character, so this is not a
theoretical bound.
"""

from app.agent_runtime.loop import (
    _MAX_TURN_TOOL_RESULT_CHARS,
    _fit_turn_tool_messages,
)
from app.agent_runtime.types import ORIGIN_DATA, AgentMessage, Role


def _tool(content: str, name: str = "read_file", call_id: str = "c1") -> AgentMessage:
    return AgentMessage(
        role=Role.TOOL,
        content=content,
        tool_call_id=call_id,
        name=name,
        origin=ORIGIN_DATA,
    )


def _total(messages) -> int:
    return sum(len(m.content or "") for m in messages)


class TestUnderBudget:
    def test_a_small_round_is_returned_unchanged(self) -> None:
        messages = [_tool("a" * 100), _tool("b" * 100)]
        assert _fit_turn_tool_messages(messages) == messages

    def test_an_empty_round_is_safe(self) -> None:
        assert _fit_turn_tool_messages([]) == []

    def test_exactly_at_the_budget_is_not_trimmed(self) -> None:
        messages = [_tool("a" * _MAX_TURN_TOOL_RESULT_CHARS)]
        assert _total(_fit_turn_tool_messages(messages)) == _MAX_TURN_TOOL_RESULT_CHARS

    def test_messages_with_no_content_are_safe(self) -> None:
        messages = [
            AgentMessage(role=Role.TOOL, content=None, tool_call_id="c", name="n"),
        ]
        assert _fit_turn_tool_messages(messages) == messages


class TestOverBudget:
    def test_the_round_fits_after_fitting(self) -> None:
        messages = [_tool("a" * 80_000, call_id=f"c{i}") for i in range(4)]
        fitted = _fit_turn_tool_messages(messages)
        assert _total(fitted) <= _MAX_TURN_TOOL_RESULT_CHARS

    def test_the_largest_message_absorbs_the_cut(self) -> None:
        # A single huge read must not starve its small siblings.
        messages = [
            _tool("small" * 10, call_id="small"),
            _tool("huge" * 40_000, call_id="huge"),
        ]
        fitted = _fit_turn_tool_messages(messages)
        by_id = {m.tool_call_id: m for m in fitted}
        assert by_id["small"].content == "small" * 10, 'a small result must survive intact'
        assert len(by_id["huge"].content or "") < len("huge" * 40_000)

    def test_every_trimmed_message_says_so(self) -> None:
        # A silently shortened tool result is worse than a truncated one: the
        # model cannot tell "the file ended there" from "we stopped showing you".
        messages = [_tool("a" * 200_000)]
        fitted = _fit_turn_tool_messages(messages)
        assert "trimmed to fit this round's budget" in (fitted[0].content or "")
        assert "original_chars=200000" in (fitted[0].content or "")

    def test_untrimmed_messages_get_no_marker(self) -> None:
        messages = [_tool("tiny", call_id="t"), _tool("a" * 300_000, call_id="big")]
        fitted = _fit_turn_tool_messages(messages)
        by_id = {m.tool_call_id: m for m in fitted}
        assert "trimmed" not in (by_id["t"].content or "")

    def test_order_and_identity_are_preserved(self) -> None:
        messages = [_tool("a" * 90_000, call_id=f"c{i}") for i in range(3)]
        fitted = _fit_turn_tool_messages(messages)
        assert [m.tool_call_id for m in fitted] == ["c0", "c1", "c2"]
        assert all(m.role is Role.TOOL for m in fitted)

    def test_the_original_list_is_not_mutated(self) -> None:
        content = "a" * 200_000
        messages = [_tool(content)]
        _fit_turn_tool_messages(messages)
        assert messages[0].content == content, 'AgentMessage is frozen; a copy must be returned'

    def test_is_idempotent(self) -> None:
        messages = [_tool("a" * 200_000)]
        once = _fit_turn_tool_messages(messages)
        twice = _fit_turn_tool_messages(once)
        assert _total(twice) <= _MAX_TURN_TOOL_RESULT_CHARS
        assert twice[0].content == once[0].content, 'fitting an already-fitted round changes nothing'

    def test_a_custom_budget_is_honoured(self) -> None:
        messages = [_tool("a" * 1000)]
        fitted = _fit_turn_tool_messages(messages, max_total_chars=100)
        assert _total(fitted) <= 100

    def test_it_converges_with_many_large_messages(self) -> None:
        messages = [_tool("a" * 50_000, call_id=f"c{i}") for i in range(10)]
        fitted = _fit_turn_tool_messages(messages)
        assert _total(fitted) <= _MAX_TURN_TOOL_RESULT_CHARS
