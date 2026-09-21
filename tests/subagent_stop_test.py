from types import SimpleNamespace

from app.agent_runtime.session import FileSessionStore
from app.agent_runtime.subagent import register_delegate_tool
from app.agent_runtime.tool_registry import ToolRegistry
from app.agent_runtime.types import Terminal, TransitionReason
from app.fabric import engine as engine_module
from scripts.agent_session_bridge import handle_request


def test_child_consumes_own_cancel_without_cancelling_parent_or_sibling(tmp_path, monkeypatch):
    store = FileSessionStore(tmp_path / 'agent-sessions')
    parent = store.create('parent')
    parent.start_turn()
    sibling = store.create('sibling', parent_session_id=parent.id)
    sibling.start_turn()
    emitted = []

    def run(prompt, session, interrupt_check, **kwargs):
        turn = session.start_turn()
        store.resume(session.id).request_cancel(reason='stop only this child')
        assert interrupt_check() is True, 'child must observe its own durable cancel'
        assert session.pending_cancel_request() is False, 'observed cancel is consumed'
        assert not parent.pending_cancel_request()
        assert not sibling.pending_cancel_request()
        session.end_turn(turn, reason='user_interrupt')
        return Terminal(reason=TransitionReason.USER_INTERRUPT, message='Stopped', turns=1, results=())

    monkeypatch.setattr(engine_module, 'run_agent_turn', run)
    registry = ToolRegistry()
    register_delegate_tool(registry, llm_provider=SimpleNamespace(create_client=lambda **kw: object()),
        workspace_root=tmp_path, parent_session_getter=lambda: parent,
        subagent_event_sink=emitted.append, id_factory=lambda: 'selected-child')
    result = registry.execute_tool('Agent', {'task': 'Read one file', 'readonly': True})
    assert result.is_error
    assert emitted[-1]['status'] == 'user_interrupt'
    assert parent.open_turn == 1
    assert sibling.open_turn == 1


def test_child_cancel_checks_durable_parent_before_writing(tmp_path, monkeypatch):
    monkeypatch.setenv('MAGIC_POINTER_USER_DATA_DIR', str(tmp_path))
    store = FileSessionStore(tmp_path / 'agent-sessions')
    parent = store.create('real-parent')
    parent.start_turn()
    child = store.create('child', parent_session_id=parent.id)
    child.start_turn()
    rejected = handle_request({'action': 'cancel', 'sessionId': child.id, 'parentSessionId': 'different-parent'})
    assert rejected == {'ok': False, 'error': 'subagent_parent_mismatch'}
    assert not child.pending_cancel_request()
    accepted = handle_request({'action': 'cancel', 'sessionId': child.id, 'parentSessionId': parent.id})
    assert accepted['ok'] is True
    assert accepted['sessionId'] == child.id
    assert child.pending_cancel_request()
    assert not parent.pending_cancel_request()
