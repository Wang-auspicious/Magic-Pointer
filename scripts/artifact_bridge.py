"""Bounded IPC bridge for durable editable DraftArtifacts."""

from __future__ import annotations

import copy
import os
import uuid
from pathlib import Path
from typing import Any, Protocol

try:
    from scripts._bridge_common import (
        PayloadTooLargeError,
        ensure_root_on_path,
        force_utf8_stdio,
        read_bounded_json_payload,
        write_json,
    )
except ModuleNotFoundError:  # direct script execution
    from _bridge_common import (  # type: ignore[no-redef]
        PayloadTooLargeError,
        ensure_root_on_path,
        force_utf8_stdio,
        read_bounded_json_payload,
        write_json,
    )

ensure_root_on_path()

from app.actions.document_backend import DocumentOperationBackend  # noqa: E402
from app.actions.figma import FigmaActionHandler  # noqa: E402
from app.adapters.figma_client import FigmaClient, FigmaClientConfig  # noqa: E402
from app.agent_runtime.session import EventSession, FileSessionStore  # noqa: E402
from app.artifacts.document_patch import (  # noqa: E402
    DocumentPatch,
    OperationReadResult,
    OperationWriteResult,
    PatchOperation,
    apply_document_patch,
    document_patch_paths,
)
from app.artifacts.projection import project_artifacts  # noqa: E402
from app.artifacts.schema import DraftArtifact  # noqa: E402
from app.context_pack.source_scope import (  # noqa: E402
    ScopeGrant,
    authorize_access,
    grant_source_scope,
    scope_from_events,
)
from app.context_pack.source_store import task_sources  # noqa: E402
from app.fabric.artifacts import ArtifactRegistry, ArtifactRegistryError  # noqa: E402
from app.receipts.schema import Receipt, ReceiptStatus  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]


class OperationBackend(Protocol):
    def read_current(self, operation: PatchOperation) -> OperationReadResult: ...

    def execute(self, operation: PatchOperation) -> OperationWriteResult: ...


class _FigmaRuntimeRouter:
    def __init__(self, raw_connections: Any) -> None:
        if raw_connections is None:
            raw_connections = []
        if not isinstance(raw_connections, list):
            raise ValueError("Figma runtime connections must be an array")
        self._handlers: dict[tuple[str, str], FigmaActionHandler] = {}
        for raw in raw_connections:
            if not isinstance(raw, dict):
                raise ValueError("Figma runtime connection must be an object")
            config = FigmaClientConfig.from_dict(raw)
            key = (config.task_id, config.document_session_id)
            if key in self._handlers:
                raise ValueError("duplicate Figma runtime connection identity")
            self._handlers[key] = FigmaActionHandler(FigmaClient(config))

    def _handler(self, source: Any) -> FigmaActionHandler:
        key = (
            source.task_id,
            str(source.identity.get("documentSessionId") or ""),
        )
        return self._handlers.get(key) or FigmaActionHandler(None)

    def read_current(
        self,
        source: Any,
        operation: PatchOperation,
    ) -> OperationReadResult:
        return self._handler(source).read_current(source, operation)

    def execute(
        self,
        source: Any,
        operation: PatchOperation,
    ) -> OperationWriteResult:
        return self._handler(source).execute(source, operation)


def _session_root() -> Path:
    configured = str(os.environ.get("MAGIC_POINTER_USER_DATA_DIR") or "").strip()
    runtime_root = Path(configured) if configured else ROOT / "data" / "runtime"
    return runtime_root / "agent-sessions"


def _artifact(
    session: EventSession,
    artifact_id: str,
) -> DraftArtifact | None:
    return next(
        (
            item
            for item in project_artifacts(session.events)
            if item.artifact_id == artifact_id
        ),
        None,
    )


