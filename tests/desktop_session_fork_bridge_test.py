from app.agent_runtime.session import FileSessionStore
from app.context_pack.source_store import register_source
from app.context_pack.sources import SourceRef
from scripts.agent_session_bridge import handle_request


def test_branch_copies_the_completed_boundary_and_context(tmp_path, monkeypatch):
    monkeypatch.setenv('MAGIC_POINTER_USER_DATA_DIR', str(tmp_path))
    store = FileSessionStore(tmp_path / 'agent-sessions')
    parent = store.create('parent')
    turn = parent.start_turn()
    register_source(parent, SourceRef.from_dict({
        'sourceId': 'source-a', 'taskId': 'parent', 'kind': 'document', 'title': 'a.txt',
        'identity': {'absolutePath': str(tmp_path / 'a.txt')}, 'revision': {},
        'capabilities': ['read'], 'origin': 'user-attached', 'parentSourceId': None,
    }))
    parent.end_turn(turn, reason='completed')
    parent.start_turn()
    response = handle_request({'action': 'fork', 'sessionId': 'parent', 'childSessionId': 'child', 'throughTurn': 1})
    assert response['ok'], response
    assert response['sessionId'] == 'child'
    assert response['taskContext']['taskId'] == 'child'
    assert response['taskContext']['sources'][0]['sourceId'] == 'source-a'
    child = store.resume('child', repair=False)
    assert child.open_turn is None
    assert child.next_turn == 2
