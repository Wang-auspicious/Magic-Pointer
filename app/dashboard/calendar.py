from __future__ import annotations

import json
import os
import threading
import uuid
from contextlib import contextmanager
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

JsonDict = dict[str, Any]
STORE_VERSION = 1
CALENDAR_ID = "local-calendar"
_PROCESS_LOCKS: dict[str, threading.RLock] = {}
_PROCESS_LOCKS_GUARD = threading.Lock()


class CalendarError(RuntimeError):
    pass


class CalendarValidationError(CalendarError):
    pass


class CalendarConflict(CalendarError):
    def __init__(self, message: str, conflicts: list[JsonDict] | None = None) -> None:
        super().__init__(message)
        self.conflicts = conflicts or []


class CalendarDataError(CalendarError):
    pass


def _now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="microseconds")


def _default_root() -> Path:
    configured = os.environ.get("MAGIC_POINTER_USER_DATA_DIR")
    if configured:
        return Path(configured)
    local_app_data = os.environ.get("LOCALAPPDATA")
    if local_app_data:
        return Path(local_app_data) / "Magic Pointer"
    return Path.home() / ".magic-pointer"


def _clean_text(value: Any, *, field: str, maximum: int, required: bool = False) -> str:
    text = " ".join(str(value or "").split())
    if required and not text:
        raise CalendarValidationError(f"{field} is required")
    if len(text) > maximum:
        raise CalendarValidationError(f"{field} exceeds {maximum} characters")
    return text


def _aware_datetime(value: Any, field: str) -> datetime:
    try:
        parsed = datetime.fromisoformat(str(value or ""))
    except ValueError as exc:
        raise CalendarValidationError(f"{field} must be an ISO datetime") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise CalendarValidationError(f"{field} must include a UTC offset")
    return parsed


def _safe_source(source: Any) -> JsonDict:
    if not isinstance(source, dict):
        return {}
    allowed = ("selection_snapshot_id", "app", "window_title", "content_sha256")
    return {
        key: str(source[key])[:1000]
        for key in allowed
        if source.get(key) is not None and str(source[key]).strip()
    }


def normalize_event(value: Any) -> JsonDict:
    if not isinstance(value, dict):
        raise CalendarValidationError("event must be an object")
    title = _clean_text(value.get("title"), field="title", maximum=160, required=True)
    location = _clean_text(value.get("location"), field="location", maximum=240)
    notes = str(value.get("notes") or "").strip()
    if len(notes) > 4000:
        raise CalendarValidationError("notes exceeds 4000 characters")
    timezone_name = str(value.get("timezone") or "").strip()
    try:
        zone = ZoneInfo(timezone_name)
    except (ZoneInfoNotFoundError, ValueError) as exc:
        raise CalendarValidationError("timezone is not a known IANA timezone") from exc
    start = _aware_datetime(value.get("start_at"), "start_at")
    end = _aware_datetime(value.get("end_at"), "end_at")
    if start.astimezone(zone).utcoffset() != start.utcoffset():
        raise CalendarValidationError("start_at offset does not match timezone")
    if end.astimezone(zone).utcoffset() != end.utcoffset():
        raise CalendarValidationError("end_at offset does not match timezone")
    if end <= start:
        raise CalendarValidationError("end_at must be after start_at")
    if end - start > timedelta(days=7):
        raise CalendarValidationError("event duration exceeds seven days")
    all_day = value.get("all_day", False)
    if not isinstance(all_day, bool):
        raise CalendarValidationError("all_day must be boolean")
    return {
        "title": title,
        "start_at": start.isoformat(timespec="seconds"),
        "end_at": end.isoformat(timespec="seconds"),
        "timezone": timezone_name,
        "location": location,
        "notes": notes,
        "all_day": all_day,
    }


def _utc(value: str) -> datetime:
    return datetime.fromisoformat(value).astimezone(timezone.utc)


