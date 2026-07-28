from __future__ import annotations

import hashlib
import json
import os
import threading
import uuid
from contextlib import contextmanager
from copy import deepcopy
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Iterator

JsonDict = dict[str, Any]
STORE_VERSION = 1
_PROCESS_LOCKS: dict[str, threading.RLock] = {}
_PROCESS_LOCKS_GUARD = threading.Lock()


class ContextSessionError(RuntimeError):
    pass


class ContextSessionConflict(ContextSessionError):
    """The active pack changed after a compiler took its read snapshot."""

    pass


def _default_root() -> Path:
    configured = os.environ.get("MAGIC_POINTER_USER_DATA_DIR")
    if configured:
        return Path(configured)
    local_app_data = os.environ.get("LOCALAPPDATA")
    if local_app_data:
        return Path(local_app_data) / "Magic Pointer"
    return Path.home() / ".magic-pointer"


def _now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="microseconds")


def _clean_text(value: Any, *, limit: int) -> str:
    return str(value or "").replace("\r\n", "\n").replace("\r", "\n").strip()[:limit]


def _optional_int(value: Any) -> int | None:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None


def _safe_window(value: Any) -> JsonDict:
    if not isinstance(value, dict):
        return {}
    output: JsonDict = {}
    for key in ("title", "hwnd", "process_name", "class_name"):
        if value.get(key) is None:
            continue
        output[key] = value[key] if key == "hwnd" else _clean_text(value[key], limit=1000)
    process_id = _optional_int(value.get("process_id") or value.get("pid"))
    if process_id is not None:
        output["process_id"] = process_id
    return output


def _safe_numbers(value: Any, *, length: int) -> list[float] | None:
    if not isinstance(value, (list, tuple)) or len(value) != length:
        return None
    try:
        return [float(part) for part in value]
    except (TypeError, ValueError):
        return None


def _safe_point(value: Any) -> list[int] | None:
    if isinstance(value, dict):
        value = [value.get("x"), value.get("y")]
    numbers = _safe_numbers(value, length=2)
    return None if numbers is None else [int(numbers[0]), int(numbers[1])]


def _safe_rectangles(value: Any) -> list[list[float]]:
    output: list[list[float]] = []
    for item in value if isinstance(value, list) else []:
        rectangle = _safe_numbers(item, length=4)
        if rectangle is not None:
            output.append(rectangle)
        if len(output) >= 32:
            break
    return output


def _safe_mapping(value: Any, *, text_limit: int = 12000) -> JsonDict:
    if not isinstance(value, dict):
        return {}
    output: JsonDict = {}
    for raw_key, raw_value in list(value.items())[:64]:
        key = _clean_text(raw_key, limit=200)
        if not key:
            continue
        if isinstance(raw_value, bool) or raw_value is None:
            output[key] = raw_value
        elif isinstance(raw_value, (int, float)):
            output[key] = raw_value
        elif isinstance(raw_value, (list, tuple)):
            output[key] = [_clean_text(item, limit=1000) for item in list(raw_value)[:64]]
        elif isinstance(raw_value, dict):
            output[key] = _safe_mapping(raw_value, text_limit=min(text_limit, 4000))
        else:
            output[key] = _clean_text(raw_value, limit=text_limit)
    return output


def _fingerprint(*parts: Any) -> str:
    serialized = json.dumps(parts, ensure_ascii=False, sort_keys=True, default=str)
    return hashlib.sha256(serialized.encode("utf-8")).hexdigest()


