from __future__ import annotations

from pathlib import Path
from typing import Any, Callable

from app.fabric.agents import AgentConnectorRegistry, AgentRequest
from app.fabric.agent_sessions import AgentSession, AgentSessionRegistry
from app.fabric.providers import AgentProviderDiscovery
from app.fabric.task_store import AgentTaskStore


class AgentGatewayError(ValueError):
    pass


_SESSION_CAPABILITY = {
    "codex": "resume",
    "pi": "resume",
    "claude": "resume",
    "cursor": "resume",
    "opencode": "resume",
    "gemini": "resume",
    "aider": "new_only",
}


class AgentGateway:
    """One safe boundary for agent discovery, session selection, and durable tasks.

    The gateway deliberately owns no worker state.  AgentTaskStore remains the
    sole durable source of task lifecycle truth.
    """

    def __init__(
        self,
        *,
        root: Path | str,
        discovery: AgentProviderDiscovery | Any | None = None,
        task_store: AgentTaskStore | None = None,
        connector: AgentConnectorRegistry | None = None,
        sessions: AgentSessionRegistry | Any | None = None,
        default_provider: str = "pi",
        target_probe: Callable[[dict[str, Any]], list[dict[str, Any]] | None] | None = None,
    ) -> None:
        self.root = Path(root)
        self.discovery = discovery or AgentProviderDiscovery()
        self.task_store = task_store or AgentTaskStore(self.root / "agent-tasks")
        self.connector = connector or AgentConnectorRegistry()
        self.sessions_registry = sessions or AgentSessionRegistry()
        self.default_provider = str(default_provider or "pi").casefold()
        self.target_probe = target_probe

    def providers(self) -> list[dict[str, Any]]:
        results: list[dict[str, Any]] = []
        for availability in self.discovery.discover_all():
            value = availability.to_dict()
            provider = str(value["id"]).casefold()
            value["sessionSupport"] = _SESSION_CAPABILITY.get(provider, "new_only")
            value["backgroundSteerable"] = provider == "pi" and value.get("available") is True
            results.append(value)
        return results

    def sessions(
        self,
        *,
        provider: str | None = None,
        cwd: str | Path | None = None,
        cwd_match: str = "strict",
        include_mismatch: bool = False,
        limit: int = 200,
        active_only: bool = False,
    ) -> list[dict[str, Any]]:
        return [item.to_dict() for item in self.sessions_registry.discover(
            provider=provider,
            cwd=cwd,
            cwd_match=cwd_match,
            include_mismatch=include_mismatch,
            limit=limit,
            active_only=active_only,
        )]

    def _provider(self, provider_id: object) -> dict[str, Any]:
        requested = str(provider_id or self.default_provider).casefold().strip()
        for provider in self.providers():
            if provider["id"] == requested:
                if provider.get("available") is not True or not provider.get("executable"):
                    raise AgentGatewayError(f"agent_provider_unavailable:{requested}")
                return provider
        raise AgentGatewayError(f"agent_provider_unknown:{requested}")

    def start(self, payload: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(payload, dict):
            raise AgentGatewayError("agent_payload_invalid")
        if payload.get("submit") is True:
            raise AgentGatewayError("external_submit_not_allowed")
        provider = self._provider(payload.get("provider"))
        prompt = str(payload.get("prompt") or "").strip()
        cwd = str(payload.get("cwd") or "").strip()
        if not prompt:
            raise AgentGatewayError("agent_prompt_missing")
        if not cwd:
            raise AgentGatewayError("agent_cwd_missing")
        permission = str(payload.get("permission") or "write").casefold()
        if permission not in {"read", "write"}:
            raise AgentGatewayError("agent_permission_invalid")
        delivery_mode = str(payload.get("deliveryMode") or payload.get("delivery_mode") or "active_session").strip().casefold()
        if delivery_mode not in {"active_session", "managed_session", "clipboard"}:
            raise AgentGatewayError("agent_delivery_mode_invalid")
        if delivery_mode == "clipboard":
            raise AgentGatewayError("agent_delivery_clipboard_only")
        cwd_match = str(payload.get("cwdMatch") or payload.get("cwd_match") or "strict").strip().casefold()
        if cwd_match not in {"strict", "subtree", "confirm"}:
            raise AgentGatewayError("agent_cwd_match_invalid")
        requested_session_id = str(payload.get("sessionId") or payload.get("session_id") or "").strip()
        session: AgentSession | None = None
        if requested_session_id:
            session = self.sessions_registry.resolve(
                str(provider["id"]),
                requested_session_id,
                cwd=cwd,
                cwd_match=cwd_match,
                confirmed=payload.get("sessionConfirmed") is True,
            )
            if session is None:
                raise AgentGatewayError(f"agent_session_not_found:{provider['id']}:{requested_session_id}")
        elif payload.get("autoAttach") is not False:
            session = self.sessions_registry.unique(str(provider["id"]), cwd=cwd, cwd_match=cwd_match)
        if delivery_mode == "active_session" and session is None:
            raise AgentGatewayError(f"agent_existing_session_required:{provider['id']}:{cwd_match}")
        session_id = session.session_id if session is not None else None
        session_evidence = (
            {
                "provider": session.provider,
                "source": session.source,
                "cwdMatch": session.cwd_match,
                "state": session.state,
                "lastActiveAt": session.last_active_at,
                "transport": session.transport,
            }
            if session is not None else {}
        )
        request = AgentRequest(
            provider=str(provider["id"]),
            prompt=prompt,
            cwd=cwd,
            attachments=tuple(str(item) for item in payload.get("attachments") or [] if str(item).strip()),
            permission=permission,
            session_id=session_id,
            resume_token=session.resume_token if session is not None else None,
            metadata={
                **dict(payload.get("privacy") or {}),
                "sessionStrategy": "resume_existing" if session is not None else "new_managed_session",
                "sessionEvidence": session_evidence,
                "contextPacket": {
                    "id": str(payload.get("contextPacketId") or ""),
                    "digest": str(payload.get("contextPacketDigest") or ""),
                    "schemaVersion": int((payload.get("contextPacket") or {}).get("schemaVersion") or 0)
                    if isinstance(payload.get("contextPacket"), dict) else 0,
                },
            },
        )
        background = payload.get("background") is True
        invocation = (
            self.connector.build_rpc_command(request, executable=str(provider["executable"]))
            if background and request.provider == "pi"
            else self.connector.build(request, executable=str(provider["executable"]))
        )
        task = self.task_store.start(request, invocation)
        task["sessionStrategy"] = "resume_existing" if session_id else "new_managed_session"
        task["sessionId"] = session_id
        task["sessionEvidence"] = session_evidence
        task["transport"] = invocation.protocol
        task["steerable"] = invocation.protocol == "jsonl-rpc"
        task["completed"] = False
        task["terminalOutcomeVerified"] = False
        return task

    def status(self, task_id: str) -> dict[str, Any]:
        if self.target_probe is not None:
            raw = self.task_store._read(task_id)
            guard = raw.get("targetLease")
            guard = dict(guard) if isinstance(guard, dict) else {}
            lease = guard.get("lease")
            if isinstance(lease, dict) and raw.get("status") in {"queued", "running"}:
                try:
                    live_windows = self.target_probe(dict(lease))
                except Exception:
                    live_windows = None
                self.task_store.enforce_target_lease(
                    task_id,
                    live_windows=live_windows,
                )
        task = self.task_store.status(task_id)
        status = str(task.get("status") or "")
        terminal = status in {"succeeded", "failed", "cancelled", "interrupted"}
        state = (
            "completed"
            if status == "succeeded"
            else "accepted"
            if status in {"queued", "running", "cancelling"}
            else "paused"
            if status == "paused_target_mismatch"
            else status
        )
        return {
            **task,
            "state": state,
            "completed": status == "succeeded",
            "terminalOutcomeVerified": terminal,
            "reconfirmationRequired": status == "paused_target_mismatch",
            "steerable": (task.get("status") in {"queued", "running"}
                          and str((self._raw_protocol(task_id) or "")) == "jsonl-rpc"),
        }

    def list(self, *, limit: int = 100) -> list[dict[str, Any]]:
        if self.target_probe is None:
            return self.task_store.list(limit=limit)
        bounded = max(0, min(int(limit), 500))
        task_files = sorted(
            self.task_store.root.glob("*/task.json"),
            key=lambda path: path.stat().st_mtime,
            reverse=True,
        )
        results: list[dict[str, Any]] = []
        for task_file in task_files[:bounded]:
            try:
                results.append(self.status(task_file.parent.name))
            except Exception:
                continue
        return results

    def reconfirm_target(
        self,
        task_id: str,
        *,
        confirmed_windows: list[dict[str, Any]],
    ) -> dict[str, Any]:
        task = self.task_store.reconfirm_target(
            task_id,
            confirmed_windows=confirmed_windows,
        )
        status = str(task.get("status") or "")
        return {
            **task,
            "state": "accepted" if status in {"queued", "running"} else status,
            "completed": False,
            "terminalOutcomeVerified": False,
            "reconfirmationRequired": False,
        }

    def _raw_protocol(self, task_id: str) -> str:
        value = self.task_store._read(task_id)
        invocation = value.get("invocation")
        return str(invocation.get("protocol") or "") if isinstance(invocation, dict) else ""
