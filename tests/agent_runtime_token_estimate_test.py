"""Request-level token estimation (Hermes model_metadata port).

The old estimator counted message content only, at ``len(content) // 2``.
That misses the two largest buckets Magic Pointer actually sends — the system
prompt (memory up to 4000 chars + skills up to 12000) and the tool schemas —
so the compaction threshold fired far too late. These tests pin the buckets.
"""

from __future__ import annotations

import statistics
import time
import unicodedata

import pytest

import app.agent_runtime.token_estimate as token_estimate
from app.agent_runtime.token_estimate import (
    _count_cjk,
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


def _fill(fragment: str, size: int) -> str:
    return (fragment * ((size + len(fragment) - 1) // len(fragment)))[:size]


@pytest.fixture(scope="module")
def mixed_wide_context_200k() -> str:
    context = "".join(
        (
            _fill("Magic Pointer tool schemas and source code 12840. ", 40_000),
            _fill("上下文管理决定长任务能否稳定存活。", 40_000),
            _fill("日本語の文脈を正確に数える。", 35_000),
            _fill("한국어문맥을정확하게계산한다.", 35_000),
            _fill("ＦＵＬＬＷＩＤＴＨ１２８４０，。", 25_000),
            _fill("😀🚀🧭🧪🍣🌏", 25_000),
        )
    )
    assert len(context) == 200_000
    return context


@pytest.fixture(scope="module")
def alternating_wide_context_200k() -> str:
    context = "a中" * 100_000
    assert len(context) == 200_000
    return context


@pytest.fixture(scope="module")
def short_wide_runs_context_200k() -> str:
    return _fill("code中文value日本語data한국어emoji😀done;", 200_000)


def _legacy_wide_count(text: str) -> int:
    return sum(
        1
        for character in text
        if unicodedata.east_asian_width(character) in ("W", "F")
    )


def _median_seconds(function, text: str, *, repeats: int = 7) -> float:
    function(text)
    samples = []
    for _ in range(repeats):
        started = time.perf_counter()
        function(text)
        samples.append(time.perf_counter() - started)
    return statistics.median(samples)


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


def test_message_estimator_batches_many_short_cjk_messages_before_wide_scan(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    messages = [_message("上下文管理决定长任务能否稳定存活。" * 50) for _ in range(200)]
    expected_wide = sum(len(message.content or "") for message in messages)
    original_legacy = token_estimate._count_wide_legacy
    legacy_calls: list[int] = []

    def legacy_spy(text: str) -> int:
        legacy_calls.append(len(text))
        return original_legacy(text)

    monkeypatch.setattr(token_estimate, "_count_wide_legacy", legacy_spy)

    assert estimate_messages_tokens(messages) == expected_wide
    assert legacy_calls == [], (
        "production estimate_messages_tokens must batch short messages into regex-sized "
        f"chunks instead of running {len(legacy_calls)} per-message unicodedata scans"
    )


def test_wide_character_scan_stays_within_two_percent_of_legacy_estimator(
    mixed_wide_context_200k: str,
) -> None:
    legacy = _legacy_wide_count(mixed_wide_context_200k)
    current = _count_cjk(mixed_wide_context_200k)
    assert abs(current - legacy) / legacy < 0.02
    assert _count_cjk("ＦＵＬＬＷＩＤＴＨ😀🚀🧭🧪") == 13


def test_wide_character_scan_is_materially_faster_on_a_200k_context(
    mixed_wide_context_200k: str,
) -> None:
    legacy_seconds = _median_seconds(_legacy_wide_count, mixed_wide_context_200k)
    current_seconds = _median_seconds(_count_cjk, mixed_wide_context_200k)
    assert current_seconds < legacy_seconds * 0.8, (
        f"optimized={current_seconds:.6f}s legacy={legacy_seconds:.6f}s "
        f"ratio={current_seconds / legacy_seconds:.3f}"
    )


def test_wide_character_scan_selects_legacy_fallback_for_fragmented_contexts(
    alternating_wide_context_200k: str,
    short_wide_runs_context_200k: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    original_legacy = token_estimate._count_wide_legacy
    fallback_calls: list[str] = []

    def legacy_spy(context: str) -> int:
        fallback_calls.append(context)
        return original_legacy(context)

    monkeypatch.setattr(token_estimate, "_count_wide_legacy", legacy_spy)
    for label, context in (
        ("alternating", alternating_wide_context_200k),
        ("short-runs", short_wide_runs_context_200k),
    ):
        assert token_estimate._has_fragmented_wide_runs(context) is True, label
        legacy_count = _legacy_wide_count(context)
        calls_before = len(fallback_calls)
        assert token_estimate._count_cjk(context) == legacy_count, label
        assert fallback_calls[calls_before:] == [context], label
