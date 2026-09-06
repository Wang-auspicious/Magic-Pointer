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
