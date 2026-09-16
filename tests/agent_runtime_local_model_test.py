from __future__ import annotations

from app import ai_client
from app.agent_runtime.model_client import (
    AiClientMessagesBackend,
    MessageDelta,
    StreamingMessagesBackend,
    TurnDone,
    TurnWithheld,
)
from app.agent_runtime.types import AgentMessage, Role

LOCAL_PROFILE = {
    "provider": "ollama", "model": "local-model", "credential": "",
    "baseUrl": "http://127.0.0.1:11434/v1", "apiMode": "local",
}


def _user() -> AgentMessage:
    return AgentMessage(role=Role.USER, content="hello", tool_call_id=None, name=None)


def test_local_profile_runs_nonstreaming_without_a_credential(monkeypatch) -> None:
    calls: list[tuple] = []

    class Response:
        status_code = 200
        text = "local answer"

        def json(self):
            return {"choices": [{"message": {"content": "local answer"}, "finish_reason": "stop"}]}

    class Client:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def post(self, url, *, headers, json):
            calls.append((url, headers, json))
            return Response()

    monkeypatch.setattr(ai_client, "read_local_secret", lambda _name: None)
    monkeypatch.setattr(ai_client, "short_circuit_message", lambda _base: None)
    monkeypatch.setattr(ai_client, "record_success", lambda **_kwargs: None)
    backend = AiClientMessagesBackend()
    backend._client_factory = lambda _budget: Client()
    with ai_client.request_ai_config(LOCAL_PROFILE):
        events = list(backend.generate([_user()], []))

    assert [event.text for event in events if isinstance(event, MessageDelta)] == ["local answer"]
    assert not [event for event in events if isinstance(event, TurnWithheld)]
    assert calls[0][0] == "http://127.0.0.1:11434/v1/chat/completions"
    assert "Authorization" not in calls[0][1]


def test_local_profile_runs_streaming_without_a_credential(monkeypatch) -> None:
    calls: list[tuple] = []

    def post_streaming(endpoint, headers, payload, *_args, **_kwargs):
        calls.append((endpoint, headers, payload))
        yield MessageDelta("local stream")
        yield TurnDone(usage=None, raw_text="local stream")

    monkeypatch.setattr(ai_client, "read_local_secret", lambda _name: None)
    monkeypatch.setattr(ai_client, "short_circuit_message", lambda _base: None)
    monkeypatch.setattr(ai_client, "record_success", lambda **_kwargs: None)
    backend = StreamingMessagesBackend()
    backend._post_streaming = post_streaming
    with ai_client.request_ai_config(LOCAL_PROFILE):
        events = list(backend.generate([_user()], []))

    assert [event.text for event in events if isinstance(event, MessageDelta)] == ["local stream"]
    assert not [event for event in events if isinstance(event, TurnWithheld)]
    assert calls[0][0] == "http://127.0.0.1:11434/v1/chat/completions"
    assert "Authorization" not in calls[0][1]
