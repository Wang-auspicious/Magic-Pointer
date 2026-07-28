from __future__ import annotations

import json

from app.models.profiles import ModelProfile
from app.models.runtime_client import ModelRuntimeClient


def profile(**changes: object) -> ModelProfile:
    value: dict[str, object] = {
        "schemaVersion": 1,
        "id": "primary",
        "displayName": "Primary",
        "provider": "openai-compatible",
        "baseUrl": "https://example.invalid/v1",
        "model": "local-model",
        "apiMode": "chat-completions",
        "credentialRef": "credential:model:primary",
        "enabled": True,
        "overrides": {"visionInput": "auto", "audioInput": "auto", "toolCalls": "auto"},
    }
    value.update(changes)
    return ModelProfile.from_dict(value)


def test_runtime_client_uses_ephemeral_credential_without_echoing_it() -> None:
    seen: dict[str, object] = {}

    def transport(request: dict[str, object]) -> dict[str, object]:
        seen.update(request)
        return {"status": 200, "json": {"choices": [{"message": {"content": "grounded answer"}}]}}

    result = ModelRuntimeClient(transport=transport).complete_text(
        profile(),
        credential="sk-only-in-memory",
        user_text="What is selected?",
    )

    assert result == {"ok": True, "state": "completed", "text": "grounded answer", "evidence": {"apiMode": "chat-completions"}}
    assert seen["headers"] == {"Authorization": "Bearer sk-only-in-memory", "Content-Type": "application/json"}
    assert "sk-only-in-memory" not in json.dumps(result)


def test_runtime_client_uses_responses_shape_and_parses_output_text() -> None:
    seen: dict[str, object] = {}

    def transport(request: dict[str, object]) -> dict[str, object]:
        seen.update(request)
        return {"status": 200, "json": {"output": [{"content": [{"type": "output_text", "text": "OK"}]}]}}

    result = ModelRuntimeClient(transport=transport).complete_text(
        profile(apiMode="responses"),
        credential="ephemeral",
        user_text="ping",
        system_text="grounded only",
    )

    assert result == {"ok": True, "state": "completed", "text": "OK", "evidence": {"apiMode": "responses"}}
    assert seen["url"] == "https://example.invalid/v1/responses"
    assert seen["json"] == {
        "model": "local-model",
        "instructions": "grounded only",
        "input": [{"role": "user", "content": [{"type": "input_text", "text": "ping"}]}],
    }


def test_runtime_client_uses_messages_shape_and_never_sends_anthropic_key_as_bearer() -> None:
    seen: dict[str, object] = {}

    def transport(request: dict[str, object]) -> dict[str, object]:
        seen.update(request)
        return {"status": 200, "json": {"content": [{"type": "text", "text": "grounded"}]}}

    result = ModelRuntimeClient(transport=transport).complete_text(
        profile(provider="anthropic", apiMode="messages", baseUrl="https://api.anthropic.com/v1"),
        credential="ephemeral",
        user_text="ping",
    )

    assert result == {"ok": True, "state": "completed", "text": "grounded", "evidence": {"apiMode": "messages"}}
    assert seen["url"] == "https://api.anthropic.com/v1/messages"
    assert seen["headers"] == {
        "x-api-key": "ephemeral",
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
    }
    assert "ephemeral" not in json.dumps(result)


def test_local_profile_does_not_require_or_emit_a_credential() -> None:
    seen: dict[str, object] = {}

    def transport(request: dict[str, object]) -> dict[str, object]:
        seen.update(request)
        return {"status": 200, "json": {"choices": [{"message": {"content": "local"}}]}}

    result = ModelRuntimeClient(transport=transport).complete_text(
        profile(provider="local", apiMode="local", baseUrl="http://127.0.0.1:11434/v1"),
        credential=None,
        user_text="ping",
    )

    assert result == {"ok": True, "state": "completed", "text": "local", "evidence": {"apiMode": "local"}}
    assert seen["headers"] == {"Content-Type": "application/json"}


def test_vision_probe_uses_one_pixel_image_and_returns_yes_without_echoing_credential() -> None:
    seen: dict[str, object] = {}

    def transport(request: dict[str, object]) -> dict[str, object]:
        seen.update(request)
        return {"status": 200, "json": {"choices": [{"message": {"content": "OK"}}]}}

    result = ModelRuntimeClient(transport=transport).probe_vision(
        profile(),
        credential="ephemeral-secret",
    )

    assert result["ok"] is True
    assert result["visionInput"] == "yes"
    content = seen["json"]["messages"][0]["content"]  # type: ignore[index]
    assert content[1]["type"] == "image_url"
    assert content[1]["image_url"]["url"].startswith("data:image/png;base64,")
    assert "ephemeral-secret" not in json.dumps(result)


def test_vision_probe_classifies_explicit_unsupported_response_as_no() -> None:
    client = ModelRuntimeClient(transport=lambda _request: {
        "status": 400,
        "json": {"error": {"message": "This model does not support image input"}},
        "text": "This model does not support image input",
    })

    result = client.probe_vision(profile(), credential="ephemeral")

    assert result["ok"] is True
    assert result["visionInput"] == "no"
    assert result["evidence"]["probe"] == "user_requested_1x1_image"


def test_vision_probe_keeps_auth_or_ambiguous_failures_unknown() -> None:
    client = ModelRuntimeClient(transport=lambda _request: {
        "status": 401,
        "json": {"error": {"message": "invalid credential"}},
        "text": "invalid credential",
    })

    result = client.probe_vision(profile(), credential="bad")

    assert result["ok"] is False
    assert result["visionInput"] == "unknown"
    assert result["error"] == "vision_probe_inconclusive_http_401"
