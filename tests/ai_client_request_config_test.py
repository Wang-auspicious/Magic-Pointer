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
    }):
        assert ai_client.get_ai_config() == (
            "request-secret",
            "https://api.groq.com/openai/v1",
            "openai/gpt-oss-120b",
        )
        assert ai_client.get_ai_api_mode() == "chat-completions"

    assert ai_client.get_ai_config() == (None, None, "gpt-4o-mini")


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
