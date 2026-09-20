import pytest

from app.agent_runtime.session import FileSessionStore
from app.agent_runtime.tool_registry import Effect
from app.agent_runtime.types import AgentMessage, Role
from app.run_kernel import RecoveryPolicy, project_operations


def task_with_unknown_and_read(tmp_path):
    session = FileSessionStore(tmp_path).create("task")
    turn = session.start_turn()
    pending = session.record_tool_call("write", "Write", {"path": "file.txt"}, step=1, effect=Effect.REVERSIBLE_WRITE)
    session.record_tool_settlement(pending.data["operationId"], AgentMessage(Role.TOOL, "unknown", "write", "Write", is_error=True), failure_type=None, used_backend=None, latency_ms=0, outcome="unknown")
    read = session.record_tool_call("read", "Read", {"path": "file.txt"}, step=2, effect=Effect.READ)
    session.record_tool_settlement(read.data["operationId"], AgentMessage(Role.TOOL, "file still old", "read", "Read"), failure_type=None, used_backend=None, latency_ms=1)
    session.end_turn(turn, reason="completed")
    return session, pending.data["operationId"]


def test_verified_confirmed_recovery_is_durable_and_unblocks(tmp_path):
    session, operation_id = task_with_unknown_and_read(tmp_path)
    pending = session.pending_recovery()
    assert pending[0]["operationId"] == operation_id
    assert pending[0]["verificationCandidates"][0]["callId"] == "read"
    session.resolve_operation_recovery(operation_id, "read", confirmed=True)
    resumed = FileSessionStore(tmp_path).resume("task")
    assert resumed.pending_recovery() == []
    assert project_operations(resumed.events)[0].recovery_policy is RecoveryPolicy.NONE


@pytest.mark.parametrize("read_id,confirmed", [("write", True), ("missing", True), ("read", False)])
def test_resolution_requires_real_read_and_explicit_confirmation(tmp_path, read_id, confirmed):
    session, operation_id = task_with_unknown_and_read(tmp_path)
    with pytest.raises(ValueError):
        session.resolve_operation_recovery(operation_id, read_id, confirmed=confirmed)
