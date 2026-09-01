"""思考流（reasoning/CoT）端到端契约。

用户裁决：思考流一定要有。模型 API 返回的 reasoning（DeepSeek/Moonshot 的
``reasoning_content``、Anthropic 的 thinking 块、OpenRouter 的 ``reasoning``）
此前被 model_client 静默丢弃（只读 delta.content/delta.tool_calls），用户在
GUI 上看不到任何思考过程。本文件钉死：解析 → loop 事件 → 桥 sink → 
trajectory/进度行的每一跳，谁断了谁红。
"""

from __future__ import annotations

import base64
import io
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.agent_runtime.model_client import (  # noqa: E402
    AiClientMessagesBackend,
    LoopModelClient,
    MessageDelta,
    ReasoningDelta,
    StreamingMessagesBackend,
    TurnDone,
    TurnStarted,
    _parse_messages_sse,
    _parse_sse,
)
from app.agent_runtime.types import AgentMessage, Role  # noqa: E402


# ---- 解析层：chat-completions SSE ----------------------------------------


def _chat_lines(*deltas: dict, finish: str = "stop") -> list[str]:
    lines = []
    for delta in deltas:
        lines.append("data: " + json.dumps({"choices": [{"delta": delta}]}))
    lines.append(
        "data: "
        + json.dumps(
            {
                "choices": [{"delta": {}, "finish_reason": finish}],
                "usage": {"prompt_tokens": 3, "completion_tokens": 5},
            }
        )
    )
    lines.append("data: [DONE]")
    return lines


def test_chat_sse_reasoning_content_becomes_reasoning_delta_before_text() -> None:
    events = list(_parse_sse(
        _chat_lines(
            {"reasoning_content": "先想"},
            {"reasoning_content": "清楚再答"},
            {"content": "答案"},
        )
    ))
    kinds = [type(event) for event in events]
    assert kinds[0] is TurnStarted or kinds[0] is ReasoningDelta
    reasoning = [e for e in events if isinstance(e, ReasoningDelta)]
    text = [e for e in events if isinstance(e, MessageDelta)]
    assert [event.text for event in reasoning] == ["先想", "清楚再答"]
    assert "".join(event.text for event in reasoning) == "先想清楚再答"
    assert len(text) == 1 and text[0].text == "答案"
    # 思考在正文之前（事件序 = 模型输出序）。
    assert kinds.index(ReasoningDelta) < kinds.index(MessageDelta)


def test_chat_sse_reasoning_field_variant_also_parsed() -> None:
    """OpenRouter 等网关把 reasoning 放在 delta.reasoning 而非 reasoning_content。"""
    events = list(_parse_sse(_chat_lines({"reasoning": " thunk"}, {"content": "ok"})))
    reasoning = [e for e in events if isinstance(e, ReasoningDelta)]
    assert len(reasoning) == 1 and reasoning[0].text == " thunk"


def test_chat_sse_without_reasoning_has_no_reasoning_delta() -> None:
    events = list(_parse_sse(_chat_lines({"content": "plain"})))
    assert not [e for e in events if isinstance(e, ReasoningDelta)]


# ---- 解析层：Anthropic messages SSE --------------------------------------


def test_messages_sse_thinking_blocks_become_reasoning_delta() -> None:
    lines = [
        "data: " + json.dumps({"type": "message_start", "message": {"usage": {}}}),
        "data: " + json.dumps(
            {"type": "content_block_start", "index": 0,
             "content_block": {"type": "thinking", "thinking": ""}}
        ),
        "data: " + json.dumps(
            {"type": "content_block_delta", "index": 0,
             "delta": {"type": "thinking_delta", "thinking": "推演"}}
        ),
        "data: " + json.dumps(
            {"type": "content_block_delta", "index": 0,
             "delta": {"type": "thinking_delta", "thinking": "一下"}}
        ),
        "data: " + json.dumps(
            {"type": "content_block_start", "index": 1,
             "content_block": {"type": "text", "text": ""}}
        ),
        "data: " + json.dumps(
            {"type": "content_block_delta", "index": 1,
             "delta": {"type": "text_delta", "text": "结论"}}
        ),
        "data: " + json.dumps(
            {"type": "message_delta", "delta": {"stop_reason": "end_turn"}}
        ),
        "data: [DONE]",
    ]
    events = list(_parse_messages_sse(iter(lines)))
    reasoning = [e for e in events if isinstance(e, ReasoningDelta)]
    text = [e for e in events if isinstance(e, MessageDelta)]
    assert [event.text for event in reasoning] == ["推演", "一下"]
    assert len(text) == 1 and text[0].text == "结论"


