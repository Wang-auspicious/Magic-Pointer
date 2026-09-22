from __future__ import annotations

from app import ai_client


def test_request_ai_config_overrides_legacy_model_for_one_request(monkeypatch) -> None:
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("OPENAI_BASE_URL", raising=False)
    monkeypatch.delenv("MAGIC_POINTER_MODEL", raising=False)
    monkeypatch.setattr(ai_client, "read_local_secret", lambda _name: None)

    with ai_client.request_ai_config({
        "provider": "groq",
        "credential": "request-secret",
        "baseUrl": "https://api.groq.com/openai/v1",
        "model": "openai/gpt-oss-120b",
        "apiMode": "chat-completions",
        "effort": "xhigh",
    }):
        assert ai_client.get_ai_config() == (
            "request-secret",
            "https://api.groq.com/openai/v1",
            "openai/gpt-oss-120b",
        )
        assert ai_client.get_ai_api_mode() == "chat-completions"
        assert ai_client.get_ai_effort() == "xhigh"

    assert ai_client.get_ai_config() == (None, None, "gpt-4o-mini")
    assert ai_client.get_ai_effort() == "high"


def test_request_ai_config_preserves_responses_api_mode(monkeypatch) -> None:
    monkeypatch.setattr(ai_client, "read_local_secret", lambda _name: None)

    with ai_client.request_ai_config({
        "provider": "openai",
        "credential": "request-secret",
        "baseUrl": "https://api.openai.com/v1",
        "model": "gpt-5",
        "apiMode": "responses",
    }):
        assert ai_client.get_ai_api_mode() == "responses"
        assert ai_client._completion_endpoint("https://api.openai.com/v1", "responses") == (
            "https://api.openai.com/v1/responses"
        )


def test_responses_mode_uses_responses_payload_and_extracts_output_text() -> None:
    payload = ai_client._text_completion_payload(
        model="gpt-5",
        content="hello",
        system_prompt="system",
        max_tokens=64,
        api_mode="responses",
    )
    assert payload == {
        "model": "gpt-5",
        "input": [{"role": "user", "content": [{"type": "input_text", "text": "hello"}]}],
        "instructions": "system",
        "max_output_tokens": 64,
    }
    assert ai_client._text_completion_response({
        "output": [{"type": "message", "content": [{"type": "output_text", "text": "done"}]}],
    }, "responses") == "done"
    assert ai_client._empty_answer_evidence({"status": "incomplete", "incomplete_details": {"reason": "max_output_tokens"}}, "responses") == "finish=max_output_tokens"


def test_responses_mode_is_respected_in_legacy_config(monkeypatch) -> None:
    monkeypatch.setenv("MAGIC_POINTER_API_MODE", "responses")
    with ai_client.request_ai_config(None):
        assert ai_client.get_ai_api_mode() == "responses"


def test_local_profile_does_not_require_or_send_a_remote_credential(monkeypatch) -> None:
    monkeypatch.setattr(ai_client, "read_local_secret", lambda _name: None)
    with ai_client.request_ai_config({
        "provider": "local", "baseUrl": "http://localhost:1234/v1",
        "model": "local-model", "apiMode": "local",
    }):
        assert ai_client.get_ai_config()[0] is None
        assert ai_client.get_ai_api_mode() == "local"
        assert "Authorization" not in ai_client._completion_headers("", "local")


def test_opencode_go_requests_use_the_runtime_session_id(monkeypatch) -> None:
    monkeypatch.setattr(ai_client, "read_local_secret", lambda _name: None)
    with ai_client.request_ai_config({"effort": "high"}, session_id="conversation-17"):
        first = ai_client._completion_headers("key", "chat-completions", base_url="https://opencode.ai/zen/go/v1")
        second = ai_client._completion_headers("key", "chat-completions", base_url="https://opencode.ai/zen/go/v1")
        assert first["x-opencode-session"] == "conversation-17"
        assert second["x-opencode-session"] == first["x-opencode-session"]
        assert "x-opencode-session" not in ai_client._completion_headers("key", "chat-completions", base_url="https://api.openai.com/v1")


def test_responses_reasoning_controls_can_be_stripped_for_gateway_retry() -> None:
    assert ai_client._without_optional_request_fields({
        "model": "gpt-5", "reasoning": {"effort": "high"}, "input": [],
    }) == {"model": "gpt-5", "input": []}


def test_responses_preserves_malformed_tool_arguments_for_runtime_correction() -> None:
    raw = '{"anchor":'
    parsed = ai_client._tool_completion_response({
        "output": [{"type": "function_call", "call_id": "call_1", "name": "read", "arguments": raw}],
    }, "responses")
    assert parsed["toolCalls"][0]["arguments"] == raw


def test_responses_tools_keep_optional_arguments_non_strict() -> None:
    payload = ai_client._tool_completion_payload(
        model="gpt-5", content="read", system_prompt="system", max_tokens=64,
        api_mode="responses", tools=[{"function": {
            "name": "read", "parameters": {"type": "object", "properties": {"path": {"type": "string"}}},
        }}],
    )
    assert payload["tools"][0]["strict"] is False


