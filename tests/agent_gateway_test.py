from __future__ import annotations

from pathlib import Path

import pytest

from app.fabric.agent_gateway import AgentGateway, AgentGatewayError
from app.fabric.agent_sessions import AgentSession
from app.fabric.providers import AgentAvailability
from app.fabric.task_store import AgentTaskStore
from app.fabric.target_lease import TargetLease


class _Discovery:
    def __init__(self, available: bool = True) -> None:
        self.available = available

    def discover_all(self) -> list[AgentAvailability]:
        return [
            AgentAvailability(
                id="pi",
                name="Pi",
                available=self.available,
                executable="C:/tools/pi.exe" if self.available else None,
                version="1.2.3" if self.available else None,
                protocols=("rpc-steer", "json"),
                reason=None if self.available else "executable_not_found",
            )
        ]


class _Sessions:
    def __init__(self) -> None:
        self.last_active_only = False

    def discover(
        self,
        *,
        provider=None,
        cwd=None,
        cwd_match="strict",
        include_mismatch=False,
        limit=200,
        active_only=False,
    ):
        self.last_active_only = active_only
        if provider not in {None, "pi"}:
            return []
        return [AgentSession(
            provider="pi",
            session_id="session-existing",
            cwd=str(Path(cwd).resolve()),
            last_active_at="2026-07-27T10:00:00+00:00",
            state="recent",
            transport="pi-session-json",
            source="pi_session_meta",
            title="Ticket investigation",
            cwd_match="strict",
        )]

    def resolve(self, provider, session_id, *, cwd, cwd_match="strict", confirmed=False):
        matches = self.discover(provider=provider, cwd=cwd, cwd_match=cwd_match)
        return matches[0] if matches and matches[0].session_id == session_id else None

    def unique(self, provider, *, cwd, cwd_match="strict"):
        matches = self.discover(provider=provider, cwd=cwd, cwd_match=cwd_match)
        return matches[0] if len(matches) == 1 else None


def _gateway(tmp_path: Path, *, available: bool = True) -> AgentGateway:
    tasks = AgentTaskStore(
        tmp_path / "agent-tasks",
        spawn_worker=lambda _task_file: 991,
        process_alive=lambda pid: pid == 991,
        terminate_process=lambda _pid: None,
    )
    return AgentGateway(
        root=tmp_path,
        discovery=_Discovery(available),
        task_store=tasks,
        sessions=_Sessions(),
    )


def test_gateway_resumes_existing_session_and_marks_background_rpc(tmp_path: Path) -> None:
    gateway = _gateway(tmp_path)

    receipt = gateway.start({
        "provider": "pi",
        "prompt": "Fix the selected card and verify it.",
        "cwd": str(tmp_path),
        "permission": "write",
        "sessionId": "session-existing",
        "background": True,
        "submit": False,
        "contextPacket": {"schemaVersion": 2, "packetId": "packet-n14"},
        "contextPacketId": "packet-n14",
        "contextPacketDigest": "a" * 64,
    })

    assert receipt["status"] == "queued"
    assert receipt["sessionStrategy"] == "resume_existing"
    assert receipt["steerable"] is True
    task = gateway.task_store._read(receipt["taskId"])
    assert task["request"]["session_id"] == "session-existing"
    assert task["invocation"]["protocol"] == "jsonl-rpc"
    assert task["invocation"]["stdin"] is None
    assert "Fix the selected card" not in " ".join(task["invocation"]["argv"])
    assert receipt["sessionId"] == "session-existing"
    assert receipt["sessionEvidence"]["source"] == "pi_session_meta"
    assert receipt["contextPacket"] == {
        "id": "packet-n14",
        "digest": "a" * 64,
        "schemaVersion": 2,
    }


def test_gateway_sessions_exposes_title_without_regressing_existing_fields(tmp_path: Path) -> None:
    session = _gateway(tmp_path).sessions(provider="pi", cwd=tmp_path)[0]

    assert session["title"] == "Ticket investigation"
    assert {
        "provider", "sessionId", "cwd", "lastActiveAt", "state", "transport",
        "source", "resumeToken", "cwdMatch",
    } <= set(session)


