"""The thinking-disabled contract in chat-completions mode, and its escape hatch.

History, because the contract reversed itself between two gateways:

- 2026-08-07, deepseek-v4-flash on OpenCode Go: HTTP 200, finish=length,
  content="", 1199 reasoning tokens. The whole ``max_tokens`` budget went to
  thinking. Fix at the time: send ``thinking: {"type": "disabled"}`` on
  chat-completions payloads too, the same contract the messages branch had.
- 2026-09-16, mimo-v2.5 on the same host: that very parameter *produces* the
  failure it was added to prevent. Measured on the live endpoint, same prompt,
  one variable changed:

      with    thinking:disabled -> 53.0s, finish=length, completion=1200,
                                   content=None
      without thinking          -> 31.0s, finish=stop,   completion=103,
                                   content='地基探针正常'

So the parameter is a per-gateway guess, not a contract. It stays as the
default because it is still right for the gateway that needed it, but a
gateway that answers *emptily* now gets the same stripped retry that a gateway
which answers *400* already got. An HTTP 200 with no visible answer is
evidence that an optional request field was not understood, and the one
retry is far cheaper than returning "AI 调用失败" to a user.

The regression nail for the 08-07 incident lived in this file until
``463f7a3`` ("harness reconstruction batch") deleted it as a "stale/duplicate
test file" while leaving the code it guarded in place.
"""
from __future__ import annotations

from app import model_health
from app.ai_client import (
    _empty_answer_evidence,
    _text_completion_payload,
    _without_optional_request_fields,
    ask_text_model,
)

_BASE_URL = "https://opencode.ai/zen/go/v1"
_MODEL = "mimo-v2.5"


class _Response:
    def __init__(self, code: int, body: dict) -> None:
        self.status_code = code
        self._body = body
        self.text = "ok"

    def json(self) -> dict:
        return self._body


def _empty_length_body() -> dict:
    return {
        "choices": [{
            "finish_reason": "length",
            "message": {"content": "", "reasoning_content": "x" * 100},
        }],
        "usage": {
            "completion_tokens": 1200,
            "completion_tokens_details": {"reasoning_tokens": 1200},
        },
    }


def _answer_body(text: str) -> dict:
    return {
        "choices": [{
            "finish_reason": "stop",
            "message": {"role": "assistant", "content": text},
        }],
        "usage": {"completion_tokens": 4},
    }


def _install_gateway(monkeypatch, tmp_path, respond) -> list[dict]:
    """Point ai_client at a fake gateway; return the list of payloads sent."""
    calls: list[dict] = []

    class Client:
        def __init__(self, **_kwargs) -> None:
            pass

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def post(self, _url, *, headers, json):
            calls.append(json)
            return respond(json)

    monkeypatch.setattr(
        "app.ai_client.get_ai_config", lambda: ("secret", _BASE_URL, _MODEL)
    )
    monkeypatch.setattr("httpx.Client", Client)
    monkeypatch.setattr(model_health, "_state_path", lambda: tmp_path / "health.json")
    model_health.record_success(model=_MODEL, base_url=_BASE_URL)
    return calls


def test_chat_completions_payload_disables_thinking_by_default() -> None:
    payload = _text_completion_payload(
        model=_MODEL,
        content="question",
        system_prompt="grounded only",
        max_tokens=120,
        api_mode="chat-completions",
    )
    assert payload["thinking"] == {"type": "disabled"}
    assert payload["max_tokens"] == 120
    assert payload["messages"][0]["role"] == "system"
    assert payload["messages"][1]["role"] == "user"


def test_stripping_removes_every_optional_reasoning_control() -> None:
    payload = _text_completion_payload(
        model=_MODEL,
        content="question",
        system_prompt="grounded only",
        max_tokens=120,
        api_mode="chat-completions",
        effort="high",
    )
    stripped = _without_optional_request_fields(payload)
    assert stripped is not None
    assert "thinking" not in stripped
    assert "reasoning_effort" not in stripped
    # max_tokens is not an optional control: dropping it would hand the
    # gateway its own default ceiling instead of the caller's latency budget.
    assert stripped["max_tokens"] == 120


def test_empty_answer_evidence_reports_reasoning_tokens() -> None:
    detail = _empty_answer_evidence(_empty_length_body(), "chat-completions")
    assert "finish=length" in detail
    assert "reasoning_tokens=1200" in detail
    assert "completion_tokens=1200" in detail


def test_empty_answer_evidence_handles_missing_usage() -> None:
    detail = _empty_answer_evidence(
        {"choices": [{"finish_reason": "stop"}]}, "chat-completions"
    )
    assert detail == "finish=stop"


def test_empty_200_retries_once_without_the_optional_controls(
    monkeypatch, tmp_path
) -> None:
    """The measured mimo-v2.5 failure: 200 + empty, cured by stripping.

    This is the behaviour the 4xx branch already had. A gateway that rejects
    an unknown field loudly and one that accepts it and then answers nothing
    are the same problem, and only the loud one was being handled.
    """

    def respond(payload: dict) -> _Response:
        if "thinking" in payload or "reasoning_effort" in payload:
            return _Response(200, _empty_length_body())
        return _Response(200, _answer_body("地基探针正常"))

    calls = _install_gateway(monkeypatch, tmp_path, respond)

    answer = ask_text_model("问", timeout_s=5, attempts=1)

    assert answer == "地基探针正常"
    assert len(calls) == 2
    assert calls[0]["thinking"] == {"type": "disabled"}
    assert "thinking" not in calls[1]
    assert "reasoning_effort" not in calls[1]


def test_empty_200_still_fails_honestly_when_stripping_does_not_help(
    monkeypatch, tmp_path
) -> None:
    """A gateway that is simply out of budget must not be retried forever.

    One stripped retry, then the honest failure with the diagnostics that make
    the next fix obvious — the 08-07 contract, preserved.
    """

    def respond(_payload: dict) -> _Response:
        return _Response(200, _empty_length_body())

    calls = _install_gateway(monkeypatch, tmp_path, respond)

    answer = ask_text_model("问", timeout_s=5, attempts=1)

    assert "没有返回可见答案" in answer
    assert "finish=length" in answer
    assert "reasoning_tokens=1200" in answer
    assert len(calls) == 2


def test_non_empty_answer_never_pays_for_a_second_request(
    monkeypatch, tmp_path
) -> None:
    """The happy path must stay one round trip; the gateway is the slow part."""

    def respond(_payload: dict) -> _Response:
        return _Response(200, _answer_body("一次就够"))

    calls = _install_gateway(monkeypatch, tmp_path, respond)

    assert ask_text_model("问", timeout_s=5, attempts=1) == "一次就够"
    assert len(calls) == 1


def test_400_thinking_param_is_stripped_and_retried(monkeypatch, tmp_path) -> None:
    def respond(payload: dict) -> _Response:
        if "thinking" in payload:
            return _Response(400, {"error": {"message": "unknown param: thinking"}})
        return _Response(200, _answer_body("retried-ok"))

    calls = _install_gateway(monkeypatch, tmp_path, respond)

    assert ask_text_model("问", timeout_s=5, attempts=1) == "retried-ok"
    assert len(calls) == 2
    assert "thinking" not in calls[1]
