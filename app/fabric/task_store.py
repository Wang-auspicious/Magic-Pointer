from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from app.fabric.agents import AgentInvocation, AgentRequest
from app.fabric.artifacts import ArtifactRegistry, ArtifactRegistryError
from app.fabric.target_lease import reconfirm_target_lease, validate_target_lease


class AgentTaskError(RuntimeError):
    pass


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def _process_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    if os.name == "nt":
        # os.kill(pid, 0) is not a pure existence probe on Windows. Some
        # Python 3.12 builds leave a chained exception pending for exited PIDs.
        try:
            import ctypes
            from ctypes import wintypes

            kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
            kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
            kernel32.OpenProcess.restype = wintypes.HANDLE
            kernel32.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
            kernel32.GetExitCodeProcess.restype = wintypes.BOOL
            kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
            kernel32.CloseHandle.restype = wintypes.BOOL
            process = kernel32.OpenProcess(0x1000, False, int(pid))
            if not process:
                return False
            try:
                exit_code = wintypes.DWORD()
                if not kernel32.GetExitCodeProcess(process, ctypes.byref(exit_code)):
                    return False
                return exit_code.value == 259  # STILL_ACTIVE
            finally:
                kernel32.CloseHandle(process)
        except (AttributeError, OSError, ValueError):
            return False
    try:
        os.kill(pid, 0)
        return True
    except (OSError, SystemError):
        return False


def _terminate_process(pid: int) -> None:
    os.kill(pid, signal.SIGTERM)


def _atomic_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    os.replace(temp, path)


