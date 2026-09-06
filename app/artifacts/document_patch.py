"""Typed, revision-bound document changes and their verification gate.

This module deliberately knows nothing about PowerPoint, PDF, Figma, or a
desktop connection.  Product adapters provide one read callback and one write
callback; this value layer owns the invariants shared by all of them.
"""

from __future__ import annotations

import copy
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any

from app.context_pack.source_scope import AccessDecision, AccessRequest
from app.context_pack.sources import FragmentLocator, REFERENCE_ROLES


SUPPORTED_DOCUMENT_OPERATIONS = frozenset({
    "replace_text",
    "set_cell_values",
    "set_shape_text",
    "set_shape_style",
    "set_shape_geometry",
    "set_figma_fill",
    "set_figma_spacing",
    "set_figma_size",
    "set_figma_position",
    "add_pdf_annotation",
    "create_file",
    "move_file",
})


def _mapping(value: Any, name: str) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        raise ValueError(f"{name} must be an object")
    return dict(value)


def _strict(
    value: Any,
    name: str,
    *,
    required: set[str],
) -> dict[str, Any]:
    data = _mapping(value, name)
    missing = sorted(required - set(data))
    unknown = sorted(set(data) - required)
    if missing or unknown:
        raise ValueError(f"invalid {name} fields missing={missing} unknown={unknown}")
    return data


