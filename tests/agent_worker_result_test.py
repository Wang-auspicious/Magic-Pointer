from __future__ import annotations

import json

from scripts.agent_worker import _extract_result


def test_jsonl_result_keeps_identity_and_final_text_but_drops_runtime_inventory() -> None:
    stdout = "\n".join([
        json.dumps({"type": "system", "skills": ["secret-local-skill"], "apiKeySource": "env"}),
        json.dumps({"type": "assistant", "message": {"content": [{"text": "hidden envelope"}]}}),
        json.dumps({
            "type": "result",
            "subtype": "success",
            "is_error": False,
            "session_id": "session-1",
            "result": "DONE",
        }),
    ])

    result = _extract_result(stdout, "jsonl")

    assert result["sessionId"] == "session-1"
    assert result["outputText"] == "DONE"
    assert result["terminalEvent"] == {
        "type": "result",
        "subtype": "success",
        "is_error": False,
        "session_id": "session-1",
    }
    assert "secret-local-skill" not in json.dumps(result)


def test_codex_result_recovers_thread_id_and_agent_message() -> None:
    stdout = "\n".join([
        json.dumps({"type": "thread.started", "thread_id": "thread-1"}),
        json.dumps({"type": "item.completed", "item": {"type": "agent_message", "text": "OK"}}),
        json.dumps({"type": "turn.completed", "usage": {"input_tokens": 123}}),
    ])

    result = _extract_result(stdout, "jsonl")

    assert result["sessionId"] == "thread-1"
    assert result["outputText"] == "OK"
    assert result["terminalEvent"] == {"type": "turn.completed"}
