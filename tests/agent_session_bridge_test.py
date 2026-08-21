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


def test_agent_session_bridge_cancel_requests_graceful_stop(tmp_path, monkeypatch) -> None:
    from app.agent_runtime.loop import run_agent_loop  # noqa: F401  (import sanity)
    from app.agent_runtime.session import cancel_interrupt_check

    monkeypatch.setenv("MAGIC_POINTER_USER_DATA_DIR", str(tmp_path))
    store = FileSessionStore(tmp_path / "agent-sessions")
    session = store.create("running-session")
    session.start_turn()

    no_turn = handle_request({
        "action": "cancel",
        "sessionId": "missing-session",
    })
    assert no_turn == {"ok": False, "error": "session_not_found"}

    cancelled = handle_request({
        "action": "cancel",
        "sessionId": "running-session",
    })
    assert cancelled == {"ok": True, "sessionId": "running-session", "turn": 1}
    # The production interrupt check sees it and consumes it exactly once.
    check = cancel_interrupt_check(session)
    assert check() is True
    assert check() is False
    session.end_turn(session.open_turn, reason="user_interrupt")

    idle = handle_request({
        "action": "cancel",
        "sessionId": "running-session",
    })
    assert idle == {"ok": False, "error": "no_open_turn"}


def test_agent_session_bridge_status_reports_pending_work(tmp_path, monkeypatch) -> None:
    from app.agent_runtime.types import Role

    monkeypatch.setenv("MAGIC_POINTER_USER_DATA_DIR", str(tmp_path))
    store = FileSessionStore(tmp_path / "agent-sessions")
    session = store.create("status-session")
    session.start_turn()
    session.append_message(_msg(Role.USER, "长任务"))
    session.end_turn(session.open_turn, reason="budget_exhausted")

    status = handle_request({"action": "status", "sessionId": "status-session"})
    assert status == {
        "ok": True,
        "sessionId": "status-session",
        "hasPendingWork": True,
        "lastTurnReason": "budget_exhausted",
        "openTurn": None,
    }

    session.start_turn()
    session.append_message(_msg(Role.ASSISTANT, "收尾完成"))
    session.end_turn(session.open_turn, reason="completed")
    status = handle_request({"action": "status", "sessionId": "status-session"})
    assert status["hasPendingWork"] is False
    assert status["lastTurnReason"] == "completed"


def _msg(role, content):
    from app.agent_runtime.types import AgentMessage, ORIGIN_DATA, ORIGIN_INSTRUCTION, Role

    return AgentMessage(
        role=role,
        content=content,
        tool_call_id=None,
        name=None,
        origin=ORIGIN_INSTRUCTION if role is Role.USER else ORIGIN_DATA,
    )
