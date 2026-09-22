
from __future__ import annotations

from app.agent_runtime.loop import _grounded_request_tokens
from app.agent_runtime.types import AgentMessage, Role


class _Params:
    def __init__(self, estimator):
        self.token_estimator = estimator


def _messages(count: int, chars: int = 400) -> list[AgentMessage]:
    return [
        AgentMessage(role=Role.USER, content="x" * chars, tool_call_id=None, name=None)
        for _ in range(count)
    ]


def test_tail_appended_after_the_measurement_is_counted() -> None:
    messages = _messages(6)
    estimator = lambda rows: 1000 * len(list(rows))  # noqa: E731
    params = _Params(estimator)
    grounded = _grounded_request_tokens(params, messages, 8000, 4)
    assert grounded == 8000 + 2000


def test_provider_number_alone_when_nothing_was_appended() -> None:
    messages = _messages(4)
    params = _Params(lambda rows: 1000 * len(list(rows)))
    assert _grounded_request_tokens(params, messages, 5000, 4) == 5000


def test_stale_prefix_is_dropped_after_the_history_is_rewritten() -> None:
    params = _Params(lambda rows: 1000 * len(list(rows)))
    assert _grounded_request_tokens(params, _messages(3), 90000, None) == 90000
    assert _grounded_request_tokens(params, _messages(3), 0, None) == 0


def test_index_past_the_end_never_raises() -> None:
    params = _Params(lambda rows: 1000 * len(list(rows)))
    assert _grounded_request_tokens(params, _messages(2), 4000, 9) == 4000


def test_missing_estimator_falls_back_to_the_provider_number() -> None:
    params = _Params(None)
    assert _grounded_request_tokens(params, _messages(4), 7000, 1) == 7000
