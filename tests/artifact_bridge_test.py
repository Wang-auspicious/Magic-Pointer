"""The UI artifact bridge edits, approves, applies, and reports one revision."""

from __future__ import annotations

from pathlib import Path

from app.agent_runtime.session import FileSessionStore
from app.artifacts.document_patch import OperationReadResult, OperationWriteResult
from app.context_pack.source_scope import ScopeGrant, grant_source_scope
from app.context_pack.source_store import register_source
from app.context_pack.sources import SourceRef
from scripts.artifact_bridge import handle_request


def _payload() -> dict:
    locator = {
        "kind": "slide-shape",
        "value": {"documentId": "deck-1", "slideId": 7, "shapeId": 22},
    }
    return {
        "patchId": "patch-bridge",
        "references": [{
            "referenceId": "ref-target",
            "sourceId": "source-deck",
            "locator": locator,
            "role": "target",
        }],
        "operations": [{
            "operationId": "op-text",
            "operation": "set_shape_text",
            "referenceId": "ref-target",
            "sourceId": "source-deck",
            "locator": locator,
            "before": "old",
            "after": "draft",
        }],
    }


class FakeBackend:
    def __init__(self) -> None:
        self.value = "old"
        self.writes: list[str] = []

    def read_current(self, operation):
        return OperationReadResult(True, self.value, "fake-powerpoint")

    def execute(self, operation):
        self.writes.append(operation.operation_id)
        self.value = operation.after
        return OperationWriteResult(True, True, "fake-powerpoint")


def test_edit_accept_apply_uses_the_same_latest_revision(tmp_path: Path) -> None:
    store = FileSessionStore(tmp_path / "agent-sessions")
    session = store.create("agent-studio-conv-0123456789abcdef0123456789abcdef")
    register_source(session, SourceRef(
        source_id="source-deck",
        task_id=session.id,
        kind="document",
        title="deck.pptx",
        identity={"path": str(tmp_path / "deck.pptx")},
        revision={"kind": "office-document", "value": "open"},
        capabilities=("read", "patch"),
        origin="user-attached",
        parent_source_id=None,
    ))
    grant_source_scope(session, grants=(ScopeGrant(
        grant_id="patch-deck",
        task_id=session.id,
        source_ids=("source-deck",),
        folder_roots=(),
        window_ids=(),
        recipients=(),
        actions=("patch",),
        expires_at_ms=None,
    ),))
    generated = session.record_artifact_generated(
        "preview draft",
        kind="document_patch",
        patch_payload=_payload(),
    )
    artifact_id = str(generated.data["artifactId"])

    read = handle_request({
        "action": "read",
        "sessionId": session.id,
        "artifactId": artifact_id,
    }, session_store=store)
    edited_payload = dict(read["artifact"]["patchPayload"])
    edited_payload["operations"] = [{
        **edited_payload["operations"][0],
        "after": "final",
    }]
    edited = handle_request({
        "action": "edit",
        "sessionId": session.id,
        "artifactId": artifact_id,
        "expectedRevision": 1,
        "content": "preview final",
        "patchPayload": edited_payload,
    }, session_store=store)
    accepted = handle_request({
        "action": "accept",
        "sessionId": session.id,
        "artifactId": artifact_id,
        "revision": 2,
    }, session_store=store)
    backend = FakeBackend()
    applied = handle_request({
        "action": "apply",
        "sessionId": session.id,
        "artifactId": artifact_id,
        "revision": 2,
    }, session_store=store, operation_backend=backend)

    assert edited["ok"] is True
    assert edited["artifact"]["revision"] == 2
    assert edited["artifact"]["patchPayload"]["artifactRevision"] == 2
    assert accepted["artifact"]["acceptedRevision"] == 2
    assert applied["ok"] is True
    assert applied["result"]["status"] == "succeeded"
    assert applied["result"]["artifactRevision"] == 2
    assert applied["receipt"]["verified"] is True
    assert applied["receipt"]["usedBackend"] == "fake-powerpoint"
    assert backend.value == "final"
    assert backend.writes == ["op-text"]

    reread = handle_request({
        "action": "read",
        "sessionId": session.id,
        "artifactId": artifact_id,
    }, session_store=store)
    assert reread["artifact"]["latestApply"]["receiptId"] == applied["receipt"]["receiptId"]


def test_bridge_rejects_a_stale_edit_without_changing_the_draft(tmp_path: Path) -> None:
    store = FileSessionStore(tmp_path / "agent-sessions")
    session = store.create("agent-studio-conv-fedcba9876543210fedcba9876543210")
    artifact_id = str(session.record_artifact_generated("one").data["artifactId"])
    first = handle_request({
        "action": "edit",
        "sessionId": session.id,
        "artifactId": artifact_id,
        "expectedRevision": 1,
        "content": "two",
    }, session_store=store)
    stale = handle_request({
        "action": "edit",
        "sessionId": session.id,
        "artifactId": artifact_id,
        "expectedRevision": 1,
        "content": "stale",
    }, session_store=store)

    assert first["ok"] is True
    assert stale == {"ok": False, "error": "stale_revision", "currentRevision": 2}
    current = handle_request({
        "action": "read",
        "sessionId": session.id,
        "artifactId": artifact_id,
    }, session_store=store)
    assert current["artifact"]["content"] == "two"