# ---- 非流式后端：reasoning 一样要浮出来 ----------------------------------


class FakeResponse:
    def __init__(self, status_code: int, payload: dict) -> None:
        self.status_code = status_code
        self._payload = payload
        self.text = "fake"

    def json(self):
        return self._payload


class FakeClient:
    def __init__(self, payload: dict) -> None:
        self._payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return None

    def post(self, url, *, headers, json):
        return FakeResponse(200, self._payload)


def _backend(payload: dict) -> AiClientMessagesBackend:
    backend = AiClientMessagesBackend(timeout_s=5.0, max_tokens=120)
    backend._client_factory = lambda timeout: FakeClient(payload)  # type: ignore[attr-defined]
    return backend


@pytest.fixture()
def _no_circuit(monkeypatch):
    from app import ai_client

    monkeypatch.setattr(ai_client, "short_circuit_message", lambda _base_url=None: None)
    monkeypatch.setattr(
        ai_client,
        "get_ai_config",
        lambda: ("key", "https://gateway.example/v1", "text-model"),
    )


def test_nonstreaming_chat_message_reasoning_content_surfaces(_no_circuit) -> None:
    payload = {
        "choices": [{"message": {
            "content": "答",
            "reasoning_content": "想了一遍",
        }}],
        "usage": {},
    }
    events = list(_backend(payload).generate(
        [_user_msg("问")], [], budget_ms=3000,
    ))
    reasoning = [e for e in events if isinstance(e, ReasoningDelta)]
    text = [e for e in events if isinstance(e, MessageDelta)]
    assert len(reasoning) == 1 and reasoning[0].text == "想了一遍"
    assert len(text) == 1 and text[0].text == "答"


def test_nonstreaming_messages_thinking_block_surfaces(_no_circuit, monkeypatch) -> None:
    from app import ai_client

    monkeypatch.setattr(
        ai_client, "get_ai_api_mode", lambda _base_url: "messages",
    )
    payload = {
        "content": [
            {"type": "thinking", "thinking": "慢慢想"},
            {"type": "text", "text": "答"},
        ],
        "usage": {},
    }
    events = list(_backend(payload).generate(
        [_user_msg("问")], [], budget_ms=3000,
    ))
    reasoning = [e for e in events if isinstance(e, ReasoningDelta)]
    text = [e for e in events if isinstance(e, MessageDelta)]
    assert len(reasoning) == 1 and reasoning[0].text == "慢慢想"
    assert len(text) == 1 and text[0].text == "答"


# ---- 客户端与 loop 层 -----------------------------------------------------


def _user_msg(content: str) -> AgentMessage:
    return AgentMessage(role=Role.USER, content=content, tool_call_id=None, name=None)


def test_loop_model_client_accumulates_last_reasoning() -> None:
    class FakeBackend:
        used_backend = "fake"

        def generate(self, messages, tools, budget_ms, cancel_scope):
            yield TurnStarted()
            yield ReasoningDelta(text="思考 A")
            yield ReasoningDelta(text="思考 B")
            yield MessageDelta(text="答案")
            yield TurnDone(usage=None, raw_text="答案")

    client = LoopModelClient(FakeBackend())
    client.generate_turn([_user_msg("问")], [])
    assert client.last_reasoning == "思考 A思考 B"
    calls, text = client.parse_tool_calls(client.generate_turn([_user_msg("问")], []))
    assert text == "答案" and calls == []


