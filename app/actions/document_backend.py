"""Route DocumentPatch operations to capability-specific action handlers."""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any

from app.actions.document_output import DocumentOutputHandler
from app.actions.executor import SafeActionExecutor
from app.actions.figma import FigmaActionHandler
from app.actions.file_organizer import FileOrganizerHandler
from app.actions.office_document import OfficeDocumentActionHandler
from app.actions.pdf import PdfActionHandler
from app.actions.powerpoint import PowerPointActionHandler
from app.actions.schema import ActionProposal, ActionTarget, ExecutionStatus, SafetyLevel
from app.artifacts.document_patch import (
    OperationReadResult,
    OperationWriteResult,
    PatchOperation,
)
from app.context_pack.sources import SourceRef


class DocumentOperationBackend:
    """Session-bound backend used by the artifact apply bridge.

    Source identity is resolved before dispatch.  The backend deliberately has
    no generic Python/script operation: every branch maps one allowlisted patch
    name to one concrete implementation.
    """

    def __init__(
        self,
        *,
        sources: Iterable[SourceRef],
        artifact_id: str,
        artifact_revision: int,
        powerpoint: Any | None = None,
        pdf: Any | None = None,
        document_output: Any | None = None,
        file_organizer: Any | None = None,
        office_document: Any | None = None,
        figma: Any | None = None,
        action_executor: SafeActionExecutor | None = None,
    ) -> None:
        self.sources = {source.source_id: source for source in sources}
        self.artifact_id = str(artifact_id)
        self.artifact_revision = int(artifact_revision)
        self.powerpoint = powerpoint or PowerPointActionHandler()
        self.pdf = pdf or PdfActionHandler()
        self.document_output = document_output or DocumentOutputHandler()
        self.file_organizer = file_organizer or FileOrganizerHandler()
        self.office_document = office_document or OfficeDocumentActionHandler()
        self.figma = figma or FigmaActionHandler(None)
        self.action_executor = action_executor or SafeActionExecutor(
            document_operation_executor=self._execute_direct,
        )

    def _source(self, operation: PatchOperation) -> SourceRef:
        source = self.sources.get(operation.source_id)
        if source is None:
            raise KeyError(f"unknown document patch source: {operation.source_id}")
        if "patch" not in source.capabilities:
            raise PermissionError(f"source does not advertise patch capability: {source.source_id}")
        return source

    def _handler(self, operation: PatchOperation) -> Any:
        if operation.locator.kind == "figma-node":
            if operation.operation not in {
                "replace_text",
                "set_figma_fill",
                "set_figma_spacing",
                "set_figma_size",
                "set_figma_position",
            }:
                raise ValueError(f"unsupported Figma operation: {operation.operation}")
            return self.figma
        if operation.operation in {
            "set_shape_text",
            "set_shape_style",
            "set_shape_geometry",
        }:
            return self.powerpoint
        if operation.operation == "add_pdf_annotation":
            return self.pdf
        if operation.operation == "create_file":
            return self.document_output
        if operation.operation == "move_file":
            return self.file_organizer
        if operation.operation in {"replace_text", "set_cell_values"}:
            if self.office_document is None:
                raise ValueError("Word/Excel document operation backend is unavailable")
            return self.office_document
        raise ValueError(f"unsupported document operation: {operation.operation}")

    def read_current(self, operation: PatchOperation) -> OperationReadResult:
        try:
            source = self._source(operation)
            return self._handler(operation).read_current(source, operation)
        except Exception as exc:
            return OperationReadResult(
                False,
                used_backend="document-operation-router",
                error=f"document_route_failed:{type(exc).__name__}:{exc}",
            )

    def _execute_direct(self, operation: PatchOperation) -> OperationWriteResult:
        try:
            source = self._source(operation)
            return self._handler(operation).execute(source, operation)
        except Exception as exc:
            return OperationWriteResult(
                False,
                False,
                "document-operation-router",
                f"document_route_failed:{type(exc).__name__}:{exc}",
            )

    def execute(self, operation: PatchOperation) -> OperationWriteResult:
        proposal = ActionProposal(
            id=f"document-patch:{self.artifact_id}:{self.artifact_revision}:{operation.operation_id}",
            action_type="document_patch_operation",
            target=ActionTarget(
                object_id=operation.source_id,
                description=f"{operation.operation} at {operation.locator.kind}",
                metadata={
                    "sourceId": operation.source_id,
                    "locator": operation.locator.to_dict(),
                },
            ),
            parameters={"operation": operation.to_dict()},
            safety_level=SafetyLevel.HIGH,
            confirmation_required=True,
            rationale="Apply the exact operation from the accepted DraftArtifact revision.",
            metadata={
                "trusted_document_patch": True,
                "artifact_id": self.artifact_id,
                "artifact_revision": self.artifact_revision,
            },
        )
        result = self.action_executor.execute(proposal, confirmed=True)
        output = dict(result.output or {})
        backend = str(output.get("used_backend") or "document-operation-router")
        used_backend = f"safe-action-executor+{backend}"
        return OperationWriteResult(
            result.status == ExecutionStatus.SUCCEEDED,
            output.get("wrote") is True,
            used_backend,
            result.error,
        )


__all__ = ["DocumentOperationBackend"]
