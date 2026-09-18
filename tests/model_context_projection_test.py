import json

import pytest

from app.agent_runtime.model_client import _messages_payload
from app.agent_runtime.types import AgentMessage, Role


def read_message(call_id="read-1", latency=123):
    source_id = "source:report"
    locators = [{"kind": "pdf-region", "value": {"pageIndex": i, "blockIndex": 0,
                 "rectPt": [72, 80, 500, 130]}} for i in range(12)]
    data = {"sourceId": source_id, "fragments": [{
        "fragmentId": f"fragment:{i}", "locator": locator, "text": f"Decisive fact {i}",
        "metadata": {"sourceTitle": "Selected report", "sourceRevision": {"capturedAt": "2026-09-18"}},
        "citations": [{"sourceId": source_id, "locator": locator}],
    } for i, locator in enumerate(locators)],
        "coverage": {"extent": "document", "complete": False, "readRanges": locators,
                     "totalUnits": 21, "nextCursor": "unit:12", "missingReason": None},
        "evidenceStatus": "ok", "usedBackend": "document.pdf.pymupdf", "latencyMs": latency}
    return AgentMessage(Role.TOOL, json.dumps(data), call_id, "Context.read", origin="data")


def results(payload, api_mode):
    if api_mode == "responses":
        return [item["output"] for item in payload["input"] if item["type"] == "function_call_output"]
    if api_mode == "messages":
        return [block["content"] for item in payload["messages"] for block in item["content"]
                if isinstance(block, dict) and block.get("type") == "tool_result"]
    return [item["content"] for item in payload["messages"] if item["role"] == "tool"]


@pytest.mark.parametrize("api_mode", ["messages", "responses", "chat-completions"])
def test_provider_projection_keeps_facts_and_cursors_without_repeated_metadata(api_mode):
    message = read_message()
    original = message.content
    payload = _messages_payload("model", [message], [], 2000, api_mode)
    projected = results(payload, api_mode)[0]
    assert len(projected) < len(original) * .60
    decoded = json.loads(projected)
    assert decoded["coverage"]["nextCursor"] == "unit:12"
    assert decoded["coverage"]["complete"] is False
    assert decoded["fragments"][-1]["text"] == "Decisive fact 11"
    assert decoded["fragments"][-1]["locator"]["value"]["pageIndex"] == 11
    assert decoded["sourceId"] == "source:report"
    assert message.content == original


def test_identical_reads_reference_content_only_while_it_is_in_current_context():
    first = read_message()
    again = read_message("read-2", latency=0.5)
    payload = _messages_payload("model", [first, again], [], 2000, "chat-completions")
    projected = results(payload, "chat-completions")
    assert len(projected[1]) < 200
    assert "read-1" in projected[1]
    assert payload["messages"][1]["tool_call_id"] == "read-2"
    after_compact = _messages_payload("model", [again], [], 2000, "chat-completions")
    assert "Decisive fact 11" in results(after_compact, "chat-completions")[0]


def test_errors_and_write_receipts_are_never_replaced_with_duplicate_read_notes():
    content = "Important diagnostic or action receipt. " * 30
    messages = [AgentMessage(Role.TOOL, content, str(i), name, is_error=error, origin="data")
                for name, error in [("Context.read", True), ("Context.read", True),
                                    ("Bash", False), ("Bash", False)] for i in [1]]
    assert results(_messages_payload("model", messages, [], 2000, "chat-completions"),
                   "chat-completions") == [content] * 4