class ContextSessionStore:
    def __init__(
        self,
        root: Path | str | None = None,
        *,
        id_factory: Callable[[], str] | None = None,
    ) -> None:
        self.root = Path(root) if root is not None else _default_root()
        self.path = self.root / "context" / "context_sessions.json"
        self.id_factory = id_factory or (lambda: uuid.uuid4().hex)

    def _new_id(self, prefix: str) -> str:
        raw = str(self.id_factory())
        return raw if raw.startswith(f"{prefix}-") else f"{prefix}-{raw}"

    @staticmethod
    def _default_state() -> JsonDict:
        return {"version": STORE_VERSION, "revision": 0, "active_session_id": None, "sessions": []}

    @staticmethod
    def _validate_state(state: Any) -> JsonDict:
        if not isinstance(state, dict) or state.get("version") != STORE_VERSION:
            raise ContextSessionError("unsupported context session schema version")
        if not isinstance(state.get("sessions"), list):
            raise ContextSessionError("invalid context sessions")
        if not isinstance(state.get("revision"), int) or state["revision"] < 0:
            raise ContextSessionError("invalid context session revision")
        active_id = state.get("active_session_id")
        if active_id is not None and (not isinstance(active_id, str) or not active_id):
            raise ContextSessionError("invalid context active session id")
        seen_ids: set[str] = set()
        for session in state["sessions"]:
            if not isinstance(session, dict):
                raise ContextSessionError("invalid context session entry")
            session_id = session.get("session_id")
            if not isinstance(session_id, str) or not session_id or session_id in seen_ids:
                raise ContextSessionError("invalid context session id")
            seen_ids.add(session_id)
            if session.get("status") not in {"active", "finished"}:
                raise ContextSessionError("invalid context session status")
            workflow_kind = session.get("workflow_kind", "context_pack")
            if workflow_kind not in {"context_pack", "runtime_issue"}:
                raise ContextSessionError("invalid context workflow kind")
            items = session.get("items")
            if not isinstance(items, list):
                raise ContextSessionError("invalid context session items")
            for item in items:
                if not isinstance(item, dict):
                    raise ContextSessionError("invalid context item")
                for key in ("item_id", "identity_fingerprint", "modality", "instruction"):
                    if not isinstance(item.get(key), str) or not item[key]:
                        raise ContextSessionError(f"invalid context item {key}")
                if item.get("role") is not None and item.get("role") not in {"issue", "reference"}:
                    raise ContextSessionError("invalid context item role")
        if active_id is not None:
            active = next((item for item in state["sessions"] if item["session_id"] == active_id), None)
            if active is None or active.get("status") != "active":
                raise ContextSessionError("invalid context active session reference")
        return state

    def _load(self) -> JsonDict:
        if not self.path.exists():
            return self._default_state()
        try:
            return self._validate_state(json.loads(self.path.read_text(encoding="utf-8")))
        except (OSError, json.JSONDecodeError) as exc:
            raise ContextSessionError(f"could not read context sessions: {type(exc).__name__}: {exc}") from exc

    def _save(self, state: JsonDict) -> None:
        validated = self._validate_state(state)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_suffix(self.path.suffix + ".tmp")
        try:
            with temporary.open("w", encoding="utf-8", newline="\n") as handle:
                json.dump(validated, handle, ensure_ascii=False, indent=2)
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            temporary.replace(self.path)
        except OSError as exc:
            raise ContextSessionError(f"could not persist context sessions: {type(exc).__name__}: {exc}") from exc

    @contextmanager
    def _mutation_lock(self) -> Iterator[None]:
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
    def _find_session(state: JsonDict, session_id: str | None) -> JsonDict | None:
        if not session_id:
            return None
        return next((item for item in state["sessions"] if item.get("session_id") == session_id), None)

    @staticmethod
    def _items_digest(items: Any) -> str:
        identities = [
            [item.get("item_id"), item.get("identity_fingerprint")]
            for item in items if isinstance(item, dict)
        ] if isinstance(items, list) else []
        return hashlib.sha256(
            json.dumps(identities, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        ).hexdigest()

    @classmethod
    def _public_session(cls, session: JsonDict, *, revision: int | None = None) -> JsonDict:
        output = deepcopy(session)
        output["item_count"] = len(output.get("items") or [])
        output["items_digest"] = cls._items_digest(output.get("items"))
        if revision is not None:
            output["store_revision"] = revision
        return output

    def active(self) -> JsonDict | None:
        state = self._load()
        session = self._find_session(state, state.get("active_session_id"))
        if session is None or session.get("status") != "active":
            return None
        return self._public_session(session, revision=state["revision"])

    def _normalize_native(
        self,
        snapshot: Any,
        instruction: str,
        *,
        item_id: str,
        sequence: int,
        now: str,
    ) -> JsonDict:
        explanation = _clean_text(instruction, limit=8000)
        if not explanation:
            raise ContextSessionError("context explanation is empty")
        if not isinstance(snapshot, dict) or not isinstance(snapshot.get("context"), dict):
            raise ContextSessionError("context requires a grounded native selection")
        context = snapshot["context"]
        artifacts = context.get("artifacts") if isinstance(context.get("artifacts"), dict) else {}
        selected = _clean_text(context.get("content"), limit=20000)
        surrounding = _clean_text(artifacts.get("selection_context"), limit=28000)
        if not selected and not surrounding and not artifacts:
            raise ContextSessionError("context requires a grounded native selection")
        document_path = _clean_text(
            artifacts.get("pdf_document_path") or artifacts.get("document") or context.get("path") or context.get("label"),
            limit=4000,
        )
        document_label = _clean_text(
            artifacts.get("document_name") or (Path(document_path).name if document_path else context.get("label")),
            limit=1000,
        )
        snapshot_id = _clean_text(snapshot.get("snapshot_id"), limit=200)
        identity = _fingerprint("native", snapshot_id or document_path, selected, explanation)
        return {
            "item_id": item_id,
            "sequence": sequence,
            "identity_fingerprint": identity,
            "modality": "native_selection",
            "instruction": explanation,
            "captured_at": _clean_text(snapshot.get("captured_at"), limit=100) or now,
            "recorded_at": now,
            "source": {
                "app": _clean_text(context.get("app"), limit=100) or "application",
                "window": _safe_window(snapshot.get("source_window") or context.get("window")),
                "document_path": document_path,
                "document_label": document_label,
                "page_number": _optional_int(artifacts.get("pdf_page_number")),
                "url": _clean_text(artifacts.get("url") or context.get("url"), limit=4000),
                "method": _clean_text(context.get("method"), limit=300),
            },
            "selected_text": selected,
            "surrounding_context": surrounding,
            "geometry": {
                "point": _safe_point(snapshot.get("target_point")),
                "selection_rectangles": _safe_rectangles(artifacts.get("selection_rectangles")),
            },
            "images": {},
            "grounding": _safe_mapping(context.get("grounding"), text_limit=4000),
            "file_context": {},
            "app_context": {},
            "vision_observation": "",
        }

    def _normalize_visual(
        self,
        capture: Any,
        instruction: str,
        *,
        item_id: str,
        sequence: int,
        now: str,
    ) -> JsonDict:
        explanation = _clean_text(instruction, limit=8000)
        if not explanation:
            raise ContextSessionError("context explanation is empty")
        if not isinstance(capture, dict):
            raise ContextSessionError("context requires a grounded visual capture")
        point = _safe_point(capture.get("point"))
        bbox = _safe_numbers(capture.get("bbox"), length=4)
        capture_bbox = _safe_numbers(capture.get("capture_bbox"), length=4)
        raw_image = _clean_text(capture.get("raw_image_path"), limit=4000)
        pointer_image = _clean_text(capture.get("pointer_image_path"), limit=4000)
        grounding = _safe_mapping(capture.get("grounding"), text_limit=4000)
        observation = _clean_text(capture.get("vision_observation"), limit=20000)
        vision_error = _clean_text(capture.get("vision_error"), limit=4000)
        file_context = _safe_mapping(capture.get("file_context"), text_limit=20000)
        app_context = _safe_mapping(capture.get("app_context"), text_limit=12000)
        capture_attestation = _safe_mapping(capture.get("capture_attestation"), text_limit=4000)
        if not any((point, bbox, raw_image, pointer_image, grounding, observation, file_context, app_context)):
            raise ContextSessionError("context requires a grounded visual capture")
        object_id = _clean_text(capture.get("object_id"), limit=200)
        identity = _fingerprint(
            "visual",
            object_id or pointer_image or raw_image,
            point,
            bbox,
            explanation,
        )
        file_path = _clean_text(file_context.get("path"), limit=4000)
        return {
            "item_id": item_id,
            "sequence": sequence,
            "identity_fingerprint": identity,
            "modality": "visual_pointer",
            "instruction": explanation,
            "captured_at": _clean_text(capture.get("captured_at"), limit=100) or now,
            "recorded_at": now,
            "source": {
                "app": _clean_text(capture.get("app") or app_context.get("app"), limit=100) or "application",
                "window": _safe_window(capture.get("source_window")),
                "document_path": file_path,
                "document_label": Path(file_path).name if file_path else "",
                "page_number": _optional_int(file_context.get("page_number")),
                "url": _clean_text(app_context.get("url"), limit=4000),
                "method": _clean_text(grounding.get("method") or capture.get("method"), limit=300),
                "confidence": (
                    _clean_text(capture.get("source_confidence"), limit=100)
                    if capture.get("source_confidence") in {"point_hit", "unknown"}
                    else "unknown"
                ),
                "capture_attestation": capture_attestation,
            },
            "selected_text": _clean_text(capture.get("selected_text"), limit=20000),
            "surrounding_context": _clean_text(capture.get("surrounding_context"), limit=28000),
            "geometry": {"point": point, "bbox": bbox, "capture_bbox": capture_bbox},
            "images": {"raw": raw_image, "pointer": pointer_image},
            "grounding": grounding,
            "file_context": file_context,
            "app_context": app_context,
            "vision_observation": observation,
            "vision_error": vision_error,
        }

    def _record(
        self,
        item_factory: Callable[[str, int, str], JsonDict],
        *,
        now: str,
        workflow_kind: str = "context_pack",
        initial_task: str = "",
        assign_runtime_role: bool = False,
    ) -> JsonDict:
        with self._mutation_lock():
            state = self._load()
            session = self._find_session(state, state.get("active_session_id"))
            if (
                session is not None
                and session.get("status") == "active"
                and str(session.get("workflow_kind") or "context_pack") != workflow_kind
            ):
                session["status"] = "finished"
                session["updated_at"] = now
                session["finished_at"] = now
                state["active_session_id"] = None
                session = None
            if session is None or session.get("status") != "active":
                session = {
                    "session_id": self._new_id("context"),
                    "status": "active",
                    "workflow_kind": workflow_kind,
                    "created_at": now,
                    "updated_at": now,
                    "finished_at": None,
                    "task_instruction": "",
                    "target_profile": "generic",
                    "items": [],
                    "compiled_prompt": None,
                    "prompt_artifact": None,
                }
                state["sessions"].append(session)
                state["active_session_id"] = session["session_id"]
            item = item_factory("pending", len(session["items"]) + 1, now)
            if assign_runtime_role:
                item["role"] = "issue" if not session["items"] else "reference"
            replay = next(
                (existing for existing in session["items"] if existing.get("identity_fingerprint") == item["identity_fingerprint"]),
                None,
            )
            if replay is not None:
                return {
                    "recorded": False,
                    "session_id": session["session_id"],
                    "item": deepcopy(replay),
                    "item_count": len(session["items"]),
                }
            item["item_id"] = self._new_id("item")
            session["items"].append(item)
            if assign_runtime_role and item["role"] == "issue":
                session["task_instruction"] = _clean_text(initial_task, limit=12000)
            session["updated_at"] = now
            session["compiled_prompt"] = None
            session["prompt_artifact"] = None
            state["revision"] += 1
            self._save(state)
            return {
                "recorded": True,
                "session_id": session["session_id"],
                "item": deepcopy(item),
                "item_count": len(session["items"]),
            }

    def record_native(self, snapshot: Any, instruction: str, *, now: str | None = None) -> JsonDict:
        stamp = now or _now_iso()
        return self._record(
            lambda item_id, sequence, current: self._normalize_native(
                snapshot,
                instruction,
                item_id=item_id,
                sequence=sequence,
                now=current,
            ),
            now=stamp,
        )

    def record_visual(self, capture: Any, instruction: str, *, now: str | None = None) -> JsonDict:
        stamp = now or _now_iso()
        return self._record(
            lambda item_id, sequence, current: self._normalize_visual(
                capture,
                instruction,
                item_id=item_id,
                sequence=sequence,
                now=current,
            ),
            now=stamp,
        )

    def record_runtime_visual(self, capture: Any, statement: str, *, now: str | None = None) -> JsonDict:
        exact_statement = _clean_text(statement, limit=12000)
        if not exact_statement:
            raise ContextSessionError("runtime issue statement is empty")
        stamp = now or _now_iso()
        return self._record(
            lambda item_id, sequence, current: self._normalize_visual(
                capture,
                exact_statement,
                item_id=item_id,
                sequence=sequence,
                now=current,
            ),
            now=stamp,
            workflow_kind="runtime_issue",
            initial_task=exact_statement,
            assign_runtime_role=True,
        )

    def save_compilation(
        self,
        *,
        task_instruction: str,
        target_profile: str,
        prompt: str,
        prompt_artifact: str,
        expected_session_id: str,
        expected_revision: int,
        expected_items_digest: str,
        now: str | None = None,
    ) -> JsonDict:
        stamp = now or _now_iso()
        with self._mutation_lock():
            state = self._load()
            session = self._find_session(state, state.get("active_session_id"))
            if session is None or session.get("status") != "active":
                raise ContextSessionError("there is no active context session")
            if (
                session.get("session_id") != expected_session_id
                or state.get("revision") != expected_revision
                or self._items_digest(session.get("items")) != expected_items_digest
            ):
                raise ContextSessionConflict("context session changed while compiling")
            session["task_instruction"] = _clean_text(task_instruction, limit=12000)
            session["target_profile"] = _clean_text(target_profile, limit=100) or "generic"
            session["compiled_prompt"] = str(prompt or "")
            session["prompt_artifact"] = str(prompt_artifact or "")
            session["updated_at"] = stamp
            state["revision"] += 1
            self._save(state)
            return self._public_session(session, revision=state["revision"])

    def finish(
        self,
        *,
        expected_session_id: str | None = None,
        now: str | None = None,
    ) -> JsonDict:
        stamp = now or _now_iso()
        with self._mutation_lock():
            state = self._load()
            session = self._find_session(state, state.get("active_session_id"))
            if session is None or session.get("status") != "active":
                raise ContextSessionError("there is no active context session")
            if expected_session_id is not None and session.get("session_id") != expected_session_id:
                raise ContextSessionConflict("context session changed before finish")
            session["status"] = "finished"
            session["updated_at"] = stamp
            session["finished_at"] = stamp
            state["active_session_id"] = None
            state["revision"] += 1
            self._save(state)
            return self._public_session(session, revision=state["revision"])