def _latest_apply(session: EventSession, artifact_id: str) -> dict[str, Any] | None:
    for event in reversed(session.events):
        if (
            event.type == "artifact/applied"
            and str(event.data.get("artifactId") or "") == artifact_id
        ):
            return copy.deepcopy(dict(event.data))
    return None


def _wire_artifact(session: EventSession, artifact: DraftArtifact) -> dict[str, Any]:
    return {
        "artifactId": artifact.artifact_id,
        "revision": artifact.revision,
        "content": artifact.content,
        "contentHash": artifact.content_hash,
        "kind": artifact.kind,
        "state": artifact.state.value,
        "acceptedRevision": artifact.accepted_revision,
        "patchPayload": copy.deepcopy(artifact.patch_payload),
        "history": [
            {
                "revision": item.revision,
                "author": item.author,
                "contentHash": item.content_hash,
                "seq": item.seq,
            }
            for item in artifact.history
        ],
        "latestApply": _latest_apply(session, artifact.artifact_id),
    }


def _integer(value: Any) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        return None
    return value


def _receipt_for(result: Any) -> Receipt:
    status = {
        "succeeded": ReceiptStatus.SUCCEEDED,
        "partial": ReceiptStatus.PARTIAL,
        "unverified": ReceiptStatus.UNVERIFIED,
    }.get(result.status, ReceiptStatus.FAILED)
    return Receipt(
        receipt_id=uuid.uuid4().hex,
        status=status,
        effect="reversible_write" if result.wrote else "patch",
        verification_method=(
            "document_patch_readback"
            if result.verified
            else "document_patch_not_verified"
        ),
        used_backend=result.used_backend or "document-patch-gate",
        artifact_ids=(result.artifact_id,),
        wrote=result.wrote,
        verified=result.verified,
        failure_type=result.error,
        memory_eligible=False,
    )


def _wire_receipt(receipt: Receipt) -> dict[str, Any]:
    return {
        "receiptId": receipt.receipt_id,
        "status": receipt.status.value,
        "effect": receipt.effect,
        "verificationMethod": receipt.verification_method,
        "usedBackend": receipt.used_backend,
        "artifactIds": list(receipt.artifact_ids),
        "wrote": receipt.wrote,
        "verified": receipt.verified,
        "failureType": receipt.failure_type,
    }


def _fresh_artifact_state(
    store: FileSessionStore,
    session_id: str,
    artifact_id: str,
) -> tuple[int, int | None]:
    fresh = store.resume(session_id, repair=False)
    artifact = _artifact(fresh, artifact_id)
    if artifact is None:
        return 0, None
    return artifact.revision, artifact.accepted_revision


def _grant_accepted_patch(
    session: EventSession,
    patch: DocumentPatch,
) -> None:
    sources = {source.source_id: source for source in task_sources(session.events)}
    source_ids = tuple(dict.fromkeys(
        operation.source_id for operation in patch.operations
    ))
    for source_id in source_ids:
        source = sources.get(source_id)
        if source is None:
            raise ValueError(f"patch source is not registered: {source_id}")
        if "patch" not in source.capabilities:
            raise ValueError(f"source does not support patch: {source_id}")
    folder_roots: list[str] = []
    for value in document_patch_paths(patch):
        parent = str(Path(value).expanduser().resolve(strict=False).parent)
        if parent not in folder_roots:
            folder_roots.append(parent)
    for operation in patch.operations:
        root = operation.locator.value.get("root")
        if isinstance(root, str) and root.strip():
            normalized = str(Path(root).expanduser().resolve(strict=False))
            if normalized not in folder_roots:
                folder_roots.append(normalized)
    grant_source_scope(session, grants=(ScopeGrant(
        grant_id=f"artifact-patch:{patch.artifact_id}:{patch.artifact_revision}",
        task_id=session.id,
        source_ids=source_ids,
        folder_roots=tuple(folder_roots),
        window_ids=(),
        recipients=(),
        actions=("patch",),
        expires_at_ms=None,
    ),))


