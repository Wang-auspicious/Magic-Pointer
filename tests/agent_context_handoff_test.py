from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.fabric.agent_context_handoff import AgentContextHandoffError, AgentContextHandoffStore


def _packet(tmp_path: Path) -> dict:
    return {
        "schemaVersion": 2,
        "packetId": "packet-n14",
        "intent": {"command": "fix the pointed control", "recipeId": "agent.handoff"},
        "objects": [{
            "id": "button-1",
            "referenceLabel": "A",
            "kind": "button",
            "label": "Save",
            "content": "Save",
            "bbox": [10, 20, 80, 50],
            "source": {"app": "code.exe", "title": "Settings"},
        }],
        "spatialRelations": [],
        "workspace": {"cwd": str(tmp_path), "repoRoot": str(tmp_path), "branch": "main"},
        "runtime": {},
        "targetLease": {},
        "visualRelays": [],
        "capabilities": [],
        "artifacts": [],
        "privacy": {"withheldVisualObjectCount": 0, "uploadableVisualObjectCount": 0},
    }


def test_two_agents_receive_the_same_sealed_context_without_repeating_scene(tmp_path: Path) -> None:
    store = AgentContextHandoffStore(tmp_path / "agent-contexts")
    packet = _packet(tmp_path)
    sealed = store.seal(
        packet,
        prompt="provider-neutral prompt derived from packet-n14",
        attachments=[],
        permission="write",
        privacy={"screenshotUploadAllowed": False},
    )
    calls: list[dict] = []

    def starter(payload: dict) -> dict:
        calls.append(payload)
        return {"taskId": f"task-{payload['provider']}", "status": "queued"}

    first = store.dispatch(sealed["contextId"], provider="codex", starter=starter)
    second = store.dispatch(sealed["contextId"], provider="pi", starter=starter)

    assert first["accepted"] is True
    assert second["accepted"] is True
    assert [call["provider"] for call in calls] == ["codex", "pi"]
    assert calls[0]["contextPacket"] == calls[1]["contextPacket"] == packet
    assert calls[0]["contextPacketDigest"] == calls[1]["contextPacketDigest"] == sealed["contextPacketDigest"]
    assert calls[0]["prompt"] == calls[1]["prompt"]
    assert all(call["submit"] is False for call in calls)

    recovered = store.get(sealed["contextId"])
    assert recovered["providers"] == ["codex", "pi"]
    assert recovered["deliveryCount"] == 2
    assert recovered["objectCount"] == 1


def test_same_packet_is_reused_and_mutated_packet_is_rejected(tmp_path: Path) -> None:
    store = AgentContextHandoffStore(tmp_path / "agent-contexts")
    packet = _packet(tmp_path)
    first = store.seal(packet, prompt="one", attachments=[], permission="read", privacy={})
    reused = store.seal(packet, prompt="one", attachments=[], permission="read", privacy={})
    assert reused["contextId"] == first["contextId"]
    assert reused["reused"] is True

    changed = _packet(tmp_path)
    changed["objects"][0]["content"] = "tampered"
    with pytest.raises(AgentContextHandoffError, match="packet id collision"):
        store.seal(changed, prompt="one", attachments=[], permission="read", privacy={})


def test_corrupt_sealed_context_fails_closed(tmp_path: Path) -> None:
    store = AgentContextHandoffStore(tmp_path / "agent-contexts")
    sealed = store.seal(_packet(tmp_path), prompt="one", attachments=[], permission="read", privacy={})
    path = tmp_path / "agent-contexts" / sealed["contextId"] / "context.json"
    value = json.loads(path.read_text(encoding="utf-8"))
    value["contextPacket"]["objects"][0]["content"] = "changed on disk"
    path.write_text(json.dumps(value), encoding="utf-8")

    with pytest.raises(AgentContextHandoffError, match="digest mismatch"):
        store.get(sealed["contextId"])


def test_failed_dispatch_is_recorded_without_faking_acceptance(tmp_path: Path) -> None:
    store = AgentContextHandoffStore(tmp_path / "agent-contexts")
    sealed = store.seal(_packet(tmp_path), prompt="one", attachments=[], permission="read", privacy={})

    def unavailable(_payload: dict) -> dict:
        raise RuntimeError("provider unavailable")

    with pytest.raises(AgentContextHandoffError, match="agent dispatch failed:RuntimeError"):
        store.dispatch(sealed["contextId"], provider="gemini", starter=unavailable)
    recovered = store.get(sealed["contextId"])
    assert recovered["deliveryCount"] == 1
    assert recovered["deliveries"][0]["status"] == "failed"
    assert recovered["deliveries"][0]["taskId"] is None


def test_delivery_status_reconciles_with_durable_agent_task_truth(tmp_path: Path) -> None:
    store = AgentContextHandoffStore(tmp_path / "agent-contexts")
    sealed = store.seal(_packet(tmp_path), prompt="one", attachments=[], permission="read", privacy={})
    store.dispatch(
        sealed["contextId"],
        provider="codex",
        starter=lambda _payload: {"taskId": "task-codex", "status": "queued"},
    )

    contexts = store.reconcile(
        lambda task_id: {"taskId": task_id, "status": "failed", "updatedAt": "2026-07-28T05:00:00Z"},
    )

    assert contexts[0]["deliveries"][0]["status"] == "failed"
