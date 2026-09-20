"""Durable inverse recovery uses the recorded write and refuses changed targets."""
from app.agent_runtime.session import FileSessionStore
from app.context_pack.source_store import register_source
from app.context_pack.source_scope import ScopeGrant, grant_source_scope
from app.context_pack.sources import SourceRef
from scripts.artifact_bridge import handle_request
from artifact_bridge_test import _payload, FakeBackend


def prepared(tmp_path):
    store = FileSessionStore(tmp_path / "sessions")
    session = store.create("undo-audit")
    register_source(session, SourceRef(source_id="source-deck", task_id=session.id,
        kind="document", title="deck", identity={"path": str(tmp_path / "deck.pptx")}, revision={},
        capabilities=("read", "patch"), origin="user-attached", parent_source_id=None))
    grant_source_scope(session, grants=(ScopeGrant(grant_id="g", task_id=session.id,
        source_ids=("source-deck",), folder_roots=(), window_ids=(), recipients=(), actions=("patch",), expires_at_ms=None),))
    artifact = str(session.record_artifact_generated("edit", kind="document_patch", patch_payload=_payload()).data["artifactId"])
    request = {"sessionId": session.id, "artifactId": artifact, "revision": 1}
    assert handle_request({**request, "action": "accept"}, session_store=store)["ok"]
    backend = FakeBackend()
    assert handle_request({**request, "action": "apply"}, session_store=store, operation_backend=backend)["result"]["verified"]
    return store, request, backend


def test_undo_survives_bridge_restart_and_is_not_repeated(tmp_path):
    store, request, backend = prepared(tmp_path)
    assert handle_request({**request, "action": "read"}, session_store=store)["artifact"]["undoAvailable"]
    restarted = FileSessionStore(store.root) if hasattr(store, "root") else FileSessionStore(tmp_path / "sessions")
    result = handle_request({**request, "action": "undo", "confirmed": True}, session_store=restarted, operation_backend=backend)
    assert result["ok"], result
    assert result["result"]["verified"]
    assert backend.value == "old"
    assert not handle_request({**request, "action": "read"}, session_store=restarted)["artifact"]["undoAvailable"]
    count = len(backend.writes)
    again = handle_request({**request, "action": "undo", "confirmed": True}, session_store=restarted, operation_backend=backend)
    assert not again["ok"]
    assert len(backend.writes) == count


def test_undo_conflict_preserves_user_edits(tmp_path):
    store, request, backend = prepared(tmp_path)
    backend.value = "user changed it later"
    result = handle_request({**request, "action": "undo", "confirmed": True}, session_store=store, operation_backend=backend)
    assert result["ok"], result
    assert result["result"]["status"] == "conflict"
    assert backend.value == "user changed it later"


def test_undo_requires_explicit_user_action(tmp_path):
    store, request, backend = prepared(tmp_path)
    result = handle_request({**request, "action": "undo"}, session_store=store, operation_backend=backend)
    assert result.get("error") == "undo_confirmation_required"
    assert backend.value == "draft"


def test_recorded_file_move_and_pdf_annotation_inverse_are_executable(tmp_path):
    import fitz
    from app.artifacts.document_patch import DocumentPatch, InverseRecord, inverse_document_patch
    from app.actions.document_backend import DocumentOperationBackend
    from office_audit_fixes_test import source, annotation, op
    original, output = tmp_path / "original.pdf", tmp_path / "copy.pdf"
    with fitz.open() as doc:
        doc.new_page()
        doc.save(original)
    operations = [annotation(output, "note", [10, 10, 30, 30])]
    source_ref = source(original)
    backend = DocumentOperationBackend(sources=[source_ref], artifact_id="a", artifact_revision=1)
    for operation in operations:
        assert backend.execute(operation).ok
    patch = DocumentPatch.from_dict({"patchId": "p", "artifactId": "a", "artifactRevision": 1,
        "references": [{"referenceId": "ref", "sourceId": "s", "locator": operations[0].locator.to_dict(), "role": "target"}],
        "operations": [operation.to_dict() for operation in operations]})
    inverse = inverse_document_patch(patch, [InverseRecord.from_operation(operation).to_dict() for operation in operations])
    reverse = inverse.operations[0]
    assert backend.read_current(reverse).value == reverse.before
    assert backend.execute(reverse).ok
    assert backend.read_current(reverse).value == reverse.after
    assert original.exists() and output.exists()

    old, new = tmp_path / "old.txt", tmp_path / "new.txt"
    old.write_text("keep me", encoding="utf-8")
    move = op("move_file", "text", {"root": str(tmp_path)}, {"path": str(old)}, {"path": str(new)})
    backend = DocumentOperationBackend(sources=[source(tmp_path)], artifact_id="a", artifact_revision=1)
    assert backend.execute(move).ok
    reverse = op("move_file", "text", {"root": str(tmp_path)}, move.after, move.before)
    assert backend.execute(reverse).ok
    assert old.read_text(encoding="utf-8") == "keep me" and not new.exists()
