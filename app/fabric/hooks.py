from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app.fabric.mcp import CurrentObjectStore


_REFERENCE_RE = re.compile(
    r"@(?:pointer|this)\b|\b(?:this|that|these|here|screen|selection)\b|"
    r"这个|这段|这张|这块|这里|刚才那个|屏幕|选区|指针",
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
    return {
        "hookSpecificOutput": {
            "hookEventName": event,
            "additionalContext": episode_context(episode),
        },
        "suppressOutput": True,
    }