def _written_artifact_path(operation: PatchOperation) -> Path | None:
    value = operation.after
    if not isinstance(value, dict):
        return None
    if operation.operation in {"create_file", "move_file"}:
        raw = value.get("path")
    elif operation.operation == "add_pdf_annotation":
        raw = value.get("outputPath")
    else:
        return None
    if not isinstance(raw, str) or not raw.strip():
        return None
    return Path(raw).expanduser().resolve(strict=False)


def _register_written_artifacts(
    store: FileSessionStore,
    session: EventSession,
    patch: DocumentPatch,
    result: Any,
    receipt: Receipt,
) -> tuple[list[dict[str, Any]], list[str]]:
    succeeded = set(result.succeeded_operation_ids)
    registry = ArtifactRegistry(store.root.parent)
    records: list[dict[str, Any]] = []
    errors: list[str] = []
    receipt_data = _wire_receipt(receipt)
    for operation in patch.operations:
        if operation.operation_id not in succeeded:
            continue
        path = _written_artifact_path(operation)
        if path is None or not path.is_file():
            continue
        try:
            records.append(registry.register_reference(
                path,
                allowed_roots=(path.parent,),
                plan_id=patch.patch_id,
                receipt_id=receipt.receipt_id,
                task_id=session.id,
                provider=result.used_backend,
                source_id=operation.source_id,
                draft_artifact_id=patch.artifact_id,
                artifact_revision=patch.artifact_revision,
                references=(item.to_dict() for item in patch.references),
                preview=patch.preview(),
                verification_receipt=receipt_data,
                kind=path.suffix.lstrip("."),
            ))
        except (ArtifactRegistryError, OSError, ValueError) as exc:
            errors.append(
                f"{operation.operation_id}:{type(exc).__name__}:{exc}"
            )
    return records, errors


