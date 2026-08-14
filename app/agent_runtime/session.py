"""Append-only, event-sourced Agent sessions.

The contract and failure semantics are adapted from DeepSeek Harness's
``packages/core/session`` (MIT): the raw log is authoritative, model history
is a projection of explicit surface events, compaction appends a replacement
instead of rewriting history, and interrupted tool calls are repaired with
different messages for "not started" and "outcome unknown".

This is intentionally smaller than DSH's general-purpose TypeScript package.
Magic Pointer runs short, local desktop tasks, so one stdlib JSONL store with a
hash chain is enough. It still enforces the invariant that matters:
``model-visible means logged``.
"""

from __future__ import annotations

import copy
import hashlib
import json
import math
import os
import re
import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator, Mapping, Sequence

from app.agent_runtime.types import AgentMessage, ORIGIN_DATA, Role

__all__ = [
    "EventSession",
    "FileSessionStore",
    "ModelSurfaceMismatch",
    "SessionCorruptionError",
    "SessionEvent",
    "SessionForkError",
    "SessionHeader",
]

SESSION_FORMAT_VERSION = 1
_SESSION_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_ZERO_HASH = "0" * 64
_PROCESS_FILE_LOCKS: dict[str, threading.RLock] = {}
_PROCESS_FILE_LOCKS_GUARD = threading.Lock()

_TOOL_NOT_STARTED = (
    "TOOL_NOT_STARTED: The tool call was interrupted before the Harness "
    "recorded it as started. Retry it if it is still needed."
)
_TOOL_OUTCOME_UNKNOWN = (
    "TOOL_OUTCOME_UNKNOWN: The tool call was interrupted after it was "
    "recorded, but no result was durably recorded. Its outcome is unknown. "
    "Retry only when the operation is read-only or idempotent; otherwise "
    "verify external state or ask the user first."
)


@contextmanager
def _exclusive_file_lock(lock_path: Path) -> Iterator[None]:
    """Portable advisory lock, coordinated across local store instances."""
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    lock_key = str(lock_path.resolve())
    with _PROCESS_FILE_LOCKS_GUARD:
        process_lock = _PROCESS_FILE_LOCKS.setdefault(lock_key, threading.RLock())
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


class SessionCorruptionError(RuntimeError):
    """The durable log cannot be reconstructed without inventing history."""


class ModelSurfaceMismatch(RuntimeError):
    """A caller tried to send model messages not projected by the log."""


class SessionForkError(RuntimeError):
    """A requested fork boundary is not a stable completed-turn boundary."""


@dataclass(frozen=True, slots=True)
class SessionHeader:
    version: int
    session_id: str
    created_at_ms: int
    parent_session_id: str | None = None
    seed_length: int = 0


@dataclass(frozen=True, slots=True)
class SessionEvent:
    session_id: str
    seq: int
    time_ms: int
    type: str
    data: dict[str, Any]
    surface_op: str | None
    prev_hash: str
    hash: str

    def to_dict(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "formatVersion": SESSION_FORMAT_VERSION,
            "sessionId": self.session_id,
            "seq": self.seq,
            "time": self.time_ms,
            "type": self.type,
            "data": copy.deepcopy(self.data),
            "prevHash": self.prev_hash,
        }
        if self.surface_op is not None:
            payload["surfaceOp"] = self.surface_op
        payload["hash"] = self.hash
        return payload


