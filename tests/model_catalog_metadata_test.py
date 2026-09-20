from app import ai_client
from app.models_catalog import list_models


def test_provider_label_identifies_the_configured_service():
    from app.models_catalog import provider_label

    assert provider_label("https://opencode.ai/go/v1") == "opencode-go"
    assert provider_label("https://opencode.ai/zen/v1") == "opencode-zen"
    assert provider_label("https://compatible.example/v1") == "compatible.example"


def test_gateway_context_metadata_is_preserved(monkeypatch):
    class Response:
        status_code = 200

        def json(self):
            return {"data": [
                {"id": "vendor/large", "context_length": 1_000_000},
                {"id": "vendor/small", "context_window": 128_000},
                {"id": "vendor/nested", "top_provider": {"context_length": 262_144}},
            ]}

    monkeypatch.setattr("app.models_catalog._http_get_models", lambda *args, **kwargs: Response())
    with ai_client.request_ai_config({"model": "vendor/large", "baseUrl": "https://compatible.example/v1", "apiMode": "chat-completions"}):
        rows = list_models()["groups"][0]["models"]
    assert [row["contextWindow"] for row in rows] == [1_000_000, 128_000, 262_144]


def test_catalog_and_runtime_share_per_model_window():
    profile = {"model": "vendor/large", "defaultContextWindow": 96_000,
               "models": [{"id": "vendor/large", "contextWindow": 1_000_000},
                          {"id": "vendor/unknown"}, {"id": "gpt-4o"}]}
    with ai_client.request_ai_config(profile):
        rows = list_models()["groups"][0]["models"]
        assert [row["contextWindow"] for row in rows] == [1_000_000, 96_000, 128_000]
        assert ai_client.get_ai_context_window() == 1_000_000
    with ai_client.request_ai_config({**profile, "model": "vendor/unknown"}):
        assert ai_client.get_ai_context_window() == 96_000


def test_discovered_metadata_preserves_legacy_secret_configuration(monkeypatch):
    for name in ("MAGIC_POINTER_MODEL", "OPENAI_BASE_URL", "OPENAI_API_KEY"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(ai_client, "read_local_secret", lambda name: {
        "model.txt": "vendor/large", "openai_base_url.txt": "https://compatible.example/v1",
    }.get(name))
    with ai_client.request_ai_config({"models": [{"id": "vendor/large", "contextWindow": 1_000_000}]}):
        assert ai_client.get_ai_config() == (None, "https://compatible.example/v1", "vendor/large")
        assert ai_client.get_ai_context_window() == 1_000_000
