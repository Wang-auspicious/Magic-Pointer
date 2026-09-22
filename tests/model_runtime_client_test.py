from __future__ import annotations

from app.models.profiles import ModelProfile
from app.models.runtime_client import ModelRuntimeClient


def _profile(*, mode: str = "chat-completions", base_url: str = "https://opencode.ai/zen/go/v1") -> ModelProfile:
    return ModelProfile(
        id="go",
        display_name="OpenCode Go",
        provider="opencode",
        base_url=base_url,
        model="mimo-v2.5",
        api_mode=mode,
        credential_ref="credential:model:go",
        enabled=True,
        overrides={"audioInput": "auto", "toolCalls": "auto"},
        resolved={
            "audioInput": "unknown", "toolCalls": "unknown",
            "source": "unknown", "evidence": "", "checkedAt": "",
        },
    )


def test_profile_runtime_uses_the_profile_headers(monkeypatch) -> None:
    calls: list[tuple[str, str, str]] = []

    def headers(api_key: str, api_mode: str, *, base_url: str | None = None):
        calls.append((api_key, api_mode, str(base_url)))
        return {"Content-Type": "application/json", "x-opencode-session": "conversation-17"}

    monkeypatch.setattr("app.models.runtime_client.ai_client._completion_headers", headers)
    requests: list[dict] = []

    def transport(request):
        requests.append(request)
        return {"status": 200, "json": {"choices": [{"message": {"content": "done"}}]}}

    client = ModelRuntimeClient(transport=transport)
    profile = _profile()
    assert client.complete_text(profile, credential="key", user_text="hello")["ok"] is True

    assert calls == [("key", "chat-completions", "https://opencode.ai/zen/go/v1")]
    assert all(request["headers"]["x-opencode-session"] == "conversation-17" for request in requests)
    assert not hasattr(client, "probe_vision"), "文字/视觉两分的探针不该回来"

