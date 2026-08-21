"""Selection-session token → durable agent session id.

Electron steer and the selection bridge must hash the same way, or a mid-run
steer lands in a different JSONL than the live loop.
"""

from __future__ import annotations

from app.agent_runtime.session_id import agent_session_id


def test_plain_token_is_prefixed() -> None:
    assert agent_session_id("abc-123") == "agent-abc-123"


def test_oversized_or_odd_token_is_hashed_to_a_stable_id() -> None:
    weird = "token with spaces/" + ("x" * 200)
    first = agent_session_id(weird)
    second = agent_session_id(weird)
    assert first == second
    assert first.startswith("agent-")
    assert " " not in first
    assert len(first) < 80
