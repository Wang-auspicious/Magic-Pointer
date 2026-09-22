
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
    body = "the quick brown fox jumps over the lazy dog. " * 200
    tail = [_tool_message(body) for _ in range(3)]
    out = _prune_stale_tool_outputs(tail)
    assert len(out) == len(tail)
    assert all("pruned" not in (m.content or "") for m in out)


def test_cjk_tail_over_4k_tokens_is_pruned() -> None:
    body = "上下文管理的好坏决定长任务存活。工具结果要保持轻量。" * 60
    tail = [_tool_message(body) for _ in range(8)]
    out = _prune_stale_tool_outputs(tail)
    assert len(out) == len(tail)
    kept_recent = [m for m in out if "pruned" not in (m.content or "")]
    assert len(kept_recent) == _TAIL_KEEP_RECENT_TOOLS
    assert sum("pruned" in (m.content or "") for m in out) == len(tail) - _TAIL_KEEP_RECENT_TOOLS


def test_threshold_constant_is_the_token_value() -> None:
    assert _TAIL_PRUNE_THRESHOLD_TOKENS == 4_000