from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import pytest

from app.fabric.agents import AgentInvocation, AgentRequest
from app.fabric.artifacts import ArtifactRegistry
from app.fabric.task_store import AgentTaskStore
from app.fabric import task_store as task_store_module
from app.fabric.target_lease import TargetLease


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


def test_terminal_agent_artifact_is_reverse_linked_to_pointer_plan(tmp_path: Path) -> None:
    runtime = tmp_path / "runtime"
    workspace = tmp_path / "workspace"
    workspace.mkdir(parents=True)
    artifact = workspace / "fixed-page.html"
    artifact.write_text("<main>verified</main>\n", encoding="utf-8")
    store = AgentTaskStore(
        runtime / "agent-tasks",
        spawn_worker=lambda _path: 777,
        process_alive=lambda _pid: True,
    )
    receipt = store.start(
        AgentRequest(provider="pi", prompt="fix it", cwd=str(workspace)),
        AgentInvocation(argv=("pi",), stdin="fix it", cwd=str(workspace), protocol="json"),
    )
    store.link_provenance(
        receipt["taskId"],
        plan_id="plan-1",
        receipt_id="receipt-1",
        recipe_id="agent.handoff",
        source_object_ids=("object-a",),
        retention_days=30,
    )
    completed = store.complete(
        receipt["taskId"],
        exit_code=0,
        summary="done",
        output={"artifact": str(artifact)},
    )

    assert completed["provenance"]["planId"] == "plan-1"
    assert len(completed["result"]["artifactIds"]) == 1
    indexed = ArtifactRegistry(runtime).get(completed["result"]["artifactIds"][0])
    assert indexed["state"] == "external"
    assert indexed["taskId"] == receipt["taskId"]
    assert indexed["sourceObjectIds"] == ["object-a"]


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


def test_cancel_stays_cancelling_until_termination_is_verified(tmp_path: Path) -> None:
    terminated: list[int] = []
    store = AgentTaskStore(
        tmp_path,
        spawn_worker=lambda _path: 321,
        process_alive=lambda _pid: True,
        terminate_process=lambda pid: terminated.append(pid),
    )
    receipt = store.start(
        AgentRequest(provider="generic", prompt="work", cwd=str(tmp_path)),
        AgentInvocation(argv=("tool",), stdin="work", cwd=str(tmp_path), protocol="text"),
    )
    store.mark_running(receipt["taskId"], agent_pid=654)

    result = store.cancel(receipt["taskId"])

    assert result["status"] == "cancelling"
    assert result["error"] == "termination_not_verified"
    assert sorted(terminated) == [321, 654]
    events = [
        json.loads(line)
        for line in (tmp_path / receipt["taskId"] / "events.jsonl").read_text(encoding="utf-8").splitlines()
    ]
    assert [event["type"] for event in events][-2:] == ["cancel_requested", "cancel_pending"]


def test_cancel_becomes_cancelled_only_after_processes_are_dead(tmp_path: Path) -> None:
    alive = {321: True, 654: True}

    def terminate(pid: int) -> None:
        alive[pid] = False

    store = AgentTaskStore(
        tmp_path,
        spawn_worker=lambda _path: 321,
        process_alive=lambda pid: alive.get(pid, False),
        terminate_process=terminate,
    )
    receipt = store.start(
        AgentRequest(provider="generic", prompt="work", cwd=str(tmp_path)),
        AgentInvocation(argv=("tool",), stdin="work", cwd=str(tmp_path), protocol="text"),
    )
    store.mark_running(receipt["taskId"], agent_pid=654)

    result = store.cancel(receipt["taskId"])
    assert result["status"] == "cancelled"
    assert result["error"] is None
    assert result["cancelRequested"] is True


