"""Tests for the thinking-disabled contract in chat-completions mode.

Regression nail for the 2026-08-07 incident: deepseek-v4-flash on OpenCode Go
returned HTTP 200 with finish_reason=length, content="" and 1199 reasoning
tokens — the whole max_tokens budget was spent on thinking, so the user saw
"模型在本次预算内没有返回可见答案". Fix: chat-completions payloads carry
thinking disabled (same contract as messages mode), gateways that reject the
param get a stripped retry, and empty answers now carry diagnostics.
"""
from __future__ import annotations

from app.ai_client import (
    _empty_answer_evidence,
    _text_completion_payload,
    ask_text_model,
)
from app import model_health


def test_chat_completions_payload_disables_thinking() -> None:
    payload = _text_completion_payload(
        model="deepseek-v4-flash",
        content="question",
        system_prompt="grounded only",
        max_tokens=120,
        api_mode="chat-completions",
    )
    assert payload["thinking"] == {"type": "disabled"}
    assert payload["max_tokens"] == 120
    assert payload["messages"][0]["role"] == "system"
    assert payload["messages"][1]["role"] == "user"


def test_empty_answer_evidence_reports_reasoning_tokens() -> None:
    data = {
        "choices": [{"finish_reason": "length", "message": {"content": ""}}],
        "usage": {
            "completion_tokens": 1199,
            "completion_tokens_details": {"reasoning_tokens": 1199},
        },
    }
    detail = _empty_answer_evidence(data, "chat-completions")
    assert "finish=length" in detail
    assert "reasoning_tokens=1199" in detail
    assert "completion_tokens=1199" in detail


def test_empty_answer_evidence_handles_missing_usage() -> None:
    detail = _empty_answer_evidence({"choices": [{"finish_reason": "stop"}]}, "chat-completions")
    assert detail == "finish=stop"


def test_empty_answer_is_reported_with_diagnostics(monkeypatch, tmp_path) -> None:
    calls = []

    class Response:
        status_code = 200
        text = "ok"

        def json(self):
            return {
                "choices": [{
                    "finish_reason": "length",
                    "message": {"content": "", "reasoning_content": "x" * 100},
                }],
                "usage": {
                    "completion_tokens": 1199,
                    "completion_tokens_details": {"reasoning_tokens": 1199},
                },
            }

    class Client:
        def __init__(self, **_kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def post(self, url, *, headers, json):
            calls.append(json)
            return Response()

    monkeypatch.setattr("app.ai_client.get_ai_config", lambda: (
        "secret", "https://opencode.ai/zen/go/v1", "deepseek-v4-flash",
    ))
    monkeypatch.setattr("httpx.Client", Client)
    monkeypatch.setattr(model_health, "_state_path", lambda: tmp_path / "health.json")
    model_health.record_success(model="deepseek-v4-flash", base_url="https://opencode.ai/zen/go/v1")

    answer = ask_text_model("问", timeout_s=5, attempts=1)

    assert "没有返回可见答案" in answer
    assert "finish=length" in answer
    assert "reasoning_tokens=1199" in answer
    assert calls[0]["thinking"] == {"type": "disabled"}


def test_400_thinking_param_is_stripped_and_retried(monkeypatch, tmp_path) -> None:
    calls = []

    class Response:
        status_code = 200
        text = "ok"

        def __init__(self, code, body):
            self.status_code = code
            self._body = body

        def json(self):
            return self._body

    class Client:
        def __init__(self, **_kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def post(self, url, *, headers, json):
            calls.append(json)
            if "thinking" in json:
                return Response(400, {"error": {"message": "unknown param: thinking"}})
            return Response(200, {
                "choices": [{
                    "finish_reason": "stop",
                    "message": {"role": "assistant", "content": "retried-ok"},
                }],
                "usage": {"completion_tokens": 4},
            })

    monkeypatch.setattr("app.ai_client.get_ai_config", lambda: (
        "secret", "https://opencode.ai/zen/go/v1", "deepseek-v4-flash",
    ))
    monkeypatch.setattr("httpx.Client", Client)
    monkeypatch.setattr(model_health, "_state_path", lambda: tmp_path / "health.json")
    model_health.record_success(model="deepseek-v4-flash", base_url="https://opencode.ai/zen/go/v1")

    answer = ask_text_model("问", timeout_s=5, attempts=1)

    assert answer == "retried-ok"
    assert len(calls) == 2
    assert "thinking" in calls[0]
    assert "thinking" not in calls[1]
