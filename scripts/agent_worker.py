from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.fabric.agents import AgentInvocation, AgentRequest
from app.fabric.task_store import AgentTaskStore


def _tail(path: Path, limit: int = 120_000) -> str:
    try:
        raw = path.read_bytes()
    except OSError:
        return ""
    return raw[-limit:].decode("utf-8", errors="replace")


def _extract_result(stdout: str, protocol: str) -> dict[str, Any]:
    if protocol not in {"json", "jsonl"}:
        return {"outputExcerpt": stdout[-8000:]}
    values: list[Any] = []
    for line in stdout.splitlines():
        try:
            values.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    if protocol == "json" and not values:
        try:
            values = [json.loads(stdout)]
        except json.JSONDecodeError:
            pass
    terminal = values[-1] if values else None
    result: dict[str, Any] = {"eventCount": len(values), "outputExcerpt": stdout[-8000:]}
    if isinstance(terminal, dict):
        result["terminalEvent"] = terminal
        session_id = terminal.get("session_id") or terminal.get("sessionId")
        if session_id:
            result["sessionId"] = str(session_id)
    return result


def _queued_events(path: Path, offset: int) -> tuple[list[dict[str, Any]], int]:
    if not path.exists():
        return [], offset
    with path.open("r", encoding="utf-8") as handle:
        handle.seek(offset)
        lines = handle.readlines()
        next_offset = handle.tell()
    values: list[dict[str, Any]] = []
    for line in lines:
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            values.append(value)
    return values, next_offset


def _run_pi_rpc(
    *,
    store: AgentTaskStore,
    task_id: str,
    request: AgentRequest,
    invocation: AgentInvocation,
    stdout_path: Path,
    stderr_path: Path,
    env: dict[str, str],
) -> int:
    events_path = stdout_path.parent / "events.jsonl"
    settled = threading.Event()
    event_count = 0
    last_event: dict[str, Any] | None = None
    write_lock = threading.Lock()

    with stdout_path.open("wb") as stdout_handle, stderr_path.open("wb") as stderr_handle:
        child = subprocess.Popen(
            list(invocation.argv),
            cwd=invocation.cwd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=stderr_handle,
            env=env,
            shell=False,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        store.mark_running(task_id, agent_pid=child.pid)

        def send(value: dict[str, Any]) -> None:
            if child.stdin is None:
                raise RuntimeError("Pi RPC stdin is unavailable")
            raw = (json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
            with write_lock:
                child.stdin.write(raw)
                child.stdin.flush()

        def read_stdout() -> None:
            nonlocal event_count, last_event
            if child.stdout is None:
                return
            for raw in iter(child.stdout.readline, b""):
                stdout_handle.write(raw)
                stdout_handle.flush()
                try:
                    value = json.loads(raw.decode("utf-8"))
                except (UnicodeDecodeError, json.JSONDecodeError):
                    continue
                if isinstance(value, dict):
                    event_count += 1
                    last_event = value
                    if value.get("type") == "agent_settled":
                        settled.set()

        reader = threading.Thread(target=read_stdout, name=f"pi-rpc-{task_id}", daemon=True)
        reader.start()
        send({"id": "initial", "type": "prompt", "message": request.prompt})

        offset = 0
        settled_at: float | None = None
        while child.poll() is None:
            queued, offset = _queued_events(events_path, offset)
            if queued:
                settled.clear()
                settled_at = None
                for event in queued:
                    if event.get("type") != "steer":
                        continue
                    send({
                        "type": "prompt",
                        "message": str(event.get("message") or ""),
                        "streamingBehavior": "steer",
                    })
            if settled.is_set():
                settled_at = settled_at or time.monotonic()
                if time.monotonic() - settled_at >= 0.75:
                    break
            time.sleep(0.1)

        try:
            if child.stdin is not None:
                child.stdin.close()
        except OSError:
            pass
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            child.terminate()
            child.wait(timeout=5)
        reader.join(timeout=2)

    current = json.loads((stdout_path.parent / "task.json").read_text(encoding="utf-8"))
    if current.get("status") == "cancelled":
        return 0
    stdout = _tail(stdout_path)
    stderr = _tail(stderr_path)
    if not settled.is_set():
        store.complete(
            task_id,
            exit_code=int(child.returncode or 1),
            summary=(stdout or stderr)[-4000:],
            output={"eventCount": event_count, "terminalEvent": last_event},
            error=f"pi_rpc_exit_{child.returncode}",
        )
        return int(child.returncode or 1)
    store.complete(
        task_id,
        exit_code=0,
        summary=(stdout or "Pi background task settled")[-4000:],
        output={
            "eventCount": event_count,
            "terminalEvent": last_event,
            "protocol": "jsonl-rpc",
            "steering": "live",
        },
    )
    return 0


def main() -> int:
    if len(sys.argv) != 2:
        return 2
    task_file = Path(sys.argv[1]).resolve()
    payload = json.loads(task_file.read_text(encoding="utf-8"))
    task_id = str(payload["taskId"])
    store = AgentTaskStore(task_file.parent.parent)
    request = AgentRequest.from_dict(dict(payload["request"]))
    invocation = AgentInvocation.from_dict(dict(payload["invocation"]))
    if invocation.shell:
        store.complete(task_id, exit_code=2, summary="", error="shell_invocation_refused")
        return 2

    argv = list(invocation.argv)
    if "{PROMPT_FILE}" in argv:
        prompt_path = task_file.parent / "prompt.md"
        prompt_path.write_text(request.prompt, encoding="utf-8", newline="\n")
        argv = [str(prompt_path) if item == "{PROMPT_FILE}" else item for item in argv]

    stdout_path = task_file.parent / "stdout.log"
    stderr_path = task_file.parent / "stderr.log"
    env = dict(os.environ)
    env.update(invocation.env or {})
    if invocation.protocol == "jsonl-rpc":
        try:
            return _run_pi_rpc(
                store=store,
                task_id=task_id,
                request=request,
                invocation=invocation,
                stdout_path=stdout_path,
                stderr_path=stderr_path,
                env=env,
            )
        except Exception as exc:
            store.complete(
                task_id,
                exit_code=1,
                summary="",
                error=f"rpc_worker_failed:{type(exc).__name__}:{exc}",
            )
            return 1
    try:
        with stdout_path.open("wb") as stdout_handle, stderr_path.open("wb") as stderr_handle:
            child = subprocess.Popen(
                argv,
                cwd=invocation.cwd,
                stdin=subprocess.PIPE if invocation.stdin is not None else subprocess.DEVNULL,
                stdout=stdout_handle,
                stderr=stderr_handle,
                env=env,
                shell=False,
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
            )
            store.mark_running(task_id, agent_pid=child.pid)
            child.communicate(
                None if invocation.stdin is None else invocation.stdin.encode("utf-8"),
            )
        stdout = _tail(stdout_path)
        stderr = _tail(stderr_path)
        result = _extract_result(stdout, invocation.protocol)
        if stderr:
            result["stderrExcerpt"] = stderr[-8000:]
        store.complete(
            task_id,
            exit_code=int(child.returncode or 0),
            summary=(stdout or stderr or f"{request.provider} finished")[-4000:],
            output=result,
            error=None if child.returncode == 0 else f"agent_exit_{child.returncode}",
        )
        return int(child.returncode or 0)
    except Exception as exc:
        store.complete(
            task_id,
            exit_code=1,
            summary="",
            error=f"worker_failed:{type(exc).__name__}:{exc}",
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