def test_list_recover_and_resume_preserve_attempt_history(tmp_path: Path) -> None:
    spawned = iter((1001, 1002))
    store = AgentTaskStore(
        tmp_path,
        spawn_worker=lambda _path: next(spawned),
        process_alive=lambda _pid: False,
    )
    receipt = store.start(
        AgentRequest(provider="pi", prompt="work", cwd=str(tmp_path)),
        AgentInvocation(argv=("pi", "--mode", "json"), stdin="work", cwd=str(tmp_path), protocol="json"),
    )
    failed = store.complete(receipt["taskId"], exit_code=1, summary="failed", error="agent_exit_1")
    assert failed["attempt"] == 1

    listed = store.list(limit=10)
    assert [item["taskId"] for item in listed] == [receipt["taskId"]]
    assert listed[0]["resumable"] is True

    resumed = store.resume(receipt["taskId"])
    assert resumed["status"] == "queued"
    assert resumed["attempt"] == 2
    assert resumed["workerPid"] == 1002
    recovered = store.recover()
    assert recovered[0]["status"] == "interrupted"
    assert recovered[0]["attempt"] == 2
    events = [
        json.loads(line)
        for line in (tmp_path / receipt["taskId"] / "events.jsonl").read_text(encoding="utf-8").splitlines()
    ]
    assert any(event["type"] == "resume" and event["data"]["attempt"] == 2 for event in events)


def test_long_task_pauses_on_target_drift_and_only_explicit_reconfirmation_restarts_it(tmp_path: Path) -> None:
    spawned = iter((1001, 1002))
    alive = {1001: True, 1002: True, 2001: True}
    terminated: list[int] = []

    def terminate(pid: int) -> None:
        terminated.append(pid)
        alive[pid] = False

    store = AgentTaskStore(
        tmp_path,
        spawn_worker=lambda _path: next(spawned),
        process_alive=lambda pid: alive.get(pid, False),
        terminate_process=terminate,
    )
    receipt = store.start(
        AgentRequest(provider="pi", prompt="work on the frozen target", cwd=str(tmp_path)),
        AgentInvocation(argv=("pi", "--mode", "rpc"), stdin=None, cwd=str(tmp_path), protocol="jsonl-rpc"),
    )
    task_id = receipt["taskId"]
    store.mark_running(task_id, agent_pid=2001)
    lease = TargetLease.create(
        [{
            "id": "screen-1",
            "kind": "screen_region",
            "source": {
                "app": "code.exe",
                "title": "Magic Pointer - Visual Studio Code",
                "hwnd": 42,
                "processId": 314,
                "desktopId": "desktop-1",
            },
        }],
        now=datetime.now(timezone.utc),
    ).to_dict()
    store.link_provenance(
        task_id,
        plan_id="plan-n04",
        receipt_id="receipt-n04",
        recipe_id="agent.background_task",
        source_object_ids=("screen-1",),
        retention_days=30,
        target_lease=lease,
    )

    paused = store.enforce_target_lease(task_id, live_windows=[])
    assert paused["status"] == "paused_target_mismatch"
    assert paused["targetLease"]["state"] == "reconfirmation_required"
    assert paused["targetLease"]["reason"] == "stale_target_window"
    assert paused["resumable"] is False
    assert sorted(terminated) == [1001, 2001]
    with pytest.raises(Exception, match="task_not_resumable"):
        store.resume(task_id)

    resumed = store.reconfirm_target(
        task_id,
        confirmed_windows=[{
            "hwnd": 84,
            "pid": 628,
            "app": "code.exe",
            "title": "Magic Pointer - Visual Studio Code",
            "desktopId": "desktop-2",
        }],
    )
    assert resumed["status"] == "queued"
    assert resumed["attempt"] == 2
    assert resumed["workerPid"] == 1002
    assert resumed["targetLease"]["state"] == "active"
    assert resumed["targetLease"]["lease"]["revision"] == 2
    validated = store.enforce_target_lease(
        task_id,
        live_windows=[{
            "hwnd": 84,
            "pid": 628,
            "title": "Magic Pointer - Visual Studio Code",
            "desktopId": "desktop-2",
        }],
    )
    assert validated["status"] == "queued"
    assert validated["targetLease"]["state"] == "active"
    events = [
        json.loads(line)
        for line in (tmp_path / task_id / "events.jsonl").read_text(encoding="utf-8").splitlines()
    ]
    assert "target_lease_paused" in [event["type"] for event in events]
    assert "target_lease_reconfirmed" in [event["type"] for event in events]
def test_process_alive_handles_missing_pid_without_raising() -> None:
    assert task_store_module._process_alive(task_store_module.os.getpid()) is True
    assert task_store_module._process_alive(2_000_000_000) is False
