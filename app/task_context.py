from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any


@dataclass
class TaskContextResult:
    task: dict[str, Any]
    rolled_over: bool = False


class TaskContextStore:
    """Lightweight current-task context, separate from persistent object history.

    ObjectStore keeps the full local log. TaskContextStore decides which recent
    objects are part of the *current task* and therefore allowed into model
    context. This prevents yesterday's screenshots from polluting today's short
    task while still allowing a previous task to be restored explicitly.
    """

    def __init__(self, root: Path, idle_timeout_minutes: int = 30) -> None:
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)
        self.state_path = self.root / "task_state.json"
        self.idle_timeout = timedelta(minutes=idle_timeout_minutes)

    def _now(self) -> datetime:
        return datetime.now()

    @staticmethod
    def _iso(dt: datetime) -> str:
        return dt.isoformat(timespec="seconds")

    @staticmethod
    def _parse_time(value: str | None) -> datetime | None:
        if not value:
            return None
        try:
            return datetime.fromisoformat(value)
        except ValueError:
            return None

    def _new_task(self, now: datetime) -> dict[str, Any]:
        task_id = now.strftime("task_%Y%m%d_%H%M%S_%f")
        return {
            "id": task_id,
            "created_at": self._iso(now),
            "updated_at": self._iso(now),
            "object_ids": [],
            "messages": [],
            "destination_id": None,
        }

    def _default_state(self, now: datetime) -> dict[str, Any]:
        task = self._new_task(now)
        return {
            "active_task_id": task["id"],
            "previous_task_id": None,
            "tasks": {task["id"]: task},
        }

    def _load_state(self, now: datetime | None = None) -> dict[str, Any]:
        now = now or self._now()
        if not self.state_path.exists():
            state = self._default_state(now)
            self._save_state(state)
            return state
        try:
            raw = json.loads(self.state_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            state = self._default_state(now)
            self._save_state(state)
            return state
        tasks = raw.get("tasks")
        if not isinstance(tasks, dict):
            tasks = {}
        clean_tasks: dict[str, dict[str, Any]] = {}
        for task_id, task in tasks.items():
            if not isinstance(task_id, str) or not isinstance(task, dict):
                continue
            object_ids = task.get("object_ids")
            messages = task.get("messages")
            destination_id = task.get("destination_id")
            clean_tasks[task_id] = {
                "id": task_id,
                "created_at": str(task.get("created_at") or self._iso(now)),
                "updated_at": str(task.get("updated_at") or self._iso(now)),
                "object_ids": [x for x in object_ids if isinstance(x, str)] if isinstance(object_ids, list) else [],
                "messages": [x for x in messages if isinstance(x, dict)] if isinstance(messages, list) else [],
                "destination_id": destination_id if isinstance(destination_id, str) else None,
            }
        active_task_id = raw.get("active_task_id") if isinstance(raw.get("active_task_id"), str) else None
        previous_task_id = raw.get("previous_task_id") if isinstance(raw.get("previous_task_id"), str) else None
        if not active_task_id or active_task_id not in clean_tasks:
            task = self._new_task(now)
            clean_tasks[task["id"]] = task
            active_task_id = task["id"]
        if previous_task_id not in clean_tasks:
            previous_task_id = None
        return {"active_task_id": active_task_id, "previous_task_id": previous_task_id, "tasks": clean_tasks}

    def _save_state(self, state: dict[str, Any]) -> None:
        self.state_path.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")

    def active_task(self, now: datetime | None = None, auto_rollover: bool = True) -> TaskContextResult:
        now = now or self._now()
        state = self._load_state(now)
        active_id = state["active_task_id"]
        task = state["tasks"][active_id]
        rolled_over = False
        updated_at = self._parse_time(task.get("updated_at"))
        if auto_rollover and updated_at and now - updated_at > self.idle_timeout:
            new_task = self._new_task(now)
            state["previous_task_id"] = active_id
            state["active_task_id"] = new_task["id"]
            state["tasks"][new_task["id"]] = new_task
            self._save_state(state)
            task = new_task
            rolled_over = True
        else:
            self._save_state(state)
        return TaskContextResult(task=task, rolled_over=rolled_over)

    def start_new_task(self, now: datetime | None = None) -> dict[str, Any]:
        now = now or self._now()
        state = self._load_state(now)
        old_active = state.get("active_task_id")
        task = self._new_task(now)
        if old_active in state["tasks"]:
            state["previous_task_id"] = old_active
        state["active_task_id"] = task["id"]
        state["tasks"][task["id"]] = task
        self._save_state(state)
        return task

    def restore_previous_task(self, now: datetime | None = None) -> dict[str, Any] | None:
        now = now or self._now()
        state = self._load_state(now)
        previous_id = state.get("previous_task_id")
        active_id = state.get("active_task_id")
        if not previous_id or previous_id not in state["tasks"]:
            return None
        state["active_task_id"] = previous_id
        state["previous_task_id"] = active_id if active_id in state["tasks"] else None
        task = state["tasks"][previous_id]
        task["updated_at"] = self._iso(now)
        self._save_state(state)
        return task

    def previous_task_id(self) -> str | None:
        state = self._load_state()
        return state.get("previous_task_id")

    def get_task(self, task_id: str) -> dict[str, Any] | None:
        state = self._load_state()
        task = state["tasks"].get(task_id)
        return task if isinstance(task, dict) else None

    def _ensure_task(self, state: dict[str, Any], task_id: str, now: datetime) -> dict[str, Any]:
        task = state["tasks"].get(task_id)
        if not isinstance(task, dict):
            task = self._new_task(now)
            task["id"] = task_id
            state["tasks"][task_id] = task
        task.setdefault("object_ids", [])
        task.setdefault("messages", [])
        task.setdefault("destination_id", None)
        return task

    def add_object(self, task_id: str, object_id: str, now: datetime | None = None) -> dict[str, Any]:
        now = now or self._now()
        state = self._load_state(now)
        task = self._ensure_task(state, task_id, now)
        object_ids = task.setdefault("object_ids", [])
        if object_id not in object_ids:
            object_ids.append(object_id)
        task["updated_at"] = self._iso(now)
        state["active_task_id"] = task_id
        self._save_state(state)
        return task

    def add_interaction(self, task_id: str, object_id: str, prompt: str, answer: str, now: datetime | None = None) -> dict[str, Any]:
        now = now or self._now()
        state = self._load_state(now)
        task = self._ensure_task(state, task_id, now)
        object_ids = task.setdefault("object_ids", [])
        if object_id not in object_ids:
            object_ids.append(object_id)
        task.setdefault("messages", []).append({
            "object_id": object_id,
            "prompt": prompt,
            "answer": answer,
            "created_at": self._iso(now),
        })
        task["updated_at"] = self._iso(now)
        state["active_task_id"] = task_id
        self._save_state(state)
        return task

    def set_destination(self, task_id: str, object_id: str, now: datetime | None = None) -> dict[str, Any]:
        now = now or self._now()
        state = self._load_state(now)
        task = self._ensure_task(state, task_id, now)
        object_ids = task.setdefault("object_ids", [])
        if object_id not in object_ids:
            object_ids.append(object_id)
        task["destination_id"] = object_id
        task["updated_at"] = self._iso(now)
        state["active_task_id"] = task_id
        self._save_state(state)
        return task

    def clear_destination(self, task_id: str, now: datetime | None = None) -> dict[str, Any] | None:
        now = now or self._now()
        state = self._load_state(now)
        task = state["tasks"].get(task_id)
        if not isinstance(task, dict):
            return None
        task["destination_id"] = None
        task["updated_at"] = self._iso(now)
        state["active_task_id"] = task_id
        self._save_state(state)
        return task

    def task_objects(self, object_store: Any, task_id: str) -> list[dict[str, Any]]:
        task = self.get_task(task_id)
        if not task:
            return []
        objects: list[dict[str, Any]] = []
        for object_id in task.get("object_ids", []):
            obj = object_store.object_by_id(object_id)
            if obj:
                objects.append(obj)
        return objects

    def destination_object(self, object_store: Any, task_id: str) -> dict[str, Any] | None:
        task = self.get_task(task_id)
        if not task:
            return None
        destination_id = task.get("destination_id")
        if not isinstance(destination_id, str):
            return None
        return object_store.object_by_id(destination_id)

    def build_reference_context(self, object_store: Any, task_id: str, current_id: str, current_bbox: tuple[int, int, int, int]) -> str:
        task = self.get_task(task_id) or {"id": task_id, "object_ids": [], "messages": []}
        task_objects = self.task_objects(object_store, task_id)
        previous = task_objects[-1] if task_objects else None
        destination = self.destination_object(object_store, task_id)
        lines = [
            "Task context v1:",
            f"current_task_id={task_id!r}",
            "Only objects in current_task are active context. Full object history is a log and must not be inferred as context.",
            "alias=this means the object selected in the current turn.",
            "alias=that means the previous object in the current task, not global history.",
            "alias=group means current task objects plus THIS; it is session-scoped, not all history.",
            "alias=destination means the explicit destination object in the current task, used for commands like put it there/write there/place there.",
            f"this: id={current_id!r}, kind='screen_region', bbox={current_bbox}",
        ]
        if previous:
            lines.append(
                f"that: id={previous.get('id')!r}, kind={previous.get('kind')!r}, image_path={previous.get('image_path')!r}, "
                f"app_title={previous.get('app_title')!r}, created_at={previous.get('created_at')!r}, "
                f"last_prompt={previous.get('prompt')!r}"
            )
        else:
            lines.append("that: null")
        if destination:
            lines.append(
                f"destination: id={destination.get('id')!r}, kind={destination.get('kind')!r}, image_path={destination.get('image_path')!r}, "
                f"app_title={destination.get('app_title')!r}, prompt={destination.get('prompt')!r}"
            )
        else:
            lines.append("destination: null")
        if task_objects:
            lines.append("current_task_objects:")
            for i, obj in enumerate(task_objects, 1):
                lines.append(
                    f"  T{i}. id={obj.get('id')!r}, image_path={obj.get('image_path')!r}, "
                    f"app_title={obj.get('app_title')!r}, prompt={obj.get('prompt')!r}"
                )
        else:
            lines.append("current_task_objects: []")
        lines.append("group_pending_this: include THIS with current_task_objects when the user says group/these/them.")
        lines.append(f"message_count={len(task.get('messages', []))}")
        return "\n".join(lines)
