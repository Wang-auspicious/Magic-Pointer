from __future__ import annotations

import json
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


_SENSITIVE_KEYS = {
    "prompt",
    "content",
    "text",
    "screenshot",
    "image",
    "audio",
    "clipboard",
    "api_key",
    "token",
    "secret",
}


def _redact(value: Any, key: str | None = None) -> Any:
    if key and key.casefold() in _SENSITIVE_KEYS:
        return "[redacted]"
    if isinstance(value, dict):
        return {str(item_key): _redact(item, str(item_key)) for item_key, item in value.items()}
    if isinstance(value, list):
        return [_redact(item) for item in value[:100]]
    if isinstance(value, str):
        return value[:1000]
    return value


class AuditStore:
    def __init__(self, path: Path | str | None = None) -> None:
        root = Path(os.environ.get("MAGIC_POINTER_USER_DATA_DIR") or Path.cwd() / "data" / "runtime")
        self.path = Path(path) if path is not None else root / "fabric-audit.jsonl"

    def append(self, event_type: str, data: dict[str, Any] | None = None) -> dict[str, Any]:
        event = {
            "eventId": str(uuid.uuid4()),
            "timestamp": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
            "type": str(event_type or "unknown")[:120],
            "data": _redact(dict(data or {})),
        }
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.path.open("a", encoding="utf-8", newline="\n") as handle:
            handle.write(json.dumps(event, ensure_ascii=False, separators=(",", ":")) + "\n")
        return event

    def tail(self, limit: int = 100) -> list[dict[str, Any]]:
        if not self.path.exists():
            return []
        items: list[dict[str, Any]] = []
        with self.path.open("r", encoding="utf-8", errors="replace") as handle:
            for line in handle:
                try:
                    value = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(value, dict):
                    items.append(value)
        return items[-max(0, min(int(limit), 500)):]

