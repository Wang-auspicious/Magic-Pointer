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
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator, Mapping, Sequence

from app.agent_runtime.tool_registry import Effect
from app.agent_runtime.types import AgentMessage, ORIGIN_DATA, ORIGIN_INSTRUCTION, Role
from app.artifacts import content_hash, project_artifacts
from app.receipts.schema import Receipt, ReceiptStatus
from app.run_kernel import RecoveryPolicy, pending_inbox, project_operations

__all__ = [
    "EventSession",
    "FileSessionStore",
    "ModelSurfaceMismatch",
    "SessionCorruptionError",
    "SessionEvent",
    "SessionForkError",
    "SessionHeader",
    "cancel_interrupt_check",
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
)
# What the model may do next depends on what the interrupted step could have
# changed, so the recovery policy is stated instead of one sentence that has to
# cover a re-read and an irreversible send at the same time.
_REPAIR_GUIDANCE = {
    RecoveryPolicy.SAFE_REPLAY: "这一步只读，没有外部副作用，可以直接重做。",
    RecoveryPolicy.VERIFY_BEFORE_RETRY: (
        "这一步会改写状态但可撤销：先读回目标确认它是否已经生效，再决定要不要重试。"
    ),
    RecoveryPolicy.NEVER_REPLAY: (
        "这一步可能已经对外产生不可撤销的效果：不要重试；"
        "先核验外部状态，或向用户确认后再行动。"
    ),
}


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


