"""Typed DraftArtifact projections over the Agent Runtime session log."""

from .projection import project_artifacts
from .document_patch import (
    DocumentPatch,
    InverseRecord,
    OperationReadResult,
    OperationWriteResult,
    PatchApplyResult,
    PatchOperation,
    PatchReference,
    SUPPORTED_DOCUMENT_OPERATIONS,
    apply_document_patch,
    bind_document_patch_payload,
    document_patch_paths,
)
from .schema import (
    ArtifactProjectionError,
    DraftArtifact,
    DraftPatch,
    DraftState,
    content_hash,
)

__all__ = [
    "ArtifactProjectionError",
    "DocumentPatch",
    "DraftArtifact",
    "DraftPatch",
    "DraftState",
    "InverseRecord",
    "OperationReadResult",
    "OperationWriteResult",
    "PatchApplyResult",
    "PatchOperation",
    "PatchReference",
    "SUPPORTED_DOCUMENT_OPERATIONS",
    "apply_document_patch",
    "bind_document_patch_payload",
    "document_patch_paths",
    "content_hash",
    "project_artifacts",
]
