import pytest

from app.actions.office_document import OfficeDocumentActionHandler
from app.artifacts.document_patch import DocumentPatch, InverseRecord, OperationReadResult, inverse_document_patch
from scripts.artifact_bridge import handle_request
from artifact_undo_audit_test import prepared
from office_audit_fixes_test import source, op
from app.actions.document_backend import DocumentOperationBackend
from app.agent_runtime.session import FileSessionStore
from app.context_pack.source_store import register_source
from dataclasses import replace


class WordGateway:
    used_backend = "fake-word-com-ranges"

    def __init__(self, text):
        self.text = text

    def read_word(self, *, start, end, **_):
        return self.text.encode("utf-16-le")[start * 2:end * 2].decode("utf-16-le")

    def replace_word(self, *, start, end, expected_text, replacement, **_):
        assert self.read_word(start=start, end=end) == expected_text
        raw = self.text.encode("utf-16-le")
        self.text = (raw[:start * 2] + replacement.encode("utf-16-le") + raw[end * 2:]).decode("utf-16-le")
        return {"ok": True, "wrote": True}


@pytest.mark.parametrize("before,after", [("old", ""), ("cat", "caterpillar"), ("old", "😀")])
def test_live_word_length_change_and_inverse_readback(tmp_path, before, after):
    gateway = WordGateway(before + " suffix")
    handler = OfficeDocumentActionHandler(gateway=gateway)
    src = source(tmp_path / "live.docx", hwnd=1)
    operation = op("replace_text", "text", {"start": 0, "end": len(before.encode("utf-16-le")) // 2}, before, after)
    assert handler.execute(src, operation).ok
    observed = handler.read_current(src, operation)
    assert observed.ok and observed.value == after, observed
    patch = DocumentPatch.from_dict({"patchId": "p", "artifactId": "a", "artifactRevision": 1,
        "references": [{"referenceId": "ref", "sourceId": "s", "locator": operation.locator.to_dict(), "role": "target"}],
        "operations": [operation.to_dict()]})
    reverse = inverse_document_patch(patch, [InverseRecord.from_operation(operation).to_dict()]).operations[0]
    restarted = OfficeDocumentActionHandler(gateway=gateway)
    assert restarted.read_current(src, reverse).value == reverse.before
    result = restarted.execute(src, reverse)
    assert result.ok, result
    assert restarted.read_current(src, reverse).value == before
    assert gateway.text == before + " suffix"


def test_undo_can_complete_after_previous_readback_failed(tmp_path):
    store, request, backend = prepared(tmp_path)
    read = backend.read_current
    failed = False

    def transient_readback(operation):
        nonlocal failed
        if backend.value == "old" and not failed:
            failed = True
            return OperationReadResult(False, error="temporary COM read failure")
        return read(operation)

    backend.read_current = transient_readback
    first = handle_request({**request, "action": "undo", "confirmed": True}, session_store=store, operation_backend=backend)
    assert first["result"]["status"] == "unverified"
    writes = len(backend.writes)
    retried = handle_request({**request, "action": "undo", "confirmed": True}, session_store=store, operation_backend=backend)
    assert retried["result"]["verified"], retried
    assert len(backend.writes) == writes
    assert not handle_request({**request, "action": "read"}, session_store=store)["artifact"]["undoAvailable"]


def word_artifact(tmp_path, before, after):
    store = FileSessionStore(tmp_path / "sessions")
    session = store.create("word")
    src = replace(source(tmp_path / "live.docx", hwnd=1), task_id=session.id)
    register_source(session, src)
    operation = op("replace_text", "text", {"start": 0, "end": len(before.encode("utf-16-le")) // 2}, before, after)
    payload = {"patchId": "p", "references": [{"referenceId": "ref", "sourceId": "s", "locator": operation.locator.to_dict(), "role": "target"}], "operations": [operation.to_dict()]}
    artifact = session.record_artifact_generated("word edit", kind="document_patch", patch_payload=payload).data["artifactId"]
    request = {"sessionId": session.id, "artifactId": artifact, "revision": 1}
    assert handle_request({**request, "action": "accept"}, session_store=store)["ok"]
    gateway = WordGateway(before + " suffix")
    def backend():
        return DocumentOperationBackend(sources=[src], artifact_id=artifact, artifact_revision=1, office_document=OfficeDocumentActionHandler(gateway=gateway))
    return store, request, gateway, backend


def test_same_accepted_word_append_is_not_applied_twice(tmp_path):
    store, request, gateway, backend = word_artifact(tmp_path, "cat", "caterpillar")
    first = handle_request({**request, "action": "apply"}, session_store=store, operation_backend=backend())
    assert first["result"]["verified"]
    second = handle_request({**request, "action": "apply"}, session_store=store, operation_backend=backend())
    assert gateway.text == "caterpillar suffix", second
    assert second.get("error") == "patch_has_unreverted_writes"
    undone = handle_request({**request, "action": "undo", "confirmed": True}, session_store=store, operation_backend=backend())
    assert undone["result"]["verified"]
    assert gateway.text == "cat suffix"
    reapplied = handle_request({**request, "action": "apply"}, session_store=store, operation_backend=backend())
    assert reapplied["result"]["verified"]
    assert gateway.text == "caterpillar suffix"


def test_zero_length_undo_readback_retry_does_not_insert_twice(tmp_path):
    store, request, gateway, backend = word_artifact(tmp_path, "old", "")
    assert handle_request({**request, "action": "apply"}, session_store=store, operation_backend=backend())["result"]["verified"]
    undo_backend = backend()
    read = undo_backend.read_current
    calls = 0
    def unavailable_after_write(operation):
        nonlocal calls
        calls += 1
        if calls == 2:
            return OperationReadResult(False, error="temporary COM read failure")
        return read(operation)
    undo_backend.read_current = unavailable_after_write
    first = handle_request({**request, "action": "undo", "confirmed": True}, session_store=store, operation_backend=undo_backend)
    assert first["result"]["status"] == "unverified"
    assert gateway.text == "old suffix"
    again = handle_request({**request, "action": "undo", "confirmed": True}, session_store=store, operation_backend=backend())
    assert again["result"]["verified"], again
    assert gateway.text == "old suffix"
