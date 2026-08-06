from __future__ import annotations

from app.adapters.base import AdapterReadContext
from scripts.selection_bridge import grounded_browser_failure_answer


def _browser_context(error: str, url: str) -> AdapterReadContext:
    return AdapterReadContext(
        adapter="browser_devtools",
        app="browser",
        content="Network failed: TypeError",
        method="cdp:dom-point",
        artifacts={
            "browser_context": {
                "networkFailures": [{"url": url, "errorText": error}],
            },
        },
    )


def test_unsafe_port_failure_is_answered_from_evidence_without_a_model() -> None:
    answer = grounded_browser_failure_answer(
        "为什么支付失败？这是后端挂了还是前端问题？我应该先检查哪里？",
        _browser_context(
            "Failed to load resource: net::ERR_UNSAFE_PORT",
            "http://user:secret@127.0.0.1:9/api/payment?token=private",
        ),
    )

    assert answer is not None
    assert "没有到达后端" in answer
    assert "ERR_UNSAFE_PORT" in answer
    assert "http://127.0.0.1:9/api/payment" in answer
    assert "secret" not in answer
    assert "token" not in answer


def test_unknown_network_failure_is_not_overdiagnosed() -> None:
    answer = grounded_browser_failure_answer(
        "为什么失败？",
        _browser_context("mysterious browser failure", "https://example.test/api"),
    )
    assert answer is None


def test_non_diagnostic_command_does_not_hijack_the_model_path() -> None:
    answer = grounded_browser_failure_answer(
        "把这句话翻译成中文",
        _browser_context("net::ERR_UNSAFE_PORT", "http://127.0.0.1:9/api"),
    )
    assert answer is None
