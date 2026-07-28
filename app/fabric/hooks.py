from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app.fabric.capabilities import CapabilityRegistry
from app.fabric.capture_policy import CapturePolicyEngine, build_capture_policy
from app.fabric.context_packet import (
    ContextPacketBuilder,
    build_agent_prompt,
    write_context_packet_artifact,
)
from app.fabric.mcp import CurrentObjectStore
from app.fabric.settings import SettingsStore
from app.fabric.target_lease import TargetLease


_REFERENCE_RE = re.compile(
    r"@(?:pointer|this)\b|\b(?:this|that|these|here|screen|selection)\b|"
    r"这个|这段|这张|这块|这里|刚才那个|屏幕|选区|指针",
    re.IGNORECASE,
)
_REFERENCE_RE = re.compile(
    _REFERENCE_RE.pattern + r"|这个|这段|这张|这块|这里|刚才那个|这些|那些|屏幕|选区|指针",
    re.IGNORECASE,
)


def prompt_references_pointer(prompt: str) -> bool:
    return bool(_REFERENCE_RE.search(str(prompt or "")))


def _parse_time(value: Any) -> datetime | None:
    raw = str(value or "").strip()
    if not raw:
        return None
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=timezone.utc)


def read_live_episode(root: Path | str, *, now: datetime | None = None) -> dict[str, Any] | None:
    episode = CurrentObjectStore(Path(root) / "current-object.json").read()
    if episode is None:
        return None
    expires = _parse_time(episode.get("expiresAt"))
    current = now or datetime.now(timezone.utc)
    if expires is not None and expires <= current:
        return None
    return episode


def episode_context(episode: dict[str, Any], *, max_chars: int = 9000) -> str:
    objects = [dict(item) for item in episode.get("objects") or [] if isinstance(item, dict)]
    slots = dict(episode.get("slots") or {})
    lines = [
        "[Magic Pointer grounded context]",
        f"episode_id: {episode.get('episodeId') or ''}",
        f"expires_at: {episode.get('expiresAt') or ''}",
        "Reference words THIS/THAT/THESE/HERE refer only to the frozen objects below.",
        "Do not recapture the desktop. Treat file paths and geometry as evidence; verify before mutation.",
        f"slots: {json.dumps(slots, ensure_ascii=False, default=str)}",
    ]
    for index, obj in enumerate(objects[:12], 1):
        source = dict(obj.get("source") or {})
        lines.extend([
            "",
            f"object_{index}:",
            f"  id: {obj.get('id') or obj.get('objectId') or ''}",
            f"  kind: {obj.get('kind') or ''}",
            f"  label: {obj.get('label') or ''}",
            f"  bbox: {json.dumps(obj.get('bbox'), ensure_ascii=False, default=str)}",
            f"  app: {source.get('app') or ''}",
            f"  title: {source.get('title') or ''}",
            f"  path: {source.get('path') or source.get('screenshotPath') or ''}",
            f"  url: {source.get('url') or ''}",
            f"  page: {source.get('page') if source.get('page') is not None else ''}",
        ])
        content = str(obj.get("content") or "").strip()
        if content:
            lines.append(f"  content: {content[:4000]}")
    return "\n".join(lines)[:max_chars]


def _attachment_candidates(objects: list[dict[str, Any]]) -> list[str]:
    values: list[str] = []
    for obj in objects:
        source = obj.get("source")
        source = dict(source) if isinstance(source, dict) else {}
        for raw in (
            obj.get("path"),
            source.get("path"),
            source.get("documentPath"),
            source.get("document_path"),
            source.get("imagePath"),
            source.get("screenshotPath"),
            source.get("capturePath"),
        ):
            value = str(raw or "").strip()
            if value and value not in values:
                values.append(value)
    return values


def _safe_slots(episode: dict[str, Any]) -> dict[str, Any]:
    slots = episode.get("slots")
    slots = dict(slots) if isinstance(slots, dict) else {}

    def object_id(value: Any) -> str:
        if not isinstance(value, dict):
            return ""
        return str(value.get("objectId") or value.get("id") or "")

    safe: dict[str, Any] = {}
    for key in ("this", "that", "here"):
        value = object_id(slots.get(key))
        if value:
            safe[key] = value
    these = slots.get("these")
    if isinstance(these, list):
        values = [object_id(item) for item in these]
        safe["these"] = [item for item in values if item][:12]
    return safe


def build_hook_response(
    provider: str,
    payload: dict[str, Any],
    *,
    root: Path | str,
    now: datetime | None = None,
    auto_context: bool = False,
) -> dict[str, Any]:
    provider_name = str(provider or "").casefold()
    event = str(payload.get("hook_event_name") or payload.get("hookEventName") or "")
    expected = "UserPromptSubmit" if provider_name == "claude" else "BeforeAgent"
    if event != expected:
        return {}
    prompt = str(payload.get("prompt") or "")
    if not auto_context and not prompt_references_pointer(prompt):
        return {}
    episode = read_live_episode(root, now=now)
    if episode is None:
        return {}
    root_path = Path(root)
    objects = [
        dict(item)
        for item in episode.get("objects") or []
        if isinstance(item, dict)
    ][:12]
    settings = SettingsStore(root_path / "fabric-settings.json").load()
    capture_engine = CapturePolicyEngine(
        settings.privacy.upload_screenshots,
        settings.privacy.default_capture_mode,
        settings.privacy.sensitive_apps,
        settings.privacy.app_capture_modes,
    )
    attachments = _attachment_candidates(objects)
    capture_policy = build_capture_policy(
        capture_engine,
        objects,
        attachments=attachments,
    )
    if objects and len(capture_policy["deniedObjectIds"]) == len(objects):
        return {}
    lease = TargetLease.create(
        objects,
        selection_session_id=str(episode.get("episodeId") or ""),
        ttl_seconds=600,
        now=now,
    )
    capabilities = CapabilityRegistry().search(
        prompt,
        objects=objects,
        selected_recipe_id="agent.handoff",
        platform=str(payload.get("platform") or "") or None,
        limit=6,
    )
    packet = ContextPacketBuilder().build(
        command=prompt,
        recipe_id="agent.handoff",
        objects=objects,
        cwd=str(payload.get("cwd") or payload.get("workspaceRoot") or Path.cwd()),
        target_lease=lease.to_dict(),
        capture_decisions=list(capture_policy["decisions"]),
        capabilities=capabilities,
        terminal_excerpt=str(payload.get("terminalExcerpt") or ""),
        attachments=attachments,
    )
    artifact = write_context_packet_artifact(packet, root=root_path)
    additional_context = build_agent_prompt(packet, artifact_path=artifact)
    safe_slots = _safe_slots(episode)
    if safe_slots:
        additional_context += (
            "\n\nReference slots THIS/THAT/THESE/HERE: "
            + json.dumps(safe_slots, ensure_ascii=False, separators=(",", ":"))
        )
    return {
        "hookSpecificOutput": {
            "hookEventName": event,
            "additionalContext": additional_context[:12_000],
        },
        "suppressOutput": True,
    }
