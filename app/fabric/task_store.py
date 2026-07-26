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


class AgentTaskError(RuntimeError):
    pass


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def _process_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except OSError:
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
    ) -> None:
        default_root = Path(os.environ.get("MAGIC_POINTER_USER_DATA_DIR") or Path.cwd() / "data" / "runtime") / "agent-tasks"
        self.root = Path(root) if root is not None else default_root
        self.spawn_worker = spawn_worker or self._spawn_worker
        self.process_alive = process_alive
        self.terminate_process = terminate_process

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
        return self._public(value)

    def _public(self, value: dict[str, Any]) -> dict[str, Any]:
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
        }

    def status(self, task_id: str) -> dict[str, Any]:
        value = self._read(task_id)
        alive_pid = int(value.get("workerPid") or 0)
        alive = self.process_alive(alive_pid) if alive_pid else False
        if value.get("status") in {"queued", "running", "cancelling"} and not alive:
            value["status"] = "interrupted"
            value["error"] = value.get("error") or "worker_process_missing"
            value["updatedAt"] = _now()
            self._write(value)
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
        value["status"] = "succeeded" if exit_code == 0 and not error else "failed"
        value["exitCode"] = int(exit_code)
        value["summary"] = str(summary or "")[:4000]
        value["result"] = dict(output or {})
        value["error"] = None if value["status"] == "succeeded" else str(error or f"agent_exit_{exit_code}")[:2000]
        value["updatedAt"] = _now()
        self._write(value)
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
        for key in ("agentPid", "workerPid"):
            pid = int(value.get(key) or 0)
            if pid and self.process_alive(pid):
                try:
                    self.terminate_process(pid)
                except OSError:
                    pass
        value["status"] = "cancelled"
        value["updatedAt"] = _now()
        self._write(value)
        return self._public(value)
