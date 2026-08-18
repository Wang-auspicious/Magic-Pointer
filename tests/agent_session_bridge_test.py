from __future__ import annotations

from app.agent_runtime.session import FileSessionStore
from scripts.agent_session_bridge import handle_request


def test_agent_session_bridge_put_and_pending_share_runtime_store(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("MAGIC_POINTER_USER_DATA_DIR", str(tmp_path))
    FileSessionStore(tmp_path / "agent-sessions").create("bridge-session")

    put = handle_request({
        "action": "put",
        "sessionId": "bridge-session",
        "target": "next-step",
        "text": "先解释，不要执行",
        "messageId": "bridge-msg-1",
    })
    pending = handle_request({
        "action": "pending",
        "sessionId": "bridge-session",
        "target": "next-step",
    })

    assert put == {
        "ok": True,
        "sessionId": "bridge-session",
        "messageId": "bridge-msg-1",
        "target": "next-step",
    }
    assert pending["ok"] is True
    assert pending["messages"] == [{
        "messageId": "bridge-msg-1",
        "target": "next-step",
        "text": "先解释，不要执行",
    }]


def test_agent_session_bridge_rejects_unknown_session_and_target(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("MAGIC_POINTER_USER_DATA_DIR", str(tmp_path))
    FileSessionStore(tmp_path / "agent-sessions").create("known-session")

    missing = handle_request({
        "action": "pending",
        "sessionId": "missing-session",
        "target": "next-step",
    })
    invalid = handle_request({
        "action": "put",
        "sessionId": "known-session",
        "target": "whenever",
        "text": "hello",
    })

    assert missing == {"ok": False, "error": "session_not_found"}
    assert invalid == {"ok": False, "error": "invalid_target"}
