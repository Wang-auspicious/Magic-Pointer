"""PDF annotations and explicit visual edits written to a new PDF copy."""

from __future__ import annotations

import os
import uuid
from collections.abc import Mapping
from contextlib import suppress
from pathlib import Path
from typing import Any

import fitz

from app.artifacts.document_patch import (
    OperationReadResult,
    OperationWriteResult,
    PatchOperation,
)
from app.context_pack.sources import SourceRef

_ANNOTATION_KINDS = frozenset({"highlight", "text-note", "visual-overlay"})


def _source_path(source: SourceRef) -> Path:
    identity = dict(source.identity)
    value = (
        identity.get("absolutePath")
        or identity.get("path")
        or identity.get("document")
    )
    if not str(value or "").strip():
        raise ValueError("PDF source has no absolute path")
    path = Path(str(value)).expanduser().resolve(strict=False)
    if path.suffix.casefold() != ".pdf":
        raise ValueError("PDF action requires a .pdf source")
    return path


def _annotation_state(operation: PatchOperation, *, after: bool) -> dict[str, Any]:
    value = operation.after if after else operation.before
    if not isinstance(value, Mapping):
        raise ValueError("add_pdf_annotation before/after must be objects")
    state = dict(value)
    required = {"annotationId", "kind", "outputPath", "present"}
    missing = required - set(state)
    if missing:
        raise ValueError(f"PDF annotation state missing fields: {sorted(missing)}")
    if str(state["kind"]) not in _ANNOTATION_KINDS:
        raise ValueError(f"unsupported PDF annotation kind: {state['kind']}")
    if not isinstance(state["present"], bool):
        raise ValueError("PDF annotation present must be boolean")
    return state


def _locator(operation: PatchOperation) -> tuple[int, fitz.Rect, str]:
    if operation.locator.kind != "pdf-region":
        raise ValueError("PDF annotation requires a pdf-region locator")
    value = operation.locator.value
    try:
        page_index = int(value["pageIndex"])
        raw_rect = value["rectPt"]
        rect = fitz.Rect(*(float(item) for item in raw_rect))
    except (KeyError, TypeError, ValueError) as exc:
        raise ValueError("PDF locator requires pageIndex and four-value rectPt") from exc
    if page_index < 0 or rect.is_empty or rect.is_infinite:
        raise ValueError("PDF locator page/rectangle is invalid")
    coordinate_space = str(value.get("coordinateSpace") or "pdf-page-points")
    if coordinate_space not in {"pdf-page-points", "rotated-page-points"}:
        raise ValueError(f"unsupported PDF coordinate space: {coordinate_space}")
    return page_index, rect, coordinate_space


def _find_annotation(page: fitz.Page, annotation_id: str) -> fitz.Annot | None:
    for annotation in page.annots() or ():
        if annotation.info.get("subject") == f"Magic Pointer {annotation_id}":
            return annotation
    return None


class PdfActionHandler:
    used_backend = "pdf.pymupdf"

    def read_current(
        self,
        source: SourceRef,
        operation: PatchOperation,
    ) -> OperationReadResult:
        try:
            if operation.operation != "add_pdf_annotation":
                raise ValueError(f"unsupported PDF operation: {operation.operation}")
            original = _source_path(source)
            before = _annotation_state(operation, after=False)
            after = _annotation_state(operation, after=True)
            if before.get("present") is not False or after.get("present") is not True:
                raise ValueError("PDF annotation must transition present false to true")
            if before.get("annotationId") != after.get("annotationId"):
                raise ValueError("PDF annotation identity cannot change")
            output = Path(str(after["outputPath"])).expanduser().resolve(strict=False)
            if output == original:
                raise ValueError("PDF annotations require an explicit output copy")
            if not output.exists():
                return OperationReadResult(True, before, self.used_backend)
            page_index, _, _ = _locator(operation)
            with fitz.open(output) as document:
                if page_index >= document.page_count:
                    return OperationReadResult(
                        True,
                        {"outputPath": str(output), "conflict": "page_missing"},
                        self.used_backend,
                    )
                found = _find_annotation(
                    document[page_index], str(after["annotationId"])
                )
                if found is not None:
                    return OperationReadResult(True, after, self.used_backend)
            return OperationReadResult(
                True,
                {"outputPath": str(output), "conflict": "output_exists"},
                self.used_backend,
            )
        except Exception as exc:
            return OperationReadResult(
                False,
                used_backend=self.used_backend,
                error=f"pdf_read_failed:{type(exc).__name__}:{exc}",
            )

    def execute(
        self,
        source: SourceRef,
        operation: PatchOperation,
    ) -> OperationWriteResult:
        temporary: Path | None = None
        try:
            original = _source_path(source)
            before = _annotation_state(operation, after=False)
            after = _annotation_state(operation, after=True)
            if before.get("present") is not False or after.get("present") is not True:
                raise ValueError("PDF annotation must transition present false to true")
            output = Path(str(after["outputPath"])).expanduser().resolve(strict=False)
            if output == original:
                raise ValueError("PDF annotations require an explicit output copy")
            if output.exists():
                return OperationWriteResult(
                    False, False, self.used_backend, "output_path_exists"
                )
            if not original.is_file():
                return OperationWriteResult(
                    False, False, self.used_backend, "source_pdf_missing"
                )
            output.parent.mkdir(parents=True, exist_ok=True)
            temporary = output.with_name(f".{output.name}.{uuid.uuid4().hex}.tmp")
            page_index, rect, coordinate_space = _locator(operation)
            with fitz.open(original) as document:
                if page_index >= document.page_count:
                    raise ValueError("PDF page no longer exists")
                page = document[page_index]
                target = rect * page.derotation_matrix if coordinate_space == "rotated-page-points" else rect
                kind = str(after["kind"])
                text = str(after.get("text") or "")
                if kind == "highlight":
                    annotation = page.add_highlight_annot(target)
                elif kind == "text-note":
                    annotation = page.add_text_annot(target.top_left, text)
                else:
                    annotation = page.add_freetext_annot(
                        target,
                        text,
                        fontsize=float(after.get("fontSize") or 10.0),
                    )
                    annotation.set_colors(
                        stroke=tuple(after.get("strokeColor") or (0.8, 0.2, 0.2)),
                        fill=tuple(after.get("fillColor") or (1.0, 1.0, 1.0)),
                    )
                annotation.set_info(
                    title="Magic Pointer",
                    subject=f"Magic Pointer {after['annotationId']}",
                    content=text,
                )
                annotation.update()
                document.save(temporary, garbage=3, deflate=True)
            with fitz.open(temporary) as verification:
                if _find_annotation(
                    verification[page_index], str(after["annotationId"])
                ) is None:
                    raise RuntimeError("annotation_readback_missing")
            os.replace(temporary, output)
            temporary = None
            return OperationWriteResult(True, True, self.used_backend)
        except Exception as exc:
            if temporary is not None:
                with suppress(OSError):
                    temporary.unlink(missing_ok=True)
            return OperationWriteResult(
                False,
                False,
                self.used_backend,
                f"pdf_write_failed:{type(exc).__name__}:{exc}",
            )


__all__ = ["PdfActionHandler"]
