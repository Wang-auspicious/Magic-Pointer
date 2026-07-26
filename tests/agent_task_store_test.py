from __future__ import annotations

import json
from pathlib import Path

from app.fabric.agents import AgentInvocation, AgentRequest
from app.fabric.task_store import AgentTaskStore


def test_start_persists_bounded_task_contract_and_status(tmp_path: Path) -> None:
    spawned: list[Path] = []
    store = AgentTaskStore(
        tmp_path,
        spawn_worker=lambda task_file: spawned.append(task_file) or 4321,
        process_alive=lambda pid: pid == 4321,
    )
    request = AgentRequest(provider="pi", prompt="inspect the selected issue", cwd=str(tmp_path))
    invocation = AgentInvocation(
        argv=("pi", "--mode", "json", "--print"),
        stdin=request.prompt,
        cwd=str(tmp_path),
        protocol="json",
    )

    receipt = store.start(request, invocation)
    assert receipt["status"] == "queued"
    assert receipt["workerPid"] == 4321
    assert spawned == [tmp_path / receipt["taskId"] / "task.json"]
    status = store.status(receipt["taskId"])
    assert status["provider"] == "pi"
    assert status["status"] == "queued"
    assert status["alive"] is True
    task_payload = json.loads(spawned[0].read_text(encoding="utf-8"))
    assert task_payload["request"]["prompt"] == request.prompt
    assert task_payload["invocation"]["shell"] is False


def test_task_events_steering_completion_and_cancel_are_auditable(tmp_path: Path) -> None:
    terminated: list[int] = []
    store = AgentTaskStore(
        tmp_path,
        spawn_worker=lambda _path: 777,
        process_alive=lambda _pid: True,
        terminate_process=lambda pid: terminated.append(pid),
    )
    receipt = store.start(
        AgentRequest(provider="generic", prompt="work", cwd=str(tmp_path)),
        AgentInvocation(argv=("tool",), stdin="work", cwd=str(tmp_path), protocol="text"),
    )
    task_id = receipt["taskId"]

    steer = store.steer(task_id, "focus on the selected table")
    assert steer["queued"] is True
    assert steer["deliveredLive"] is False
    events = (tmp_path / task_id / "events.jsonl").read_text(encoding="utf-8").splitlines()
    assert json.loads(events[-1])["type"] == "steer"

    store.complete(task_id, exit_code=0, summary="done", output={"artifact": "result.md"})
    status = store.status(task_id)
    assert status["status"] == "succeeded"
    assert status["result"]["artifact"] == "result.md"

    cancel = store.cancel(task_id)
    assert cancel["status"] == "succeeded"
    assert terminated == []


def test_pi_rpc_steering_is_marked_live(tmp_path: Path) -> None:
    store = AgentTaskStore(
        tmp_path,
        spawn_worker=lambda _path: 778,
        process_alive=lambda _pid: True,
    )
    receipt = store.start(
        AgentRequest(provider="pi", prompt="work", cwd=str(tmp_path)),
        AgentInvocation(
            argv=("pi", "--mode", "rpc", "--no-session"),
            stdin=None,
            cwd=str(tmp_path),
            protocol="jsonl-rpc",
        ),
    )
    steer = store.steer(receipt["taskId"], "focus on verification")
    assert steer["queued"] is True
    assert steer["deliveredLive"] is True


def test_stale_running_pid_becomes_interrupted_not_success(tmp_path: Path) -> None:
    store = AgentTaskStore(
        tmp_path,
        spawn_worker=lambda _path: 900,
        process_alive=lambda _pid: False,
    )
    receipt = store.start(
        AgentRequest(provider="generic", prompt="work", cwd=str(tmp_path)),
        AgentInvocation(argv=("tool",), stdin="work", cwd=str(tmp_path), protocol="text"),
    )
    store.mark_running(receipt["taskId"], agent_pid=901)
    status = store.status(receipt["taskId"])
    assert status["status"] == "interrupted"
    assert status["error"] == "worker_process_missing"
