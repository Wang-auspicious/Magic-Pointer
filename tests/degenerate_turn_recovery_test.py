
import asyncio

from app.agent_runtime.errors import CONTEXT_OVERFLOW_REASON, is_context_overflow_error
from app.agent_runtime.loop import LoopParams, LoopStopped, run_agent_loop
from app.agent_runtime.model_client import LoopModelClient, TurnDone, TurnWithheld
from app.agent_runtime.tool_registry import ToolRegistry
from app.agent_runtime.types import Role, TransitionReason


class Scripted:
    def __init__(self, *scenes) -> None:
        self._scenes = list(scenes)
        self.calls = 0
        self.seen_messages: list[list] = []

    def generate(self, messages, tools, budget_ms=None, cancel_scope=None):
        self.calls += 1
        self.seen_messages.append(list(messages))
        if self._scenes:
            yield from self._scenes.pop(0)
        else:
            yield TurnDone(usage=None, raw_text="")


def _params(client, **overrides) -> LoopParams:
    kwargs = {"user_input": "给我一个答案", "registry": ToolRegistry(), "client": client}
    kwargs.update(overrides)
    return LoopParams(**kwargs)


async def _collect(params):
    events = []
    terminal = None
    async for event in run_agent_loop(params):
        events.append(event)
        if isinstance(event, LoopStopped):
            terminal = event.terminal
    return events, terminal


def _empty():
    return [TurnDone(usage=None, raw_text="")]


def _answer(text="这是答案"):
    return [TurnDone(usage=None, raw_text=text)]



class TestEmptyCompletionRecovery:
    def test_an_empty_turn_is_not_the_end(self) -> None:
        backend = Scripted(_empty(), _answer())
        client = LoopModelClient(backend)
        _events, terminal = asyncio.run(_collect(_params(client)))
        assert backend.calls >= 2, 'an empty answer must be asked for again'
        assert terminal.reason is TransitionReason.COMPLETED
        assert terminal.message == "这是答案"

    def test_the_retry_carries_an_instruction_to_answer(self) -> None:
        backend = Scripted(_empty(), _answer())
        asyncio.run(_collect(_params(LoopModelClient(backend))))
        followup = backend.seen_messages[1][-1]
        assert followup.role is Role.USER
        assert "没有返回任何内容" in followup.content

    def test_recovery_is_bounded(self) -> None:
        backend = Scripted(*[_empty() for _ in range(30)])
        _events, terminal = asyncio.run(_collect(_params(LoopModelClient(backend))))
        assert backend.calls == 4, 'three retries, then give up'
        assert terminal.reason is TransitionReason.PROVIDER_UNAVAILABLE
        assert terminal.message == "backend_error:empty_response"

    def test_a_normal_answer_is_untouched(self) -> None:
        backend = Scripted(_answer())
        _events, terminal = asyncio.run(_collect(_params(LoopModelClient(backend))))
        assert backend.calls == 1
        assert terminal.message == "这是答案"

    def test_a_whitespace_only_answer_counts_as_empty(self) -> None:
        backend = Scripted([TurnDone(usage=None, raw_text="   \n  ")], _answer())
        _events, terminal = asyncio.run(_collect(_params(LoopModelClient(backend))))
        assert backend.calls >= 2
        assert terminal.message == "这是答案"



class TestOverflowClassification:
    def test_vendor_wordings_are_recognised(self) -> None:
        bodies = [
            '{"error":{"code":"context_length_exceeded"}}',
            'prompt is too long: 210000 tokens > 200000 maximum',
            "This model's maximum context length is 8192 tokens",
            '{"error":{"message":"too many tokens"}}',
            "输入上下文长度超出模型限制",
        ]
        for body in bodies:
            assert is_context_overflow_error(body), body

    def test_unrelated_errors_are_not_overflow(self) -> None:
        for body in ('invalid api key', '{"error":"rate limited"}', '', None, 400):
            assert not is_context_overflow_error(body), body


class TestContextOverflowRescue:
    def test_the_loop_compacts_and_resends(self) -> None:
        backend = Scripted(
            [TurnWithheld(reason=CONTEXT_OVERFLOW_REASON), TurnDone(usage=None, raw_text=None)],
            _answer(),
        )
        compacted: list[int] = []

        def compactor(messages):
            compacted.append(len(messages))
            return messages[:1]

        _events, terminal = asyncio.run(_collect(_params(
            LoopModelClient(backend),
            evidence_input="[证据] 一段很长的屏幕内容",
            compactor=compactor,
            token_estimator=lambda messages: len(messages) * 100,
            context_budget_tokens=10_000,
        )))
        assert compacted, 'a context overflow must trigger a compaction'
        assert backend.calls >= 2, 'and the request must be resent afterwards'
        assert terminal.reason is TransitionReason.COMPLETED
        assert terminal.message == "这是答案"

    def test_a_history_with_nothing_to_remove_fails_honestly(self) -> None:
        backend = Scripted(
            *[[TurnWithheld(reason=CONTEXT_OVERFLOW_REASON), TurnDone(usage=None, raw_text=None)]
              for _ in range(5)]
        )
        _events, terminal = asyncio.run(_collect(_params(
            LoopModelClient(backend),
            compactor=lambda messages: messages[:1],
            token_estimator=lambda messages: len(messages) * 100,
            context_budget_tokens=200,
        )))
        assert terminal.reason is TransitionReason.PROVIDER_UNAVAILABLE
        assert terminal.message == "context_overflow_compaction_ineffective"

    def test_compaction_that_changes_nothing_is_reported_honestly(self) -> None:
        backend = Scripted(
            *[[TurnWithheld(reason=CONTEXT_OVERFLOW_REASON), TurnDone(usage=None, raw_text=None)]
              for _ in range(5)]
        )
        _events, terminal = asyncio.run(_collect(_params(
            LoopModelClient(backend),
            evidence_input="[证据] 一段很长的屏幕内容",
            compactor=lambda messages: messages,
            token_estimator=lambda messages: len(messages) * 100,
            context_budget_tokens=200,
        )))
        assert terminal.reason is TransitionReason.PROVIDER_UNAVAILABLE
        assert terminal.message == "context_overflow_compaction_ineffective"

    def test_without_a_compactor_it_fails_with_that_reason(self) -> None:
        backend = Scripted(
            [TurnWithheld(reason=CONTEXT_OVERFLOW_REASON), TurnDone(usage=None, raw_text=None)],
            _answer(),
        )
        _events, terminal = asyncio.run(_collect(_params(LoopModelClient(backend))))
        assert terminal.reason is TransitionReason.PROVIDER_UNAVAILABLE
        assert terminal.message == "context_overflow_without_compactor"

    def test_a_plain_backend_error_is_still_not_an_overflow(self) -> None:
        backend = Scripted(
            [TurnWithheld(reason="backend_error:http_400"), TurnDone(usage=None, raw_text=None)],
            _answer(),
        )
        compacted: list[int] = []
        _events, terminal = asyncio.run(_collect(_params(
            LoopModelClient(backend),
            compactor=lambda messages: (compacted.append(1), messages[:1])[1],
            token_estimator=lambda messages: len(messages) * 100,
            context_budget_tokens=200,
        )))
        assert not compacted, 'an ordinary 400 must not be answered by compacting'
        assert terminal.reason is TransitionReason.PROVIDER_UNAVAILABLE