class AgentTaskStore:
    def __init__(
        self,
        root: Path | str | None = None,
        *,
        spawn_worker: Callable[[Path], int] | None = None,
        process_alive: Callable[[int], bool] = _process_alive,
        terminate_process: Callable[[int], None] = _terminate_process,
        artifact_registry: ArtifactRegistry | None = None,
    ) -> None:
        default_root = Path(os.environ.get("MAGIC_POINTER_USER_DATA_DIR") or Path.cwd() / "data" / "runtime") / "agent-tasks"
        self.root = Path(root) if root is not None else default_root
        self.spawn_worker = spawn_worker or self._spawn_worker
        self.process_alive = process_alive
        self.terminate_process = terminate_process
        self.artifact_registry = artifact_registry
        if self.artifact_registry is None and self.root.name.casefold() == "agent-tasks":
            self.artifact_registry = ArtifactRegistry(self.root.parent)

    def _task_file(self, task_id: str) -> Path:
        if not task_id or any(char not in "0123456789abcdef-" for char in task_id.casefold()):
            raise AgentTaskError("invalid task id")
        return self.root / task_id / "task.json"

    def _spawn_worker(self, task_file: Path) -> int:
        script = Path(__file__).resolve().parents[2] / "scripts" / "agent_worker.py"
        kwargs: dict[str, Any] = {
            "cwd": str(task_file.parent),
            "stdin": subprocess.DEVNULL,
            "stdout": subprocess.DEVNULL,
            "stderr": subprocess.DEVNULL,
            "shell": False,
        }
        if os.name == "nt":
            kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW | subprocess.DETACHED_PROCESS
        else:
            kwargs["start_new_session"] = True
        return int(subprocess.Popen([sys.executable, str(script), str(task_file)], **kwargs).pid)

    def _read(self, task_id: str) -> dict[str, Any]:
        path = self._task_file(task_id)
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except FileNotFoundError as exc:
            raise AgentTaskError("unknown task id") from exc
        except (OSError, json.JSONDecodeError) as exc:
            raise AgentTaskError(f"corrupt task state: {type(exc).__name__}") from exc
        if not isinstance(value, dict) or value.get("schemaVersion") != 1 or value.get("taskId") != task_id:
            raise AgentTaskError("invalid task state")
        return value

    def _write(self, value: dict[str, Any]) -> None:
        _atomic_json(self._task_file(str(value["taskId"])), value)

    def _append_event(
        self,
        task_id: str,
        event_type: str,
        data: dict[str, Any] | None = None,
    ) -> None:
        event = {
            "timestamp": _now(),
            "type": str(event_type or "unknown")[:120],
            "data": dict(data or {}),
        }
        event_path = self._task_file(task_id).parent / "events.jsonl"
        event_path.parent.mkdir(parents=True, exist_ok=True)
        with event_path.open("a", encoding="utf-8", newline="\n") as handle:
            handle.write(json.dumps(event, ensure_ascii=False, separators=(",", ":")) + "\n")

    def start(self, request: AgentRequest, invocation: AgentInvocation) -> dict[str, Any]:
        task_id = str(uuid.uuid4())
        value = {
            "schemaVersion": 1,
            "taskId": task_id,
            "provider": request.provider,
            "status": "queued",
            "createdAt": _now(),
            "updatedAt": _now(),
            "workerPid": None,
            "agentPid": None,
            "exitCode": None,
            "error": None,
            "summary": None,
            "result": {},
            "cancelRequested": False,
            "attempt": 1,
            "request": request.to_dict(),
            "invocation": invocation.to_dict(),
        }
        self._write(value)
        try:
            value["workerPid"] = int(self.spawn_worker(self._task_file(task_id)))
        except Exception as exc:
            value["status"] = "failed"
            value["error"] = f"worker_spawn_failed:{type(exc).__name__}:{exc}"
        value["updatedAt"] = _now()
        self._write(value)
        self._append_event(task_id, "start", {
            "attempt": value["attempt"],
            "provider": request.provider,
            "status": value["status"],
        })
        return self._public(value)

    def _public(self, value: dict[str, Any]) -> dict[str, Any]:
        request = dict(value.get("request") or {})
        metadata = dict(request.get("metadata") or {})
        invocation = dict(value.get("invocation") or {})
        return {
            "taskId": value["taskId"],
            "provider": value["provider"],
            "status": value["status"],
            "createdAt": value["createdAt"],
            "updatedAt": value["updatedAt"],
            "workerPid": value.get("workerPid"),
            "agentPid": value.get("agentPid"),
            "exitCode": value.get("exitCode"),
            "error": value.get("error"),
            "summary": value.get("summary"),
            "result": dict(value.get("result") or {}),
            "cancelRequested": value.get("cancelRequested") is True,
            "attempt": int(value.get("attempt") or 1),
            "resumable": value.get("status") in {"failed", "interrupted"},
            "provenance": dict(value.get("provenance") or {}),
            "targetLease": dict(value.get("targetLease") or {}),
            "sessionId": str(request.get("session_id") or "") or None,
            "sessionStrategy": str(metadata.get("sessionStrategy") or "") or None,
            "sessionEvidence": dict(metadata.get("sessionEvidence") or {}),
            "contextPacket": dict(metadata.get("contextPacket") or {}),
            "transport": str(invocation.get("protocol") or ""),
        }

    @staticmethod
    def _artifact_candidates(value: Any, *, depth: int = 0) -> list[str]:
        if depth > 4:
            return []
        candidates: list[str] = []
        if isinstance(value, dict):
            for key, item in value.items():
                folded = str(key).casefold()
                if folded in {
                    "artifact",
                    "artifactpath",
                    "artifact_path",
                    "outputfile",
                    "output_file",
                    "files",
                    "artifacts",
                }:
                    if isinstance(item, str) and item.strip():
                        candidates.append(item.strip())
                    elif isinstance(item, list):
                        for child in item[:32]:
                            if isinstance(child, str) and child.strip():
                                candidates.append(child.strip())
                            elif isinstance(child, dict):
                                raw_path = child.get("path") or child.get("artifact")
                                if isinstance(raw_path, str) and raw_path.strip():
                                    candidates.append(raw_path.strip())
                elif isinstance(item, (dict, list)):
                    candidates.extend(AgentTaskStore._artifact_candidates(item, depth=depth + 1))
        elif isinstance(value, list):
            for item in value[:32]:
                candidates.extend(AgentTaskStore._artifact_candidates(item, depth=depth + 1))
        return list(dict.fromkeys(candidates))[:32]

    def _index_result_artifacts(self, value: dict[str, Any]) -> None:
        if self.artifact_registry is None or value.get("status") != "succeeded":
            return
        provenance = value.get("provenance")
        provenance = dict(provenance) if isinstance(provenance, dict) else {}
        if not provenance.get("planId") or not provenance.get("receiptId"):
            return
        result = value.get("result")
        result = dict(result) if isinstance(result, dict) else {}
        request = value.get("request")
        request = dict(request) if isinstance(request, dict) else {}
        workspace = str(request.get("cwd") or "").strip()
        if not workspace:
            return
        artifact_ids = [
            str(item)
            for item in result.get("artifactIds") or []
            if str(item)
        ]
        for raw_path in self._artifact_candidates(result):
            common = {
                "plan_id": str(provenance.get("planId") or ""),
                "receipt_id": str(provenance.get("receiptId") or ""),
                "task_id": str(value.get("taskId") or ""),
                "recipe_id": str(provenance.get("recipeId") or ""),
                "provider": str(value.get("provider") or ""),
                "source_object_ids": tuple(
                    str(item)
                    for item in provenance.get("sourceObjectIds") or []
                ),
            }
            try:
                indexed = self.artifact_registry.register(
                    raw_path,
                    retention_days=int(provenance.get("retentionDays") or 30),
                    **common,
                )
            except ArtifactRegistryError:
                try:
                    indexed = self.artifact_registry.register_reference(
                        raw_path,
                        allowed_roots=(workspace,),
                        **common,
                    )
                except ArtifactRegistryError:
                    continue
            artifact_id = str(indexed["artifactId"])
            if artifact_id not in artifact_ids:
                artifact_ids.append(artifact_id)
        if artifact_ids:
            result["artifactIds"] = artifact_ids[:32]
            value["result"] = result

    def status(self, task_id: str) -> dict[str, Any]:
        value = self._read(task_id)
        worker_pid = int(value.get("workerPid") or 0)
        agent_pid = int(value.get("agentPid") or 0)
        worker_alive = self.process_alive(worker_pid) if worker_pid else False
        agent_alive = self.process_alive(agent_pid) if agent_pid else False
        alive = worker_alive or agent_alive
        if value.get("status") == "cancelling" and not alive:
            value["status"] = "cancelled"
            value["error"] = None
            value["updatedAt"] = _now()
            self._write(value)
            self._append_event(task_id, "cancel_verified", {"status": "cancelled"})
        elif value.get("status") == "pausing_target_mismatch" and not alive:
            value["status"] = "paused_target_mismatch"
            guard = value.get("targetLease")
            guard = dict(guard) if isinstance(guard, dict) else {}
            guard["state"] = "reconfirmation_required"
            guard["confirmationRequired"] = True
            guard["pausedAt"] = _now()
            value["targetLease"] = guard
            value["updatedAt"] = _now()
            self._write(value)
            self._append_event(task_id, "target_lease_paused", {
                "reason": str(guard.get("reason") or "target_mismatch"),
            })
        elif value.get("status") in {"queued", "running"} and not worker_alive:
            value["status"] = "interrupted"
            value["error"] = value.get("error") or "worker_process_missing"
            value["updatedAt"] = _now()
            self._write(value)
            self._append_event(task_id, "interrupted", {"reason": value["error"]})
        public = self._public(value)
        public["alive"] = alive
        return public

    def mark_running(self, task_id: str, *, agent_pid: int) -> dict[str, Any]:
        value = self._read(task_id)
        if value["status"] not in {"queued", "running"}:
            return self._public(value)
        value["status"] = "running"
        value["agentPid"] = int(agent_pid)
        value["updatedAt"] = _now()
        self._write(value)
        return self._public(value)

    def complete(
        self,
        task_id: str,
        *,
        exit_code: int,
        summary: str,
        output: dict[str, Any] | None = None,
        error: str | None = None,
    ) -> dict[str, Any]:
        value = self._read(task_id)
        if value["status"] == "paused_target_mismatch":
            return self._public(value)
        if value["status"] in {"cancelled", "cancelling"} and value.get("cancelRequested") is True:
            value["status"] = "cancelled"
            value["error"] = None
            value["updatedAt"] = _now()
            self._write(value)
            return self._public(value)
        value["status"] = "succeeded" if exit_code == 0 and not error else "failed"
        value["exitCode"] = int(exit_code)
        value["summary"] = str(summary or "")[:4000]
        value["result"] = dict(output or {})
        value["error"] = None if value["status"] == "succeeded" else str(error or f"agent_exit_{exit_code}")[:2000]
        value["updatedAt"] = _now()
        self._index_result_artifacts(value)
        self._write(value)
        self._append_event(task_id, "completed", {
            "attempt": int(value.get("attempt") or 1),
            "status": value["status"],
            "exitCode": value["exitCode"],
        })
        return self._public(value)

    def link_provenance(
        self,
        task_id: str,
        *,
        plan_id: str,
        receipt_id: str,
        recipe_id: str,
        source_object_ids: tuple[str, ...] | list[str],
        retention_days: int,
        target_lease: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        value = self._read(task_id)
        value["provenance"] = {
            "planId": str(plan_id or ""),
            "receiptId": str(receipt_id or ""),
            "recipeId": str(recipe_id or ""),
            "sourceObjectIds": [
                str(item)
                for item in source_object_ids
                if str(item)
            ][:32],
            "retentionDays": max(0, min(int(retention_days), 3650)),
        }
        value["updatedAt"] = _now()
        if isinstance(target_lease, dict) and target_lease.get("schemaVersion") == 1:
            value["targetLease"] = {
                "state": "active",
                "reason": None,
                "confirmationRequired": False,
                "boundAt": _now(),
                "lastCheckedAt": None,
                "lease": dict(target_lease),
            }
        self._index_result_artifacts(value)
        self._write(value)
        self._append_event(task_id, "provenance_linked", {
            "planId": value["provenance"]["planId"],
            "receiptId": value["provenance"]["receiptId"],
            "sourceObjectCount": len(value["provenance"]["sourceObjectIds"]),
        })
        return self._public(value)

    def enforce_target_lease(
        self,
        task_id: str,
        *,
        live_windows: list[dict[str, Any]] | None,
        terminate: bool = True,
    ) -> dict[str, Any]:
        value = self._read(task_id)
        guard = value.get("targetLease")
        guard = dict(guard) if isinstance(guard, dict) else {}
        lease = guard.get("lease")
        lease = dict(lease) if isinstance(lease, dict) else None
        if lease is None or value.get("status") not in {"queued", "running"}:
            return self._public(value)
        validation = validate_target_lease(lease, live_windows=live_windows)
        guard["lastCheckedAt"] = _now()
        if validation.valid:
            guard["state"] = "active"
            guard["reason"] = None
            guard["confirmationRequired"] = False
            value["targetLease"] = guard
            value["updatedAt"] = _now()
            self._write(value)
            return self._public(value)

        value["status"] = "pausing_target_mismatch" if terminate else "paused_target_mismatch"
        value["error"] = None
        guard["state"] = "pausing" if terminate else "reconfirmation_required"
        guard["reason"] = validation.reason
        guard["confirmationRequired"] = not terminate
        value["targetLease"] = guard
        value["updatedAt"] = _now()
        self._write(value)
        self._append_event(task_id, "target_lease_pause_requested", {
            "reason": validation.reason,
            "leaseId": str(lease.get("leaseId") or ""),
        })
        if terminate:
            for key in ("agentPid", "workerPid"):
                pid = int(value.get(key) or 0)
                if pid and self.process_alive(pid):
                    try:
                        self.terminate_process(pid)
                    except OSError:
                        pass
            surviving = [
                int(value.get(key) or 0)
                for key in ("agentPid", "workerPid")
                if int(value.get(key) or 0) and self.process_alive(int(value.get(key) or 0))
            ]
            if not surviving:
                value["status"] = "paused_target_mismatch"
                guard["state"] = "reconfirmation_required"
                guard["confirmationRequired"] = True
                guard["pausedAt"] = _now()
                event_type = "target_lease_paused"
                event_data = {"reason": validation.reason}
            else:
                event_type = "target_lease_pause_pending"
                event_data = {"reason": validation.reason, "survivingPids": surviving}
            value["targetLease"] = guard
            value["updatedAt"] = _now()
            self._write(value)
            self._append_event(task_id, event_type, event_data)
        else:
            guard["pausedAt"] = _now()
            value["targetLease"] = guard
            value["updatedAt"] = _now()
            self._write(value)
            self._append_event(task_id, "target_lease_paused", {
                "reason": validation.reason,
            })
        return self._public(value)

    def reconfirm_target(
        self,
        task_id: str,
        *,
        confirmed_windows: list[dict[str, Any]],
    ) -> dict[str, Any]:
        value = self._read(task_id)
        guard = value.get("targetLease")
        guard = dict(guard) if isinstance(guard, dict) else {}
        lease = guard.get("lease")
        if value.get("status") != "paused_target_mismatch" or not isinstance(lease, dict):
            raise AgentTaskError("target_reconfirmation_not_required")
        try:
            renewed = reconfirm_target_lease(
                dict(lease),
                confirmed_windows=confirmed_windows,
            )
        except ValueError as exc:
            raise AgentTaskError(str(exc)) from exc
        value["attempt"] = int(value.get("attempt") or 1) + 1
        value["status"] = "queued"
        value["agentPid"] = None
        value["exitCode"] = None
        value["error"] = None
        value["summary"] = None
        value["result"] = {}
        value["cancelRequested"] = False
        guard.update({
            "state": "active",
            "reason": None,
            "confirmationRequired": False,
            "reconfirmedAt": _now(),
            "lastCheckedAt": _now(),
            "lease": renewed,
        })
        value["targetLease"] = guard
        try:
            value["workerPid"] = int(self.spawn_worker(self._task_file(task_id)))
        except Exception as exc:
            value["workerPid"] = None
            value["status"] = "failed"
            value["error"] = f"worker_spawn_failed:{type(exc).__name__}:{exc}"
        value["updatedAt"] = _now()
        self._write(value)
        self._append_event(task_id, "target_lease_reconfirmed", {
            "attempt": value["attempt"],
            "status": value["status"],
            "leaseId": str(renewed.get("leaseId") or ""),
            "previousLeaseId": str(renewed.get("previousLeaseId") or ""),
        })
        return self._public(value)

    def steer(self, task_id: str, message: str) -> dict[str, Any]:
        value = self._read(task_id)
        clean = str(message or "").strip()
        if not clean:
            raise AgentTaskError("steer message is empty")
        event = {"timestamp": _now(), "type": "steer", "message": clean[:12000]}
        event_path = self._task_file(task_id).parent / "events.jsonl"
        with event_path.open("a", encoding="utf-8", newline="\n") as handle:
            handle.write(json.dumps(event, ensure_ascii=False, separators=(",", ":")) + "\n")
        return {
            "taskId": task_id,
            "queued": value["status"] in {"queued", "running"},
            "deliveredLive": (value.get("invocation") or {}).get("protocol") == "jsonl-rpc",
            "status": value["status"],
        }

    def cancel(self, task_id: str) -> dict[str, Any]:
        value = self._read(task_id)
        if value["status"] in {"succeeded", "failed", "cancelled", "interrupted"}:
            return self._public(value)
        value["cancelRequested"] = True
        value["status"] = "cancelling"
        value["updatedAt"] = _now()
        self._write(value)
        self._append_event(task_id, "cancel_requested", {
            "agentPid": value.get("agentPid"),
            "workerPid": value.get("workerPid"),
        })
        requested_pids: list[int] = []
        for key in ("agentPid", "workerPid"):
            pid = int(value.get(key) or 0)
            if pid and pid not in requested_pids and self.process_alive(pid):
                requested_pids.append(pid)
                try:
                    self.terminate_process(pid)
                except OSError:
                    pass
        surviving = [pid for pid in requested_pids if self.process_alive(pid)]
        if surviving:
            value["status"] = "cancelling"
            value["error"] = "termination_not_verified"
            event_type = "cancel_pending"
            event_data = {"survivingPids": surviving}
        else:
            value["status"] = "cancelled"
            value["error"] = None
            event_type = "cancel_verified"
            event_data = {"status": "cancelled"}
        value["updatedAt"] = _now()
        self._write(value)
        self._append_event(task_id, event_type, event_data)
        return self._public(value)

    def list(self, *, limit: int = 100) -> list[dict[str, Any]]:
        if not self.root.exists():
            return []
        bounded = max(0, min(int(limit), 500))
        task_files = sorted(
            self.root.glob("*/task.json"),
            key=lambda path: path.stat().st_mtime,
            reverse=True,
        )
        results: list[dict[str, Any]] = []
        for task_file in task_files[:bounded]:
            try:
                results.append(self.status(task_file.parent.name))
            except AgentTaskError:
                continue
        return results

    def recover(self) -> list[dict[str, Any]]:
        return self.list(limit=500)

    def resume(self, task_id: str) -> dict[str, Any]:
        value = self._read(task_id)
        if value["status"] not in {"failed", "interrupted"}:
            raise AgentTaskError("task_not_resumable")
        value["attempt"] = int(value.get("attempt") or 1) + 1
        value["status"] = "queued"
        value["agentPid"] = None
        value["exitCode"] = None
        value["error"] = None
        value["summary"] = None
        value["result"] = {}
        value["cancelRequested"] = False
        try:
            value["workerPid"] = int(self.spawn_worker(self._task_file(task_id)))
        except Exception as exc:
            value["workerPid"] = None
            value["status"] = "failed"
            value["error"] = f"worker_spawn_failed:{type(exc).__name__}:{exc}"
        value["updatedAt"] = _now()
        self._write(value)
        self._append_event(task_id, "resume", {
            "attempt": value["attempt"],
            "status": value["status"],
        })
        return self._public(value)
