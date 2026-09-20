"""Fork keeps task-owned state usable under the child's durable identity."""

from __future__ import annotations

import json
from dataclasses import replace

import pytest

from app.agent_runtime.session import FileSessionStore, project_plan
from app.context_pack.source_scope import ScopeGrant, grant_source_scope, scope_from_events
from app.context_pack.source_store import (
    apply_reference_updates,
    register_source,
    task_references,
    task_sources,
)
from app.context_pack.sources import ReferenceUpdate, SourceRef, TaskInput


def _source(task_id, path):
    return SourceRef.from_dict({
        "sourceId": "source-document",
        "taskId": task_id,
        "kind": "document",
        "title": "proposal",
        "identity": {"absolutePath": str(path), "documentSessionId": "office-session"},
        "revision": {"observedAtMs": 10},
        "capabilities": ["read", "patch"],
        "origin": "user-pointed",
        "parentSourceId": None,
    })


def _reference():
    return ReferenceUpdate.from_dict({
        "operation": "add",
        "binding": {
            "referenceId": "reference-a", "label": "A", "sourceId": "source-document",
            "locator": {"kind": "slide-shape", "value": {"slideId": "s1", "shapeId": "shape1"}},
            "role": "target", "frameLeaseId": "frame-original", "capturedAtMs": 12,
            "ordinal": 1, "active": True,
        },
    })


def test_fork_plan_can_resume_and_continue_without_changing_parent(tmp_path):
    store = FileSessionStore(tmp_path)
    parent = store.create("parent")
    plan = [{"content": "核对材料", "status": "in_progress"}]
    parent.record_plan_updated(plan)
    parent_bytes = parent.path.read_bytes()

    child = store.fork(parent.id, "child")
    resumed = store.resume(child.id, repair=True)

    assert project_plan(resumed.events) == plan
    assert resumed.events[-1].data["taskId"] == child.id
    assert resumed.header.parent_session_id == parent.id
    resumed.record_plan_updated([{"content": "核对材料", "status": "completed"}])
    assert parent.path.read_bytes() == parent_bytes
    assert project_plan(store.resume(parent.id).events) == plan


def test_fork_rebinds_context_ownership_but_preserves_source_and_reference_identity(tmp_path):
    store = FileSessionStore(tmp_path / "sessions")
    parent = store.create("parent")
    source = _source(parent.id, tmp_path / "proposal.pptx")
    register_source(parent, source)
    update = _reference()
    apply_reference_updates(parent, (update,))
    grant = ScopeGrant(
        grant_id="edit-proposal", task_id=parent.id, source_ids=(source.source_id,),
        folder_roots=(), window_ids=(), recipients=(), actions=("read", "patch"),
        expires_at_ms=None,
    )
    grant_source_scope(parent, grants=(grant,))
    parent_bytes = parent.path.read_bytes()

    child = store.fork(parent.id, "child")
    resumed = store.resume(child.id, repair=True)

    assert task_sources(resumed.events) == (replace(source, task_id=child.id),)
    assert task_references(resumed.events) == (update.binding,)
    assert scope_from_events(resumed.events, task_id=child.id).grants == (replace(grant, task_id=child.id),)
    apply_reference_updates(resumed, (
        replace(update, operation="remove", binding=replace(update.binding, active=False)),
    ))
    assert not task_references(store.resume(child.id).events)[0].active
    assert parent.path.read_bytes() == parent_bytes
    assert task_references(store.resume(parent.id).events)[0].active


@pytest.mark.parametrize("consumed", [False, True])
def test_fork_structured_inbox_can_resume_and_claim_materials(tmp_path, consumed):
    store = FileSessionStore(tmp_path / "sessions")
    parent = store.create("parent")
    register_source(parent, _source(parent.id, tmp_path / "proposal.pptx"))
    task_input = TaskInput(
        input_id="material-input", task_id=parent.id, target="next-turn",
        instruction="继续核对材料", reference_updates=(_reference(),),
        source_ids=("source-document",), timeline=(), captured_at_ms=20,
    )
    parent.enqueue_inbox(task_input.instruction, task_input.target, payload=task_input.to_dict())
    if consumed:
        parent.claim_task_inputs("next-turn")
        turn = parent.start_turn()
        parent.record_model_request(parent.derive_messages(), tools=[], header={}, step=1)
        parent.end_turn(turn, reason="completed")
    parent_bytes = parent.path.read_bytes()

    child = store.fork(parent.id, "child")
    resumed = store.resume(child.id, repair=True)
    if not consumed:
        assert resumed.pending_inbox()[0].payload["taskId"] == child.id
        claim = resumed.claim_task_inputs("next-turn")
        assert claim.input_ids == (task_input.input_id,)

    assert task_references(resumed.events) == (_reference().binding,)
    material = json.loads(resumed.derive_messages()[-1].content.split("\n", 1)[1])
    assert material["taskId"] == child.id
    assert material["sourceIds"] == list(task_input.source_ids)
    turn = resumed.start_turn()
    resumed.record_model_request(resumed.derive_messages(), tools=[], header={}, step=1)
    resumed.end_turn(turn, reason="completed")
    assert store.resume(child.id).open_turn is None
    assert parent.path.read_bytes() == parent_bytes