class CalendarEventStore:
    def __init__(self, root: Path | str | None = None) -> None:
        self.root = Path(root) if root is not None else _default_root()
        self.path = self.root / "dashboard" / "calendar_events.json"

    @staticmethod
    def _default_state() -> JsonDict:
        return {
            "version": STORE_VERSION,
            "revision": 0,
            "calendar": {
                "id": CALENDAR_ID,
                "name": "本地日历",
                "events": [],
                "receipts": [],
            },
        }

    def _validate_state(self, state: Any) -> JsonDict:
        if not isinstance(state, dict) or state.get("version") != STORE_VERSION:
            raise CalendarDataError("unsupported calendar schema version")
        if not isinstance(state.get("revision"), int) or state["revision"] < 0:
            raise CalendarDataError("invalid calendar revision")
        calendar = state.get("calendar")
        if not isinstance(calendar, dict) or calendar.get("id") != CALENDAR_ID:
            raise CalendarDataError("invalid calendar identity")
        if not isinstance(calendar.get("events"), list) or not isinstance(calendar.get("receipts"), list):
            raise CalendarDataError("invalid calendar records")
        for event in calendar["events"]:
            if not isinstance(event, dict) or not isinstance(event.get("id"), str):
                raise CalendarDataError("invalid calendar event")
        return state

    def _load(self) -> JsonDict:
        if not self.path.exists():
            return self._default_state()
        try:
            state = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise CalendarDataError(f"could not read calendar: {type(exc).__name__}: {exc}") from exc
        return self._validate_state(state)

    def _save(self, state: JsonDict) -> None:
        validated = self._validate_state(state)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temp_path = self.path.with_suffix(self.path.suffix + ".tmp")
        try:
            with temp_path.open("w", encoding="utf-8", newline="\n") as handle:
                json.dump(validated, handle, ensure_ascii=False, indent=2)
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            temp_path.replace(self.path)
        except OSError as exc:
            raise CalendarDataError(f"could not persist calendar: {type(exc).__name__}: {exc}") from exc

    @contextmanager
    def _mutation_lock(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        lock_path = self.path.with_suffix(self.path.suffix + ".lock")
        lock_key = str(lock_path.resolve())
        with _PROCESS_LOCKS_GUARD:
            process_lock = _PROCESS_LOCKS.setdefault(lock_key, threading.RLock())
        with process_lock, lock_path.open("a+b") as handle:
            handle.seek(0, os.SEEK_END)
            if handle.tell() == 0:
                handle.write(b"\0")
                handle.flush()
            handle.seek(0)
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(handle.fileno(), msvcrt.LK_LOCK, 1)
            else:
                import fcntl

                fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                handle.seek(0)
                if os.name == "nt":
                    msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    fcntl.flock(handle.fileno(), fcntl.LOCK_UN)

    @staticmethod
    def _active_events(state: JsonDict) -> list[JsonDict]:
        return [event for event in state["calendar"]["events"] if not event.get("removed_at")]

    @staticmethod
    def _conflicts(state: JsonDict, event: JsonDict) -> list[JsonDict]:
        start = _utc(event["start_at"])
        end = _utc(event["end_at"])
        return [
            deepcopy(existing)
            for existing in CalendarEventStore._active_events(state)
            if start < _utc(existing["end_at"]) and _utc(existing["start_at"]) < end
        ]

    def public_calendar(self) -> JsonDict:
        state = self._load()
        events = [deepcopy(event) for event in self._active_events(state)]
        events.sort(key=lambda event: _utc(event["start_at"]))
        return {
            "version": STORE_VERSION,
            "revision": state["revision"],
            "id": CALENDAR_ID,
            "name": state["calendar"].get("name") or "本地日历",
            "events": events,
        }

    def preview_conflicts(self, event: Any) -> list[JsonDict]:
        normalized = normalize_event(event)
        return self._conflicts(self._load(), normalized)

    def create_event(
        self,
        event: Any,
        *,
        idempotency_key: str,
        source: Any,
        allow_conflict: bool = False,
        now: str | None = None,
    ) -> JsonDict:
        normalized = normalize_event(event)
        key = str(idempotency_key or "").strip()
        if not key:
            raise CalendarValidationError("idempotency key is required")
        if not isinstance(allow_conflict, bool):
            raise CalendarValidationError("allow_conflict must be boolean")
        with self._mutation_lock():
            state = self._load()
            existing = next((entry for entry in state["calendar"]["events"] if entry.get("idempotency_key") == key), None)
            if existing is not None:
                if existing.get("removed_at"):
                    raise CalendarConflict("the idempotent event creation was already undone")
                return {
                    "created": False,
                    "verified": True,
                    "receipt_id": existing.get("create_receipt_id"),
                    "event": deepcopy(existing),
                    "conflicts": [],
                    "revision": state["revision"],
                }
            conflicts = self._conflicts(state, normalized)
            if conflicts and not allow_conflict:
                raise CalendarConflict("calendar event overlaps an existing event", conflicts)
            stamp = now or _now_iso()
            event_id = f"event-{uuid.uuid4().hex[:16]}"
            receipt_id = f"receipt-{uuid.uuid4().hex[:16]}"
            stored = {
                "id": event_id,
                **normalized,
                "idempotency_key": key,
                "source": _safe_source(source),
                "create_receipt_id": receipt_id,
                "created_at": stamp,
                "updated_at": stamp,
                "removed_at": None,
            }
            state["calendar"]["events"].append(stored)
            state["calendar"]["receipts"].append({
                "id": receipt_id,
                "action_type": "calendar_event_create",
                "event_id": event_id,
                "created_at": stamp,
                "undone_at": None,
            })
            state["revision"] += 1
            self._save(state)
            verified = next((entry for entry in self._load()["calendar"]["events"] if entry.get("id") == event_id), None)
            if not verified or any(verified.get(field) != value for field, value in normalized.items()):
                raise CalendarDataError("calendar event write verification failed")
            return {
                "created": True,
                "verified": True,
                "receipt_id": receipt_id,
                "event": deepcopy(verified),
                "conflicts": conflicts,
                "revision": state["revision"],
            }

    def undo_create(
        self,
        event_id: str,
        receipt_id: str,
        expected_updated_at: str,
        *,
        now: str | None = None,
    ) -> JsonDict:
        with self._mutation_lock():
            state = self._load()
            event = next((entry for entry in state["calendar"]["events"] if entry.get("id") == event_id), None)
            if not event or event.get("removed_at"):
                raise CalendarConflict("calendar event no longer exists")
            receipt = next((entry for entry in state["calendar"]["receipts"] if entry.get("id") == receipt_id), None)
            if not receipt or receipt.get("action_type") != "calendar_event_create" or receipt.get("event_id") != event_id:
                raise CalendarConflict("calendar event receipt does not match")
            if receipt.get("undone_at"):
                raise CalendarConflict("calendar event creation was already undone")
            if event.get("updated_at") != expected_updated_at:
                raise CalendarConflict("calendar event changed after creation")
            stamp = now or _now_iso()
            event["removed_at"] = stamp
            event["updated_at"] = stamp
            receipt["undone_at"] = stamp
            state["revision"] += 1
            self._save(state)
            verified = next((entry for entry in self._load()["calendar"]["events"] if entry.get("id") == event_id), None)
            if not verified or verified.get("removed_at") != stamp:
                raise CalendarDataError("calendar event undo verification failed")
            return {"verified": True, "event": deepcopy(verified), "revision": state["revision"]}
