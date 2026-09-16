"""Raising the output ceiling when a turn is truncated.

The defect this covers: the loop already detected ``finish_reason == "length"``
and retried, but it retried at **the same ceiling**. A request that needed more
room than 4096 output tokens was re-sent at 4096 until
``MAX_OUTPUT_TOKENS_RECOVERY_LIMIT`` ran out and the turn was reported as
failed. Writing a 200-line file, one long patch, or a summary of a long
command's output all sit in that band, so the retry was structurally incapable
of succeeding. Claude Code re-sends the identical request with a much larger
ceiling; this is the same idea at a smaller multiple.
"""

import asyncio

import pytest

from app.agent_runtime.loop import LoopParams, run_agent_loop
from app.agent_runtime.model_client import (
    ESCALATED_MAX_TOKENS,
    MAX_OUTPUT_TOKEN_ESCALATIONS,
    AiClientBackend,
    LoopModelClient,
    TurnDone,
    TurnWithheld,
    escalated_max_tokens,
)
from app.agent_runtime.tool_registry import ToolRegistry


class CeilingBackend:
    """Backend that records the ceiling in force for every request.

    Also implements ``escalate_max_tokens``, which is the surface the loop
    reaches for.
    """

    def __init__(self, *scenes) -> None:
        self._scenes = list(scenes)
        self.ceilings: list[int] = []
        self.max_tokens = 4096

    def escalate_max_tokens(self, escalations_used: int = 0) -> int:
        raised = escalated_max_tokens(self.max_tokens, escalations_used)
        if raised:
            self.max_tokens = raised
        return raised

    def generate(self, messages, tools, budget_ms=None, cancel_scope=None):
        self.ceilings.append(self.max_tokens)
        if self._scenes:
            yield from self._scenes.pop(0)
        else:
            yield TurnDone(usage=None, raw_text=None)


class PlainBackend:
    """No escalation surface at all — the loop must not require one."""

    def __init__(self, *scenes) -> None:
        self._scenes = list(scenes)
        self.calls = 0

    def generate(self, messages, tools, budget_ms=None, cancel_scope=None):
        self.calls += 1
        if self._scenes:
            yield from self._scenes.pop(0)
        else:
            yield TurnDone(usage=None, raw_text=None)


def _params(client) -> LoopParams:
    return LoopParams(user_input="写一个长文件", registry=ToolRegistry(), client=client)


async def _collect(params):
    events = []
    async for event in run_agent_loop(params):
        events.append(event)
    return events


def _withheld():
    return [TurnWithheld(reason="max_output_tokens"), TurnDone(usage=None, raw_text=None)]


def _answered(text="done"):
    return [TurnDone(usage=None, raw_text=text)]


class TestEscalationLadder:
    def test_first_escalation_quadruples(self) -> None:
        assert escalated_max_tokens(4096, 0) == 16384

    def test_second_escalation_reaches_the_cap(self) -> None:
        assert escalated_max_tokens(16384, 1) == ESCALATED_MAX_TOKENS

    def test_ladder_is_exhausted_after_the_allowed_count(self) -> None:
        assert escalated_max_tokens(4096, MAX_OUTPUT_TOKEN_ESCALATIONS) == 0
        assert escalated_max_tokens(64000, 1) == 0

    def test_low_ceilings_still_get_real_headroom(self) -> None:
        # A 240-token ceiling (the AiClientBackend default) must not escalate
        # to 960 — that is not enough room to matter.
        assert escalated_max_tokens(240, 0) >= 16384

    def test_never_decreases(self) -> None:
        assert escalated_max_tokens(500_000, 0) == 0

    def test_is_monotonic_in_current(self) -> None:
        values = [escalated_max_tokens(n, 0) for n in (1, 100, 4096, 8192, 16384)]
        assert values == sorted(values)


class TestLoopEscalatesOnTruncation:
    def test_retry_uses_a_higher_ceiling(self) -> None:
        backend = CeilingBackend(_withheld(), _answered())
        client = LoopModelClient(backend)
        asyncio.run(_collect(_params(client)))
        assert backend.ceilings[0] == 4096, 'the first request uses the configured ceiling'
        assert backend.ceilings[1] > backend.ceilings[0], (
            'the retry after a truncation must ask for more room; retrying at the '
            'same ceiling cannot succeed'
        )

    def test_it_does_not_escalate_forever(self) -> None:
        # Every turn truncated: the ladder must stop, and the run must still
        # terminate rather than escalating without bound.
        backend = CeilingBackend(*[_withheld() for _ in range(12)])
        client = LoopModelClient(backend)
        asyncio.run(_collect(_params(client)))
        assert client.output_token_escalations <= MAX_OUTPUT_TOKEN_ESCALATIONS
        assert backend.max_tokens <= ESCALATED_MAX_TOKENS

    def test_a_backend_without_the_surface_is_unaffected(self) -> None:
        # AiClientBackend predates this and has no escalate_max_tokens on some
        # paths; the loop must degrade to the old behaviour, not raise.
        backend = PlainBackend(_withheld(), _answered())
        client = LoopModelClient(backend)
        asyncio.run(_collect(_params(client)))
        assert backend.calls == 2

    def test_a_raising_escalation_does_not_kill_the_loop(self) -> None:
        class Exploding(CeilingBackend):
            def escalate_max_tokens(self, escalations_used: int = 0) -> int:
                raise RuntimeError('backend said no')

        backend = Exploding(_withheld(), _answered())
        client = LoopModelClient(backend)
        events = asyncio.run(_collect(_params(client)))
        assert events, 'the loop must survive a backend that refuses to escalate'


class TestClientSurface:
    def test_client_reports_zero_without_a_backend_surface(self) -> None:
        client = LoopModelClient(PlainBackend())
        assert client.escalate_output_tokens() == 0

    def test_client_counts_escalations(self) -> None:
        client = LoopModelClient(CeilingBackend())
        first = client.escalate_output_tokens()
        second = client.escalate_output_tokens()
        third = client.escalate_output_tokens()
        assert first and second
        assert third == 0, 'the ladder must be finite'
        assert client.output_token_escalations == MAX_OUTPUT_TOKEN_ESCALATIONS

    def test_ai_client_backend_escalates_its_own_ceiling(self) -> None:
        backend = AiClientBackend(max_tokens=4096)
        assert backend.max_tokens == 4096
        raised = backend.escalate_max_tokens(0)
        assert raised == 16384
        assert backend.max_tokens == 16384, 'the payload builder reads this attribute'

    def test_ai_client_backend_stops_at_the_cap(self) -> None:
        backend = AiClientBackend(max_tokens=4096)
        backend.escalate_max_tokens(0)
        backend.escalate_max_tokens(1)
        assert backend.escalate_max_tokens(2) == 0
        assert backend.max_tokens == ESCALATED_MAX_TOKENS