def test_vision_request_uses_responses_input_format(monkeypatch, tmp_path) -> None:
    calls = []

    class Response:
        status_code = 200
        text = "ok"

        def json(self):
            return {"output": [{"type": "message", "content": [{"type": "output_text", "text": "image read"}]}]}

    class Client:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def post(self, url, *, headers, json):
            calls.append((url, json))
            return Response()

    monkeypatch.setattr(ai_client, "read_local_secret", lambda _name: None)
    monkeypatch.setattr(ai_client, "_httpx_client", lambda *_args, **_kwargs: Client())
    monkeypatch.setattr(ai_client, "_image_data_url", lambda _path: "data:image/png;base64,YWJj")
    monkeypatch.setattr(ai_client, "short_circuit_message", lambda _base_url: None)
    monkeypatch.setattr(ai_client, "record_success", lambda **_kwargs: None)
    monkeypatch.setenv("MAGIC_POINTER_VISION_MODEL", "gemini-2.5-flash")
    monkeypatch.setenv("MAGIC_POINTER_VISION_BASE_URL", "https://wrong.example/v1")
    monkeypatch.setenv("MAGIC_POINTER_VISION_KEY", "wrong-key")
    monkeypatch.setenv("MAGIC_POINTER_VISION_API_MODE", "messages")
    with ai_client.request_ai_config({
        "provider": "openai", "model": "gpt-5", "credential": "key",
        "baseUrl": "https://api.openai.com/v1", "apiMode": "responses",
    }):
        answer = ai_client.ask_vision_model(tmp_path / "frame.png", "read this", attempts=1)

    assert answer == "image read"
    assert calls[0][0] == "https://api.openai.com/v1/responses"
    payload = calls[0][1]
    assert payload["model"] == "gpt-5"
    assert "messages" not in payload
    assert payload["input"][0]["content"][0]["type"] == "input_text"
    assert payload["input"][0]["content"][1] == {"type": "input_image", "image_url": "data:image/png;base64,YWJj"}
    assert payload["max_output_tokens"] == 1200
    assert payload["instructions"]


def test_request_ai_config_does_not_leak_between_resident_worker_requests(monkeypatch) -> None:
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("OPENAI_BASE_URL", raising=False)
    monkeypatch.delenv("MAGIC_POINTER_MODEL", raising=False)
    monkeypatch.setattr(ai_client, "read_local_secret", lambda _name: None)

    with ai_client.request_ai_config({
        "credential": "first-secret",
        "baseUrl": "https://api.groq.com/openai/v1",
        "model": "llama-3.1-8b-instant",
        "apiMode": "chat-completions",
    }):
        assert ai_client.get_ai_config()[0] == "first-secret"

    assert ai_client.get_ai_config()[0] is None


def test_empty_request_config_keeps_legacy_local_secret_fallback(monkeypatch) -> None:
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("OPENAI_BASE_URL", raising=False)
    monkeypatch.delenv("MAGIC_POINTER_MODEL", raising=False)
    values = {
        "openai_key.txt": "legacy-secret",
        "openai_base_url.txt": "https://legacy.example/v1",
        "model.txt": "legacy-model",
    }
    monkeypatch.setattr(ai_client, "read_local_secret", values.get)

    with ai_client.request_ai_config(None):
        assert ai_client.get_ai_config() == (
            "legacy-secret",
            "https://legacy.example/v1",
            "legacy-model",
        )


def test_effort_without_a_model_profile_keeps_local_model_configuration(monkeypatch) -> None:
    for name in ("OPENAI_API_KEY", "OPENAI_BASE_URL", "MAGIC_POINTER_MODEL", "MAGIC_POINTER_API_MODE"):
        monkeypatch.delenv(name, raising=False)
    values = {
        "openai_key.txt": "local-secret",
        "openai_base_url.txt": "https://local.example/v1",
        "model.txt": "configured-model",
        "model_api_mode.txt": "messages",
    }
    monkeypatch.setattr(ai_client, "read_local_secret", values.get)

    with ai_client.request_ai_config({"effort": "xhigh"}):
        assert ai_client.get_ai_config() == (
            "local-secret", "https://local.example/v1", "configured-model",
        )
        assert ai_client.get_ai_api_mode() == "messages"
        assert ai_client.get_ai_effort() == "xhigh"


def test_missing_profile_credential_names_selected_provider_not_openai_file(monkeypatch) -> None:
    monkeypatch.setattr(ai_client, "read_local_secret", lambda _name: None)

    with ai_client.request_ai_config({
        "provider": "groq",
        "baseUrl": "https://api.groq.com/openai/v1",
        "model": "openai/gpt-oss-120b",
        "apiMode": "chat-completions",
    }):
        answer = ai_client.ask_text_model("hello", attempts=1)

    assert "Groq" in answer
    assert "模型档案" in answer
    assert "OPENAI_API_KEY" not in answer