def test_turn_done_is_terminal_even_if_backend_cleanup_would_raise() -> None:
    class DoneThenRaiseBackend:
        used_backend = "fake"

        def generate(self, messages, tools, budget_ms, cancel_scope):
            yield TurnStarted()
            yield MessageDelta("complete")
            yield TurnDone(usage={"prompt_tokens": 7}, raw_text="complete")
            raise OSError("response context failed after terminal event")

    client = LoopModelClient(DoneThenRaiseBackend())
    events = list(client.stream_turn([_user_msg("问")], []))

    assert sum(isinstance(event, TurnDone) for event in events) == 1
    assert not [event for event in events if type(event).__name__ == "TurnWithheld"]
    assert client.last_usage == {"prompt_tokens": 7}


def test_raw_text_turn_done_survives_backend_cleanup_failure() -> None:
    class RawTextThenRaiseBackend:
        used_backend = "fake"

        def generate(self, messages, tools, budget_ms, cancel_scope):
            yield TurnStarted()
            yield TurnDone(
                usage={"prompt_tokens": 9},
                raw_text="raw-only answer",
            )
            raise OSError("response context failed after raw-text terminal")

    client = LoopModelClient(RawTextThenRaiseBackend())
    events = list(client.stream_turn([_user_msg("问")], []))
    calls, text = client.parse_tool_calls(events)

    assert sum(isinstance(event, TurnDone) for event in events) == 1
    assert not [event for event in events if type(event).__name__ == "TurnWithheld"]
    assert client.last_usage == {"prompt_tokens": 9}
    assert calls == []
    assert text == "raw-only answer"


def test_turn_done_drains_stream_backend_success_bookkeeping(
    _no_circuit,
    monkeypatch,
) -> None:
    from app import ai_client

    successes: list[dict] = []
    monkeypatch.setattr(ai_client, "record_success", lambda **fields: successes.append(fields))
    monkeypatch.setattr(ai_client, "get_ai_api_mode", lambda _base_url: "chat")

    backend = StreamingMessagesBackend(timeout_s=5.0, max_tokens=120)
    backend._post_streaming = lambda *_args, **_kwargs: iter((  # type: ignore[method-assign]
        MessageDelta("complete"),
        TurnDone(usage={"prompt_tokens": 7}, raw_text="complete"),
    ))
    client = LoopModelClient(backend)

    events = list(client.stream_turn([_user_msg("问")], []))

    assert successes == [{
        "model": "text-model",
        "base_url": "https://gateway.example/v1",
    }]
    assert sum(isinstance(event, TurnDone) for event in events) == 1
    assert client.last_usage == {"prompt_tokens": 7}


def test_stream_backend_terminal_cleanup_failure_does_not_poison_health(
    _no_circuit,
    monkeypatch,
) -> None:
    from app import ai_client

    successes: list[dict] = []
    failures: list[dict] = []
    monkeypatch.setattr(ai_client, "record_success", lambda **fields: successes.append(fields))
    monkeypatch.setattr(ai_client, "record_failure", lambda **fields: failures.append(fields))
    monkeypatch.setattr(ai_client, "get_ai_api_mode", lambda _base_url: "chat")

    def terminal_then_raise(*_args, **_kwargs):
        yield MessageDelta("complete")
        yield TurnDone(usage={"prompt_tokens": 11}, raw_text="complete")
        raise OSError("response context failed after terminal")

    backend = StreamingMessagesBackend(timeout_s=5.0, max_tokens=120)
    backend._post_streaming = terminal_then_raise  # type: ignore[method-assign]

    events = list(backend.generate([_user_msg("问")], []))

    assert sum(isinstance(event, TurnDone) for event in events) == 1
    assert not [event for event in events if type(event).__name__ == "TurnWithheld"]
    assert successes == [{
        "model": "text-model",
        "base_url": "https://gateway.example/v1",
    }]
    assert failures == []


