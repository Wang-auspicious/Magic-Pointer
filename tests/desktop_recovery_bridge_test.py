from app.agent_runtime.session import FileSessionStore
from app.agent_runtime.tool_registry import Effect
from app.agent_runtime.types import AgentMessage, Role
from scripts.agent_session_bridge import handle_request


def test_gui_recovery_requires_readback_and_confirmation(tmp_path, monkeypatch):
    monkeypatch.setenv('MAGIC_POINTER_USER_DATA_DIR', str(tmp_path))
    session = FileSessionStore(tmp_path / 'agent-sessions').create('task')
    turn = session.start_turn()
    write = session.record_tool_call('write', 'Write', {'path': 'file.txt'}, step=1, effect=Effect.REVERSIBLE_WRITE)
    session.record_tool_settlement(write.data['operationId'], AgentMessage(Role.TOOL, 'unknown', 'write', 'Write', is_error=True), failure_type=None, used_backend=None, latency_ms=0, outcome='unknown')
    read = session.record_tool_call('read', 'Read', {'path': 'file.txt'}, step=2, effect=Effect.READ)
    session.record_tool_settlement(read.data['operationId'], AgentMessage(Role.TOOL, 'file still old', 'read', 'Read'), failure_type=None, used_backend=None, latency_ms=1)
    session.end_turn(turn, reason='completed')
    status = handle_request({'action': 'status', 'sessionId': 'task'})
    assert status['pendingRecovery'][0]['verificationCandidates'][0]['result'] == 'file still old'
    payload = {'action': 'recovery-resolve', 'sessionId': 'task', 'operationId': write.data['operationId'], 'verificationCallId': 'read'}
    assert not handle_request(payload)['ok']
    assert handle_request({**payload, 'confirmed': True})['ok']
    assert handle_request({'action': 'status', 'sessionId': 'task'})['pendingRecovery'] == []
