from __future__ import annotations

import hashlib
import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable

from app.fabric.schema import OperationPlan


class ArtifactRegistryError(RuntimeError):
    pass


def _now(value: datetime | None = None) -> datetime:
    current = value or datetime.now(timezone.utc)
    return current if current.tzinfo is not None else current.replace(tzinfo=timezone.utc)


def _timestamp(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat(timespec="milliseconds")


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while True:
            chunk = handle.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


class ArtifactRegistry:
    """Local provenance index and recoverable retention for app-owned files."""

    def __init__(self, root: Path | str) -> None:
        self.root = Path(root).expanduser().resolve()
        self.index_path = self.root / "artifact-index.jsonl"
        self.trash_root = self.root / "artifact-trash"

    def _managed_path(self, value: Path | str) -> Path:
        path = Path(value).expanduser().resolve()
        try:
            path.relative_to(self.root)
        except ValueError as exc:
            raise ArtifactRegistryError("artifact_outside_managed_root") from exc
        return path

    def _managed_artifact_path(self, value: Path | str) -> Path:
        path = self._managed_path(value)
        relative = path.relative_to(self.root)
        if not relative.parts or relative.parts[0].casefold() not in {
            "artifacts",
            "evidence",
            "context",
            "review",
        }:
            raise ArtifactRegistryError("artifact_outside_managed_directory")
        return path

    def _managed_trash_path(self, value: Path | str) -> Path:
        path = self._managed_path(value)
        try:
            path.relative_to(self.trash_root.resolve())
        except ValueError as exc:
            raise ArtifactRegistryError("artifact_outside_trash") from exc
        return path

    def _append(self, value: dict[str, Any]) -> None:
        self.index_path.parent.mkdir(parents=True, exist_ok=True)
        with self.index_path.open("a", encoding="utf-8", newline="\n") as handle:
            handle.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")

    def _latest(self) -> dict[str, dict[str, Any]]:
        if not self.index_path.exists():
            return {}
        items: dict[str, dict[str, Any]] = {}
        with self.index_path.open("r", encoding="utf-8", errors="replace") as handle:
            for line in handle:
                try:
                    value = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(value, dict) and str(value.get("artifactId") or ""):
                    items[str(value["artifactId"])] = value
        return items

    def register(
        self,
        path: Path | str,
        *,
        plan_id: str,
        receipt_id: str,
        task_id: str = "",
        recipe_id: str = "",
        provider: str = "",
        source_object_ids: Iterable[str] = (),
        kind: str = "",
        retention_days: int = 30,
        now: datetime | None = None,
    ) -> dict[str, Any]:
        artifact = self._managed_artifact_path(path)
        if not artifact.is_file():
            raise ArtifactRegistryError("artifact_file_missing")
        current = _now(now)
        days = max(0, min(int(retention_days), 3650))
        normalized_path = str(artifact).casefold()
        artifact_id = "artifact-" + hashlib.sha256(
            normalized_path.encode("utf-8")
        ).hexdigest()[:24]
        value = {
            "schemaVersion": 1,
            "artifactId": artifact_id,
            "state": "active",
            "managed": True,
            "kind": str(kind or artifact.suffix.lstrip(".") or "file")[:80],
            "path": str(artifact),
            "trashPath": "",
            "sha256": _sha256_file(artifact),
            "sizeBytes": artifact.stat().st_size,
            "createdAt": _timestamp(current),
            "updatedAt": _timestamp(current),
            "expiresAt": _timestamp(current + timedelta(days=days)),
            "retentionDays": days,
            "planId": str(plan_id or ""),
            "receiptId": str(receipt_id or ""),
            "taskId": str(task_id or ""),
            "recipeId": str(recipe_id or ""),
            "provider": str(provider or ""),
            "sourceObjectIds": [
                str(item)
                for item in source_object_ids
                if str(item)
            ][:32],
        }
        self._append(value)
        return dict(value)

    def register_reference(
        self,
        path: Path | str,
        *,
        allowed_roots: Iterable[Path | str],
        plan_id: str,
        receipt_id: str,
        task_id: str = "",
        recipe_id: str = "",
        provider: str = "",
        source_object_ids: Iterable[str] = (),
        kind: str = "",
        now: datetime | None = None,
    ) -> dict[str, Any]:
        artifact = Path(path).expanduser().resolve()
        roots = [Path(item).expanduser().resolve() for item in allowed_roots]
        allowed = False
        for root in roots:
            try:
                artifact.relative_to(root)
            except ValueError:
                continue
            allowed = True
            break
        if not allowed:
            raise ArtifactRegistryError("artifact_reference_outside_workspace")
        if not artifact.is_file():
            raise ArtifactRegistryError("artifact_file_missing")
        current = _now(now)
        artifact_id = "artifact-" + hashlib.sha256(
            str(artifact).casefold().encode("utf-8")
        ).hexdigest()[:24]
        value = {
            "schemaVersion": 1,
            "artifactId": artifact_id,
            "state": "external",
            "managed": False,
            "kind": str(kind or artifact.suffix.lstrip(".") or "file")[:80],
            "path": str(artifact),
            "trashPath": "",
            "sha256": _sha256_file(artifact),
            "sizeBytes": artifact.stat().st_size,
            "createdAt": _timestamp(current),
            "updatedAt": _timestamp(current),
            "expiresAt": "",
            "retentionDays": 0,
            "planId": str(plan_id or ""),
            "receiptId": str(receipt_id or ""),
            "taskId": str(task_id or ""),
            "recipeId": str(recipe_id or ""),
            "provider": str(provider or ""),
            "sourceObjectIds": [
                str(item)
                for item in source_object_ids
                if str(item)
            ][:32],
        }
        self._append(value)
        return dict(value)

    def register_receipt(
        self,
        plan: OperationPlan,
        receipt: dict[str, Any],
        *,
        retention_days: int,
        now: datetime | None = None,
    ) -> list[dict[str, Any]]:
        output = receipt.get("output")
        output = dict(output) if isinstance(output, dict) else {}
        candidates: list[tuple[str, str]] = []
        for key in ("artifact", "contextPacketArtifact"):
            value = str(output.get(key) or "").strip()
            if value:
                candidates.append((value, "context_packet" if key == "contextPacketArtifact" else ""))
        raw_artifacts = output.get("artifacts")
        if isinstance(raw_artifacts, list):
            candidates.extend((str(item), "") for item in raw_artifacts if str(item).strip())
        registered: list[dict[str, Any]] = []
        seen: set[str] = set()
        for raw_path, kind in candidates:
            try:
                artifact = self._managed_artifact_path(raw_path)
            except ArtifactRegistryError:
                continue
            normalized = str(artifact).casefold()
            if normalized in seen or not artifact.is_file():
                continue
            seen.add(normalized)
            registered.append(self.register(
                artifact,
                plan_id=plan.id,
                receipt_id=str(receipt.get("id") or ""),
                task_id=str(output.get("taskId") or ""),
                recipe_id=plan.recipe_id,
                provider=plan.provider,
                source_object_ids=plan.object_ids,
                kind=kind,
                retention_days=retention_days,
                now=now,
            ))
        return registered

    def list(self, *, limit: int = 100) -> list[dict[str, Any]]:
        items = list(self._latest().values())
        items.sort(key=lambda item: str(item.get("updatedAt") or ""), reverse=True)
        return [dict(item) for item in items[:max(0, min(int(limit), 500))]]

    def get(self, artifact_id: str) -> dict[str, Any]:
        value = self._latest().get(str(artifact_id or ""))
        if value is None:
            raise ArtifactRegistryError("artifact_not_found")
        return dict(value)

    def cleanup_expired(
        self,
        *,
        confirmed: bool,
        now: datetime | None = None,
    ) -> dict[str, Any]:
        current = _now(now)
        candidates: list[dict[str, Any]] = []
        for item in self.list(limit=500):
            if item.get("state") != "active":
                continue
            try:
                expires = datetime.fromisoformat(
                    str(item.get("expiresAt") or "").replace("Z", "+00:00")
                )
            except ValueError:
                continue
            if expires <= current:
                candidates.append(item)
        candidate_ids = [str(item["artifactId"]) for item in candidates]
        if not confirmed:
            return {
                "status": "confirmation_required",
                "candidateArtifactIds": candidate_ids,
                "candidateCount": len(candidate_ids),
            }
        trashed: list[str] = []
        missing: list[str] = []
        for item in candidates:
            artifact_id = str(item["artifactId"])
            source = self._managed_artifact_path(str(item.get("path") or ""))
            updated = dict(item)
            updated["updatedAt"] = _timestamp(current)
            if not source.is_file():
                updated["state"] = "missing"
                self._append(updated)
                missing.append(artifact_id)
                continue
            destination = self._managed_trash_path(
                self.trash_root / artifact_id / source.name
            )
            destination.parent.mkdir(parents=True, exist_ok=True)
            if destination.exists():
                raise ArtifactRegistryError("artifact_trash_collision")
            os.replace(source, destination)
            updated["state"] = "trashed"
            updated["trashPath"] = str(destination)
            self._append(updated)
            trashed.append(artifact_id)
        return {
            "status": "trashed",
            "trashedArtifactIds": trashed,
            "missingArtifactIds": missing,
        }

    def restore(
        self,
        artifact_id: str,
        *,
        now: datetime | None = None,
    ) -> dict[str, Any]:
        item = self.get(artifact_id)
        if item.get("state") != "trashed":
            raise ArtifactRegistryError("artifact_not_trashed")
        source = self._managed_trash_path(str(item.get("trashPath") or ""))
        destination = self._managed_artifact_path(str(item.get("path") or ""))
        if not source.is_file():
            raise ArtifactRegistryError("trashed_artifact_missing")
        if destination.exists():
            raise ArtifactRegistryError("artifact_restore_collision")
        destination.parent.mkdir(parents=True, exist_ok=True)
        os.replace(source, destination)
        current = _now(now)
        updated = dict(item)
        updated.update({
            "state": "active",
            "trashPath": "",
            "updatedAt": _timestamp(current),
            "expiresAt": _timestamp(
                current + timedelta(days=int(item.get("retentionDays") or 0))
            ),
        })
        self._append(updated)
        return updated
