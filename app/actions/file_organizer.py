"""Previewed, non-overwriting file moves with recoverable inverse records."""

from __future__ import annotations

import os
import shutil
from collections.abc import Iterable, Mapping
from pathlib import Path
from typing import Any

from app.artifacts.document_patch import (
    OperationReadResult,
    OperationWriteResult,
    PatchOperation,
)
from app.context_pack.sources import FragmentLocator, SourceRef


def _state(value: Any, name: str) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        raise ValueError(f"move_file {name} must be an object")
    path = str(value.get("path") or "").strip()
    if not path:
        raise ValueError(f"move_file {name}.path is required")
    return dict(value)


def _paths(operation: PatchOperation) -> tuple[dict[str, Any], dict[str, Any], Path, Path]:
    if operation.operation != "move_file":
        raise ValueError(f"unsupported file organizer operation: {operation.operation}")
    before = _state(operation.before, "before")
    after = _state(operation.after, "after")
    old_path = Path(str(before["path"])).expanduser().resolve(strict=False)
    new_path = Path(str(after["path"])).expanduser().resolve(strict=False)
    if old_path == new_path:
        raise ValueError("move_file old and new paths must differ")
    return before, after, old_path, new_path


def _inside(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def _source_root(source: SourceRef) -> Path:
    identity = dict(source.identity)
    raw = identity.get("absolutePath") or identity.get("path")
    if not str(raw or "").strip():
        raise ValueError("file organizer source has no root path")
    candidate = Path(str(raw)).expanduser().resolve(strict=False)
    return candidate if candidate.is_dir() else candidate.parent


def _validate_scope(source: SourceRef, old_path: Path, new_path: Path) -> None:
    root = _source_root(source)
    if not _inside(old_path, root) or not _inside(new_path, root):
        raise ValueError("move_file paths must remain inside the authorized source root")


class FileOrganizerHandler:
    used_backend = "file-organizer.local-filesystem"

    def read_current(
        self,
        source: SourceRef,
        operation: PatchOperation,
    ) -> OperationReadResult:
        try:
            before, after, old_path, new_path = _paths(operation)
            _validate_scope(source, old_path, new_path)
            old_exists = old_path.exists()
            new_exists = new_path.exists()
            if old_exists and not new_exists:
                value = before
            elif new_exists and not old_exists:
                value = after
            else:
                value = {
                    "oldPath": str(old_path),
                    "newPath": str(new_path),
                    "oldExists": old_exists,
                    "newExists": new_exists,
                }
            return OperationReadResult(True, value, self.used_backend)
        except Exception as exc:
            return OperationReadResult(
                False,
                used_backend=self.used_backend,
                error=f"file_move_read_failed:{type(exc).__name__}:{exc}",
            )

    def execute(
        self,
        source: SourceRef,
        operation: PatchOperation,
    ) -> OperationWriteResult:
        try:
            _, _, old_path, new_path = _paths(operation)
            _validate_scope(source, old_path, new_path)
            if not old_path.exists():
                return OperationWriteResult(
                    False, False, self.used_backend, "source_path_missing"
                )
            if new_path.exists():
                return OperationWriteResult(
                    False, False, self.used_backend, "destination_path_exists"
                )
            if not new_path.parent.is_dir():
                return OperationWriteResult(
                    False, False, self.used_backend, "destination_parent_missing"
                )
            shutil.move(str(old_path), str(new_path))
            return OperationWriteResult(True, True, self.used_backend)
        except Exception as exc:
            return OperationWriteResult(
                False,
                False,
                self.used_backend,
                f"file_move_failed:{type(exc).__name__}:{exc}",
            )


def restore_move(*, expected_current: Path | str, restore: Path | str) -> OperationWriteResult:
    current = Path(expected_current).expanduser().resolve(strict=False)
    destination = Path(restore).expanduser().resolve(strict=False)
    backend = "file-organizer.local-filesystem"
    if not current.exists():
        return OperationWriteResult(False, False, backend, "inverse_current_missing")
    if destination.exists():
        return OperationWriteResult(False, False, backend, "inverse_destination_exists")
    if not destination.parent.is_dir():
        return OperationWriteResult(False, False, backend, "inverse_parent_missing")
    try:
        shutil.move(str(current), str(destination))
        return OperationWriteResult(True, True, backend)
    except OSError as exc:
        return OperationWriteResult(
            False, False, backend, f"inverse_move_failed:{type(exc).__name__}:{exc}"
        )


def build_move_preview(
    root: Path | str,
    moves: Iterable[tuple[Path | str, Path | str]],
    *,
    source_id: str,
    reference_id: str,
) -> list[dict[str, Any]]:
    """Resolve a proposed batch and report conflicts without changing disk."""
    authorized_root = Path(root).expanduser().resolve(strict=False)
    operations: list[dict[str, Any]] = []
    destinations: set[str] = set()
    for index, (old_value, new_value) in enumerate(moves, start=1):
        old_path = Path(old_value).expanduser().resolve(strict=False)
        new_path = Path(new_value).expanduser().resolve(strict=False)
        if not _inside(old_path, authorized_root) or not _inside(new_path, authorized_root):
            raise ValueError("move preview path is outside the selected root")
        key = os.path.normcase(str(new_path))
        conflict = (
            "source_missing" if not old_path.exists()
            else "destination_exists" if new_path.exists()
            else "duplicate_destination" if key in destinations
            else None
        )
        destinations.add(key)
        operations.append({
            "operationId": f"move-{index}",
            "operation": "move_file",
            "referenceId": reference_id,
            "sourceId": source_id,
            "locator": FragmentLocator(
                "text", {"root": str(authorized_root)}
            ).to_dict(),
            "before": {"path": str(old_path)},
            "after": {"path": str(new_path)},
            "conflict": conflict,
        })
    return operations


__all__ = ["FileOrganizerHandler", "build_move_preview", "restore_move"]