def _canonical_bytes(value: Any) -> bytes:
    try:
        return json.dumps(
            value,
            ensure_ascii=False,
            allow_nan=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    except (TypeError, ValueError, OverflowError) as exc:
        raise ValueError(f"value is not losslessly JSON-serializable: {exc}") from exc


def _snapshot_json(value: Any) -> Any:
    """Validate and detach one durable value through a single JSON form."""
    return json.loads(_canonical_bytes(value).decode("utf-8"))


def _event_hash(payload_without_hash: Mapping[str, Any]) -> str:
    return hashlib.sha256(_canonical_bytes(payload_without_hash)).hexdigest()


class EventSession:
    """One local append-only JSONL session and its model-surface projection."""

    def __init__(
        self,
        path: Path,
        header: SessionHeader,
        events: list[SessionEvent],
        *,
        repaired_tail_bytes: int = 0,
    ) -> None:
        self.path = path
        self.header = header
        self._events = events
        self._surface: list[AgentMessage] = []
        self._lock = threading.RLock()
        self._turn_lease_context: Any | None = None
        self.repaired_tail_bytes = repaired_tail_bytes
        self._rebuild_surface()

    @property
    def id(self) -> str:
        return self.header.session_id

    @property
    def events(self) -> tuple[SessionEvent, ...]:
        # SessionEvent is frozen but its JSON ``data`` payload is not.
        # Never expose the authoritative in-memory hash-chain objects.
        return tuple(copy.deepcopy(self._events))

    @property
    def open_turn(self) -> int | None:
        opened: int | None = None
        for event in self._events:
            if event.type == "turn/start":
                if opened is not None:
                    raise SessionCorruptionError(
                        f"turn {event.data.get('turn')} starts while {opened} is open"
                    )
                opened = int(event.data["turn"])
            elif event.type == "turn/end":
                if opened != int(event.data.get("turn") or -1):
                    raise SessionCorruptionError("turn/end does not match the open turn")
                opened = None
        return opened

    @property
    def next_turn(self) -> int:
        highest = 0
        for event in self._events:
            if event.type == "turn/start":
                highest = max(highest, int(event.data["turn"]))
        return highest + 1

    def derive_messages(self) -> list[AgentMessage]:
        """Return a deep snapshot projected only from explicit events.

        ``AgentMessage`` is frozen, but provider tool-call arguments contain
        ordinary nested dictionaries.  A shallow list copy would let an
        adapter mutate the authoritative in-memory projection without any
        corresponding durable event.
        """
        return copy.deepcopy(self._surface)

    def append(
        self,
        event_type: str,
        data: Mapping[str, Any],
        *,
        surface_op: str | None = None,
    ) -> SessionEvent:
        if not event_type or not isinstance(event_type, str):
            raise ValueError("session event type must be a non-empty string")
        if surface_op not in (None, "append", "replace"):
            raise ValueError(f"unsupported surface operation {surface_op!r}")
        data_snapshot = _snapshot_json(dict(data))
        with self._lock, self._file_lock():
            self._refresh_from_disk()
            if event_type == "session/created" and self._events:
                raise FileExistsError(f"session {self.id!r} already exists")
            self._validate_append_transition(event_type, data_snapshot)
            seq = len(self._events)
            prev_hash = self._events[-1].hash if self._events else _ZERO_HASH
            core: dict[str, Any] = {
                "formatVersion": SESSION_FORMAT_VERSION,
                "sessionId": self.id,
                "seq": seq,
                "time": int(time.time() * 1000),
                "type": event_type,
                "data": data_snapshot,
                "prevHash": prev_hash,
            }
            if surface_op is not None:
                core["surfaceOp"] = surface_op
            event = SessionEvent(
                session_id=self.id,
                seq=seq,
                time_ms=int(core["time"]),
                type=event_type,
                data=data_snapshot,
                surface_op=surface_op,
                prev_hash=prev_hash,
                hash=_event_hash(core),
            )
            # Validate the candidate surface transition before durability.
            candidate_surface = self._project_event(list(self._surface), event)
            line = _canonical_bytes(event.to_dict()) + b"\n"
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with self.path.open("ab", buffering=0) as handle:
                written = handle.write(line)
                if written != len(line):
                    raise OSError(
                        f"short session write: wrote {written} of {len(line)} bytes"
                    )
                os.fsync(handle.fileno())
            self._events.append(event)
            self._surface = candidate_surface
            return event

    @contextmanager
    def _file_lock(self) -> Iterator[None]:
        """Serialize hash-chain extension across independent processes."""
        lock_path = self.path.with_suffix(self.path.suffix + ".lock")
        with _exclusive_file_lock(lock_path):
            yield

    def _refresh_from_disk(self) -> None:
        """Adopt the latest verified chain before deriving the next event."""
        if not self.path.exists():
            return
        latest = FileSessionStore(self.path.parent)._load(
            self.path, self.id, already_locked=True
        )
        self.header = latest.header
        self._events = list(latest.events)
        self._surface = latest.derive_messages()
        self.repaired_tail_bytes += latest.repaired_tail_bytes

    def _synchronize(self) -> None:
        with self._lock, self._file_lock():
            self._refresh_from_disk()

    def _acquire_turn_lease(self) -> None:
        if self._turn_lease_context is not None:
            return
        context = _exclusive_file_lock(
            self.path.with_suffix(self.path.suffix + ".turn.lock")
        )
        context.__enter__()
        self._turn_lease_context = context

    def _release_turn_lease(self) -> None:
        context = self._turn_lease_context
        if context is None:
            return
        self._turn_lease_context = None
        context.__exit__(None, None, None)

    def _validate_append_transition(
        self, event_type: str, data: Mapping[str, Any]
    ) -> None:
        """Recheck turn invariants after refreshing under the file lock."""
        if not self._events and event_type != "session/created":
            raise SessionCorruptionError("first event must be session/created")
        if event_type == "turn/start":
            opened = self.open_turn
            if opened is not None:
                raise RuntimeError(
                    f"session {self.id!r} already has an open turn"
                )
            expected = self.next_turn
            if int(data.get("turn") or 0) != expected:
                raise RuntimeError(
                    f"cannot start turn {data.get('turn')!r}; next turn is {expected}"
                )
            return
        if event_type == "turn/end":
            opened = self.open_turn
            requested = int(data.get("turn") or 0)
            if opened != requested:
                raise RuntimeError(
                    f"cannot end turn {requested}; open turn is {opened}"
                )
            return
        if event_type in {"model/request", "model/response", "tool/call"}:
            opened = self.open_turn
            if opened is None or int(data.get("turn") or 0) != opened:
                raise RuntimeError(
                    f"{event_type} does not match the open turn {opened}"
                )
        if event_type == "model/request":
            projected = [message.to_dict() for message in self._surface]
            expected_hash = hashlib.sha256(_canonical_bytes(projected)).hexdigest()
            if (
                int(data.get("messageCount") or 0) != len(projected)
                or data.get("messagesHash") != expected_hash
            ):
                raise ModelSurfaceMismatch(
                    "model request messages differ from the event-sourced surface"
                )

    def start_turn(self, *, hold_lease: bool = False) -> int:
        if hold_lease:
            self._acquire_turn_lease()
        try:
            self._synchronize()
            if self.open_turn is not None:
                raise RuntimeError(f"session {self.id!r} already has an open turn")
            turn = self.next_turn
            self.append("turn/start", {"turn": turn})
            return turn
        except Exception:
            if hold_lease:
                self._release_turn_lease()
            raise

    def end_turn(self, turn: int, *, reason: str, detail: str = "") -> SessionEvent:
        try:
            self._synchronize()
            if self.open_turn != turn:
                raise RuntimeError(f"cannot end turn {turn}; open turn is {self.open_turn}")
            return self.append(
                "turn/end",
                {"turn": turn, "reason": str(reason), "detail": str(detail)},
            )
        finally:
            self._release_turn_lease()

    def append_message(self, message: AgentMessage) -> SessionEvent:
        event_type = {
            Role.USER: "user/message",
            Role.ASSISTANT: "assistant/message",
            Role.TOOL: "tool/result",
        }[message.role]
        return self.append(
            event_type,
            {"message": message.to_dict()},
            surface_op="append",
        )

    def replace_messages(
        self,
        messages: Sequence[AgentMessage],
        *,
        reason: str,
    ) -> SessionEvent:
        return self.append(
            "surface/replace",
            {
                "messages": [message.to_dict() for message in messages],
                "reason": str(reason),
            },
            surface_op="replace",
        )

    def record_model_request(
        self,
        messages: Sequence[AgentMessage],
        *,
        tools: Sequence[Mapping[str, Any]],
        header: Mapping[str, Any],
        step: int,
    ) -> SessionEvent:
        projected = [message.to_dict() for message in self.derive_messages()]
        proposed = [message.to_dict() for message in messages]
        if proposed != projected:
            raise ModelSurfaceMismatch(
                "model request messages differ from the event-sourced surface"
            )
        if self.open_turn is None:
            raise RuntimeError("model request requires an open turn")
        return self.append(
            "model/request",
            {
                "turn": self.open_turn,
                "step": int(step),
                "messageCount": len(projected),
                "messagesHash": hashlib.sha256(_canonical_bytes(projected)).hexdigest(),
                "tools": [dict(tool) for tool in tools],
                "header": dict(header),
            },
        )

    def record_tool_call(
        self,
        call_id: str,
        name: str,
        arguments: Mapping[str, Any],
        *,
        step: int,
    ) -> SessionEvent:
        if self.open_turn is None:
            raise RuntimeError("tool call requires an open turn")
        return self.append(
            "tool/call",
            {
                "turn": self.open_turn,
                "step": int(step),
                "callId": str(call_id),
                "name": str(name),
                "arguments": dict(arguments),
            },
        )

    def record_model_response(
        self,
        *,
        step: int,
        outcome: str,
        usage: Mapping[str, Any] | None,
        output_text_chars: int,
        tool_call_count: int,
    ) -> SessionEvent:
        """Record response metadata without duplicating model-visible text."""
        if self.open_turn is None:
            raise RuntimeError("model response requires an open turn")
        bounded_usage = {
            str(key)[:100]: value
            for key, value in dict(usage or {}).items()
            if (
                isinstance(value, (int, float))
                and not isinstance(value, bool)
                and math.isfinite(value)
            )
        }
        return self.append(
            "model/response",
            {
                "turn": self.open_turn,
                "step": int(step),
                "outcome": str(outcome or "unknown")[:80],
                "usage": bounded_usage,
                "outputTextChars": max(0, int(output_text_chars)),
                "toolCallCount": max(0, int(tool_call_count)),
            },
        )

    def repair_interrupted_turn(self) -> int:
        """Append risk-aware results for unresolved calls, then close the turn."""
        if self._turn_lease_context is None:
            self._acquire_turn_lease()
        try:
            self._synchronize()
            turn = self.open_turn
            if turn is None:
                return 0
            start_index = next(
                index
                for index in range(len(self._events) - 1, -1, -1)
                if self._events[index].type == "turn/start"
                and int(self._events[index].data.get("turn") or 0) == turn
            )
            calls: list[dict[str, Any]] = []

            def first_unresolved(call_id: str) -> dict[str, Any] | None:
                return next(
                    (
                        call
                        for call in calls
                        if call["id"] == call_id and not call["resolved"]
                    ),
                    None,
                )

            # Match call/result occurrences in event order, only inside the
            # interrupted user turn. Provider-generated ids are not trusted to
            # be globally unique (some gateways historically emitted call_0
            # every round), so a set over the whole surface is insufficient.
            for event in self._events[start_index + 1 :]:
                if event.surface_op == "append":
                    raw = event.data.get("message")
                    if isinstance(raw, dict):
                        message = AgentMessage.from_dict(raw)
                        if message.role is Role.ASSISTANT:
                            for call in message.tool_calls:
                                call_id = str(call.get("id") or "")
                                if call_id:
                                    calls.append({
                                        "id": call_id,
                                        "name": str(call.get("name") or ""),
                                        "arguments": dict(call.get("arguments") or {}),
                                        "started": False,
                                        "resolved": False,
                                    })
                        elif message.role is Role.TOOL and message.tool_call_id:
                            pending = first_unresolved(str(message.tool_call_id))
                            if pending is not None:
                                pending["resolved"] = True
                if event.type == "tool/call":
                    call_id = str(event.data.get("callId") or "")
                    pending = first_unresolved(call_id)
                    if pending is not None:
                        pending["started"] = True
            repairs = 0
            for call in calls:
                if call["resolved"]:
                    continue
                content = _TOOL_OUTCOME_UNKNOWN if call["started"] else _TOOL_NOT_STARTED
                self.append_message(
                    AgentMessage(
                        role=Role.TOOL,
                        content=content,
                        tool_call_id=call["id"],
                        name=call["name"],
                        is_error=True,
                        origin=ORIGIN_DATA,
                    )
                )
                repairs += 1
            self.end_turn(turn, reason="interrupted", detail="crash_repair")
            return repairs
        finally:
            self._release_turn_lease()

    def _rebuild_surface(self) -> None:
        surface: list[AgentMessage] = []
        for event in self._events:
            surface = self._project_event(surface, event)
        self._surface = surface

    @staticmethod
    def _project_event(
        surface: list[AgentMessage], event: SessionEvent
    ) -> list[AgentMessage]:
        if event.surface_op is None:
            return surface
        if event.surface_op == "append":
            raw = event.data.get("message")
            if not isinstance(raw, dict):
                raise SessionCorruptionError(
                    f"surface append event {event.seq} has no message"
                )
            return [*surface, AgentMessage.from_dict(raw)]
        raw_messages = event.data.get("messages")
        if not isinstance(raw_messages, list):
            raise SessionCorruptionError(
                f"surface replace event {event.seq} has no messages list"
            )
        return [AgentMessage.from_dict(raw) for raw in raw_messages]


class FileSessionStore:
    """Session factory/persistence seam backed by one hash-chained JSONL file."""

    def __init__(self, root: Path | str) -> None:
        self.root = Path(root)

    def create(
        self,
        session_id: str,
        *,
        parent_session_id: str | None = None,
        seed_length: int = 0,
    ) -> EventSession:
        session_id = self._validate_id(session_id)
        path = self._path(session_id)
        if path.exists():
            raise FileExistsError(f"session {session_id!r} already exists")
        header = SessionHeader(
            version=SESSION_FORMAT_VERSION,
            session_id=session_id,
            created_at_ms=int(time.time() * 1000),
            parent_session_id=parent_session_id,
            seed_length=int(seed_length),
        )
        session = EventSession(path, header, [])
        session.append(
            "session/created",
            {
                "version": header.version,
                "sessionId": header.session_id,
                "createdAt": header.created_at_ms,
                "parentSessionId": header.parent_session_id,
                "seedLength": header.seed_length,
            },
        )
        return session

    def resume(self, session_id: str, *, repair: bool = False) -> EventSession:
        session_id = self._validate_id(session_id)
        session = self._load(self._path(session_id), session_id)
        if repair:
            session.repair_interrupted_turn()
        return session

    def open_or_create(self, session_id: str, *, repair: bool = True) -> EventSession:
        try:
            return self.resume(session_id, repair=repair)
        except FileNotFoundError:
            try:
                return self.create(session_id)
            except FileExistsError:
                # Another bridge created the same conversation between our
                # missing-file read and create attempt. Adopt its verified
                # log instead of failing a perfectly valid user turn.
                return self.resume(session_id, repair=repair)

    def fork(self, source_id: str, child_id: str) -> EventSession:
        source = self.resume(source_id, repair=False)
        if source.open_turn is not None:
            raise SessionForkError(
                f"cannot fork session {source_id!r} with an open turn"
            )
        child = self.create(
            child_id,
            parent_session_id=source.id,
            seed_length=len(source.events),
        )
        for event in source.events[1:]:
            child.append(event.type, event.data, surface_op=event.surface_op)
        return child

    def _load(
        self,
        path: Path,
        session_id: str,
        *,
        already_locked: bool = False,
    ) -> EventSession:
        if not already_locked:
            with _exclusive_file_lock(path.with_suffix(path.suffix + ".lock")):
                return self._load(path, session_id, already_locked=True)
        raw = path.read_bytes()
        repaired_tail_bytes = 0
        if not raw:
            raise SessionCorruptionError("empty session log")
        fragments = raw.splitlines(keepends=True)
        if fragments and not fragments[-1].endswith(b"\n"):
            tail = fragments[-1]
            try:
                json.loads(tail.decode("utf-8"))
            except (UnicodeError, json.JSONDecodeError):
                repaired_tail_bytes = len(tail)
                fragments.pop()
                repaired = b"".join(fragments)
                with path.open("r+b") as handle:
                    handle.truncate(len(repaired))
                    handle.flush()
                    os.fsync(handle.fileno())
                raw = repaired
            else:
                # A complete final record missing only its delimiter is safe to
                # normalize; future O_APPEND writes must start on a new line.
                with path.open("ab") as handle:
                    handle.write(b"\n")
                    handle.flush()
                    os.fsync(handle.fileno())
                raw += b"\n"

        rows = raw.splitlines()
        events: list[SessionEvent] = []
        previous_hash = _ZERO_HASH
        for index, row in enumerate(rows):
            line_number = index + 1
            try:
                payload = json.loads(row.decode("utf-8"))
            except (UnicodeError, json.JSONDecodeError) as exc:
                raise SessionCorruptionError(
                    f"invalid JSON at line {line_number}: {exc}"
                ) from exc
            event = self._parse_event(payload, session_id, index, previous_hash)
            events.append(event)
            previous_hash = event.hash
        if not events or events[0].type != "session/created":
            raise SessionCorruptionError("first event must be session/created")
        header_data = events[0].data
        header = SessionHeader(
            version=int(header_data.get("version") or 0),
            session_id=str(header_data.get("sessionId") or ""),
            created_at_ms=int(header_data.get("createdAt") or 0),
            parent_session_id=(
                str(header_data["parentSessionId"])
                if header_data.get("parentSessionId") is not None
                else None
            ),
            seed_length=int(header_data.get("seedLength") or 0),
        )
        if header.version != SESSION_FORMAT_VERSION or header.session_id != session_id:
            raise SessionCorruptionError("session header identity/version mismatch")
        return EventSession(
            path,
            header,
            events,
            repaired_tail_bytes=repaired_tail_bytes,
        )

    @staticmethod
    def _parse_event(
        payload: Any,
        session_id: str,
        expected_seq: int,
        previous_hash: str,
    ) -> SessionEvent:
        if not isinstance(payload, dict):
            raise SessionCorruptionError(
                f"session event {expected_seq} must be a JSON object"
            )
        if int(payload.get("formatVersion") or 0) != SESSION_FORMAT_VERSION:
            raise SessionCorruptionError("unsupported session event format version")
        if payload.get("sessionId") != session_id:
            raise SessionCorruptionError("session event identity mismatch")
        if payload.get("seq") != expected_seq:
            raise SessionCorruptionError(
                f"non-contiguous seq {payload.get('seq')!r}; expected {expected_seq}"
            )
        if payload.get("prevHash") != previous_hash:
            raise SessionCorruptionError(
                f"hash chain mismatch at event {expected_seq}"
            )
        supplied_hash = payload.get("hash")
        core = dict(payload)
        core.pop("hash", None)
        expected_hash = _event_hash(core)
        if supplied_hash != expected_hash:
            raise SessionCorruptionError(f"hash mismatch at event {expected_seq}")
        data = payload.get("data")
        if not isinstance(data, dict):
            raise SessionCorruptionError(f"event {expected_seq} data must be an object")
        surface_op = payload.get("surfaceOp")
        if surface_op not in (None, "append", "replace"):
            raise SessionCorruptionError(
                f"event {expected_seq} has invalid surface operation"
            )
        return SessionEvent(
            session_id=session_id,
            seq=expected_seq,
            time_ms=int(payload.get("time") or 0),
            type=str(payload.get("type") or ""),
            data=_snapshot_json(data),
            surface_op=surface_op,
            prev_hash=previous_hash,
            hash=str(supplied_hash),
        )

    def _path(self, session_id: str) -> Path:
        return self.root / f"{session_id}.jsonl"

    @staticmethod
    def _validate_id(session_id: str) -> str:
        value = str(session_id or "")
        if not _SESSION_ID.fullmatch(value):
            raise ValueError(
                "session id must match [A-Za-z0-9][A-Za-z0-9._-]{0,127}"
            )
        return value
