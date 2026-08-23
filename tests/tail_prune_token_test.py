"""Tail-prune 阈值按 token 口径（roadmap §3.2）。

旧实现只按字符数（24k chars）判断，CJK 1 字/token、英文约 4 chars/token，
同一阈值对两种语言的实际 token 负担完全不同。新的单一判据是
``estimate_messages_tokens(tail) > 4000`` —— 估算器已含 CJK 1 字/token
修正，所以中英文共用同一个正确的门。
"""

from __future__ import annotations

from app.agent_runtime.memory import (
    _TAIL_KEEP_RECENT_TOOLS,
    _TAIL_PRUNE_THRESHOLD_TOKENS,
    _prune_stale_tool_outputs,
)
from app.agent_runtime.types import AgentMessage, Role


def _tool_message(text: str) -> AgentMessage:
    return AgentMessage(
        role=Role.TOOL,
        content=text,
        tool_call_id="t1",
        name="read_file",
        origin="data",
    )


def test_english_tail_under_4k_tokens_is_not_pruned() -> None:
    """24k chars of English ≈ 6k+ tokens would prune under the OLD char gate
    at 24k; the token gate holds it until it genuinely weighs >4k tokens."""
    body = "the quick brown fox jumps over the lazy dog. " * 200  # ~1080 chars
    tail = [_tool_message(body) for _ in range(3)]  # ~3.2k chars, <4k tokens
    out = _prune_stale_tool_outputs(tail)
    assert len(out) == len(tail)
    assert all("pruned" not in (m.content or "") for m in out)


def test_cjk_tail_over_4k_tokens_is_pruned() -> None:
    """CJK is 1 char/token: a 6k-char CJK tail exceeds 4k tokens and must
    prune older heavy tool results even though it is far below any
    char-based English gate."""
    body = "上下文管理的好坏决定长任务存活。工具结果要保持轻量。" * 60  # ~1320 chars
    tail = [_tool_message(body) for _ in range(8)]  # ~10.5k chars ≈ 10k+ tokens
    out = _prune_stale_tool_outputs(tail)
    assert len(out) == len(tail)
    kept_recent = [m for m in out if "pruned" not in (m.content or "")]
    assert len(kept_recent) == _TAIL_KEEP_RECENT_TOOLS
    assert sum("pruned" in (m.content or "") for m in out) == len(tail) - _TAIL_KEEP_RECENT_TOOLS


def test_threshold_constant_is_the_token_value() -> None:
    assert _TAIL_PRUNE_THRESHOLD_TOKENS == 4_000