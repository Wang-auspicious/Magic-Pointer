from __future__ import annotations

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


class ReviewSessionError(RuntimeError):
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
    for key in ("title", "hwnd", "process_id", "process_name", "class_name"):
        if value.get(key) is not None:
            output[key] = value[key] if key in {"hwnd", "process_id"} else str(value[key])[:1000]
    return output


def _safe_rectangles(value: Any) -> list[list[float]]:
    output: list[list[float]] = []
    for item in value if isinstance(value, list) else []:
        if not isinstance(item, (list, tuple)) or len(item) != 4:
            continue
        try:
            output.append([float(part) for part in item])
        except (TypeError, ValueError):
            continue
        if len(output) >= 32:
            break
    return output


class ReviewSessionStore:
    def __init__(
        self,
        root: Path | str | None = None,
        *,
        id_factory: Callable[[], str] | None = None,
    ) -> None:
        self.root = Path(root) if root is not None else _default_root()
        self.path = self.root / "review" / "review_sessions.json"
        self.id_factory = id_factory or (lambda: uuid.uuid4().hex)

    def _new_id(self, prefix: str) -> str:
        raw = str(self.id_factory())
        return raw if raw.startswith(f"{prefix}-") else f"{prefix}-{raw}"

    @staticmethod
    def _default_state() -> JsonDict:
        return {
            "version": STORE_VERSION,
            "revision": 0,
            "active_session_id": None,
            "sessions": [],
        }

    def _validate_state(self, state: Any) -> JsonDict:
        if not isinstance(state, dict) or state.get("version") != STORE_VERSION:
            raise ReviewSessionError("unsupported review session schema version")
        if not isinstance(state.get("sessions"), list):
            raise ReviewSessionError("invalid review sessions")
        if not isinstance(state.get("revision"), int) or state["revision"] < 0:
            raise ReviewSessionError("invalid review session revision")
        return state

    def _load(self) -> JsonDict:
        if not self.path.exists():
            return self._default_state()
        try:
            return self._validate_state(json.loads(self.path.read_text(encoding="utf-8")))
        except (OSError, json.JSONDecodeError) as exc:
            raise ReviewSessionError(f"could not read review sessions: {type(exc).__name__}: {exc}") from exc

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
            raise ReviewSessionError(f"could not persist review sessions: {type(exc).__name__}: {exc}") from exc

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
    def _public_session(session: JsonDict) -> JsonDict:
        output = deepcopy(session)
        output["anchor_count"] = len(output.get("anchors") or [])
        return output

    def active(self) -> JsonDict | None:
        state = self._load()
        session = self._find_session(state, state.get("active_session_id"))
        if session is None or session.get("status") != "active":
            return None
        return self._public_session(session)

    def _normalize_anchor(
        self,
        snapshot: Any,
        instruction: str,
        *,
        anchor_id: str,
        sequence: int,
        now: str,
    ) -> JsonDict:
        note = _clean_text(instruction, limit=8000)
        if not note:
            raise ReviewSessionError("review instruction is empty")
        if not isinstance(snapshot, dict) or not isinstance(snapshot.get("context"), dict):
            raise ReviewSessionError("review requires a grounded selection context")
        context = snapshot["context"]
        artifacts = context.get("artifacts") if isinstance(context.get("artifacts"), dict) else {}
        selected_text = _clean_text(context.get("content"), limit=16000)
        surrounding = _clean_text(artifacts.get("selection_context"), limit=24000)
        if not selected_text and not surrounding and not artifacts:
            raise ReviewSessionError("review requires a grounded selection context")
        document_path = _clean_text(
            artifacts.get("pdf_document_path") or artifacts.get("document") or context.get("label"),
            limit=4000,
        )
        document_label = _clean_text(
            artifacts.get("document_name") or (Path(document_path).name if document_path else context.get("label")),
            limit=1000,
        )
        return {
            "anchor_id": anchor_id,
            "sequence": sequence,
            "instruction": note,
            "captured_at": _clean_text(snapshot.get("captured_at"), limit=100) or now,
            "recorded_at": now,
            "snapshot_id": _clean_text(snapshot.get("snapshot_id"), limit=200),
            "source_window": _safe_window(snapshot.get("source_window") or context.get("window")),
            "app": _clean_text(context.get("app"), limit=100) or "application",
            "method": _clean_text(context.get("method"), limit=300),
            "document_path": document_path,
            "document_label": document_label,
            "page_number": _optional_int(artifacts.get("pdf_page_number")),
            "selected_text": selected_text,
            "surrounding_context": surrounding,
            "selection_rectangles": _safe_rectangles(artifacts.get("selection_rectangles")),
        }

    def record(self, snapshot: Any, instruction: str, *, now: str | None = None) -> JsonDict:
        stamp = now or _now_iso()
        with self._mutation_lock():
            state = self._load()
            session = self._find_session(state, state.get("active_session_id"))
            if session is None or session.get("status") != "active":
                session = {
                    "session_id": self._new_id("review"),
                    "status": "active",
                    "created_at": stamp,
                    "updated_at": stamp,
                    "finished_at": None,
                    "artifact": {},
                    "anchors": [],
                    "compiled_prompt": None,
                    "prompt_artifact": None,
                }
                state["sessions"].append(session)
                state["active_session_id"] = session["session_id"]

            snapshot_id = _clean_text(snapshot.get("snapshot_id") if isinstance(snapshot, dict) else "", limit=200)
            clean_instruction = _clean_text(instruction, limit=8000)
            replay = next(
                (
                    item for item in session["anchors"]
                    if item.get("snapshot_id") == snapshot_id and item.get("instruction") == clean_instruction
                ),
                None,
            )
            if replay is not None:
                return {
                    "recorded": False,
                    "session_id": session["session_id"],
                    "anchor": deepcopy(replay),
                    "anchor_count": len(session["anchors"]),
                }

            anchor = self._normalize_anchor(
                snapshot,
                clean_instruction,
                anchor_id=self._new_id("anchor"),
                sequence=len(session["anchors"]) + 1,
                now=stamp,
            )
            session["anchors"].append(anchor)
            session["updated_at"] = stamp
            if not session["artifact"]:
                session["artifact"] = {
                    "document_path": anchor["document_path"],
                    "document_label": anchor["document_label"],
                    "app": anchor["app"],
                }
            session["compiled_prompt"] = None
            session["prompt_artifact"] = None
            state["revision"] += 1
            self._save(state)
            return {
                "recorded": True,
                "session_id": session["session_id"],
                "anchor": deepcopy(anchor),
                "anchor_count": len(session["anchors"]),
            }

    def finish(self, *, now: str | None = None) -> JsonDict:
        stamp = now or _now_iso()
        with self._mutation_lock():
            state = self._load()
            session = self._find_session(state, state.get("active_session_id"))
            if session is None or session.get("status") != "active":
                raise ReviewSessionError("there is no active review session")
            session["status"] = "finished"
            session["updated_at"] = stamp
            session["finished_at"] = stamp
            state["active_session_id"] = None
            state["revision"] += 1
            self._save(state)
            return self._public_session(session)
