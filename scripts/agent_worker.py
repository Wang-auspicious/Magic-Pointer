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
from app.system_context import list_visible_windows


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
    result: dict[str, Any] = {"eventCount": len(values)}
    output_text = ""
    session_id = ""
    for event in values:
        if not isinstance(event, dict):
            continue
        session_id = str(
            event.get("session_id") or event.get("sessionId") or event.get("thread_id") or session_id
        )
        if isinstance(event.get("result"), str):
            output_text = str(event["result"])
        item = event.get("item")
        if isinstance(item, dict) and item.get("type") == "agent_message":
            output_text = str(item.get("text") or output_text)
    if output_text:
        result["outputText"] = output_text[-8000:]
    if session_id:
        result["sessionId"] = session_id
    if isinstance(terminal, dict):
        result["terminalEvent"] = {
            key: terminal[key]
            for key in (
                "type", "subtype", "is_error", "api_error_status", "stop_reason",
                "session_id", "sessionId", "thread_id", "terminal_reason",
            )
            if key in terminal
        }
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


def _pi_rpc_response_error(value: dict[str, Any], *, request_id: str) -> str | None:
    """Return a stable error when Pi rejects one correlated RPC command."""
    if (
        value.get("type") != "response"
        or str(value.get("id") or "") != str(request_id)
        or value.get("success") is not False
    ):
        return None
    command = str(value.get("command") or "command").strip().replace(" ", "_")[:80]
    detail = str(value.get("error") or "rejected").strip()[:1600]
    return f"pi_rpc_{command}_rejected:{detail}"


def _pi_rpc_terminal_error(agent_end: dict[str, Any] | None) -> str | None:
    """Read Pi's final assistant stop reason; settlement alone does not mean success."""
    if not isinstance(agent_end, dict) or agent_end.get("type") != "agent_end":
        return None
    messages = agent_end.get("messages")
    if not isinstance(messages, list):
        return None
    for message in reversed(messages):
        if not isinstance(message, dict) or message.get("role") != "assistant":
            continue
        reason = str(message.get("stopReason") or message.get("stop_reason") or "").casefold()
        if reason not in {"error", "aborted"}:
            return None
        detail = str(
            message.get("errorMessage")
            or message.get("error_message")
            or reason
        ).strip()[:1600]
        return f"pi_rpc_agent_{reason}:{detail}"
    return None


def _target_lease_allows_progress(
    store: AgentTaskStore,
    task_id: str,
    *,
    live_windows: list[dict[str, Any]] | None = None,
) -> bool:
    raw = store._read(task_id)
    guard = raw.get("targetLease")
    guard = dict(guard) if isinstance(guard, dict) else {}
    if guard.get("state") != "active" or not isinstance(guard.get("lease"), dict):
        return raw.get("status") not in {"pausing_target_mismatch", "paused_target_mismatch"}
    windows = list_visible_windows() if live_windows is None else live_windows
    guarded = store.enforce_target_lease(
        task_id,
        live_windows=windows,
        terminate=False,
    )
    return guarded.get("status") not in {"pausing_target_mismatch", "paused_target_mismatch"}


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
    initial_accepted = threading.Event()
    protocol_failed = threading.Event()
    event_count = 0
    last_event: dict[str, Any] | None = None
    last_agent_end: dict[str, Any] | None = None
    protocol_error: str | None = None
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
            nonlocal event_count, last_event, last_agent_end, protocol_error
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
                    response_error = _pi_rpc_response_error(value, request_id="initial")
                    if response_error:
                        protocol_error = response_error
                        protocol_failed.set()
                    elif (
                        value.get("type") == "response"
                        and str(value.get("id") or "") == "initial"
                        and value.get("success") is True
                    ):
                        initial_accepted.set()
                    response_id = str(value.get("id") or "")
                    if response_id.startswith("steer:") and value.get("type") == "response":
                        steer_id = response_id.removeprefix("steer:")
                        steer_error = _pi_rpc_response_error(value, request_id=response_id)
                        if steer_error:
                            store.mark_steer_rejected(task_id, steer_id, steer_error)
                        elif value.get("success") is True:
                            store.mark_steer_delivered(task_id, steer_id)
                    if value.get("type") == "agent_end":
                        last_agent_end = value
                    if value.get("type") == "agent_settled":
                        settled.set()

        reader = threading.Thread(target=read_stdout, name=f"pi-rpc-{task_id}", daemon=True)
        reader.start()
        send({"id": "initial", "type": "prompt", "message": request.prompt})

        current_attempt = int(store._read(task_id).get("attempt") or 1)
        offset = 0
        settled_at: float | None = None
        initial_deadline = time.monotonic() + 10.0
        while child.poll() is None:
            if protocol_failed.is_set():
                child.terminate()
                break
            if not initial_accepted.is_set() and time.monotonic() >= initial_deadline:
                protocol_error = "pi_rpc_prompt_ack_timeout"
                protocol_failed.set()
                child.terminate()
                break
            if not _target_lease_allows_progress(store, task_id):
                child.terminate()
                break
            queued, offset = _queued_events(events_path, offset)
            if queued:
                settled.clear()
                settled_at = None
                for event in queued:
                    if (
                        event.get("type") != "steer"
                        or int(event.get("attempt") or 0) != current_attempt
                    ):
                        continue
                    send({
                        "id": f"steer:{str(event.get('eventId') or '')}",
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
    if current.get("status") in {"cancelled", "paused_target_mismatch"}:
        return 0
    stdout = _tail(stdout_path)
    stderr = _tail(stderr_path)
    if protocol_error:
        store.complete(
            task_id,
            exit_code=int(child.returncode or 1),
            summary=(stdout or stderr)[-4000:],
            output={"eventCount": event_count, "terminalEvent": last_event},
            error=protocol_error,
        )
        return int(child.returncode or 1)
    if not settled.is_set():
        store.complete(
            task_id,
            exit_code=int(child.returncode or 1),
            summary=(stdout or stderr)[-4000:],
            output={"eventCount": event_count, "terminalEvent": last_event},
            error=f"pi_rpc_exit_{child.returncode}",
        )
        return int(child.returncode or 1)
    terminal_error = _pi_rpc_terminal_error(last_agent_end)
    if terminal_error:
        store.complete(
            task_id,
            exit_code=1,
            summary=(stdout or stderr)[-4000:],
            output={
                "eventCount": event_count,
                "terminalEvent": last_agent_end,
                "protocol": "jsonl-rpc",
                "steering": "live",
            },
            error=terminal_error,
        )
        return 1
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
        paused_for_target = False
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
            if child.stdin is not None and invocation.stdin is not None:
                child.stdin.write(invocation.stdin.encode("utf-8"))
                child.stdin.close()
            while child.poll() is None:
                if not _target_lease_allows_progress(store, task_id):
                    paused_for_target = True
                    child.terminate()
                    try:
                        child.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        child.kill()
                        child.wait(timeout=5)
                    break
                time.sleep(0.1)
        if paused_for_target:
            return 0
        stdout = _tail(stdout_path)
        stderr = _tail(stderr_path)
        result = _extract_result(stdout, invocation.protocol)
        if stderr:
            result["stderrExcerpt"] = stderr[-8000:]
        completion_summary = str(
            result.get("outputText")
            or result.get("terminalEvent")
            or stderr
            or f"{request.provider} finished"
        )[-4000:]
        store.complete(
            task_id,
            exit_code=int(child.returncode or 0),
            summary=completion_summary,
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
