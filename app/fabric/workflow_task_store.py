from __future__ import annotations

import json
import os
import threading
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator


class WorkflowTaskError(RuntimeError):
    pass


_PROCESS_LOCKS: dict[str, threading.RLock] = {}
_PROCESS_LOCKS_GUARD = threading.Lock()
_SURFACES = {"cli", "gui"}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


class WorkflowTaskStore:
    """Durable, cross-surface execution gate for signed Fabric plans.

    The complete plan and receipt stay on disk; the public projection exposes
    only operational metadata. Every mutation is serialized across processes so
    CLI and GUI cannot both claim the same plan.
    """

    def __init__(self, root: Path | str) -> None:
        self.root = Path(root)

    @staticmethod
    def _surface(value: str) -> str:
        surface = str(value or "").strip().casefold()
        if surface not in _SURFACES:
            raise WorkflowTaskError("invalid workflow surface")
        return surface

    def _task_path(self, task_id: str) -> Path:
        clean = str(task_id or "").strip().casefold()
        if not clean or any(char not in "0123456789abcdef-" for char in clean):
            raise WorkflowTaskError("invalid workflow task id")
        return self.root / clean / "task.json"

    @contextmanager
    def _mutation_lock(self) -> Iterator[None]:
        self.root.mkdir(parents=True, exist_ok=True)
        lock_path = self.root / ".workflow.lock"
        lock_key = str(lock_path.resolve()).casefold()
        with _PROCESS_LOCKS_GUARD:
            process_lock = _PROCESS_LOCKS.setdefault(lock_key, threading.RLock())
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

    def _read(self, task_id: str) -> dict[str, Any]:
        path = self._task_path(task_id)
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except FileNotFoundError as exc:
            raise WorkflowTaskError("unknown workflow task id") from exc
        except (OSError, json.JSONDecodeError) as exc:
            raise WorkflowTaskError("invalid workflow task state") from exc
        required = {
            "schemaVersion", "taskId", "idempotencyKey", "recipeId", "plan",
            "approvalState", "executionState", "surfaceHistory", "createdAt", "updatedAt",
        }
        if (
            not isinstance(value, dict)
            or value.get("schemaVersion") != 1
            or value.get("taskId") != str(task_id).casefold()
            or not required.issubset(value)
            or not isinstance(value.get("plan"), dict)
            or not isinstance(value.get("surfaceHistory"), list)
            or value.get("approvalState") not in {"pending", "not_required", "approved"}
            or value.get("executionState") not in {"idle", "running", "terminal"}
        ):
            raise WorkflowTaskError("invalid workflow task state")
        return value

    def _write(self, value: dict[str, Any]) -> None:
        path = self._task_path(str(value.get("taskId") or ""))
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(f".json.{uuid.uuid4().hex}.tmp")
        try:
            with temporary.open("w", encoding="utf-8", newline="\n") as handle:
                json.dump(value, handle, ensure_ascii=False, indent=2)
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, path)
        except OSError as exc:
            raise WorkflowTaskError(f"could not persist workflow task: {type(exc).__name__}") from exc
        finally:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass

    @staticmethod
    def _touch_surface(value: dict[str, Any], surface: str) -> None:
        history = [str(item) for item in value.get("surfaceHistory") or [] if str(item) in _SURFACES]
        if not history or history[-1] != surface:
            history.append(surface)
        value["surfaceHistory"] = history[-20:]
        value["lastSurface"] = surface
        value["updatedAt"] = _now()

    @staticmethod
    def _status(value: dict[str, Any]) -> str:
        if value["executionState"] == "running":
            return "running"
        if value["executionState"] == "terminal":
            receipt = value.get("receipt") if isinstance(value.get("receipt"), dict) else {}
            return str(receipt.get("status") or "terminal")
        if value["approvalState"] == "pending":
            return "approval_required"
        return "ready"

    def _public(self, value: dict[str, Any], *, reused: bool = False) -> dict[str, Any]:
        preview = value.get("plan", {}).get("preview")
        preview = preview if isinstance(preview, dict) else {}
        receipt = value.get("receipt") if isinstance(value.get("receipt"), dict) else {}
        return {
            "taskId": value["taskId"],
            "recipeId": value["recipeId"],
            "title": str(preview.get("title") or value["recipeId"]),
            "status": self._status(value),
            "approvalState": value["approvalState"],
            "executionState": value["executionState"],
            "receiptStatus": str(receipt.get("status") or "") or None,
            "createdAt": value["createdAt"],
            "updatedAt": value["updatedAt"],
            "lastSurface": value.get("lastSurface"),
            "surfaceHistory": list(value["surfaceHistory"]),
            "reused": reused,
        }

    def _find_by_idempotency_key(self, key: str) -> dict[str, Any] | None:
        for path in sorted(self.root.glob("*/task.json")):
            try:
                value = self._read(path.parent.name)
            except WorkflowTaskError:
                continue
            if value["idempotencyKey"] == key:
                return value
        return None

    def create(self, plan: dict[str, Any], *, surface: str) -> dict[str, Any]:
        surface = self._surface(surface)
        if not isinstance(plan, dict):
            raise WorkflowTaskError("workflow plan must be an object")
        key = str(plan.get("idempotencyKey") or "").strip()
        recipe_id = str(plan.get("recipeId") or "").strip()
        if not key or not recipe_id or not plan.get("id") or not plan.get("integrityToken"):
            raise WorkflowTaskError("workflow plan is incomplete or unsigned")
        with self._mutation_lock():
            existing = self._find_by_idempotency_key(key)
            if existing is not None:
                if existing["recipeId"] != recipe_id:
                    raise WorkflowTaskError("workflow idempotency collision")
                self._touch_surface(existing, surface)
                self._write(existing)
                return self._public(existing, reused=True)
            task_id = str(uuid.uuid4())
            stamp = _now()
            value = {
                "schemaVersion": 1,
                "taskId": task_id,
                "idempotencyKey": key,
                "recipeId": recipe_id,
                "plan": dict(plan),
                "approvalState": "pending" if plan.get("requiresConfirmation") is True else "not_required",
                "executionState": "idle",
                "executionClaim": None,
                "receipt": None,
                "surfaceHistory": [surface],
                "lastSurface": surface,
                "createdAt": stamp,
                "updatedAt": stamp,
            }
            self._write(value)
            return self._public(value)

    def get(self, task_id: str, *, surface: str) -> dict[str, Any]:
        surface = self._surface(surface)
        with self._mutation_lock():
            value = self._read(task_id)
            self._touch_surface(value, surface)
            self._write(value)
            return self._public(value)

    def list(self, *, surface: str, limit: int = 100) -> list[dict[str, Any]]:
        surface = self._surface(surface)
        with self._mutation_lock():
            values: list[dict[str, Any]] = []
            paths = sorted(
                self.root.glob("*/task.json"),
                key=lambda item: item.stat().st_mtime_ns,
                reverse=True,
            )
            for path in paths[:max(1, min(int(limit), 500))]:
                value = self._read(path.parent.name)
                self._touch_surface(value, surface)
                self._write(value)
                values.append(self._public(value))
            return values

    def approve(self, task_id: str, *, surface: str) -> dict[str, Any]:
        surface = self._surface(surface)
        with self._mutation_lock():
            value = self._read(task_id)
            if value["executionState"] != "idle":
                raise WorkflowTaskError("workflow approval is already closed")
            if value["approvalState"] == "pending":
                value["approvalState"] = "approved"
                value["approvedAt"] = _now()
                value["approvedSurface"] = surface
            self._touch_surface(value, surface)
            self._write(value)
            return self._public(value)

    def claim_execution(self, task_id: str, *, surface: str) -> dict[str, Any]:
        surface = self._surface(surface)
        with self._mutation_lock():
            value = self._read(task_id)
            self._touch_surface(value, surface)
            if value["approvalState"] == "pending":
                self._write(value)
                return {"claimed": False, "reason": "approval_required", "task": self._public(value)}
            if value["executionState"] == "running":
                self._write(value)
                return {"claimed": False, "reason": "execution_in_progress", "task": self._public(value)}
            if value["executionState"] == "terminal":
                self._write(value)
                return {
                    "claimed": False,
                    "reused": True,
                    "reason": "terminal_receipt_reused",
                    "task": self._public(value, reused=True),
                    "receipt": dict(value.get("receipt") or {}),
                }
            claim_id = str(uuid.uuid4())
            value["executionState"] = "running"
            value["executionClaim"] = {"claimId": claim_id, "surface": surface, "claimedAt": _now()}
            self._write(value)
            return {"claimed": True, "claimId": claim_id, "task": self._public(value)}

    def plan_for_claim(self, task_id: str, *, claim_id: str) -> dict[str, Any]:
        with self._mutation_lock():
            value = self._read(task_id)
            claim = value.get("executionClaim") if isinstance(value.get("executionClaim"), dict) else {}
            if value["executionState"] != "running" or claim.get("claimId") != claim_id:
                raise WorkflowTaskError("invalid workflow execution claim")
            return dict(value["plan"])

    def complete_execution(
        self,
        task_id: str,
        *,
        claim_id: str,
        receipt: dict[str, Any],
        surface: str,
    ) -> dict[str, Any]:
        surface = self._surface(surface)
        if not isinstance(receipt, dict) or not receipt.get("id") or not receipt.get("status"):
            raise WorkflowTaskError("invalid workflow execution receipt")
        with self._mutation_lock():
            value = self._read(task_id)
            claim = value.get("executionClaim") if isinstance(value.get("executionClaim"), dict) else {}
            if value["executionState"] != "running" or claim.get("claimId") != claim_id:
                raise WorkflowTaskError("invalid workflow execution claim")
            value["executionState"] = "terminal"
            value["executionClaim"] = None
            value["receipt"] = dict(receipt)
            value["completedAt"] = _now()
            self._touch_surface(value, surface)
            self._write(value)
            return self._public(value)