def test_accept_then_apply_builds_the_real_backend_and_scopes_that_revision(
    tmp_path: Path,
) -> None:
    store = FileSessionStore(tmp_path / "agent-sessions")
    session = store.create("agent-studio-conv-11111111111111111111111111111111")
    output = tmp_path / "generated.docx"
    source = SourceRef(
        source_id="source-output-folder",
        task_id=session.id,
        kind="file",
        title=tmp_path.name,
        identity={"absolutePath": str(tmp_path)},
        revision={"authority": "disk"},
        capabilities=("read", "patch"),
        origin="user-attached",
        parent_source_id=None,
    )
    register_source(session, source)
    locator = {"kind": "text", "value": {"path": str(output)}}
    generated = session.record_artifact_generated(
        "Create an editable report",
        kind="document_patch",
        patch_payload={
            "patchId": "patch-output",
            "references": [{
                "referenceId": "ref-output",
                "sourceId": source.source_id,
                "locator": locator,
                "role": "target",
            }],
            "operations": [{
                "operationId": "op-output",
                "operation": "create_file",
                "referenceId": "ref-output",
                "sourceId": source.source_id,
                "locator": locator,
                "before": {"exists": False, "path": str(output)},
                "after": {
                    "exists": True,
                    "path": str(output),
                    "format": "docx",
                    "content": {"paragraphs": ["Durable report"]},
                    "references": [],
                },
            }],
        },
    )
    artifact_id = str(generated.data["artifactId"])

    accepted = handle_request({
        "action": "accept",
        "sessionId": session.id,
        "artifactId": artifact_id,
        "revision": 1,
    }, session_store=store)
    applied = handle_request({
        "action": "apply",
        "sessionId": session.id,
        "artifactId": artifact_id,
        "revision": 1,
    }, session_store=store)

    assert accepted["ok"] is True
    assert applied["ok"] is True
    assert applied["result"]["status"] == "succeeded"
    assert applied["result"]["verified"] is True
    assert "safe-action-executor" in applied["result"]["usedBackend"]
    assert output.is_file()
    assert applied["registeredArtifacts"][0]["path"] == str(output.resolve())
    assert applied["registeredArtifacts"][0]["draftArtifactId"] == artifact_id
    assert applied["registeredArtifacts"][0]["artifactRevision"] == 1


def test_apply_routes_runtime_only_figma_connection_to_matching_document(
    tmp_path: Path,
    monkeypatch,
) -> None:
    from scripts import artifact_bridge

    store = FileSessionStore(tmp_path / "agent-sessions")
    session = store.create("agent-studio-conv-22222222222222222222222222222222")
    figma_source = SourceRef(
        source_id="source-figma",
        task_id=session.id,
        kind="figma",
        title="Checkout design",
        identity={"documentSessionId": "document-a", "pageId": "0:7"},
        revision={"selectionRevision": 1},
        capabilities=("read", "patch"),
        origin="user-pointed",
        parent_source_id=None,
    )
    register_source(session, figma_source)
    locator = {
        "kind": "figma-node",
        "value": {"nodeId": "1:2", "textStart": 0, "textEnd": 3},
    }
    generated = session.record_artifact_generated(
        "Change the selected Figma text",
        kind="document_patch",
        patch_payload={
            "patchId": "patch-figma",
            "references": [{
                "referenceId": "ref-figma",
                "sourceId": figma_source.source_id,
                "locator": locator,
                "role": "target",
            }],
            "operations": [{
                "operationId": "op-figma",
                "operation": "replace_text",
                "referenceId": "ref-figma",
                "sourceId": figma_source.source_id,
                "locator": locator,
                "before": "Old",
                "after": "New",
            }],
        },
    )
    artifact_id = str(generated.data["artifactId"])
    assert handle_request({
        "action": "accept",
        "sessionId": session.id,
        "artifactId": artifact_id,
        "revision": 1,
    }, session_store=store)["ok"] is True

    class RuntimeFigmaClient:
        characters = "Old label"

        def __init__(self, config) -> None:
            self.task_id = config.task_id
            self.document_session_id = config.document_session_id

        def request(self, operation, arguments):
            if operation == "apply_patch":
                item = arguments["operations"][0]
                self.characters = (
                    self.characters[:item["start"]]
                    + item["after"]
                    + self.characters[item["end"]:]
                )
            return {"nodes": [{
                "id": "1:2",
                "type": "TEXT",
                "name": "Button",
                "characters": self.characters,
            }]}

    monkeypatch.setattr(artifact_bridge, "FigmaClient", RuntimeFigmaClient)
    applied = handle_request({
        "action": "apply",
        "sessionId": session.id,
        "artifactId": artifact_id,
        "revision": 1,
        "_figmaRuntimeConnections": [{
            "baseUrl": "http://127.0.0.1:37843",
            "controlToken": "x" * 32,
            "taskId": session.id,
            "documentSessionId": "document-a",
        }],
    }, session_store=store)

    assert applied["ok"] is True
    assert applied["result"]["status"] == "succeeded"
    assert "figma-plugin-loopback" in applied["result"]["usedBackend"]
