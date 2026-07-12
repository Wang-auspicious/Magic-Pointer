from __future__ import annotations

import re
from typing import Any

_ENGLISH = (
    re.compile(r"^route\s+(?:these|them)$", re.IGNORECASE),
    re.compile(r"^get\s+directions\s+between\s+(?:these|them)$", re.IGNORECASE),
    re.compile(r"^plan\s+(?:a\s+)?route\s+between\s+(?:these|them)$", re.IGNORECASE),
)
_CHINESE = {"规划路线", "这两个地方怎么走", "这两处怎么走", "查看路线", "生成路线"}


def wants_route_draft(command: str) -> bool:
    normalized = " ".join(str(command or "").strip().split())
    return normalized in _CHINESE or any(pattern.fullmatch(normalized) for pattern in _ENGLISH)


def _location(obj: Any) -> str:
    if not isinstance(obj, dict):
        return ""
    text = " ".join(str(obj.get("content") or "").split())
    if not text or len(text) > 240 or any(ord(char) < 32 for char in text):
        return ""
    return text


def _safe_source(obj: Any) -> dict[str, Any]:
    if not isinstance(obj, dict):
        return {}
    return {
        key: obj.get(key)
        for key in ("objectId", "label", "app", "windowTitle")
        if obj.get(key) is not None
    }


def parse_route_draft(interaction_episode: Any) -> dict[str, Any]:
    slots = interaction_episode.get("slots") if isinstance(interaction_episode, dict) else {}
    slots = slots if isinstance(slots, dict) else {}
    these = slots.get("these") if isinstance(slots.get("these"), list) else []
    if len(these) == 2:
        origin_obj, destination_obj = these
    else:
        origin_obj, destination_obj = slots.get("that"), slots.get("this")
    origin = _location(origin_obj)
    destination = _location(destination_obj)
    missing = []
    if not origin:
        missing.append("origin")
    if not destination:
        missing.append("destination")
    return {
        "origin": origin,
        "destination": destination,
        "travel_mode": "driving",
        "origin_source": _safe_source(origin_obj),
        "destination_source": _safe_source(destination_obj),
        "episode_id": str(interaction_episode.get("episodeId") or "") if isinstance(interaction_episode, dict) else "",
        "missing_fields": missing,
    }
