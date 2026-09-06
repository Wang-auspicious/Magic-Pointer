from __future__ import annotations

from pathlib import Path

import pytest

from app.agent_runtime.session import FileSessionStore
from app.agent_runtime.tool_registry import ToolRegistry
from app.artifacts.projection import project_artifacts
from app.context_pack.source_store import (
    apply_reference_updates,
    register_source,
    task_references,
    task_sources,
)
from app.context_pack.sources import (
    Coverage,
    FragmentLocator,
    ReadFragment,
    ReadResult,
    ReferenceBinding,
    ReferenceUpdate,
    SourceReaderRegistry,
    SourceRef,
)
from app.context_pack.tools import register_context_tools


def _source(task_id: str, source_id: str, *, parent: str | None = None) -> SourceRef:
    return SourceRef.from_dict({
        "sourceId": source_id,
        "taskId": task_id,
        "kind": "document",
        "title": "合同",
        "identity": {"absolutePath": f"C:/materials/{source_id}.pdf"},
        "revision": {"version": 1},
        "capabilities": ["read", "search", "follow"],
        "origin": "task-discovered" if parent else "user-attached",
        "parentSourceId": parent,
    })


def _result(source_id: str, text: str, locator: FragmentLocator, *, complete: bool) -> ReadResult:
    return ReadResult(
        source_id=source_id,
        fragments=(ReadFragment(
            fragment_id=f"fragment:{source_id}:1",
            locator=locator,
            text=text,
            metadata={"page": 37},
            citations=({"sourceId": source_id, "page": 37},),
        ),),
        coverage=Coverage(
            extent="query-results",
            read_ranges=(locator.value,),
            total_units=40,
            complete=complete,
            next_cursor=None if complete else "cursor:next",
            missing_reason=None if complete else "more-results",
        ),
        evidence_status="ok",
        used_backend="fake.document.reader",
        latency_ms=1.5,
    )


class _Reader:
    def __init__(self, task_id: str) -> None:
        self.task_id = task_id
        self.calls: list[tuple] = []
        self.locator = FragmentLocator("pdf-region", {"page": 37, "bbox": [1, 2, 3, 4]})

    def describe(self, source):
        self.calls.append(("describe", source.source_id))
        return _result(source.source_id, "40 pages", self.locator, complete=False)

    def read(self, source, locator, cursor, limit):
        self.calls.append(("read", source.source_id, locator, cursor, limit))
        return _result(source.source_id, "责任限制正文", locator or self.locator, complete=False)

    def search(self, source, query, cursor, limit):
        self.calls.append(("search", source.source_id, query, cursor, limit))
        return _result(source.source_id, "责任限制", self.locator, complete=False)

    def follow(self, source, fragment_id):
        self.calls.append(("follow", source.source_id, fragment_id))
        return (_source(self.task_id, "source-attachment", parent=source.source_id),)


def test_context_search_returns_reopenable_fragments_and_coverage(tmp_path: Path) -> None:
    session = FileSessionStore(tmp_path / "sessions").open_or_create("task-context")
    source = _source(session.id, "source-contract")
    register_source(session, source)
    reader = _Reader(session.id)
    readers = SourceReaderRegistry()
    readers.register("document", reader)
    registry = ToolRegistry()
    register_context_tools(registry, session=session, readers=readers)

    listed = registry.execute_tool("Context.list", {}).value
    assert listed["sources"][0]["sourceId"] == source.source_id

    searched = registry.execute_tool("Context.search", {
        "query": "责任限制",
        "source_ids": [source.source_id],
        "cursor": None,
        "limit": 8,
    }).value
    result = searched["results"][0]
    assert result["sourceId"] == source.source_id
    assert result["fragments"][0]["locator"] == reader.locator.to_dict()
    assert result["coverage"]["complete"] is False
    assert result["coverage"]["nextCursor"] == "cursor:next"
    assert result["usedBackend"] == "fake.document.reader"