class InboxClaimConflict(RuntimeError):
    """Another process consumed the same durable steer first."""


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
        # Bytes of the log this handle has already verified. A long job
        # appends thousands of events; re-reading and re-verifying the whole
        # hash chain on every append is O(n^2) IO that grows with the very
        # history the session protects. Unchanged files cost one stat;
        # external growth is adopted incrementally (Codex rollout pattern).
        try:
            self._known_size = path.stat().st_size
        except OSError:
            self._known_size = 0
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
        if surface_op not in (None, "append", "append_many", "replace"):
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
            self._known_size += len(line)
            return event

    @contextmanager
    def _file_lock(self) -> Iterator[None]:
        """Serialize hash-chain extension across independent processes."""
        lock_path = self.path.with_suffix(self.path.suffix + ".lock")
        with _exclusive_file_lock(lock_path):
            yield

    def _refresh_from_disk(self) -> None:
        """Adopt the latest verified chain before deriving the next event.

        Fast path: the file is exactly as long as the bytes this handle has
        already verified, so nobody else wrote and one stat settles it.
        Growth is adopted line-by-line, chaining onto the in-memory hash
        chain; only shrinkage, crash debris or a parse failure falls back to
        the full repairing load.
        """
        if not self.path.exists():
            return
        try:
            size = self.path.stat().st_size
        except OSError:
            return
        if size == self._known_size:
            return
        if size > self._known_size and self._adopt_incremental(size):
            return
        latest = FileSessionStore(self.path.parent)._load(
            self.path, self.id, already_locked=True
        )
        self.header = latest.header
        self._events = list(latest.events)
        self._surface = latest.derive_messages()
        self.repaired_tail_bytes += latest.repaired_tail_bytes
        try:
            self._known_size = self.path.stat().st_size
        except OSError:
            self._known_size = 0

    def _adopt_incremental(self, size: int) -> bool:
        """Adopt only the bytes beyond the already-verified prefix.

        Returns False when the new tail cannot be chained (crash debris,
        invalid JSON, hash mismatch); the caller then repairs via the full
        load. The verification strength is identical to a full read: every
        adopted line must extend the in-memory chain with contiguous seq and
        matching prevHash/hash.
        """
        try:
            with self.path.open("rb") as handle:
                handle.seek(self._known_size)
                new_bytes = handle.read()
        except OSError:
            return False
        previous_hash = self._events[-1].hash if self._events else _ZERO_HASH
        adopted: list[SessionEvent] = []
        consumed = 0
        for raw_line in new_bytes.splitlines(keepends=True):
            if not raw_line.endswith(b"\n"):
                return False
            try:
                payload = json.loads(raw_line.decode("utf-8"))
            except (UnicodeError, json.JSONDecodeError):
                return False
            try:
                event = FileSessionStore._parse_event(
                    payload,
                    self.id,
                    len(self._events) + len(adopted),
                    previous_hash,
                )
            except SessionCorruptionError:
                return False
            adopted.append(event)
            previous_hash = event.hash
            consumed += len(raw_line)
        surface = self._surface
        for event in adopted:
            surface = self._project_event(surface, event)
        self._events.extend(adopted)
        self._surface = surface
        self._known_size += consumed
        return True

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
        if event_type in {
            "model/request",
            "model/response",
            "tool/call",
            "operation/prepared",
            "operation/settled",
            "interaction/start",
            "cancel/request",
            "cancel/consumed",
        }:
            opened = self.open_turn
            if opened is None or int(data.get("turn") or 0) != opened:
                raise RuntimeError(
                    f"{event_type} does not match the open turn {opened}"
                )
        if event_type == "cancel/request":
            if not str(data.get("requestId") or ""):
                raise ValueError("cancel request requires requestId")
            if self._pending_cancel_request_locked(int(data.get("turn") or -1)):
                raise RuntimeError("this turn already has a pending cancel request")
        if event_type == "cancel/consumed":
            if not self._pending_cancel_request_locked(int(data.get("turn") or -1)):
                raise RuntimeError("no pending cancel request to consume")
        if event_type == "operation/prepared":
            operation_id = str(data.get("operationId") or "")
            if not operation_id:
                raise ValueError("prepared operation requires operationId")
            if any(
                event.type == "operation/prepared"
                and event.data.get("operationId") == operation_id
                for event in self._events
            ):
                raise RuntimeError(f"duplicate operation id {operation_id!r}")
        if event_type == "interaction/start":
            opened = self.open_turn
            if any(
                event.type == "interaction/start"
                and int(event.data.get("turn") or 0) == opened
                for event in self._events
            ):
                raise RuntimeError(f"turn {opened} already has an interaction start")
        if event_type == "operation/settled":
            operation_id = str(data.get("operationId") or "")
            operations = {
                operation.operation_id: operation
                for operation in project_operations(self._events)
            }
            operation = operations.get(operation_id)
            if operation is None or operation.settled_seq is not None:
                raise RuntimeError(
                    f"operation {operation_id!r} is missing or already settled"
                )
            raw_message = data.get("message")
            if not isinstance(raw_message, dict):
                raise ValueError("operation settlement requires a tool message")
            message = AgentMessage.from_dict(raw_message)
            if message.role is not Role.TOOL or message.tool_call_id != operation.call_id:
                raise ValueError("operation settlement tool message does not match call")
        if event_type == "inbox/message":
            message_id = str(data.get("messageId") or "")
            target = str(data.get("target") or "")
            text = str(data.get("text") or "")
            if not message_id or not text.strip() or target not in {"next-step", "next-turn"}:
                raise ValueError("inbox message requires id, text and a supported target")
            if any(
                event.type == "inbox/message"
                and event.data.get("messageId") == message_id
                for event in self._events
            ):
                raise RuntimeError(f"duplicate inbox message id {message_id!r}")
        if event_type == "inbox/consumed":
            target = str(data.get("target") or "")
            message_ids = tuple(str(value or "") for value in data.get("messageIds") or ())
            available = pending_inbox(self._events, target)
            selected = tuple(item for item in available if item.message_id in message_ids)
            if (
                target not in {"next-step", "next-turn"}
                or not message_ids
                or len(set(message_ids)) != len(message_ids)
                or tuple(item.message_id for item in selected) != message_ids
            ):
                raise InboxClaimConflict("inbox messages are no longer pending")
            raw_messages = data.get("messages")
            if not isinstance(raw_messages, list) or len(raw_messages) != len(selected):
                raise ValueError("inbox consumption requires matching surface messages")
            projected = [AgentMessage.from_dict(raw) for raw in raw_messages]
            if any(message.role is not Role.USER for message in projected):
                raise ValueError("inbox consumption may only append user steer messages")
            if [message.content for message in projected] != [item.text for item in selected]:
                raise ValueError("inbox surface messages differ from durable steer text")
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
        if event_type in {"artifact/generated", "artifact/patched", "artifact/accepted"}:
            self._validate_artifact_event(event_type, data)
        if event_type == "receipt/issued":
            self._validate_receipt_event(data)

    def _validate_artifact_event(self, event_type: str, data: Mapping[str, Any]) -> None:
        artifact_id = str(data.get("artifactId") or "")
        if not artifact_id:
            raise ValueError("draft event requires artifactId")
        current = {
            item.artifact_id: item for item in project_artifacts(self._events)
        }.get(artifact_id)
        if event_type == "artifact/generated":
            content = str(data.get("content") or "")
            if not content.strip():
                raise ValueError("draft content is empty")
            if current is not None:
                raise RuntimeError(f"duplicate artifact id {artifact_id!r}")
            if int(data.get("revision") or 0) != 1:
                raise ValueError("generated draft must be revision 1")
            if str(data.get("contentHash") or "") != content_hash(content):
                raise ValueError("contentHash does not match content")
            return
        if current is None:
            raise ValueError(f"unknown artifact {artifact_id!r}")
        if event_type == "artifact/patched":
            content = str(data.get("content") or "")
            if not content.strip():
                raise ValueError("draft content is empty")
            if str(data.get("author") or "") not in {"user", "agent"}:
                raise ValueError("patch author must be user or agent")
            if int(data.get("revision") or 0) != current.revision + 1:
                raise ValueError("patched revision must follow the current draft")
            if str(data.get("contentHash") or "") != content_hash(content):
                raise ValueError("contentHash does not match content")
            return
        if int(data.get("revision") or 0) != current.revision:
            raise ValueError("accepted revision is not current")
        if str(data.get("contentHash") or "") != current.content_hash:
            raise ValueError("contentHash does not match the current draft")

    def _validate_receipt_event(self, data: Mapping[str, Any]) -> None:
        if not str(data.get("receiptId") or ""):
            raise ValueError("receipt requires receiptId")
        status = str(data.get("status") or "")
        try:
            ReceiptStatus(status)
        except ValueError as exc:
            raise ValueError(f"unknown receipt status {status!r}") from exc

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

    def record_interaction_start(
        self,
        metadata: Mapping[str, Any] | None = None,
    ) -> SessionEvent:
        """Bind one public ledger identity and its grounded input metadata."""
        turn = self.open_turn
        if turn is None:
            raise RuntimeError("interaction start requires an open turn")
        raw = dict(metadata or {})
        normalized: dict[str, Any] = {
            "interactionId": str(
                raw.get("interactionId") or f"{self.id}:{turn}"
            )[:260],
            "turn": turn,
        }
        for key, limit in (
            ("appName", 200),
            ("evidenceLayerHit", 20),
            ("inputArtifactId", 260),
        ):
            value = str(raw.get(key) or "").strip()
            if value:
                normalized[key] = value[:limit]
        confidence = raw.get("confidence")
        if (
            isinstance(confidence, (int, float))
            and not isinstance(confidence, bool)
            and math.isfinite(float(confidence))
        ):
            normalized["confidence"] = min(1.0, max(0.0, float(confidence)))
        normalized["usedLook"] = raw.get("usedLook") is True
        return self.append("interaction/start", normalized)

    def record_tool_call(
        self,
        call_id: str,
        name: str,
        arguments: Mapping[str, Any],
        *,
        step: int,
        effect: Effect | str = "unknown",
        dispatched: bool = True,
        operation_id: str | None = None,
    ) -> SessionEvent:
        if self.open_turn is None:
            raise RuntimeError("tool call requires an open turn")
        return self.append(
            "operation/prepared",
            {
                "operationId": str(operation_id or uuid.uuid4()),
                "turn": self.open_turn,
                "step": int(step),
                "callId": str(call_id),
                "name": str(name),
                "arguments": dict(arguments),
                "effect": str(effect),
                "dispatched": bool(dispatched),
            },
        )

    def record_tool_settlement(
        self,
        operation_id: str,
        message: AgentMessage,
        *,
        failure_type: object | None,
        used_backend: str | None,
        latency_ms: float | None,
        outcome: str | None = None,
    ) -> SessionEvent:
        """Settle an operation and append its TOOL message in one event."""
        if self.open_turn is None:
            raise RuntimeError("tool settlement requires an open turn")
        if message.role is not Role.TOOL:
            raise ValueError("tool settlement message must have role=tool")
        resolved_outcome = outcome or ("failed" if message.is_error else "succeeded")
        return self.append(
            "operation/settled",
            {
                "operationId": str(operation_id),
                "turn": self.open_turn,
                "outcome": str(resolved_outcome),
                "failureType": (
                    str(getattr(failure_type, "value", failure_type))
                    if failure_type is not None
                    else None
                ),
                "usedBackend": str(used_backend) if used_backend else None,
                "latencyMs": latency_ms,
                "message": message.to_dict(),
            },
            surface_op="append",
        )

    def enqueue_inbox(
        self,
        text: str,
        target: str,
        *,
        message_id: str | None = None,
    ) -> SessionEvent:
        """Persist one cross-process steer without mutating model history yet."""
        return self.append(
            "inbox/message",
            {
                "messageId": str(message_id or uuid.uuid4()),
                "target": str(target),
                "text": str(text),
            },
        )

    def pending_inbox(self, target: str | None = None):
        self._synchronize()
        return pending_inbox(self._events, target)

    def claim_inbox(self, target: str) -> list[str]:
        """Atomically consume pending steer and expose it to the model surface."""
        items = self.pending_inbox(target)
        if not items:
            return []
        messages = [
            AgentMessage(
                role=Role.USER,
                content=item.text,
                tool_call_id=None,
                name=None,
                origin=ORIGIN_INSTRUCTION,
            )
            for item in items
        ]
        try:
            self.append(
                "inbox/consumed",
                {
                    "target": str(target),
                    "messageIds": [item.message_id for item in items],
                    "messages": [message.to_dict() for message in messages],
                },
                surface_op="append_many",
            )
        except InboxClaimConflict:
            return []
        return [item.text for item in items]

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

    def record_artifact_generated(self, content: str) -> SessionEvent:
        """Persist a completed answer as revision 1 of a new draft."""
        text = str(content or "")
        return self.append(
            "artifact/generated",
            {
                "artifactId": uuid.uuid4().hex,
                "revision": 1,
                "content": text,
                "contentHash": content_hash(text),
                "author": "model",
            },
        )

    def record_artifact_patched(
        self,
        artifact_id: str,
        content: str,
        *,
        author: str,
    ) -> SessionEvent:
        """Record a user or agent edit. Later edits void a previous approval."""
        text = str(content or "")
        current = {
            item.artifact_id: item for item in project_artifacts(self.events)
        }.get(str(artifact_id))
        if current is None:
            raise ValueError(f"unknown artifact {artifact_id!r}")
        return self.append(
            "artifact/patched",
            {
                "artifactId": str(artifact_id),
                "revision": current.revision + 1,
                "baseRevision": current.revision,
                "content": text,
                "contentHash": content_hash(text),
                "author": str(author),
            },
        )

    def record_artifact_accepted(
        self,
        artifact_id: str,
        *,
        revision: int,
        content_hash: str,
    ) -> SessionEvent:
        """Approve one exact revision. The hash is what the approval is of."""
        return self.append(
            "artifact/accepted",
            {
                "artifactId": str(artifact_id),
                "revision": int(revision),
                "contentHash": str(content_hash),
            },
        )

    def record_receipt(self, receipt: Receipt) -> SessionEvent:
        """Persist the stop proof. Not model-visible."""
        failure = receipt.failure_type
        return self.append(
            "receipt/issued",
            {
                "receiptId": str(receipt.receipt_id),
                "status": str(receipt.status.value),
                "effect": str(receipt.effect),
                "verificationMethod": str(receipt.verification_method),
                "usedBackend": str(receipt.used_backend),
                "artifactIds": list(receipt.artifact_ids),
                "wrote": bool(receipt.wrote),
                "verified": bool(receipt.verified),
                "failureType": None if failure is None else str(failure),
                "memoryEligible": bool(receipt.memory_eligible),
            },
        )

    def request_cancel(self, *, turn: int | None = None, reason: str = "") -> SessionEvent:
        """Persist a graceful-cancel request for the open turn.

        The request is durable so a cancel that lands while the loop is mid
        round is not lost: the running loop polls it at the next round
        boundary and terminates as ``user_interrupt`` (Receipt issued, turn
        closed) instead of being killed mid-write. Scoped to the requested
        turn so a stale request can never interrupt a later turn.
        """
        opened = self.open_turn
        if opened is None:
            raise RuntimeError("cancel request requires an open turn")
        target = int(opened if turn is None else turn)
        if target != opened:
            raise RuntimeError(
                f"cannot cancel turn {target}; open turn is {opened}"
            )
        return self.append(
            "cancel/request",
            {
                "turn": target,
                "requestId": uuid.uuid4().hex,
                "reason": str(reason or "")[:200],
            },
        )

    def pending_cancel_request(self, turn: int | None = None) -> bool:
        """True when the given (default: open) turn has an unclaimed cancel."""
        self._synchronize()
        return self._pending_cancel_request_locked(
            self.open_turn if turn is None else int(turn)
        )

    def _pending_cancel_request_locked(self, target: int) -> bool:
        """Scan without syncing: safe inside append's already-held lock."""
        consumed = {
            str(event.data.get("requestId") or "")
            for event in self._events
            if event.type == "cancel/consumed"
        }
        return any(
            event.type == "cancel/request"
            and int(event.data.get("turn") or -1) == target
            and str(event.data.get("requestId") or "") not in consumed
            for event in self._events
        )

    def consume_cancel_request(self, *, turn: int | None = None) -> bool:
        """Claim the pending cancel for this turn so it fires at most once."""
        opened = self.open_turn
        target = int(opened if turn is None else turn)
        if not self.pending_cancel_request(target):
            return False
        request_id = next(
            (
                str(event.data.get("requestId") or "")
                for event in reversed(self._events)
                if event.type == "cancel/request"
                and int(event.data.get("turn") or -1) == target
            ),
            "",
        )
        self.append(
            "cancel/consumed",
            {"turn": target, "requestId": request_id},
        )
        return True

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
                if event.surface_op in {"append", "append_many"}:
                    surface_messages = (
                        [event.data.get("message")]
                        if event.surface_op == "append"
                        else event.data.get("messages") or []
                    )
                    for raw in surface_messages:
                        if not isinstance(raw, dict):
                            continue
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
                if event.type in {"tool/call", "operation/prepared"}:
                    call_id = str(event.data.get("callId") or "")
                    pending = first_unresolved(call_id)
                    if pending is not None:
                        pending["started"] = True
            repairs = 0
            for call in calls:
                if call["resolved"]:
                    continue
                operation = next(
                    (
                        item
                        for item in reversed(project_operations(self._events))
                        if item.turn == turn
                        and item.call_id == call["id"]
                        and item.settled_seq is None
                    ),
                    None,
                )
                # The prose the model reads and the outcome we persist must
                # come from the same fact. A prepared-but-never-dispatched call
                # is safe to replay; telling the model to verify external state
                # first would make it refuse a retry the record permits.
                dispatched = (
                    operation.dispatched if operation is not None else call["started"]
                )
                if not dispatched:
                    content = _TOOL_NOT_STARTED
                else:
                    policy = (
                        operation.recovery_policy
                        if operation is not None
                        else RecoveryPolicy.NEVER_REPLAY
                    )
                    content = _TOOL_OUTCOME_UNKNOWN + _REPAIR_GUIDANCE[policy]
                repair_message = AgentMessage(
                    role=Role.TOOL,
                    content=content,
                    tool_call_id=call["id"],
                    name=call["name"],
                    is_error=True,
                    origin=ORIGIN_DATA,
                )
                if operation is None:
                    self.append_message(repair_message)
                else:
                    self.record_tool_settlement(
                        operation.operation_id,
                        repair_message,
                        failure_type="interrupted",
                        used_backend=None,
                        latency_ms=None,
                        outcome=("unknown" if operation.dispatched else "not_started"),
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
        if event.surface_op == "append_many":
            raw_messages = event.data.get("messages")
            if not isinstance(raw_messages, list):
                raise SessionCorruptionError(
                    f"surface append-many event {event.seq} has no messages list"
                )
            return [
                *surface,
                *(AgentMessage.from_dict(raw) for raw in raw_messages),
            ]
        raw_messages = event.data.get("messages")
        if not isinstance(raw_messages, list):
            raise SessionCorruptionError(
                f"surface replace event {event.seq} has no messages list"
            )
        return [AgentMessage.from_dict(raw) for raw in raw_messages]


def cancel_interrupt_check(session: EventSession):
    """Pollable graceful-cancel check for :class:`LoopParams`.

    Returns an ``interrupt_check`` callable that consumes the open turn's
    pending cancel request; the loop then terminates as ``user_interrupt``
    with a Receipt instead of being killed mid-write. Bridges pass this so
    the GUI stop button gets the graceful path (O3).
    """

    def check() -> bool:
        turn = session.open_turn
        if turn is None:
            return False
        if not session.pending_cancel_request(turn):
            return False
        return session.consume_cancel_request(turn=turn)

    return check


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
        if surface_op not in (None, "append", "append_many", "replace"):
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
