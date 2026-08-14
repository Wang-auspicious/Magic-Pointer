"""Background Agent supervision must never report undeliverable steering."""

from __future__ import annotations

import threading

import pytest

from app.fabric.agents import AgentInvocation, AgentRequest
from app.fabric.task_store import AgentTaskError, AgentTaskStore
from scripts.agent_worker import _pi_rpc_response_error, _pi_rpc_terminal_error


def _start_task(tmp_path, *, protocol: str) -> tuple[AgentTaskStore, str]:
    store = AgentTaskStore(
        tmp_path / "agent-tasks",
        spawn_worker=lambda _path: 4321,
        process_alive=lambda _pid: True,
    )
    task = store.start(
        AgentRequest(provider="pi", prompt="work", cwd=str(tmp_path)),
        AgentInvocation(
            argv=("pi",),
            stdin="work",
            cwd=str(tmp_path),
            protocol=protocol,
        ),
    )
    return store, str(task["taskId"])


def test_steer_rejects_non_live_transport_instead_of_claiming_success(tmp_path) -> None:
    store, task_id = _start_task(tmp_path, protocol="jsonl")

    with pytest.raises(AgentTaskError, match="task_not_steerable"):
        store.steer(task_id, "change direction")


def test_steer_accepts_active_pi_rpc_transport(tmp_path) -> None:
    store, task_id = _start_task(tmp_path, protocol="jsonl-rpc")

    receipt = store.steer(task_id, "change direction")

    assert receipt["queued"] is True
    assert receipt["deliveredLive"] is False
    assert receipt["deliveryState"] == "queued"
    event_id = receipt["eventId"]

    acknowledged = store.mark_steer_delivered(task_id, event_id)

    assert acknowledged["lastSteering"]["eventId"] == event_id
    assert acknowledged["lastSteering"]["state"] == "delivered"


def test_worker_completion_cannot_overwrite_a_concurrent_cancellation(tmp_path) -> None:
    store, task_id = _start_task(tmp_path, protocol="jsonl-rpc")
    worker_store = AgentTaskStore(
        store.root,
        spawn_worker=lambda _path: 4321,
        process_alive=lambda _pid: False,
    )
    started = threading.Event()
    finished = threading.Event()

    def finish_worker() -> None:
        started.set()
        worker_store.complete(task_id, exit_code=0, summary="done")
        finished.set()

    with store._mutation_lock(task_id):
        thread = threading.Thread(target=finish_worker)
        thread.start()
        assert started.wait(0.5)
        assert not finished.wait(0.05)
        value = store._read(task_id)
        value["status"] = "cancelled"
        value["cancelRequested"] = True
        store._write(value)

    thread.join(timeout=0.5)
    assert finished.is_set()
    assert store.status(task_id)["status"] == "cancelled"


def test_pi_rpc_rejected_initial_prompt_is_a_terminal_protocol_error() -> None:
    event = {
        "id": "initial",
        "type": "response",
        "command": "prompt",
        "success": False,
        "error": "No model configured",
    }

    assert _pi_rpc_response_error(event, request_id="initial") == (
        "pi_rpc_prompt_rejected:No model configured"
    )


def test_pi_rpc_settlement_with_assistant_error_is_not_success() -> None:
    event = {
        "type": "agent_end",
        "messages": [
            {"role": "user", "content": "work"},
            {
                "role": "assistant",
                "content": [],
                "stopReason": "error",
                "errorMessage": "authentication failed",
            },
        ],
        "willRetry": False,
    }

    assert _pi_rpc_terminal_error(event) == "pi_rpc_agent_error:authentication failed"


def test_each_queued_steer_keeps_an_independent_delivery_receipt(tmp_path) -> None:
    store, task_id = _start_task(tmp_path, protocol="jsonl-rpc")
    first = store.steer(task_id, "first correction")
    second = store.steer(task_id, "second correction")

    store.mark_steer_delivered(task_id, first["eventId"])
    state = store.mark_steer_rejected(
        task_id,
        second["eventId"],
        "agent is no longer streaming",
    )

    receipts = {item["eventId"]: item for item in state["steeringReceipts"]}
    assert receipts[first["eventId"]]["state"] == "delivered"
    assert receipts[second["eventId"]]["state"] == "rejected"
    assert state["lastSteering"]["error"] == "agent is no longer streaming"
