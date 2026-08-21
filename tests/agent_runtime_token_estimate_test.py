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


def test_cjk_text_is_not_underestimated_four_fold():
    """真实事故（notepad-edit 真机测试）：全中文上下文真实 prompt_tokens 已达
    86k，估算还认为 ~48k——压缩晚了 4 轮。中文约 1 字 1 token，不是 4 字 1
    token；估算必须分语言计数。"""
    chinese = "激活次数统计" * 100  # 600 个汉字
    assert estimate_text_tokens(chinese) >= 600
    ascii_text = "value 12840 " * 100  # 1200 个 ASCII 字符
    assert 250 <= estimate_text_tokens(ascii_text) <= 400
    mixed = "Q1 激活 12840 次，Q2 激活 19207 次。" * 50
    # 400 个全角字符 + ~1000 ASCII：正确值 ≈ 400 + 250 = 650；
    # 旧的平铺 4-chars/token 会给 350——CJK 主导时系统性低估一半。
    assert estimate_text_tokens(mixed) >= 600


def test_messages_tokens_count_cjk_content():
    from app.agent_runtime.types import AgentMessage, ORIGIN_DATA, Role

    message = AgentMessage(
        role=Role.TOOL,
        content="文档内容：" + "中文测试数据" * 200,  # ~1000+ 汉字
        tool_call_id="t1",
        name="get_app_state",
        origin=ORIGIN_DATA,
    )
    assert estimate_messages_tokens([message]) >= 1000
