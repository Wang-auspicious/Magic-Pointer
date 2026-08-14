from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from app.agent_runtime.tool_registry import Effect
from app.computer_operator import (
    ComputerOperatorRegistry,
    ComputerTaskService,
    OperatorBackendResult,
    OperatorObservation,
)


class _Backend:
    backend_name = "fake-operator"

    def __init__(self) -> None:
        self.state = 1
        self.actions = []

    def observe(self, grant, *, scope=None):
        return OperatorObservation(
            observation_id=f"observation-{self.state}",
            surface_id=grant.surface_id,
            image_ref=f"artifact://observation-{self.state}.png",
            image_sha256=f"{self.state}" * 64,
            width=800,
            height=600,
            captured_at=datetime.now(UTC).isoformat(),
            used_backend=self.backend_name,
        )

    def execute(self, action, grant, *, scope=None):
        self.actions.append(action)
        self.state += 1
        return OperatorBackendResult(executed=True, data={"state": self.state})

    def abort(self, _operation_id):
        return False


class _Model:
    used_backend = "fake-ui-tars"

    def __init__(self) -> None:
        self.responses = iter([
            "Action: click(start_box='[0.5, 0.5]')",
            "Action: finished(content='done')",
        ])

    def predict(self, task, observation, history, *, scope=None):
        return next(self.responses)


def _leases():
    expires = (datetime.now(UTC) + timedelta(minutes=1)).isoformat()
    frame = {
        "schemaVersion": 1,
        "frameLeaseId": "frame-1",
        "contentHash": "sha256:" + "a" * 64,
        "surfaceBoundsPx": [0, 0, 800, 600],
        "targetWindow": {"hwnd": 42, "processId": 314},
    }
    target = {
        "schemaVersion": 1,
        "leaseId": "target-1",
        "createdAt": datetime.now(UTC).isoformat(),
        "expiresAt": expires,
        "window": {"hwnd": 42, "processId": 314},
        "windows": [{"hwnd": 42, "processId": 314}],
        "objectIds": [],
        "objectFingerprint": "x",
        "captureFingerprint": "",
        "captureFiles": [],
        "requiresLiveValidation": True,
    }
    return frame, target


def test_computer_task_service_runs_only_after_live_lease_revalidation() -> None:
    backend = _Backend()
    registry = ComputerOperatorRegistry()
    registry.register(backend)
    service = ComputerTaskService(
        registry,
        model_factory=_Model,
        live_window_probe=lambda: [{
            "hwnd": 42,
            "pid": 314,
            "title": "",
            "app": "",
        }],
    )
    frame, target = _leases()

    result = service.run(
        "open item",
        frame_lease=frame,
        target_lease=target,
        action_effect=Effect.REVERSIBLE_WRITE,
        backend_name="fake-operator",
    )

    assert result.status == "completed"
    assert result.final_text == "done"
    assert len(backend.actions) == 1
    assert backend.actions[0].effect is Effect.REVERSIBLE_WRITE


def test_computer_task_service_rejects_read_effect_for_input_actions() -> None:
    registry = ComputerOperatorRegistry()
    registry.register(_Backend())
    service = ComputerTaskService(
        registry,
        model_factory=_Model,
        live_window_probe=lambda: [],
    )
    frame, target = _leases()

    with pytest.raises(ValueError, match="non-read"):
        service.run(
            "open item",
            frame_lease=frame,
            target_lease=target,
            action_effect=Effect.READ,
            backend_name="fake-operator",
        )
