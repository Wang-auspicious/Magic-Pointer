"""DocumentPatch binds preview, authorization, write and verification."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

import pytest

from app.artifacts.document_patch import (
    DocumentPatch,
    OperationReadResult,
    OperationWriteResult,
    apply_document_patch,
)
from app.context_pack.source_scope import AccessDecision, AccessRequest


def _reference(
    reference_id: str,
    source_id: str,
    shape_id: int,
    *,
    role: str,
) -> dict[str, Any]:
    return {
        "referenceId": reference_id,
        "sourceId": source_id,
        "locator": {
            "kind": "slide-shape",
            "value": {"documentId": "deck-1", "slideId": 7, "shapeId": shape_id},
        },
        "role": role,
    }


def _operation(
    *,
    reference_id: str = "ref-target",
    source_id: str = "source-b",
    shape_id: int = 22,
    before: Any = "before",
    after: Any = "after",
) -> dict[str, Any]:
    return {
        "operationId": "op-1",
        "operation": "set_shape_text",
        "referenceId": reference_id,
        "sourceId": source_id,
        "locator": {
            "kind": "slide-shape",
            "value": {"documentId": "deck-1", "slideId": 7, "shapeId": shape_id},
        },
        "before": before,
        "after": after,
    }


def _patch(*, operations: list[dict[str, Any]] | None = None) -> DocumentPatch:
    return DocumentPatch.from_dict({
        "patchId": "patch-1",
        "artifactId": "artifact-1",
        "artifactRevision": 1,
        "references": [
            _reference("ref-reference", "source-a", 11, role="reference"),
            _reference("ref-target", "source-b", 22, role="target"),
        ],
        "operations": operations or [_operation()],
    })


def _allow(requests: list[AccessRequest]) -> Callable[[AccessRequest], AccessDecision]:
    def authorize(request: AccessRequest) -> AccessDecision:
        requests.append(request)
        return AccessDecision(True)

    return authorize


def test_one_change_is_verified_and_records_a_reversible_inverse() -> None:
    patch = _patch()
    requests: list[AccessRequest] = []
    reads = iter(("before", "after"))

    result = apply_document_patch(
        patch,
        current_artifact_revision=1,
        accepted_revision=1,
        authorize=_allow(requests),
        read_current=lambda _operation: OperationReadResult(
            ok=True,
            value=next(reads),
            used_backend="fake-powerpoint",
        ),
        execute=lambda _operation: OperationWriteResult(
            ok=True,
            wrote=True,
            used_backend="fake-powerpoint",
        ),
    )

    assert result.status == "succeeded"
    assert result.succeeded_operation_ids == ("op-1",)
    assert result.written_operation_ids == ("op-1",)
    assert result.unexecuted_operation_ids == ()
    assert result.wrote is True
    assert result.verified is True
    assert requests == [AccessRequest(action="patch", source_ids=("source-b",))]
    assert result.inverse_records[0].to_dict() == {
        "operationId": "inverse:op-1",
        "forwardOperationId": "op-1",
        "operation": "set_shape_text",
        "sourceId": "source-b",
        "locator": {
            "kind": "slide-shape",
            "value": {"documentId": "deck-1", "slideId": 7, "shapeId": 22},
        },
        "expectedCurrent": "after",
        "restore": "before",
        "strategy": "restore_if_unchanged",
    }


def test_stale_artifact_revision_does_not_read_or_execute() -> None:
    effects: list[str] = []
    result = apply_document_patch(
        _patch(),
        current_artifact_revision=2,
        accepted_revision=None,
        authorize=lambda _request: effects.append("authorize") or AccessDecision(True),
        read_current=lambda _operation: effects.append("read") or OperationReadResult(True, "before"),
        execute=lambda _operation: effects.append("write") or OperationWriteResult(True, True),
    )

    assert result.status == "stale_revision"
    assert result.wrote is False
    assert effects == []


def test_reference_material_cannot_be_smuggled_in_as_the_target() -> None:
    operation = _operation(
        reference_id="ref-target",
        source_id="source-a",
        shape_id=11,
    )
    with pytest.raises(ValueError, match="does not match target reference"):
        _patch(operations=[operation])


def test_a_write_with_mismatched_readback_is_never_reported_as_success() -> None:
    reads = iter(("before", "someone else changed it"))
    result = apply_document_patch(
        _patch(),
        current_artifact_revision=1,
        accepted_revision=1,
        authorize=lambda _request: AccessDecision(True),
        read_current=lambda _operation: OperationReadResult(
            ok=True,
            value=next(reads),
            used_backend="fake-powerpoint",
        ),
        execute=lambda _operation: OperationWriteResult(
            ok=True,
            wrote=True,
            used_backend="fake-powerpoint",
        ),
    )

    assert result.status == "unverified"
    assert result.succeeded_operation_ids == ()
    assert result.written_operation_ids == ("op-1",)
    assert result.unexecuted_operation_ids == ()
    assert result.wrote is True
    assert result.verified is False
    assert result.error == "readback_mismatch:op-1"


def test_denied_authorization_has_no_reader_or_writer_side_effects() -> None:
    effects: list[str] = []
    result = apply_document_patch(
        _patch(),
        current_artifact_revision=1,
        accepted_revision=1,
        authorize=lambda request: AccessDecision(False, f"denied:{request.source_ids[0]}"),
        read_current=lambda _operation: effects.append("read") or OperationReadResult(True, "before"),
        execute=lambda _operation: effects.append("write") or OperationWriteResult(True, True),
    )

    assert result.status == "denied"
    assert result.wrote is False
    assert result.error == "denied:source-b"
    assert effects == []
