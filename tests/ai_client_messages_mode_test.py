from __future__ import annotations

from app.ai_client import (
    _completion_endpoint,
    _completion_headers,
    _tool_completion_payload,
    _tool_completion_response,
    _text_completion_payload,
    _text_completion_response,
    _vision_content_block,
    ask_text_model,
    ask_text_model_with_tools,
)
from app import model_health


def test_messages_mode_uses_anthropic_shape_and_never_bearer_auth() -> None:
    headers = _completion_headers("secret", "messages")
    payload = _text_completion_payload(
        model="deepseek-v4-flash[1M]",
        content="question",
        system_prompt="grounded only",
        max_tokens=32,
        api_mode="messages",
    )

    assert _completion_endpoint("https://api.deepseek.com/anthropic/v1", "messages") == (
        "https://api.deepseek.com/anthropic/v1/messages"
    )
    assert headers["x-api-key"] == "secret"
    assert "Authorization" not in headers
    assert payload["system"] == "grounded only"
    assert payload["messages"] == [{"role": "user", "content": "question"}]
    assert payload["thinking"] == {"type": "disabled"}
    assert not any(item.get("role") == "system" for item in payload["messages"])


def test_messages_response_collects_text_blocks() -> None:
    assert _text_completion_response({
        "content": [
            {"type": "thinking", "thinking": "private"},
            {"type": "text", "text": "grounded"},
            {"type": "text", "text": "answer"},
        ],
    }, "messages") == "grounded\nanswer"


def test_messages_tool_payload_and_response_use_anthropic_contract() -> None:
    payload = _tool_completion_payload(
        model="deepseek-v4-flash[1M]",
        content="retry it",
        system_prompt="grounded only",
        tools=[{
            "type": "function",
            "function": {
                "name": "retry_payment",
                "description": "Retry the payment",
                "parameters": {
                    "type": "object",
                    "properties": {"orderId": {"type": "string"}},
                    "required": ["orderId"],
                },
            },
        }],
        max_tokens=96,
        api_mode="messages",
    )

    assert payload["system"] == "grounded only"
    assert payload["thinking"] == {"type": "disabled"}
    assert payload["tools"] == [{
        "name": "retry_payment",
        "description": "Retry the payment",
        "input_schema": {
            "type": "object",
            "properties": {"orderId": {"type": "string"}},
            "required": ["orderId"],
        },
    }]
    assert "tool_choice" not in payload

    response = _tool_completion_response({
        "content": [
            {"type": "thinking", "thinking": "private"},
            {"type": "text", "text": "I'll retry it."},
            {"type": "tool_use", "name": "retry_payment", "input": {"orderId": "A-7"}},
        ],
    }, "messages")
    assert response == {
        "text": "I'll retry it.",
        "toolCalls": [{"name": "retry_payment", "arguments": {"orderId": "A-7"}}],
    }


def test_messages_vision_uses_anthropic_base64_source() -> None:
    assert _vision_content_block("data:image/jpeg;base64,YWJj", "messages") == {
        "type": "image",
        "source": {
            "type": "base64",
            "media_type": "image/jpeg",
            "data": "YWJj",
        },
    }


def test_gateway_health_probes_anthropic_completion_not_models(monkeypatch, tmp_path) -> None:
    calls = []

    class Response:
        status_code = 200
        text = "ok"

    class Client:
        def __init__(self, **_kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def post(self, url, *, headers, json):
            calls.append((url, headers, json))
            return Response()

        def get(self, *_args, **_kwargs):
            raise AssertionError("messages mode must not probe /models")

    monkeypatch.setattr("app.ai_client.get_ai_config", lambda: (
        "secret", "https://api.deepseek.com/anthropic/v1", "deepseek-v4-flash[1M]",
    ))
    monkeypatch.setattr("httpx.Client", Client)
    monkeypatch.setattr(model_health, "_state_path", lambda: tmp_path / "health.json")

    health = model_health.probe_gateway(timeout_s=1)

    assert health.healthy is True
    assert calls[0][0] == "https://api.deepseek.com/anthropic/v1/messages"
    assert calls[0][1]["x-api-key"] == "secret"
    assert "Authorization" not in calls[0][1]
    assert calls[0][2]["max_tokens"] == 1


def test_request_read_timeout_does_not_poison_gateway_health(monkeypatch, tmp_path) -> None:
    import httpx

    class Client:
        def __init__(self, **_kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def post(self, *_args, **_kwargs):
            raise httpx.ReadTimeout("request budget expired")

    monkeypatch.setattr("app.ai_client.get_ai_config", lambda: (
        "secret", "https://api.deepseek.com/anthropic/v1", "deepseek-v4-flash[1M]",
    ))
    monkeypatch.setattr("httpx.Client", Client)
    monkeypatch.setattr(model_health, "_state_path", lambda: tmp_path / "health.json")
    model_health.record_success(model="deepseek-v4-flash[1M]", base_url="https://api.deepseek.com/anthropic/v1")

    result = ask_text_model_with_tools("比较下", tools=[], timeout_s=1, attempts=1)

    assert result["error"] == "model_request_timeout"
    assert model_health.read_health().state == "ok"
    assert model_health.read_health().circuit_open is False


def test_text_request_timeout_is_reported_as_this_request_not_endpoint_outage(monkeypatch, tmp_path) -> None:
    import httpx

    class Client:
        def __init__(self, **_kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def post(self, *_args, **_kwargs):
            raise httpx.ReadTimeout("request budget expired")

    monkeypatch.setattr("app.ai_client.get_ai_config", lambda: (
        "secret", "https://api.deepseek.com/anthropic/v1", "deepseek-v4-flash[1M]",
    ))
    monkeypatch.setattr("httpx.Client", Client)
    monkeypatch.setattr(model_health, "_state_path", lambda: tmp_path / "health.json")
    model_health.record_success(model="deepseek-v4-flash[1M]", base_url="https://api.deepseek.com/anthropic/v1")

    answer = ask_text_model("比较下", timeout_s=1, attempts=1)

    assert "模型回答超过 1 秒" in answer
    assert "连不上模型端点" not in answer
    assert model_health.read_health().state == "ok"
