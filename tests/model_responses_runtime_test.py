from __future__ import annotations

import asyncio
import contextlib
import json
from types import SimpleNamespace

from app import ai_client
from app.agent_runtime import loop
from app.agent_runtime.model_client import (
    AiClientMessagesBackend,
    MessageDelta,
    ToolCallArrived,
    TurnDone,
    TurnWithheld,
    _convert_tools,
    _messages_payload,
    _parse_sse,
    _response_hit_token_limit,
)
from app.agent_runtime.session import FileSessionStore
from app.agent_runtime.tool_registry import ToolRegistry
from app.agent_runtime.types import AgentMessage, Role


def _msg(role: Role, content: str = "", **kwargs) -> AgentMessage:
    return AgentMessage(role=role, content=content, tool_call_id=kwargs.get("tool_call_id"), name=None,
                        tool_calls=kwargs.get("tool_calls", []), is_error=kwargs.get("is_error", False))


def test_responses_payload_projects_history_to_input_items() -> None:
    payload = _messages_payload(
        "gpt-5", [_msg(Role.USER, "问"), _msg(Role.ASSISTANT, "答")], [], 32, "responses",
        system_prompt="系统",
    )
    assert payload["instructions"] == "系统"
    assert payload["max_output_tokens"] == 32
    assert payload["input"][0]["content"][0] == {"type": "input_text", "text": "问"}
    assert payload["input"][1]["role"] == "assistant"
    assert payload["input"][1]["content"] == "答"


def test_responses_payload_replays_provider_reasoning_item_before_assistant_output() -> None:
    reasoning = {"type": "reasoning", "id": "rs_1", "summary": []}
    message = AgentMessage(
        role=Role.ASSISTANT, content="答", tool_call_id=None, name=None,
        provider_items=(reasoning,), origin="data",
    )
    payload = _messages_payload("gpt-5", [message], [], 32, "responses")
    assert payload["input"] == [reasoning, {"role": "assistant", "content": "答"}]


def test_agent_message_provider_items_survive_session_json_roundtrip() -> None:
    reasoning = {"type": "reasoning", "id": "rs_1", "summary": []}
    message = AgentMessage(
        role=Role.ASSISTANT, content="答", tool_call_id=None, name=None,
        provider_items=(reasoning,), origin="data",
    )
    restored = AgentMessage.from_dict(message.to_dict())
    assert restored.provider_items == (reasoning,)


def test_provider_reasoning_item_survives_disk_session_reload(tmp_path) -> None:
    reasoning = {"type": "reasoning", "id": "rs_disk", "summary": []}
    store = FileSessionStore(tmp_path)
    session = store.create("responses-session")
    session.append_message(AgentMessage(
        role=Role.ASSISTANT, content="答", tool_call_id=None, name=None,
        provider_items=(reasoning,), origin="data",
    ))
    resumed = store.resume("responses-session")
    payload = _messages_payload("gpt-5", resumed.derive_messages(), [], 32, "responses")
    assert reasoning in payload["input"]


def test_public_loop_binds_durable_session_id_to_model_requests(monkeypatch) -> None:
    seen: list[str | None] = []

    @contextlib.contextmanager
    def bind(session_id):
        seen.append(session_id)
        yield

    async def fake_impl(_params):
        yield "done"

    monkeypatch.setattr(loop._ai_client, "request_ai_session", bind)
    monkeypatch.setattr(loop, "_run_agent_loop_impl", fake_impl)
    params = loop.LoopParams(
        user_input="问", registry=ToolRegistry(), client=object(),
        session=SimpleNamespace(id="durable-session-1"),
    )

    async def collect():
        return [event async for event in loop.run_agent_loop(params)]

    assert asyncio.run(collect()) == ["done"]
    assert seen == ["durable-session-1"]