def test_context_bind_requires_a_locator_observed_by_context_read_or_search(tmp_path: Path) -> None:
    session = FileSessionStore(tmp_path / "sessions").open_or_create("task-bind")
    source = _source(session.id, "source-contract")
    register_source(session, source)
    reader = _Reader(session.id)
    readers = SourceReaderRegistry()
    readers.register("document", reader)
    registry = ToolRegistry()
    register_context_tools(registry, session=session, readers=readers)
    bind_args = {
        "reference_id": "reference:liability",
        "role": "target",
        "source_id": source.source_id,
        "locator": reader.locator.to_dict(),
        "reason": "用户问的是责任限制条款",
    }

    before = registry.execute_tool("Context.bind", bind_args)
    assert before.is_error is True
    assert task_references(session.events) == ()

    registry.execute_tool("Context.read", {
        "source_id": source.source_id,
        "locator": reader.locator.to_dict(),
        "cursor": None,
        "limit": 4,
    })
    bound = registry.execute_tool("Context.bind", bind_args)
    assert bound.is_error is False
    assert task_references(session.events)[0].locator == reader.locator


def test_context_follow_registers_only_children_traced_to_the_requested_source(tmp_path: Path) -> None:
    session = FileSessionStore(tmp_path / "sessions").open_or_create("task-follow")
    source = _source(session.id, "source-chat")
    register_source(session, source)
    reader = _Reader(session.id)
    readers = SourceReaderRegistry()
    readers.register("document", reader)
    registry = ToolRegistry()
    register_context_tools(registry, session=session, readers=readers)

    followed = registry.execute_tool("Context.follow", {
        "source_id": source.source_id,
        "fragment_id": "fragment:source-chat:1",
    })

    assert followed.is_error is False
    assert [item.source_id for item in task_sources(session.events)] == [
        source.source_id,
        "source-attachment",
    ]
    assert task_sources(session.events)[1].parent_source_id == source.source_id


def test_context_tool_names_use_the_public_namespace_and_never_expose_scope_argument(
    tmp_path: Path,
) -> None:
    session = FileSessionStore(tmp_path / "sessions").open_or_create("task-names")
    registry = ToolRegistry()
    register_context_tools(registry, session=session, readers=SourceReaderRegistry())

    names = [item.name for item in registry.list()]
    assert names == [
        "Context.list",
        "Context.read",
        "Context.search",
        "Context.follow",
        "Context.bind",
        "Knowledge.search",
        "Knowledge.add_to_task",
        "DailyWrap.read",
        "Document.propose_patch",
    ]
    assert all("scope" not in item.input_schema["properties"] for item in registry.list())


def test_document_propose_patch_creates_an_editable_unapplied_artifact(
    tmp_path: Path,
) -> None:
    session = FileSessionStore(tmp_path / "sessions").open_or_create("task-patch")
    source = SourceRef.from_dict({
        **_source(session.id, "source-deck").to_dict(),
        "identity": {"absolutePath": r"C:\materials\deck.pptx", "hwnd": 77},
        "capabilities": ["read", "search", "follow", "patch"],
    })
    register_source(session, source)
    locator = FragmentLocator("slide-shape", {"slideId": 19, "shapeId": 42})
    binding = ReferenceBinding(
        reference_id="reference-target",
        label="A",
        source_id=source.source_id,
        locator=locator,
        role="target",
        frame_lease_id=None,
        captured_at_ms=1,
        ordinal=1,
        active=True,
    )
    apply_reference_updates(session, (ReferenceUpdate("add", binding),))
    registry = ToolRegistry()
    register_context_tools(registry, session=session, readers=SourceReaderRegistry())

    proposed = registry.execute_tool("Document.propose_patch", {
        "patch_id": "patch-deck-title",
        "summary": "Shorten the selected title",
        "references": [{
            "referenceId": binding.reference_id,
            "sourceId": source.source_id,
            "locator": locator.to_dict(),
            "role": "target",
        }],
        "operations": [{
            "operationId": "operation-title",
            "operation": "set_shape_text",
            "referenceId": binding.reference_id,
            "sourceId": source.source_id,
            "locator": locator.to_dict(),
            "before": {"text": "Long selected title"},
            "after": {"text": "Short title"},
        }],
    })

    assert proposed.is_error is False
    artifact = project_artifacts(session.events)[0]
    assert artifact.kind == "document_patch"
    assert artifact.revision == 1
    assert artifact.accepted_revision is None
    assert artifact.patch_payload["operations"][0]["after"] == {"text": "Short title"}
    assert proposed.value["requiresUserAcceptance"] is True
