from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path
from typing import Any


@dataclass
class PointerObject:
    """A user-selected screen object.

    ObjectStore is a durable local log, not the active AI context. Active
    this/that/group references are session-scoped by TaskContextStore so old
    screenshots do not pollute new tasks.
    """

    id: str
    alias: str
    kind: str
    bbox: tuple[int, int, int, int]
    image_path: str
    app_title: str
    prompt: str
    answer: str
    created_at: str
    screen_context: dict[str, Any] | None = None


class ObjectStore:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)
        self.log_path = self.root / "objects.jsonl"

    def append(self, obj: PointerObject) -> None:
        with self.log_path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(asdict(obj), ensure_ascii=False) + "\n")

    def iter_objects(self) -> list[dict[str, Any]]:
        objects: list[dict[str, Any]] = []
        if not self.log_path.exists():
            return objects
        with self.log_path.open("r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    objects.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
        return objects

    def recent(self, limit: int = 5) -> list[dict[str, Any]]:
        """Return recent log objects for history/debug UI only.

        Do not use this as implicit model context. TaskContextStore decides the
        current task scope.
        """

        if limit <= 0:
            return []
        return list(reversed(self.iter_objects()))[:limit]

    def object_by_id(self, object_id: str) -> dict[str, Any] | None:
        for obj in reversed(self.iter_objects()):
            if obj.get("id") == object_id:
                return obj
        return None

    def latest_alias_snapshot(self) -> dict[str, Any]:
        """Return persisted-log aliases for diagnostics only.

        Runtime aliases are task-scoped and are built by TaskContextStore.
        """

        objects = self.iter_objects()
        if not objects:
            return {}
        latest = objects[-1]
        previous = objects[-2] if len(objects) >= 2 else None
        return {
            "this": latest,
            "that": previous,
            "count": len(objects),
        }

    def build_reference_context(self, current_id: str, current_bbox: tuple[int, int, int, int], limit: int = 4) -> str:
        """Build diagnostic history context.

        Kept for compatibility/tests. Model calls should prefer
        TaskContextStore.build_reference_context().
        """

        recent = self.recent(limit)
        lines = [
            "Object log v1 (diagnostic only; not active task context):",
            f"this: id={current_id!r}, kind='screen_region', bbox={current_bbox}",
        ]
        if recent:
            lines.append("recent_log:")
            for i, obj in enumerate(recent, 1):
                lines.append(
                    f"  {i}. id={obj.get('id')!r}, image_path={obj.get('image_path')!r}, "
                    f"app_title={obj.get('app_title')!r}, prompt={obj.get('prompt')!r}"
                )
        else:
            lines.append("recent_log: []")
        return "\n".join(lines)


def new_object_id() -> str:
    return datetime.now().strftime("obj_%Y%m%d_%H%M%S_%f")
