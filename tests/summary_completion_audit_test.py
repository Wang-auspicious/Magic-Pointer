"""An incomplete model answer must never replace durable task history."""
import pytest
from app import ai_client
from app.agent_runtime.compaction_prompt import summarize_history_text


def test_unconfigured_summary_is_rejected(monkeypatch):
    monkeypatch.setattr(ai_client, "get_ai_config", lambda: (None, "https://example.invalid", "fake"))
    monkeypatch.setattr(ai_client, "get_ai_api_mode", lambda *_: "chat-completions")
    monkeypatch.setattr(ai_client, "record_unconfigured", lambda: None)
    assert ai_client.is_ai_failure(ai_client.ask_text_model("test"))
    assert not summarize_history_text("Original full history")


@pytest.mark.parametrize("mode, data", [
    ("chat-completions", {"choices": [{"finish_reason": "length", "message": {"content": "partial summary"}}]}),
    ("messages", {"content": [{"type": "text", "text": "partial summary"}], "stop_reason": "max_tokens"}),
    ("responses", {"status": "incomplete", "output": [{"type": "message", "content": [{"type": "output_text", "text": "partial summary"}]}]}),
])
def test_nonempty_incomplete_text_is_not_a_success(monkeypatch, mode, data):
    class Response:
        status_code = 200
        text = ""
        def json(self): return data
    class Client:
        def __enter__(self): return self
        def __exit__(self, *_): pass
        def post(self, *_args, **_kwargs): return Response()
    monkeypatch.setattr(ai_client, "get_ai_config", lambda: ("test-key", "https://example.invalid/v1", "fake"))
    monkeypatch.setattr(ai_client, "get_ai_api_mode", lambda *_: mode)
    monkeypatch.setattr(ai_client, "short_circuit_message", lambda *_: None)
    monkeypatch.setattr(ai_client, "record_success", lambda **_: None)
    monkeypatch.setattr(ai_client, "_httpx_client", lambda *_, **__: Client())
    assert ai_client.is_ai_failure(ai_client.ask_text_model("Summarize", attempts=1))