def _text(value: Any, name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{name} must be a non-empty string")
    return value.strip()


@dataclass(frozen=True, slots=True)
class PatchReference:
    reference_id: str
    source_id: str
    locator: FragmentLocator
    role: str

    @classmethod
    def from_dict(cls, value: Mapping[str, Any]) -> "PatchReference":
        data = _strict(
            value,
            cls.__name__,
            required={"referenceId", "sourceId", "locator", "role"},
        )
        role = _text(data["role"], "PatchReference.role")
        if role not in REFERENCE_ROLES:
            raise ValueError(f"unsupported PatchReference.role: {role}")
        return cls(
            reference_id=_text(data["referenceId"], "PatchReference.referenceId"),
            source_id=_text(data["sourceId"], "PatchReference.sourceId"),
            locator=FragmentLocator.from_dict(
                _mapping(data["locator"], "PatchReference.locator")
            ),
            role=role,
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "referenceId": self.reference_id,
            "sourceId": self.source_id,
            "locator": self.locator.to_dict(),
            "role": self.role,
        }


@dataclass(frozen=True, slots=True)
class PatchOperation:
    operation_id: str
    operation: str
    reference_id: str
    source_id: str
    locator: FragmentLocator
    before: Any
    after: Any

    @classmethod
    def from_dict(cls, value: Mapping[str, Any]) -> "PatchOperation":
        data = _strict(
            value,
            cls.__name__,
            required={
                "operationId",
                "operation",
                "referenceId",
                "sourceId",
                "locator",
                "before",
                "after",
            },
        )
        operation = _text(data["operation"], "PatchOperation.operation")
        if operation not in SUPPORTED_DOCUMENT_OPERATIONS:
            raise ValueError(f"unsupported document operation: {operation}")
        before = copy.deepcopy(data["before"])
        after = copy.deepcopy(data["after"])
        if before == after:
            raise ValueError("document operation before and after must differ")
        return cls(
            operation_id=_text(data["operationId"], "PatchOperation.operationId"),
            operation=operation,
            reference_id=_text(data["referenceId"], "PatchOperation.referenceId"),
            source_id=_text(data["sourceId"], "PatchOperation.sourceId"),
            locator=FragmentLocator.from_dict(
                _mapping(data["locator"], "PatchOperation.locator")
            ),
            before=before,
            after=after,
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "operationId": self.operation_id,
            "operation": self.operation,
            "referenceId": self.reference_id,
            "sourceId": self.source_id,
            "locator": self.locator.to_dict(),
            "before": copy.deepcopy(self.before),
            "after": copy.deepcopy(self.after),
        }


@dataclass(frozen=True, slots=True)
class DocumentPatch:
    patch_id: str
    artifact_id: str
    artifact_revision: int
    references: tuple[PatchReference, ...]
    operations: tuple[PatchOperation, ...]

    @classmethod
    def from_dict(cls, value: Mapping[str, Any]) -> "DocumentPatch":
        data = _strict(
            value,
            cls.__name__,
            required={
                "patchId",
                "artifactId",
                "artifactRevision",
                "references",
                "operations",
            },
        )
        revision = data["artifactRevision"]
        if isinstance(revision, bool) or not isinstance(revision, int) or revision < 1:
            raise ValueError("DocumentPatch.artifactRevision must be an integer >= 1")
        raw_references = data["references"]
        raw_operations = data["operations"]
        if not isinstance(raw_references, list) or not raw_references:
            raise ValueError("DocumentPatch.references must be a non-empty array")
        if not isinstance(raw_operations, list) or not raw_operations:
            raise ValueError("DocumentPatch.operations must be a non-empty array")
        references = tuple(PatchReference.from_dict(item) for item in raw_references)
        operations = tuple(PatchOperation.from_dict(item) for item in raw_operations)
        reference_ids = [item.reference_id for item in references]
        operation_ids = [item.operation_id for item in operations]
        if len(reference_ids) != len(set(reference_ids)):
            raise ValueError("DocumentPatch referenceId values must be unique")
        if len(operation_ids) != len(set(operation_ids)):
            raise ValueError("DocumentPatch operationId values must be unique")
        by_reference = {item.reference_id: item for item in references}
        for operation in operations:
            target = by_reference.get(operation.reference_id)
            if target is None or target.role != "target":
                raise ValueError(
                    f"operation {operation.operation_id!r} does not name a target reference"
                )
            if (
                operation.source_id != target.source_id
                or operation.locator != target.locator
            ):
                raise ValueError(
                    f"operation {operation.operation_id!r} does not match target reference"
                )
        return cls(
            patch_id=_text(data["patchId"], "DocumentPatch.patchId"),
            artifact_id=_text(data["artifactId"], "DocumentPatch.artifactId"),
            artifact_revision=revision,
            references=references,
            operations=operations,
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "patchId": self.patch_id,
            "artifactId": self.artifact_id,
            "artifactRevision": self.artifact_revision,
            "references": [item.to_dict() for item in self.references],
            "operations": [item.to_dict() for item in self.operations],
        }

    def preview(self) -> dict[str, Any]:
        """Return the exact values the approved revision would write."""
        return {
            "patchId": self.patch_id,
            "artifactId": self.artifact_id,
            "artifactRevision": self.artifact_revision,
            "changes": [item.to_dict() for item in self.operations],
        }


def bind_document_patch_payload(
    value: Mapping[str, Any],
    *,
    artifact_id: str,
    artifact_revision: int,
) -> dict[str, Any]:
    """Bind UI/model patch data to session-owned artifact coordinates."""
    data = _mapping(value, "document patch payload")
    data["artifactId"] = _text(artifact_id, "artifact_id")
    data["artifactRevision"] = artifact_revision
    return DocumentPatch.from_dict(data).to_dict()


@dataclass(frozen=True, slots=True)
class OperationReadResult:
    ok: bool
    value: Any = None
    used_backend: str = ""
    error: str | None = None


@dataclass(frozen=True, slots=True)
class OperationWriteResult:
    ok: bool
    wrote: bool
    used_backend: str = ""
    error: str | None = None


@dataclass(frozen=True, slots=True)
class InverseRecord:
    operation_id: str
    forward_operation_id: str
    operation: str
    source_id: str
    locator: FragmentLocator
    expected_current: Any
    restore: Any
    strategy: str

    @classmethod
    def from_operation(cls, operation: PatchOperation) -> "InverseRecord":
        strategy = "restore_if_unchanged"
        restore = copy.deepcopy(operation.before)
        if operation.operation == "create_file":
            strategy = "retain_created_file"
            restore = None
        elif operation.operation == "add_pdf_annotation":
            strategy = "remove_annotation_if_unchanged"
        return cls(
            operation_id=f"inverse:{operation.operation_id}",
            forward_operation_id=operation.operation_id,
            operation=operation.operation,
            source_id=operation.source_id,
            locator=operation.locator,
            expected_current=copy.deepcopy(operation.after),
            restore=restore,
            strategy=strategy,
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "operationId": self.operation_id,
            "forwardOperationId": self.forward_operation_id,
            "operation": self.operation,
            "sourceId": self.source_id,
            "locator": self.locator.to_dict(),
            "expectedCurrent": copy.deepcopy(self.expected_current),
            "restore": copy.deepcopy(self.restore),
            "strategy": self.strategy,
        }


@dataclass(frozen=True, slots=True)
class PatchApplyResult:
    patch_id: str
    artifact_id: str
    artifact_revision: int
    status: str
    succeeded_operation_ids: tuple[str, ...]
    written_operation_ids: tuple[str, ...]
    unexecuted_operation_ids: tuple[str, ...]
    inverse_records: tuple[InverseRecord, ...]
    wrote: bool
    verified: bool
    used_backend: str
    error: str | None = None
    difference: dict[str, Any] | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "patchId": self.patch_id,
            "artifactId": self.artifact_id,
            "artifactRevision": self.artifact_revision,
            "status": self.status,
            "succeededOperationIds": list(self.succeeded_operation_ids),
            "writtenOperationIds": list(self.written_operation_ids),
            "unexecutedOperationIds": list(self.unexecuted_operation_ids),
            "inverseRecords": [item.to_dict() for item in self.inverse_records],
            "wrote": self.wrote,
            "verified": self.verified,
            "usedBackend": self.used_backend,
            "error": self.error,
            "difference": copy.deepcopy(self.difference),
        }