def handle_request(
    payload: dict[str, Any],
    *,
    session_store: FileSessionStore | None = None,
    operation_backend: OperationBackend | None = None,
) -> dict[str, Any]:
    action = str(payload.get("action") or "").strip()
    session_id = str(payload.get("sessionId") or "").strip()
    artifact_id = str(payload.get("artifactId") or "").strip()
    store = session_store or FileSessionStore(_session_root())
    try:
        session = store.resume(session_id, repair=False)
    except FileNotFoundError:
        return {"ok": False, "error": "session_not_found"}
    except ValueError:
        return {"ok": False, "error": "invalid_session_id"}

    if action == "read":
        artifacts = project_artifacts(session.events)
        if artifact_id:
            current = next(
                (item for item in artifacts if item.artifact_id == artifact_id),
                None,
            )
            if current is None:
                return {"ok": False, "error": "artifact_not_found"}
            return {"ok": True, "artifact": _wire_artifact(session, current)}
        return {
            "ok": True,
            "artifacts": [_wire_artifact(session, item) for item in artifacts],
        }

    if not artifact_id:
        return {"ok": False, "error": "artifact_id_required"}
    current = _artifact(session, artifact_id)
    if current is None:
        return {"ok": False, "error": "artifact_not_found"}

    if action == "edit":
        expected_revision = _integer(payload.get("expectedRevision"))
        if expected_revision is None:
            return {"ok": False, "error": "expected_revision_required"}
        if expected_revision != current.revision:
            return {
                "ok": False,
                "error": "stale_revision",
                "currentRevision": current.revision,
            }
        patch_payload = payload.get("patchPayload")
        if patch_payload is not None and not isinstance(patch_payload, dict):
            return {"ok": False, "error": "invalid_patch_payload"}
        try:
            session.record_artifact_patched(
                artifact_id,
                str(payload.get("content") or ""),
                author="user",
                expected_revision=expected_revision,
                kind=current.kind,
                patch_payload=patch_payload,
            )
        except RuntimeError:
            fresh = store.resume(session_id, repair=False)
            fresh_artifact = _artifact(fresh, artifact_id)
            return {
                "ok": False,
                "error": "stale_revision",
                "currentRevision": fresh_artifact.revision if fresh_artifact else 0,
            }
        except ValueError as exc:
            return {"ok": False, "error": f"invalid_edit:{exc}"}
        updated = _artifact(session, artifact_id)
        return {
            "ok": True,
            "artifact": _wire_artifact(session, updated),
        }

    if action == "accept":
        revision = _integer(payload.get("revision"))
        if revision is None:
            return {"ok": False, "error": "revision_required"}
        if revision != current.revision:
            return {
                "ok": False,
                "error": "stale_revision",
                "currentRevision": current.revision,
            }
        try:
            if current.kind == "document_patch":
                if current.patch_payload is None:
                    return {"ok": False, "error": "document_patch_payload_missing"}
                patch = DocumentPatch.from_dict(current.patch_payload)
                _grant_accepted_patch(session, patch)
            session.record_artifact_accepted(artifact_id, revision=revision)
        except (RuntimeError, ValueError) as exc:
            return {"ok": False, "error": f"accept_rejected:{exc}"}
        accepted = _artifact(session, artifact_id)
        return {
            "ok": True,
            "artifact": _wire_artifact(session, accepted),
        }

    if action == "apply":
        revision = _integer(payload.get("revision"))
        if revision is None:
            return {"ok": False, "error": "revision_required"}
        if revision != current.revision:
            return {
                "ok": False,
                "error": "stale_revision",
                "currentRevision": current.revision,
            }
        if current.kind != "document_patch" or current.patch_payload is None:
            return {"ok": False, "error": "artifact_is_not_document_patch"}
        try:
            patch = DocumentPatch.from_dict(current.patch_payload)
        except ValueError as exc:
            return {"ok": False, "error": f"invalid_document_patch:{exc}"}
        if operation_backend is None:
            try:
                operation_backend = DocumentOperationBackend(
                    sources=task_sources(session.events),
                    artifact_id=artifact_id,
                    artifact_revision=revision,
                    figma=_FigmaRuntimeRouter(
                        payload.get("_figmaRuntimeConnections")
                    ),
                )
            except ValueError as exc:
                return {"ok": False, "error": f"invalid_figma_runtime:{exc}"}
        scope = scope_from_events(session.events, task_id=session.id)
        result = apply_document_patch(
            patch,
            current_artifact_revision=current.revision,
            accepted_revision=current.accepted_revision,
            authorize=lambda request: authorize_access(scope, request),
            read_current=operation_backend.read_current,
            execute=operation_backend.execute,
            state_probe=lambda: _fresh_artifact_state(
                store,
                session_id,
                artifact_id,
            ),
        )
        receipt = _receipt_for(result)
        session.record_receipt(receipt)
        registered_artifacts, registry_errors = _register_written_artifacts(
            store,
            session,
            patch,
            result,
            receipt,
        )
        result_data = result.to_dict()
        apply_event = {
            "artifactId": artifact_id,
            "artifactRevision": revision,
            "patchId": patch.patch_id,
            "receiptId": receipt.receipt_id,
            "result": result_data,
        }
        session.append("artifact/applied", apply_event)
        return {
            "ok": True,
            "result": result_data,
            "receipt": _wire_receipt(receipt),
            "registeredArtifacts": registered_artifacts,
            "artifactRegistryErrors": registry_errors,
        }

    return {"ok": False, "error": "invalid_action"}


def main() -> int:
    force_utf8_stdio()
    try:
        payload = read_bounded_json_payload()
        result = handle_request(payload)
    except (PayloadTooLargeError, ValueError) as exc:
        result = {"ok": False, "error": f"invalid_request:{exc}"}
    write_json(result)
    return 0 if result.get("ok") is True else 1


if __name__ == "__main__":
    raise SystemExit(main())