def test_gateway_sessions_forwards_active_only_to_registry(tmp_path: Path) -> None:
    registry = _Sessions()
    gateway = _gateway(tmp_path)
    gateway.sessions_registry = registry

    gateway.sessions(provider="pi", cwd=tmp_path, active_only=True)

    assert registry.last_active_only is True


def test_gateway_rejects_unverified_or_missing_active_session(tmp_path: Path) -> None:
    gateway = _gateway(tmp_path)
    with pytest.raises(AgentGatewayError, match="agent_session_not_found"):
        gateway.start({
            "provider": "pi",
            "prompt": "inspect",
            "cwd": str(tmp_path),
            "sessionId": "invented-session",
            "deliveryMode": "active_session",
        })

    receipt = gateway.start({
        "provider": "pi",
        "prompt": "inspect",
        "cwd": str(tmp_path),
        "deliveryMode": "active_session",
    })
    assert receipt["sessionId"] == "session-existing"


def test_gateway_managed_mode_is_the_only_mode_allowed_to_create_session(tmp_path: Path) -> None:
    gateway = _gateway(tmp_path)
    receipt = gateway.start({
        "provider": "pi",
        "prompt": "inspect",
        "cwd": str(tmp_path),
        "deliveryMode": "managed_session",
        "sessionId": "",
        "autoAttach": False,
    })
    assert receipt["sessionStrategy"] == "new_managed_session"


def test_gateway_rejects_external_submit_and_unavailable_provider(tmp_path: Path) -> None:
    gateway = _gateway(tmp_path)
    with pytest.raises(AgentGatewayError, match="external_submit_not_allowed"):
        gateway.start({
            "provider": "pi",
            "prompt": "send it",
            "cwd": str(tmp_path),
            "submit": True,
        })

    missing = _gateway(tmp_path, available=False)
    with pytest.raises(AgentGatewayError, match="agent_provider_unavailable:pi"):
        missing.start({
            "provider": "pi",
            "prompt": "inspect",
            "cwd": str(tmp_path),
        })


def test_gateway_reports_capability_and_never_equates_queue_with_completion(tmp_path: Path) -> None:
    gateway = _gateway(tmp_path)
    providers = gateway.providers()
    assert providers[0]["id"] == "pi"
    assert providers[0]["sessionSupport"] == "resume"

    receipt = gateway.start({"provider": "pi", "prompt": "inspect", "cwd": str(tmp_path)})
    status = gateway.status(receipt["taskId"])
    assert status["state"] == "accepted"
    assert status["completed"] is False
    assert status["terminalOutcomeVerified"] is False


def test_gateway_status_enforces_bound_target_and_exposes_reconfirmation_state(tmp_path: Path) -> None:
    alive = {991}
    tasks = AgentTaskStore(
        tmp_path / "agent-tasks",
        spawn_worker=lambda _task_file: 991,
        process_alive=lambda pid: pid in alive,
        terminate_process=lambda pid: alive.discard(pid),
    )
    gateway = AgentGateway(
        root=tmp_path,
        discovery=_Discovery(True),
        task_store=tasks,
        target_probe=lambda _lease: [],
        sessions=_Sessions(),
    )
    receipt = gateway.start({"provider": "pi", "prompt": "inspect", "cwd": str(tmp_path)})
    lease = TargetLease.create([{
        "id": "screen-1",
        "kind": "screen_region",
        "source": {
            "app": "code.exe",
            "title": "Design review",
            "hwnd": 42,
            "processId": 314,
        },
    }]).to_dict()
    tasks.link_provenance(
        receipt["taskId"],
        plan_id="plan-1",
        receipt_id="receipt-1",
        recipe_id="agent.background_task",
        source_object_ids=("screen-1",),
        retention_days=30,
        target_lease=lease,
    )

    status = gateway.status(receipt["taskId"])

    assert status["status"] == "paused_target_mismatch"
    assert status["state"] == "paused"
    assert status["completed"] is False
    assert status["terminalOutcomeVerified"] is False
    assert status["targetLease"]["confirmationRequired"] is True
    assert status["reconfirmationRequired"] is True