def test_agent_loop_yields_reasoning_chunk_events() -> None:
    """loop 把 ReasoningDelta 转成 ReasoningChunk 往 UI 送（与 ModelChunk 同权）。"""

    class FakeBackend:
        used_backend = "fake"

        def generate(self, messages, tools, budget_ms, cancel_scope):
            yield TurnStarted()
            yield ReasoningDelta(text="想想")
            yield MessageDelta(text="答")
            yield TurnDone(usage=None, raw_text="答")

    from app.agent_runtime.loop import LoopParams, run_agent_loop
    from app.agent_runtime.tool_registry import ToolRegistry
    from app.governance.latency_budget import DEFAULT_BUDGETS

    async def _collect():
        events = []
        params = LoopParams(
            user_input="问",
            registry=ToolRegistry(),
            client=LoopModelClient(FakeBackend()),
            budgets=DEFAULT_BUDGETS,
        )
        async for event in run_agent_loop(params):
            events.append(event)
        return events

    import asyncio

    events = asyncio.run(_collect())
    chunks = [
        getattr(event, "text", None)
        for event in events
        if type(event).__name__ == "ReasoningChunk"
    ]
    assert chunks == ["想想"], f"loop 必须把 reasoning 送出去，收到：{[type(e).__name__ for e in events]}"


def test_agent_loop_exposes_first_model_delta_before_backend_finishes() -> None:
    """真正的流式必须在后端产出后续 delta 前把首段交给消费者。

    只断言最终收到了 a/b/c 仍会让「先攒完整 list、再一次性重放」的假流式
    混过去；逐个 ``__anext__`` 才能钉死首字延迟的真实边界。
    """
    produced: list[str] = []

    class FakeBackend:
        used_backend = "fake"

        def generate(self, messages, tools, budget_ms, cancel_scope):
            yield TurnStarted()
            for text in ("a", "b", "c"):
                produced.append(text)
                yield MessageDelta(text=text)
            yield TurnDone(usage=None, raw_text="abc")

    from app.agent_runtime.loop import LoopParams, ModelChunk, run_agent_loop
    from app.agent_runtime.tool_registry import ToolRegistry
    from app.governance.latency_budget import DEFAULT_BUDGETS

    async def _first_chunk():
        stream = run_agent_loop(LoopParams(
            user_input="问",
            registry=ToolRegistry(),
            client=LoopModelClient(FakeBackend()),
            budgets=DEFAULT_BUDGETS,
        ))
        try:
            while True:
                event = await stream.__anext__()
                if isinstance(event, ModelChunk):
                    return event
        finally:
            await stream.aclose()

    import asyncio

    first = asyncio.run(_first_chunk())
    assert first.text == "a"
    assert produced == ["a"], "后端的 b/c 不该在消费者看到首段前就被读完"


# ---- 桥 sink 层：trajectory + 进度行 -------------------------------------


class _FakeClock:
    def __init__(self) -> None:
        self.blobs: list[tuple[str, str]] = []

    def mark(self, phase: str, **fields):
        return 0.0

    def mark_blob(self, phase: str, blob: str) -> float:
        self.blobs.append((phase, blob))
        return 0.0


def _b64(text: str) -> str:
    return base64.b64encode(text.encode("utf-8")).decode("ascii")


def test_conversation_sink_routes_reasoning_into_record_and_progress_line() -> None:
    from scripts import conversation_bridge

    clock = _FakeClock()
    sink = conversation_bridge._ConversationActivitySink(clock)
    sink(SimpleNamespace(kind="loop_start"))
    sink(SimpleNamespace(kind="turn_started", turn=1))
    sink(SimpleNamespace(kind="reasoning_chunk", text="第一步思考"))
    sink(SimpleNamespace(kind="reasoning_chunk", text="，第二步"))
    sink(SimpleNamespace(kind="model_chunk", text="答案"))
    sink(SimpleNamespace(kind="turn_finished", state=SimpleNamespace(value="done")))

    # 1) trajectory 的 message record 带 reasoning（正式渲染用）。
    message_records = [r for r in sink.trajectory if r.get("kind") == "message"]
    assert message_records, sink.trajectory
    assert message_records[0].get("reasoning") == "第一步思考，第二步"

    # 2) reasoning_chunk 进度行（边想边画用），base64 与 answer_chunk 同款。
    reasoning_blobs = [b for phase, b in clock.blobs if phase == "reasoning_chunk"]
    assert reasoning_blobs, clock.blobs
    decoded = "".join(
        base64.b64decode(blob).decode("utf-8") for blob in reasoning_blobs
    )
    assert "第一步思考" in decoded and "第二步" in decoded
