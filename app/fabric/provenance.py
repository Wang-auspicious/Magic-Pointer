from __future__ import annotations

import json
import os
import threading
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

from app.fabric.artifacts import ArtifactRegistry
from app.fabric.schema import OperationPlan
from app.fabric.task_store import AgentTaskStore


class ProvenanceError(RuntimeError):
    pass


_PROCESS_LOCKS: dict[str, threading.RLock] = {}
_PROCESS_LOCKS_GUARD = threading.Lock()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


class ProvenanceIndex:
    """Local reverse index from pointed objects to executions and outputs."""

    def __init__(self, root: Path | str) -> None:
        self.root = Path(root).expanduser().resolve()
        self.path = self.root / "provenance-executions.jsonl"
        self.artifacts = ArtifactRegistry(self.root)
        self.tasks = AgentTaskStore(self.root / "agent-tasks")

    @contextmanager
    def _lock(self) -> Iterator[None]:
        self.root.mkdir(parents=True, exist_ok=True)
        lock_path = self.path.with_suffix(".jsonl.lock")
        key = str(lock_path.resolve()).casefold()
        with _PROCESS_LOCKS_GUARD:
            process_lock = _PROCESS_LOCKS.setdefault(key, threading.RLock())
        with process_lock, lock_path.open("a+b") as handle:
            handle.seek(0, os.SEEK_END)
            if handle.tell() == 0:
                handle.write(b"\0")
                handle.flush()
            handle.seek(0)
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(handle.fileno(), msvcrt.LK_LOCK, 1)
            else:
                import fcntl

                fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                handle.seek(0)
                if os.name == "nt":
                    msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    fcntl.flock(handle.fileno(), fcntl.LOCK_UN)

    @staticmethod
    def _object(value: dict[str, Any], fallback_id: str) -> dict[str, Any]:
        source = value.get("source")
        source = dict(source) if isinstance(source, dict) else {}
        bbox = value.get("bbox")
        bbox = list(bbox)[:4] if isinstance(bbox, (list, tuple)) else None
        return {
            "objectId": str(value.get("id") or value.get("objectId") or fallback_id),
            "referenceLabel": str(value.get("referenceLabel") or "")[:24],
            "kind": str(value.get("kind") or "object")[:120],
            "label": str(value.get("label") or value.get("name") or fallback_id)[:300],
            "bbox": bbox,
            "source": {
                "app": str(source.get("app") or "")[:260],
                "title": str(source.get("title") or "")[:500],
            },
        }

    def record_execution(self, plan: OperationPlan, receipt: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(receipt, dict) or not receipt.get("id"):
            raise ProvenanceError("execution receipt id is required")
        raw_objects = [dict(item) for item in plan.parameters.get("objects") or [] if isinstance(item, dict)]
        by_id = {
            str(item.get("id") or item.get("objectId") or ""): item
            for item in raw_objects
            if str(item.get("id") or item.get("objectId") or "")
        }
        objects = [self._object(by_id.get(object_id, {}), object_id) for object_id in plan.object_ids]
        output = receipt.get("output")
        output = dict(output) if isinstance(output, dict) else {}
        value = {
            "schemaVersion": 1,
            "eventId": str(uuid.uuid4()),
            "timestamp": _now(),
            "planId": plan.id,
            "receiptId": str(receipt.get("id") or ""),
            "taskId": str(output.get("taskId") or ""),
            "recipeId": plan.recipe_id,
            "provider": plan.provider,
            "status": str(receipt.get("status") or ""),
            "objects": objects,
        }
        with self._lock():
            with self.path.open("a", encoding="utf-8", newline="\n") as handle:
                handle.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")
                handle.flush()
                os.fsync(handle.fileno())
        return dict(value)

    def _records(self) -> list[dict[str, Any]]:
        if not self.path.exists():
            return []
        values: list[dict[str, Any]] = []
        with self._lock():
            with self.path.open("r", encoding="utf-8", errors="replace") as handle:
                for line in handle:
                    try:
                        value = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if (
                        isinstance(value, dict)
                        and value.get("schemaVersion") == 1
                        and isinstance(value.get("objects"), list)
                    ):
                        values.append(value)
        return values

    def objects(self, *, limit: int = 200) -> list[dict[str, Any]]:
        latest: dict[str, dict[str, Any]] = {}
        for record in self._records():
            for item in record["objects"]:
                if not isinstance(item, dict) or not str(item.get("objectId") or ""):
                    continue
                object_id = str(item["objectId"])
                latest[object_id] = {
                    **dict(item),
                    "lastPlanId": str(record.get("planId") or ""),
                    "lastTaskId": str(record.get("taskId") or ""),
                    "lastStatus": str(record.get("status") or ""),
                    "updatedAt": str(record.get("timestamp") or ""),
                }
        items = sorted(latest.values(), key=lambda item: item["updatedAt"], reverse=True)
        return items[:max(0, min(int(limit), 500))]

    @staticmethod
    def _link_kind(artifact: dict[str, Any]) -> str:
        path = Path(str(artifact.get("path") or ""))
        kind = str(artifact.get("kind") or "").casefold()
        suffix = path.suffix.casefold()
        if suffix in {".diff", ".patch"} or kind in {"diff", "patch"}:
            return "diff"
        if suffix in {".html", ".htm"} or kind in {"html", "page", "webpage"}:
            return "page"
        return "artifact"

    def trace(self, object_id: str) -> dict[str, Any]:
        object_id = str(object_id or "").strip()
        if not object_id:
            raise ProvenanceError("object id is required")
        records = [
            record for record in self._records()
            if any(
                isinstance(item, dict) and str(item.get("objectId") or "") == object_id
                for item in record["objects"]
            )
        ]
        artifacts = [
            item for item in self.artifacts.list(limit=500)
            if object_id in [str(value) for value in item.get("sourceObjectIds") or []]
        ]
        tasks = [
            item for item in self.tasks.list(limit=500)
            if object_id in [
                str(value) for value in (item.get("provenance") or {}).get("sourceObjectIds") or []
            ]
        ]
        if not records and not artifacts and not tasks:
            raise ProvenanceError("object provenance not found")
        object_value = next((
            dict(item)
            for record in reversed(records)
            for item in record["objects"]
            if isinstance(item, dict) and str(item.get("objectId") or "") == object_id
        ), {"objectId": object_id, "referenceLabel": "", "kind": "object", "label": object_id, "bbox": None, "source": {}})
        return {
            "object": object_value,
            "plans": [{
                "planId": str(record.get("planId") or ""),
                "receiptId": str(record.get("receiptId") or ""),
                "taskId": str(record.get("taskId") or ""),
                "recipeId": str(record.get("recipeId") or ""),
                "provider": str(record.get("provider") or ""),
                "status": str(record.get("status") or ""),
                "timestamp": str(record.get("timestamp") or ""),
            } for record in reversed(records[-100:])],
            "tasks": [{
                "taskId": item.get("taskId"),
                "provider": item.get("provider"),
                "status": item.get("status"),
                "artifactIds": list((item.get("result") or {}).get("artifactIds") or []),
                "updatedAt": item.get("updatedAt"),
            } for item in tasks],
            "artifacts": [{
                "artifactId": item.get("artifactId"),
                "linkKind": self._link_kind(item),
                "kind": item.get("kind"),
                "state": item.get("state"),
                "path": item.get("path"),
                "taskId": item.get("taskId"),
                "planId": item.get("planId"),
                "receiptId": item.get("receiptId"),
                "sourceObjectIds": list(item.get("sourceObjectIds") or []),
                "sha256": item.get("sha256"),
            } for item in artifacts],
        }
