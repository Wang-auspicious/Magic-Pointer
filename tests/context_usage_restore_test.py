from app.agent_runtime.session import FileSessionStore
from app.agent_runtime.types import AgentMessage, Role
from scripts.agent_session_bridge import handle_request


def test_usage_restores_last_request_from_durable_log_without_writing(tmp_path, monkeypatch):
    monkeypatch.setenv("MAGIC_POINTER_USER_DATA_DIR", str(tmp_path))
    session = FileSessionStore(tmp_path / "agent-sessions").create("usage-restore")
    session.start_turn()
    session.append_message(AgentMessage(role=Role.USER, content="解释这个文件", tool_call_id=None, name=None))
    for step, count in [(1, 6888), (2, 42085)]:
        session.record_model_request(
            messages=session.derive_messages(), tools=[{"name": "Read"}],
            header={"systemPrompt": "已有提示词"}, step=step,
        )
        session.append("model/response", {"turn": 1, "step": step, "usage": {
            "prompt_tokens": count, "completion_tokens": 805,
        }})
        session.append_message(AgentMessage(role=Role.ASSISTANT, content="答复", tool_call_id=None, name=None))
    before = session.path.read_bytes()
    result = handle_request({"action": "usage", "sessionId": session.id})
    assert result["ok"] is True
    usage = result["contextUsage"]
    assert usage["contextTokens"] == 42085
    assert usage["contextEstimated"] == 0
    assert usage["lastOutputTokens"] == 805
    assert usage["systemTokensEstimate"] > 0
    assert usage["toolSchemaTokensEstimate"] > 0
    assert usage["messageTokensEstimate"] > 0
    assert "inputTokens" not in usage  # Never replace the separate billing totals.
    assert session.path.read_bytes() == before
