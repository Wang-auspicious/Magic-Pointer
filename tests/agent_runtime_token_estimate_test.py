"""Request-level token estimation (Hermes model_metadata port).

The old estimator counted message content only, at ``len(content) // 2``.
That misses the two largest buckets Magic Pointer actually sends — the system
prompt (memory up to 4000 chars + skills up to 12000) and the tool schemas —
so the compaction threshold fired far too late. These tests pin the buckets.
"""

from __future__ import annotations

from app.agent_runtime.token_estimate import (
    estimate_messages_tokens,
    estimate_request_tokens,
    estimate_text_tokens,
)
from app.agent_runtime.types import ORIGIN_DATA, AgentMessage, Role


def _message(content: str | None, *, role: Role = Role.USER, **kwargs) -> AgentMessage:
    return AgentMessage(
        role=role,
        content=content,
        tool_call_id=None,
        name=None,
        origin=ORIGIN_DATA,
        **kwargs,
    )


def test_short_text_never_estimates_to_zero_tokens():
    # Ceiling division: many short tool results must not sum to nothing.
    assert estimate_text_tokens("a") == 1
    assert estimate_text_tokens("abc") == 1
    assert estimate_text_tokens("abcde") == 2
    assert estimate_text_tokens("") == 0


def test_missing_content_is_not_an_error():
    assert estimate_messages_tokens([_message(None)]) == 0


def test_tool_call_arguments_count_toward_the_estimate():
    plain = _message("go", role=Role.ASSISTANT)
    with_call = AgentMessage(
        role=Role.ASSISTANT,
        content="go",
        tool_call_id=None,
        name=None,
        origin=ORIGIN_DATA,
        tool_calls=(
            {"id": "c1", "name": "get_app_state", "arguments": {"window": "Notepad"}},
        ),
    )
    assert estimate_messages_tokens([with_call]) > estimate_messages_tokens([plain])


def test_system_prompt_and_tool_schemas_are_counted():
    messages = [_message("hi")]
    messages_only = estimate_request_tokens(messages)

    # A realistic Magic Pointer system prompt carries memory and skills.
    with_prompt = estimate_request_tokens(messages, system_prompt="x" * 16_000)
    assert with_prompt - messages_only >= 4_000

    tools = [
        {
            "name": f"tool_{index}",
            "description": "d" * 400,
            "parameters": {"type": "object", "properties": {"a": {"type": "string"}}},
        }
        for index in range(13)
    ]
    with_tools = estimate_request_tokens(messages, tools=tools)
    assert with_tools - messages_only >= 1_000


def test_repeated_estimates_of_the_same_tool_list_agree():
    tools = [{"name": "look", "description": "d" * 100, "parameters": {}}]
    messages = [_message("hi")]
    first = estimate_request_tokens(messages, tools=tools)
    second = estimate_request_tokens(messages, tools=tools)
    assert first == second