def test_responses_two_rounds_replay_opaque_reasoning_item() -> None:
    class Response:
        status_code = 200
        text = "ok"

        def __init__(self, payload):
            self.payload = payload

        def json(self):
            return self.payload

    class Client:
        def __init__(self):
            self.requests: list[dict] = []
            self.responses = iter((
                {"output": [
                    {"type": "reasoning", "id": "rs_1", "summary": []},
                    {"type": "function_call", "call_id": "call_1", "name": "lookup", "arguments": "{}"},
                ]},
                {"output": [{"type": "message", "content": [{"type": "output_text", "text": "done"}]}]},
            ))

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def post(self, _url, *, headers, json):
            self.requests.append(json)
            return Response(next(self.responses))

    client = Client()
    backend = AiClientMessagesBackend()
    backend._client_factory = lambda _budget: client
    with ai_client.request_ai_config({"credential": "key", "baseUrl": "https://gateway.example/v1", "model": "gpt-5", "apiMode": "responses"}):
        first = list(backend.generate([_msg(Role.USER, "问")], []))
        done = next(event for event in first if isinstance(event, TurnDone))
        assistant = AgentMessage(
            role=Role.ASSISTANT, content="", tool_call_id=None, name=None,
            tool_calls=({"id": "call_1", "name": "lookup", "arguments": {}},),
            provider_items=done.provider_items, origin="data",
        )
        list(backend.generate([_msg(Role.USER, "问"), assistant], []))
    assert client.requests[1]["input"][0] == {"role": "user", "content": [{"type": "input_text", "text": "问"}]}
    assert client.requests[1]["input"][1] == {"type": "reasoning", "id": "rs_1", "summary": []}
    assert client.requests[1]["input"][2]["type"] == "function_call"


def test_responses_tools_use_native_function_shape_and_token_limit() -> None:
    converted = _convert_tools([{"name": "lookup", "description": "d", "parameters": {"type": "object"}}], "responses")
    assert converted == [{"type": "function", "name": "lookup", "description": "d", "parameters": {"type": "object"}, "strict": False}]
    assert _response_hit_token_limit({"status": "incomplete", "incomplete_details": {"reason": "max_output_tokens"}}, "responses")


def test_responses_stream_emits_text_tool_call_and_usage() -> None:
    frames = [
        {"type": "response.output_text.delta", "delta": "查一下"},
        {"type": "response.output_item.added", "output_index": 1,
         "item": {"type": "function_call", "id": "fc_1", "call_id": "call_1", "name": "lookup", "arguments": ""}},
        {"type": "response.function_call_arguments.delta", "output_index": 1, "item_id": "fc_1", "delta": '{"q":"hello"}'},
        {"type": "response.completed", "response": {"status": "completed", "usage": {"input_tokens": 7, "output_tokens": 9}, "output": [{"type": "reasoning", "id": "rs_1", "summary": []}]}},
    ]
    events = list(_parse_sse(["data: " + json.dumps(frame) for frame in frames], api_mode="responses"))
    assert [event.text for event in events if isinstance(event, MessageDelta)] == ["查一下"]
    calls = [event.call for event in events if isinstance(event, ToolCallArrived)]
    assert len(calls) == 1 and calls[0].id == "call_1" and calls[0].arguments == {"q": "hello"}
    assert [event.usage for event in events if isinstance(event, TurnDone)] == [{"input_tokens": 7, "output_tokens": 9}]
    assert next(event for event in events if isinstance(event, TurnDone)).provider_items == (
        {"type": "reasoning", "id": "rs_1", "summary": []},
    )


def test_responses_content_filter_incomplete_is_not_a_successful_answer() -> None:
    frames = [
        {"type": "response.output_text.delta", "delta": "partial"},
        {"type": "response.incomplete", "response": {
            "status": "incomplete", "incomplete_details": {"reason": "content_filter"},
        }},
    ]
    events = list(_parse_sse(["data: " + json.dumps(frame) for frame in frames], api_mode="responses"))
    assert [event.reason for event in events if isinstance(event, TurnWithheld)] == [
        "backend_error:response_incomplete:content_filter",
    ]


def test_responses_nonstream_content_filter_incomplete_is_withheld(monkeypatch) -> None:
    class Response:
        status_code = 200
        text = "partial"

        def json(self):
            return {
                "status": "incomplete", "incomplete_details": {"reason": "content_filter"},
                "output": [{"type": "message", "content": [{"type": "output_text", "text": "partial"}]}],
            }

    class Client:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def post(self, *_args, **_kwargs):
            return Response()

    monkeypatch.setattr(ai_client, "get_ai_config", lambda: ("key", "https://gateway.example/v1", "model"))
    monkeypatch.setattr(ai_client, "get_ai_api_mode", lambda _base: "responses")
    monkeypatch.setattr(ai_client, "short_circuit_message", lambda _base: None)
    monkeypatch.setattr(ai_client, "record_failure", lambda **_kwargs: None)
    monkeypatch.setattr(ai_client, "record_success", lambda **_kwargs: None)
    backend = AiClientMessagesBackend()
    backend._client_factory = lambda _budget: Client()
    events = list(backend.generate([_msg(Role.USER, "hello")], []))
    assert [event.reason for event in events if isinstance(event, TurnWithheld)] == [
        "backend_error:response_incomplete:content_filter",
    ]