def document_patch_paths(patch: DocumentPatch) -> tuple[str, ...]:
    paths: list[str] = []
    for operation in patch.operations:
        values: tuple[Any, ...]
        if operation.operation == "create_file":
            values = (operation.after,)
        elif operation.operation == "move_file":
            values = (operation.before, operation.after)
        elif operation.operation == "add_pdf_annotation":
            value = operation.after
            output_path = value.get("outputPath") if isinstance(value, Mapping) else None
            values = ({"path": output_path},) if output_path else ()
        else:
            continue
        for value in values:
            if isinstance(value, Mapping):
                path = str(value.get("path") or "").strip()
            else:
                path = str(value or "").strip()
            if path and path not in paths:
                paths.append(path)
    return tuple(paths)


def _backend_name(names: list[str]) -> str:
    unique: list[str] = []
    for name in names:
        value = str(name or "").strip()
        if value and value not in unique:
            unique.append(value)
    return "+".join(unique)


def apply_document_patch(
    patch: DocumentPatch,
    *,
    current_artifact_revision: int,
    accepted_revision: int | None,
    authorize: Callable[[AccessRequest], AccessDecision],
    read_current: Callable[[PatchOperation], OperationReadResult],
    execute: Callable[[PatchOperation], OperationWriteResult],
    state_probe: Callable[[], tuple[int, int | None]] | None = None,
) -> PatchApplyResult:
    """Apply an approved patch sequentially, stopping at the first uncertainty."""

    succeeded: list[str] = []
    written: list[str] = []
    inverses: list[InverseRecord] = []
    backends: list[str] = []

    def result(
        status: str,
        *,
        error: str | None = None,
        unexecuted_from: int = 0,
        difference: dict[str, Any] | None = None,
        verified: bool = False,
    ) -> PatchApplyResult:
        return PatchApplyResult(
            patch_id=patch.patch_id,
            artifact_id=patch.artifact_id,
            artifact_revision=patch.artifact_revision,
            status=status,
            succeeded_operation_ids=tuple(succeeded),
            written_operation_ids=tuple(written),
            unexecuted_operation_ids=tuple(
                item.operation_id for item in patch.operations[unexecuted_from:]
            ),
            inverse_records=tuple(inverses),
            wrote=bool(written),
            verified=verified,
            used_backend=_backend_name(backends),
            error=error,
            difference=copy.deepcopy(difference),
        )

    if current_artifact_revision != patch.artifact_revision:
        return result(
            "stale_revision",
            error=(
                f"artifact_revision_changed:{patch.artifact_revision}"
                f"->{current_artifact_revision}"
            ),
        )
    if accepted_revision != patch.artifact_revision:
        return result("not_accepted", error="artifact_revision_not_accepted")

    source_ids = tuple(dict.fromkeys(item.source_id for item in patch.operations))
    request = AccessRequest(
        action="patch",
        source_ids=source_ids,
        paths=document_patch_paths(patch),
    )
    try:
        decision = authorize(request)
    except Exception as exc:
        return result(
            "denied",
            error=f"authorization_failed:{type(exc).__name__}:{exc}",
        )
    if not isinstance(decision, AccessDecision):
        return result("denied", error="authorization_returned_invalid_decision")
    if not decision.allowed:
        return result("denied", error=decision.reason or "access_denied")

    for index, operation in enumerate(patch.operations):
        if state_probe is not None:
            live_revision, live_accepted_revision = state_probe()
            if live_revision != patch.artifact_revision:
                return result(
                    "partial" if written else "stale_revision",
                    error=(
                        f"artifact_revision_changed:{patch.artifact_revision}"
                        f"->{live_revision}"
                    ),
                    unexecuted_from=index,
                )
            if live_accepted_revision != patch.artifact_revision:
                return result(
                    "partial" if written else "not_accepted",
                    error="artifact_revision_not_accepted",
                    unexecuted_from=index,
                )
        try:
            before = read_current(operation)
        except Exception as exc:
            status = "partial" if written else "failed"
            return result(
                status,
                error=f"pre_read_failed:{operation.operation_id}:{type(exc).__name__}:{exc}",
                unexecuted_from=index,
            )
        if not isinstance(before, OperationReadResult) or not before.ok:
            status = "partial" if written else "failed"
            error = (
                before.error
                if isinstance(before, OperationReadResult)
                else "invalid_read_result"
            )
            return result(
                status,
                error=f"pre_read_failed:{operation.operation_id}:{error or 'unknown'}",
                unexecuted_from=index,
            )
        backends.append(before.used_backend)
        if before.value != operation.before:
            status = "partial" if written else "conflict"
            return result(
                status,
                error=f"base_mismatch:{operation.operation_id}",
                unexecuted_from=index,
                difference={
                    "operationId": operation.operation_id,
                    "expected": copy.deepcopy(operation.before),
                    "actual": copy.deepcopy(before.value),
                },
            )

        if state_probe is not None:
            live_revision, live_accepted_revision = state_probe()
            if live_revision != patch.artifact_revision:
                return result(
                    "partial" if written else "stale_revision",
                    error=(
                        f"artifact_revision_changed:{patch.artifact_revision}"
                        f"->{live_revision}"
                    ),
                    unexecuted_from=index,
                )
            if live_accepted_revision != patch.artifact_revision:
                return result(
                    "partial" if written else "not_accepted",
                    error="artifact_revision_not_accepted",
                    unexecuted_from=index,
                )
        try:
            write = execute(operation)
        except Exception as exc:
            status = "partial" if written else "failed"
            return result(
                status,
                error=f"write_failed:{operation.operation_id}:{type(exc).__name__}:{exc}",
                unexecuted_from=index,
            )
        if not isinstance(write, OperationWriteResult) or not write.ok:
            if isinstance(write, OperationWriteResult):
                backends.append(write.used_backend)
                if write.wrote:
                    written.append(operation.operation_id)
                    inverses.append(InverseRecord.from_operation(operation))
                error = write.error or "unknown"
            else:
                error = "invalid_write_result"
            status = "partial" if written else "failed"
            return result(
                status,
                error=f"write_failed:{operation.operation_id}:{error}",
                unexecuted_from=index + 1,
            )
        backends.append(write.used_backend)
        if not write.wrote:
            status = "partial" if written else "failed"
            return result(
                status,
                error=f"write_reported_no_effect:{operation.operation_id}",
                unexecuted_from=index + 1,
            )
        written.append(operation.operation_id)
        inverses.append(InverseRecord.from_operation(operation))

        try:
            after = read_current(operation)
        except Exception as exc:
            return result(
                "unverified",
                error=f"readback_failed:{operation.operation_id}:{type(exc).__name__}:{exc}",
                unexecuted_from=index + 1,
            )
        if not isinstance(after, OperationReadResult) or not after.ok:
            error = (
                after.error
                if isinstance(after, OperationReadResult)
                else "invalid_read_result"
            )
            return result(
                "unverified",
                error=f"readback_failed:{operation.operation_id}:{error or 'unknown'}",
                unexecuted_from=index + 1,
            )
        backends.append(after.used_backend)
        if after.value != operation.after:
            return result(
                "unverified",
                error=f"readback_mismatch:{operation.operation_id}",
                unexecuted_from=index + 1,
                difference={
                    "operationId": operation.operation_id,
                    "expected": copy.deepcopy(operation.after),
                    "actual": copy.deepcopy(after.value),
                },
            )
        succeeded.append(operation.operation_id)

    return result(
        "succeeded",
        unexecuted_from=len(patch.operations),
        verified=True,
    )


__all__ = [
    "DocumentPatch",
    "InverseRecord",
    "OperationReadResult",
    "OperationWriteResult",
    "PatchApplyResult",
    "PatchOperation",
    "PatchReference",
    "SUPPORTED_DOCUMENT_OPERATIONS",
    "apply_document_patch",
    "bind_document_patch_payload",
]
