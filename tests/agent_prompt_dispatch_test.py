from __future__ import annotations

from pathlib import Path

import pytest

from app.fabric.agent_prompt_dispatch import AgentPromptDispatchError, dispatch_agent_prompt
from app.fabric.settings import FabricSettings


def _packet(tmp_path: Path) -> dict:
    return {
        "schemaVersion": 2,
        "packetId": "packet-agent-prompt",
        "intent": {"command": "fix it", "recipeId": "agent.handoff"},
        "objects": [{"id": "obj-1", "kind": "text", "content": "broken", "source": {}}],
        "spatialRelations": [],
        "workspace": {"cwd": str(tmp_path)},
        "runtime": {},
        "targetLease": {},
        "visualRelays": [],
        "capabilities": [],
        "artifacts": [],
        "privacy": {},
    }


class _Gateway:
    def __init__(self, *, live: bool = True) -> None:
        self.calls: list[dict] = []
        self.live = live

    def sessions(self, **_kwargs) -> list[dict]:
        if not self.live:
            return []
        return [{
            "provider": "codex",
            "sessionId": "session-42",
            "live": True,
        }]

    def start(self, payload: dict) -> dict:
        self.calls.append(payload)
        return {
            "taskId": "task-1",
            "status": "queued",
            "sessionId": payload["sessionId"],
            "provider": payload["provider"],
        }


def test_edited_prompt_dispatches_to_exact_existing_session(tmp_path: Path) -> None:
    gateway = _Gateway()
    settings = FabricSettings.defaults()
    result = dispatch_agent_prompt(
        root=tmp_path,
        packet=_packet(tmp_path),
        prompt="用户编辑后的 Prompt",
        provider="codex",
        session_id="session-42",
        settings=settings,
        gateway=gateway,
    )

    assert result["ok"] is True
    assert result["state"] == "accepted"
    assert result["task"]["taskId"] == "task-1"
    assert gateway.calls[0]["prompt"] == "用户编辑后的 Prompt"
    assert gateway.calls[0]["provider"] == "codex"
    assert gateway.calls[0]["sessionId"] == "session-42"
    assert gateway.calls[0]["deliveryMode"] == "active_session"
    assert gateway.calls[0]["autoAttach"] is False
    assert gateway.calls[0]["submit"] is False


def test_dispatch_rechecks_that_selected_session_is_still_live(tmp_path: Path) -> None:
    with pytest.raises(AgentPromptDispatchError, match="agent_session_not_live"):
        dispatch_agent_prompt(
            root=tmp_path,
            packet=_packet(tmp_path),
            prompt="用户编辑后的 Prompt",
            provider="codex",
            session_id="session-42",
            settings=FabricSettings.defaults(),
            gateway=_Gateway(live=False),
        )


@pytest.mark.parametrize(
    ("prompt", "session_id", "error"),
    [
        ("", "session-42", "agent_prompt_missing"),
        ("ok", "", "agent_session_missing"),
    ],
)
def test_dispatch_rejects_incomplete_confirmation(
    tmp_path: Path, prompt: str, session_id: str, error: str
) -> None:
    with pytest.raises(AgentPromptDispatchError, match=error):
        dispatch_agent_prompt(
            root=tmp_path,
            packet=_packet(tmp_path),
            prompt=prompt,
            provider="codex",
            session_id=session_id,
            settings=FabricSettings.defaults(),
            gateway=_Gateway(),
        )
