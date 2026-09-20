import pytest

from app.agent_runtime.session import FileSessionStore
from app.agent_runtime.types import Terminal, TransitionReason
from app.fabric import engine
from scripts import conversation_bridge, selection_bridge
from conversation_bridge_test import _FakeClock, _install_workspace_boot_stubs


@pytest.mark.parametrize("outcome", ["completed", "open", "crash"])
def test_conversation_runtime_turn_does_not_alias_previous_turn(monkeypatch, tmp_path, outcome):
    session = FileSessionStore(tmp_path / "sessions").create("task-turn-boundary")
    prior = session.start_turn()
    session.end_turn(prior, reason="completed")
    _install_workspace_boot_stubs(monkeypatch, {}, fake_session=session)

    def run(*args, **kwargs):
        current = session.start_turn()
        if outcome == "crash":
            raise RuntimeError("interrupted after turn/start")
        if outcome == "completed":
            session.end_turn(current, reason="completed")
        return Terminal(reason=TransitionReason.COMPLETED, message="done", turns=1, results=())

    monkeypatch.setattr(engine, "run_agent_turn", run)
    result = conversation_bridge.answer_conversation("continue", [], {}, "read-only", clock=_FakeClock(), agent_session_id=session.id)
    assert result["runtimeTurn"] == (2 if outcome == "completed" else None)


@pytest.mark.parametrize("completed", [False, True])
def test_selection_runtime_turn_requires_completed_current_turn(monkeypatch, tmp_path, completed):
    monkeypatch.setenv("MAGIC_POINTER_USER_DATA_DIR", str(tmp_path))

    def run(*args, **kwargs):
        session = kwargs["session"]
        previous = session.start_turn()
        session.end_turn(previous, reason="completed")
        current = session.start_turn()
        if completed:
            session.end_turn(current, reason="completed")
        return Terminal(reason=TransitionReason.COMPLETED, message="done", turns=1, results=())

    monkeypatch.setattr(engine, "run_agent_turn", run)
    result = selection_bridge._loop_router("inspect", [{"id": "object"}], None, None, None, None, "selection-boundary", "snapshot-boundary", clock=selection_bridge.PhaseClock("test", enabled=False))
    assert result["runtimeTurn"] == (2 if completed else None)
