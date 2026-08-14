"""Multi-turn messages-protocol backend for the agent loop (batch 4 wiring).

``AiClientMessagesBackend`` is the real production ModelBackend: it sends the
loop's full message history as a native messages array (chat-completions or
Anthropic-style messages protocol) instead of flattening everything into one
user_prompt. Assistant tool calls and their results keep the provider-native
ids and roles across turns.

Tests use a stubbed httpx client; nothing real is called.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import ai_client  # noqa: E402
from app.agent_runtime.model_client import (  # noqa: E402
    AiClientMessagesBackend,
    ToolCallArrived,
    TurnDone,
    TurnWithheld,
)
from app.agent_runtime.types import AgentMessage, Role  # noqa: E402


def _user(content: str) -> AgentMessage:
    return AgentMessage(role=Role.USER, content=content, tool_call_id=None, name=None)


def _assistant(content: str) -> AgentMessage:
    return AgentMessage(role=Role.ASSISTANT, content=content, tool_call_id=None, name=None)


def _assistant_tool_call(
    content: str = "",
    call_id: str = "call_1",
    name: str = "read_around",
) -> AgentMessage:
    return AgentMessage(
        role=Role.ASSISTANT,
        content=content,
        tool_call_id=None,
        name=None,
        tool_calls=({"id": call_id, "name": name, "arguments": {"anchor": "a1"}},),
    )


def _tool_result(
    content: str,
    call_id: str = "call_1",
    name: str = "read_around",
    *,
    is_error: bool = False,
) -> AgentMessage:
    return AgentMessage(
        role=Role.TOOL,
        content=content,
        tool_call_id=call_id,
        name=name,
        is_error=is_error,
        origin="data",
    )


TOOLS = [
    {
        "name": "read_around",
        "description": "read around an anchor",
        "parameters": {"type": "object", "properties": {}, "required": []},
    }
]


class FakeResponse:
    def __init__(self, status_code: int, payload: dict) -> None:
        self.status_code = status_code
        self._payload = payload
        self.text = "fake"

    def json(self):
        return self._payload


class FakeClient:
    """Stubbed httpx.Client factory capturing every post call."""

    def __init__(self, calls: list) -> None:
        self._calls = calls

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return None

    def post(self, url, *, headers, json):
        self._calls.append({"url": url, "headers": headers, "json": json})
        return FakeResponse(200, {
            "usage": {"prompt_tokens": 15, "completion_tokens": 6},
            "choices": [{
                "message": {
                    "content": "answer text",
                    "tool_calls": [
                        {"function": {"name": "read_around", "arguments": '{"anchor": "a1"}'}},
                    ],
                }
            }]
        })


def _backend(calls: list) -> AiClientMessagesBackend:
    backend = AiClientMessagesBackend(timeout_s=5.0, max_tokens=120)
    backend._client_factory = lambda timeout: FakeClient(calls)  # type: ignore[attr-defined]
    return backend


def _no_circuit(monkeypatch) -> None:
    monkeypatch.setattr(ai_client, "short_circuit_message", lambda _base_url=None: None)


def test_chat_completions_sends_native_messages_array(monkeypatch):
    calls: list = []
    monkeypatch.setattr(
        ai_client,
        "get_ai_config",
        lambda: ("key", "https://gateway.example/v1", "text-model"),
    )
    _no_circuit(monkeypatch)

    events = list(_backend(calls).generate(
        [
            _user("先读一下这里"),
            _assistant_tool_call("好的"),
            _tool_result('{"status": "ok", "value": "hello"}'),
        ],
        TOOLS,
        budget_ms=3000,
    ))

    assert len(calls) == 1
    request = calls[0]
    assert request["url"] == "https://gateway.example/v1/chat/completions"
    assert request["headers"]["Authorization"] == "Bearer key"
    payload = request["json"]
    assert payload["model"] == "text-model"
    assert [m["role"] for m in payload["messages"]] == ["user", "assistant", "tool"]
    assert payload["messages"][2]["tool_call_id"] == "call_1"
    assert payload["messages"][2]["content"].startswith('{"status": "ok"')
    assert payload["messages"][1]["tool_calls"][0]["id"] == "call_1"
    assert payload["tools"] == [{
        "type": "function",
        "function": {
            "name": "read_around",
            "description": "read around an anchor",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    }]
    assert payload["tool_choice"] == "auto"
    assert payload["max_tokens"] == 120

    kinds = [type(event).__name__ for event in events]
    assert "TurnStarted" in kinds
    assert kinds.count("MessageDelta") == 1
    tool_calls = [event for event in events if isinstance(event, ToolCallArrived)]
    assert len(tool_calls) == 1
    assert tool_calls[0].call.name == "read_around"
    assert tool_calls[0].call.arguments == {"anchor": "a1"}
    assert events[-1].raw_text == "answer text"
    assert events[-1].usage == {"prompt_tokens": 15, "completion_tokens": 6}


def test_messages_protocol_endpoint_and_headers(monkeypatch):
    calls: list = []
    monkeypatch.setattr(
        ai_client,
        "get_ai_config",
        lambda: ("key", "https://api.deepseek.com/anthropic/v1", "text-model"),
    )
    _no_circuit(monkeypatch)

    class MessagesClient:
        def __init__(self, calls_inner: list) -> None:
            self._calls = calls_inner

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def post(self, url, *, headers, json):
            self._calls.append({"url": url, "headers": headers, "json": json})
            return FakeResponse(200, {
                "content": [
                    {"type": "text", "text": "messages answer"},
                    {"type": "tool_use", "name": "look", "input": {"anchor": "bbox:1,2,3,4"}},
                ]
            })

    backend = AiClientMessagesBackend(timeout_s=5.0, max_tokens=120)
    backend._client_factory = lambda timeout: MessagesClient(calls)  # type: ignore[attr-defined]

    events = list(backend.generate(
        [
            _user("看看这个"),
            _assistant_tool_call(name="look"),
            _tool_result("read failed", name="look", is_error=True),
        ],
        TOOLS,
        budget_ms=3000,
    ))

    assert calls[0]["url"] == "https://api.deepseek.com/anthropic/v1/messages"
    assert calls[0]["headers"]["x-api-key"] == "key"
    assert "Authorization" not in calls[0]["headers"]
    request_messages = calls[0]["json"]["messages"]
    assert request_messages[1]["content"][0]["type"] == "tool_use"
    assert request_messages[1]["content"][0]["id"] == "call_1"
    assert request_messages[2]["content"][0]["tool_use_id"] == "call_1"
    assert request_messages[2]["content"][0]["is_error"] is True
    tool_calls = [event for event in events if isinstance(event, ToolCallArrived)]
    assert tool_calls[0].call.name == "look"
    assert tool_calls[0].call.arguments == {"anchor": "bbox:1,2,3,4"}


def test_budget_ms_becomes_http_timeout(monkeypatch):
    calls: list = []
    monkeypatch.setattr(
        ai_client,
        "get_ai_config",
        lambda: ("key", "https://gateway.example/v1", "text-model"),
    )
    _no_circuit(monkeypatch)

    captured: list = []

    class Client:
        def __init__(self, timeout):
            captured.append(timeout)

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def post(self, url, *, headers, json):
            calls.append({"url": url, "headers": headers, "json": json})
            return FakeResponse(200, {
                "choices": [{"message": {"content": "ok"}}]
            })

    backend = AiClientMessagesBackend(timeout_s=5.0, max_tokens=120)
    backend._client_factory = lambda timeout: Client(timeout)  # type: ignore[attr-defined]

    list(backend.generate([_user("hi")], TOOLS, budget_ms=2500))

    assert captured[0] == 2.5


def test_backend_error_is_withheld_and_finished(monkeypatch):
    calls: list = []
    monkeypatch.setattr(
        ai_client,
        "get_ai_config",
        lambda: ("key", "https://gateway.example/v1", "text-model"),
    )
    _no_circuit(monkeypatch)

    class ErrorClient:
        def __init__(self, calls_inner: list) -> None:
            self._calls = calls_inner

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def post(self, url, *, headers, json):
            self._calls.append({"url": url, "headers": headers, "json": json})
            return FakeResponse(200, {"error": {"message": "gateway exploded"}})

    backend = AiClientMessagesBackend(timeout_s=5.0, max_tokens=120)
    backend._client_factory = lambda timeout: ErrorClient(calls)  # type: ignore[attr-defined]

    events = list(backend.generate([_user("hi")], TOOLS))

    withheld = [event for event in events if isinstance(event, TurnWithheld)]
    assert len(withheld) == 1
    assert "backend_error" in withheld[0].reason
    assert isinstance(events[-1], TurnDone)


def test_empty_http_200_response_is_withheld_instead_of_fake_completion(
    monkeypatch,
):
    monkeypatch.setattr(
        ai_client,
        "get_ai_config",
        lambda: ("key", "https://gateway.example/v1", "text-model"),
    )
    _no_circuit(monkeypatch)

    class EmptyClient:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def post(self, _url, *, headers, json):
            return FakeResponse(200, {
                "choices": [{
                    "message": {"content": "", "tool_calls": []},
                    "finish_reason": "stop",
                }],
            })

    backend = AiClientMessagesBackend(timeout_s=5.0, max_tokens=120)
    backend._client_factory = lambda _timeout: EmptyClient()  # type: ignore[attr-defined]

    events = list(backend.generate([_user("hi")], TOOLS))

    assert [
        event.reason for event in events if isinstance(event, TurnWithheld)
    ] == ["backend_error:empty_response"]
    assert isinstance(events[-1], TurnDone)


def test_non_streaming_token_limits_are_withheld_in_both_protocols(monkeypatch):
    _no_circuit(monkeypatch)

    class PayloadClient:
        def __init__(self, payload):
            self.payload = payload

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def post(self, _url, *, headers, json):
            return FakeResponse(200, self.payload)

    cases = [
        (
            "https://gateway.example/v1",
            {
                "choices": [
                    {
                        "message": {"content": "partial"},
                        "finish_reason": "length",
                    }
                ]
            },
        ),
        (
            "https://api.deepseek.com/anthropic/v1",
            {
                "content": [{"type": "text", "text": "partial"}],
                "stop_reason": "max_tokens",
            },
        ),
    ]

    for base_url, payload in cases:
        monkeypatch.setattr(
            ai_client,
            "get_ai_config",
            lambda base_url=base_url: ("key", base_url, "text-model"),
        )
        backend = AiClientMessagesBackend(timeout_s=5.0, max_tokens=120)
        backend._client_factory = (  # type: ignore[attr-defined]
            lambda _timeout, payload=payload: PayloadClient(payload)
        )

        events = list(backend.generate([_user("hi")], TOOLS))

        assert [
            event.reason for event in events if isinstance(event, TurnWithheld)
        ] == ["max_output_tokens"]


def test_open_circuit_is_withheld_before_any_request(monkeypatch):
    monkeypatch.setattr(
        ai_client,
        "get_ai_config",
        lambda: ("key", "https://gateway.example/v1", "text-model"),
    )
    monkeypatch.setattr(
        ai_client,
        "short_circuit_message",
        lambda _base_url=None: "模型端点余额不足",
    )

    backend = AiClientMessagesBackend(timeout_s=5.0, max_tokens=120)

    events = list(backend.generate([_user("hi")], TOOLS))

    withheld = [event for event in events if isinstance(event, TurnWithheld)]
    assert len(withheld) == 1
    assert "余额不足" in withheld[0].reason
    assert isinstance(events[-1], TurnDone)


def test_system_prompt_is_sent_natively(monkeypatch):
    calls: list = []
    monkeypatch.setattr(
        ai_client,
        "get_ai_config",
        lambda: ("key", "https://gateway.example/v1", "text-model"),
    )
    _no_circuit(monkeypatch)

    backend = AiClientMessagesBackend(
        timeout_s=5.0,
        max_tokens=120,
        system_prompt="你是桌面助手。",
    )
    backend._client_factory = lambda timeout: FakeClient(calls)  # type: ignore[attr-defined]

    list(backend.generate([_user("hi")], TOOLS))

    payload = calls[0]["json"]
    assert payload["messages"][0] == {"role": "system", "content": "你是桌面助手。"}
    assert payload["messages"][1] == {"role": "user", "content": "hi"}


def test_system_prompt_uses_messages_protocol_system_field(monkeypatch):
    calls: list = []
    monkeypatch.setattr(
        ai_client,
        "get_ai_config",
        lambda: ("key", "https://api.deepseek.com/anthropic/v1", "text-model"),
    )
    _no_circuit(monkeypatch)

    class MessagesClient:
        def __init__(self, calls_inner: list) -> None:
            self._calls = calls_inner

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def post(self, url, *, headers, json):
            self._calls.append({"url": url, "headers": headers, "json": json})
            return FakeResponse(200, {
                "content": [{"type": "text", "text": "ok"}]
            })

    backend = AiClientMessagesBackend(
        timeout_s=5.0,
        max_tokens=120,
        system_prompt="你是桌面助手。",
    )
    backend._client_factory = lambda timeout: MessagesClient(calls)  # type: ignore[attr-defined]

    list(backend.generate([_user("hi")], TOOLS))

    payload = calls[0]["json"]
    assert payload["system"] == "你是桌面助手。"
    assert payload["messages"][0] == {"role": "user", "content": "hi"}
