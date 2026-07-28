from __future__ import annotations

from scripts.agent_worker import _target_lease_allows_progress


class _Store:
    def __init__(self, *, bound: bool, status: str) -> None:
        self.bound = bound
        self.status = status
        self.calls: list[dict] = []

    def _read(self, _task_id: str) -> dict:
        return {
            "status": "running",
            "targetLease": ({"state": "active", "lease": {"schemaVersion": 1}} if self.bound else {}),
        }

    def enforce_target_lease(self, task_id: str, *, live_windows, terminate: bool) -> dict:
        self.calls.append({
            "taskId": task_id,
            "liveWindows": live_windows,
            "terminate": terminate,
        })
        return {"status": self.status}


def test_worker_stops_progress_when_bound_target_guard_pauses() -> None:
    store = _Store(bound=True, status="paused_target_mismatch")
    assert _target_lease_allows_progress(store, "task-1", live_windows=[]) is False
    assert store.calls == [{"taskId": "task-1", "liveWindows": [], "terminate": False}]


def test_worker_does_not_probe_unbound_tasks() -> None:
    store = _Store(bound=False, status="running")
    assert _target_lease_allows_progress(store, "task-1", live_windows=[]) is True
    assert store.calls == []
