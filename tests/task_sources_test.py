from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.agent_runtime.session import FileSessionStore
from app.context_pack.source_store import (
    apply_reference_updates,
    reference_revision,
    register_source,
    resolve_source,
    task_references,
    task_sources,
)
from app.context_pack.sources import (
    Coverage,
    ReferenceBinding,
    ReferenceUpdate,
    SourceRef,
    TaskInput,
)


FIXTURE = Path(__file__).parent / "fixtures" / "task_input" / "reference_correction.json"


def _fixture() -> dict:
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def test_source_and_reference_contracts_round_trip_strictly() -> None:
    fixture = _fixture()
    for raw in fixture["sources"]:
        assert SourceRef.from_dict(raw).to_dict() == raw
    for raw in [*fixture["initialUpdates"], *fixture["updates"]]:
        assert ReferenceUpdate.from_dict(raw).to_dict() == raw
    assert Coverage.from_dict(fixture["coverage"]).to_dict() == fixture["coverage"]
    assert TaskInput.from_dict(fixture["referenceOnlyInput"]).to_dict() == fixture["referenceOnlyInput"]

    with pytest.raises(ValueError, match="unknown field"):
        SourceRef.from_dict({**fixture["sources"][0], "silentlyIgnored": True})
    with pytest.raises(ValueError, match="kind"):
        SourceRef.from_dict({**fixture["sources"][0], "kind": "mystery"})


def test_context_events_keep_source_identity_and_stable_reference_labels(tmp_path: Path) -> None:
    fixture = _fixture()
    store = FileSessionStore(tmp_path)
    session = store.create(fixture["taskId"])

    for raw in fixture["sources"]:
        register_source(session, SourceRef.from_dict(raw))
    apply_reference_updates(
        session,
        [ReferenceUpdate.from_dict(raw) for raw in fixture["initialUpdates"]],
        expected_revision=0,
    )
    apply_reference_updates(
        session,
        [ReferenceUpdate.from_dict(raw) for raw in fixture["updates"]],
        expected_revision=1,
    )

    resumed = store.resume(fixture["taskId"])
    sources = task_sources(resumed.events)
    assert len(sources) == 2
    assert sources[0].title == sources[1].title
    assert sources[0].source_id != sources[1].source_id
    assert resolve_source(resumed.events, "source-brief-b").identity["absolutePath"].endswith("B/brief.pdf")

    references = {item.reference_id: item for item in task_references(resumed.events)}
    assert references["ref-a"].active is False
    assert references["ref-b"].label == "B", "removing A must not renumber B"
    assert references["ref-b"].role == "target"
    assert references["ref-b"].locator.value == {"pageIndex": 4, "textQuote": "里程碑"}
    assert references["ref-c"].label == "C"
    assert reference_revision(resumed.events) == 2

    with pytest.raises(ValueError, match="revision"):
        apply_reference_updates(resumed, [], expected_revision=0)


def test_task_projection_never_inherits_another_tasks_sources(tmp_path: Path) -> None:
    fixture = _fixture()
    store = FileSessionStore(tmp_path)
    alpha = store.create(fixture["taskId"])
    beta = store.create("task-beta")
    register_source(alpha, SourceRef.from_dict(fixture["sources"][0]))
    register_source(beta, SourceRef.from_dict(fixture["otherTaskSource"]))

    assert [item.source_id for item in task_sources(alpha.events)] == ["source-brief-a"]
    assert [item.source_id for item in task_sources(beta.events)] == ["source-other"]
    with pytest.raises(KeyError):
        resolve_source(alpha.events, "source-other")
    with pytest.raises(ValueError, match="task"):
        register_source(alpha, SourceRef.from_dict(fixture["otherTaskSource"]))


def test_preview_coverage_does_not_claim_the_document_was_read() -> None:
    coverage = Coverage.from_dict(_fixture()["coverage"])
    assert coverage.extent == "page"
    assert coverage.complete is False
    assert coverage.total_units == 12
    assert coverage.next_cursor == "page:1"
