from __future__ import annotations

from pathlib import Path
from typing import Any

from app.fabric.agent_context_handoff import AgentContextHandoffStore
from app.fabric.agent_gateway import AgentGateway
from app.fabric.settings import FabricSettings, SettingsStore


class AgentPromptDispatchError(ValueError):
    pass


def dispatch_agent_prompt(
    *,
    root: Path | str,
    packet: dict[str, Any],
    prompt: str,
    provider: str,
    session_id: str,
    settings: FabricSettings | None = None,
    gateway: AgentGateway | Any | None = None,
) -> dict[str, Any]:
    clean_prompt = str(prompt or "").strip()
    clean_provider = str(provider or "").strip().casefold()
    clean_session_id = str(session_id or "").strip()
    if not clean_prompt:
        raise AgentPromptDispatchError("agent_prompt_missing")
    if len(clean_prompt) > 60_000:
        raise AgentPromptDispatchError("agent_prompt_too_large")
    if clean_provider not in {"codex", "claude", "gemini", "pi"}:
        raise AgentPromptDispatchError("agent_provider_invalid")
    if not clean_session_id:
        raise AgentPromptDispatchError("agent_session_missing")
    if not isinstance(packet, dict) or packet.get("schemaVersion") != 2:
        raise AgentPromptDispatchError("context_packet_invalid")

    root_path = Path(root)
    active_settings = settings or SettingsStore(root_path / "fabric-settings.json").load()
    active_gateway = gateway or AgentGateway(
        root=root_path,
        default_provider=active_settings.agents.preferred,
    )
    workspace = packet.get("workspace") if isinstance(packet.get("workspace"), dict) else {}
    workspace_cwd = str(workspace.get("cwd") or root_path)
    live_sessions = active_gateway.sessions(
        provider=clean_provider,
        cwd=workspace_cwd,
        cwd_match="strict",
        include_mismatch=False,
        limit=100,
        active_only=True,
    )
    if not any(
        str(item.get("provider") or "").casefold() == clean_provider
        and str(item.get("sessionId") or "") == clean_session_id
        and item.get("live") is True
        for item in live_sessions
        if isinstance(item, dict)
    ):
        raise AgentPromptDispatchError("agent_session_not_live")
    contexts = AgentContextHandoffStore(root_path / "agent-contexts")
    sealed = contexts.seal(
        packet,
        prompt=clean_prompt,
        attachments=[str(item) for item in packet.get("artifacts") or [] if str(item).strip()],
        permission="write",
        privacy=dict(packet.get("privacy") or {}),
    )

    dispatched = contexts.dispatch(
        sealed["contextId"],
        provider=clean_provider,
        session_id=clean_session_id,
        starter=lambda request: active_gateway.start({
            **request,
            "deliveryMode": "active_session",
            "cwdMatch": active_settings.agents.cwd_match,
            "autoAttach": False,
            "sessionId": clean_session_id,
            "submit": False,
        }),
    )
    task = dict(dispatched.get("task") or {})
    accepted = dispatched.get("accepted") is True
    return {
        "ok": accepted,
        "state": "accepted" if accepted else "verification_failed",
        "contextId": sealed["contextId"],
        "dispatch": dispatched,
        "task": task,
        "error": None if accepted else "agent_task_receipt_invalid",
    }
