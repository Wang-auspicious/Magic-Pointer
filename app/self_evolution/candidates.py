"""Recoverable candidate mutations for background learning.

Adapted from HermesAgent's background review and learning mutations (MIT),
with a stricter boundary for Magic Pointer: background work may only propose;
only an explicit user approval may atomically write user-owned learning,
skills, or plugin files. Core source is never a legal target.
"""

from __future__ import annotations

import difflib
import functools
import hashlib
import json
import os
import stat
import threading
import time
import uuid
from contextlib import contextmanager, suppress
from dataclasses import asdict, dataclass
from pathlib import Path, PurePosixPath
from typing import Any

__all__ = [
    "CandidateConflictError",
    "CandidatePermissionError",
    "LearningCandidate",
    "LearningCandidateStore",
]

_KIND_ROOTS = {
    "memory": "learning",
    "skill": "skills",
    "plugin": "plugins",
}
_PROCESS_STORE_LOCKS: dict[str, threading.RLock] = {}
_PROCESS_STORE_LOCKS_GUARD = threading.Lock()


@contextmanager
def _exclusive_store_lock(path: Path):
    """Serialize candidate mutations across threads and local processes."""
    path.parent.mkdir(parents=True, exist_ok=True)
    key = str(path.resolve())
    with _PROCESS_STORE_LOCKS_GUARD:
        process_lock = _PROCESS_STORE_LOCKS.setdefault(key, threading.RLock())
    with process_lock, path.open("a+b") as handle:
        handle.seek(0, os.SEEK_END)
        if handle.tell() == 0:
            handle.write(b"\0")
            handle.flush()
        handle.seek(0)
        if os.name == "nt":
            import msvcrt  # noqa: PLC0415 -- platform-specific import

            msvcrt.locking(handle.fileno(), msvcrt.LK_LOCK, 1)
        else:
            import fcntl  # noqa: PLC0415 -- platform-specific import

            fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            handle.seek(0)
            if os.name == "nt":
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def _serialized_mutation(method):
    @functools.wraps(method)
    def wrapped(self, *args, **kwargs):
        with _exclusive_store_lock(self.state_root / ".mutation.lock"):
            return method(self, *args, **kwargs)

    return wrapped


class CandidatePermissionError(PermissionError):
    """A proposal or decision crossed the user-owned learning boundary."""


class CandidateConflictError(RuntimeError):
    """The target changed since review, so the candidate is stale."""


@dataclass(frozen=True, slots=True)
class LearningCandidate:
    id: str
    session_id: str
    kind: str
    target: str
    proposed_content: str
    original_content: str
    rationale: str
    old_hash: str
    new_hash: str
    target_existed: bool
    created_at_ms: int
    status: str = "pending"
    approved_by: str = ""
    decided_at_ms: int = 0
    decision_reason: str = ""
    backup_path: str = ""

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> LearningCandidate:
        return cls(**payload)


def _hash_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _atomic_write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.parent / f".{path.name}.{uuid.uuid4().hex}.tmp"
    try:
        with temp.open("xb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp, path)
    finally:
        with suppress(OSError):
            temp.unlink(missing_ok=True)


class LearningCandidateStore:
    """On-disk pending/applied/rejected learning changes with rollback."""

    def __init__(self, user_root: Path | str) -> None:
        self.user_root = Path(user_root).resolve()
        self.state_root = self.user_root / "self-evolution"
        self.candidates_dir = self.state_root / "candidates"
        self.backups_dir = self.state_root / "backups"
        self.audit_path = self.state_root / "audit.jsonl"

    @_serialized_mutation
    def propose(
        self,
        *,
        session_id: str,
        kind: str,
        target: str,
        proposed_content: str,
        rationale: str,
    ) -> LearningCandidate:
        target_path, relative = self._resolve_target(kind, target)
        if not isinstance(proposed_content, str):
            raise ValueError("proposed content must be text")
        if not proposed_content:
            raise ValueError("proposed content must not be empty")
        if not str(rationale or "").strip():
            raise ValueError("candidate rationale must not be empty")
        target_existed = target_path.is_file()
        if target_path.exists() and not target_existed:
            raise CandidatePermissionError("learning target must be a regular file")
        try:
            original_bytes = target_path.read_bytes() if target_existed else b""
            original_content = original_bytes.decode("utf-8")
        except UnicodeError as exc:
            raise CandidatePermissionError("learning targets must be UTF-8 text") from exc
        old_bytes = original_bytes
        new_bytes = proposed_content.encode("utf-8")
        old_hash = _hash_bytes(old_bytes)
        new_hash = _hash_bytes(new_bytes)
        identity = f"{kind}\0{relative}\0{old_hash}\0{new_hash}"
        candidate_id = hashlib.sha256(identity.encode("utf-8")).hexdigest()[:24]
        existing_path = self._candidate_path(candidate_id)
        if existing_path.is_file():
            existing = self.get(candidate_id)
            if existing.status == "pending":
                return existing
            # A decided candidate is immutable audit history.  A later review
            # may make the same proposal again, but it receives a fresh id
            # instead of rewriting rejected/applied/rolled-back evidence.
            while existing_path.exists():
                candidate_id = hashlib.sha256(
                    f"{identity}\0{uuid.uuid4().hex}".encode()
                ).hexdigest()[:24]
                existing_path = self._candidate_path(candidate_id)
        candidate = LearningCandidate(
            id=candidate_id,
            session_id=str(session_id),
            kind=kind,
            target=relative,
            proposed_content=proposed_content,
            original_content=original_content,
            rationale=str(rationale).strip(),
            old_hash=old_hash,
            new_hash=new_hash,
            target_existed=target_existed,
            created_at_ms=int(time.time() * 1000),
        )
        self._save(candidate)
        self._audit(candidate, "proposed", actor="background_review")
        return candidate

    def get(self, candidate_id: str) -> LearningCandidate:
        path = self._candidate_path(candidate_id)
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            raise KeyError(f"unknown learning candidate {candidate_id!r}") from None
        if not isinstance(payload, dict):
            raise ValueError("candidate record must be an object")
        try:
            candidate = LearningCandidate.from_dict(payload)
        except (TypeError, ValueError) as exc:
            raise CandidateConflictError(
                f"candidate {candidate_id!r} failed record integrity validation"
            ) from exc
        if (
            candidate.id != candidate_id
            or _hash_bytes(candidate.proposed_content.encode("utf-8"))
            != candidate.new_hash
            or _hash_bytes(candidate.original_content.encode("utf-8"))
            != candidate.old_hash
            or (not candidate.target_existed and candidate.original_content != "")
        ):
            raise CandidateConflictError(
                f"candidate {candidate_id!r} failed content integrity validation"
            )
        return candidate

    def list(self, *, status: str | None = None) -> list[LearningCandidate]:
        if not self.candidates_dir.is_dir():
            return []
        candidates: list[LearningCandidate] = []
        for path in sorted(self.candidates_dir.glob("*.json")):
            candidate = self.get(path.stem)
            if status is None or candidate.status == status:
                candidates.append(candidate)
        return sorted(candidates, key=lambda item: (item.created_at_ms, item.id))

    def diff(self, candidate_id: str) -> str:
        candidate = self.get(candidate_id)
        return "".join(
            difflib.unified_diff(
                candidate.original_content.splitlines(keepends=True),
                candidate.proposed_content.splitlines(keepends=True),
                fromfile=f"a/{candidate.target}",
                tofile=f"b/{candidate.target}",
            )
        )

    @_serialized_mutation
    def apply(self, candidate_id: str, *, approved_by: str) -> LearningCandidate:
        self._require_user(approved_by)
        candidate = self.get(candidate_id)
        if candidate.status != "pending":
            raise CandidateConflictError(
                f"candidate {candidate.id} is {candidate.status}, not pending"
            )
        target, _ = self._resolve_target(candidate.kind, candidate.target)
        if target.exists() and not target.is_file():
            raise CandidateConflictError(
                f"target {candidate.target!r} is no longer a regular file"
            )
        current = target.read_bytes() if target.is_file() else b""
        if _hash_bytes(current) != candidate.old_hash:
            raise CandidateConflictError(
                f"target {candidate.target!r} changed since background review"
            )
        backup = self.backups_dir / f"{candidate.id}.bak"
        _atomic_write(backup, current)
        _atomic_write(target, candidate.proposed_content.encode("utf-8"))
        updated = LearningCandidate(
            **{
                **asdict(candidate),
                "status": "applied",
                "approved_by": "user",
                "decided_at_ms": int(time.time() * 1000),
                "backup_path": str(backup),
            }
        )
        self._save(updated)
        self._audit(updated, "applied", actor="user")
        return updated

    @_serialized_mutation
    def reject(
        self,
        candidate_id: str,
        *,
        approved_by: str,
        reason: str,
    ) -> LearningCandidate:
        self._require_user(approved_by)
        candidate = self.get(candidate_id)
        if candidate.status != "pending":
            raise CandidateConflictError(
                f"candidate {candidate.id} is {candidate.status}, not pending"
            )
        updated = LearningCandidate(
            **{
                **asdict(candidate),
                "status": "rejected",
                "approved_by": "user",
                "decided_at_ms": int(time.time() * 1000),
                "decision_reason": str(reason or "").strip(),
            }
        )
        self._save(updated)
        self._audit(updated, "rejected", actor="user")
        return updated

    @_serialized_mutation
    def rollback(self, candidate_id: str, *, approved_by: str) -> LearningCandidate:
        self._require_user(approved_by)
        candidate = self.get(candidate_id)
        if candidate.status != "applied" or not candidate.backup_path:
            raise CandidateConflictError("only an applied candidate can be rolled back")
        target, _ = self._resolve_target(candidate.kind, candidate.target)
        current = target.read_bytes() if target.is_file() else b""
        if _hash_bytes(current) != candidate.new_hash:
            raise CandidateConflictError(
                f"target {candidate.target!r} changed after candidate application"
            )
        backup = Path(candidate.backup_path)
        expected_backup = (self.backups_dir / f"{candidate.id}.bak").resolve()
        if backup.resolve() != expected_backup or not backup.is_file():
            raise CandidateConflictError("candidate backup is missing or invalid")
        backup_bytes = backup.read_bytes()
        if _hash_bytes(backup_bytes) != candidate.old_hash:
            raise CandidateConflictError("candidate backup failed integrity validation")
        if candidate.target_existed:
            _atomic_write(target, backup_bytes)
        else:
            target.unlink(missing_ok=True)
        updated = LearningCandidate(
            **{
                **asdict(candidate),
                "status": "rolled_back",
                "approved_by": "user",
                "decided_at_ms": int(time.time() * 1000),
            }
        )
        self._save(updated)
        self._audit(updated, "rolled_back", actor="user")
        return updated

    def _resolve_target(self, kind: str, target: str) -> tuple[Path, str]:
        expected_root = _KIND_ROOTS.get(str(kind))
        if expected_root is None:
            raise CandidatePermissionError(f"unsupported learning kind {kind!r}")
        raw = str(target or "").replace("\\", "/")
        relative_path = PurePosixPath(raw)
        if relative_path.is_absolute() or not relative_path.parts:
            raise CandidatePermissionError("learning target must be relative")
        if any(part in ("", ".", "..") for part in relative_path.parts):
            raise CandidatePermissionError("learning target cannot traverse directories")
        if relative_path.parts[0] != expected_root:
            raise CandidatePermissionError(
                f"{kind} candidates must stay under {expected_root}/"
            )
        relative = relative_path.as_posix()
        target_path = (self.user_root / Path(*relative_path.parts)).resolve()
        try:
            target_path.relative_to(self.user_root)
        except ValueError as exc:
            raise CandidatePermissionError("learning target escapes user data") from exc
        self._reject_reparse_ancestors(target_path)
        return target_path, relative

    def _reject_reparse_ancestors(self, target: Path) -> None:
        current = self.user_root
        for part in target.relative_to(self.user_root).parts:
            current = current / part
            if not current.exists():
                continue
            info = current.lstat()
            attributes = int(getattr(info, "st_file_attributes", 0))
            if stat.S_ISLNK(info.st_mode) or attributes & 0x400:
                raise CandidatePermissionError(
                    f"learning target crosses a symlink/reparse point: {current}"
                )

    def _candidate_path(self, candidate_id: str) -> Path:
        if not re_full_candidate_id(candidate_id):
            raise ValueError("invalid candidate id")
        return self.candidates_dir / f"{candidate_id}.json"

    def _save(self, candidate: LearningCandidate) -> None:
        payload = json.dumps(
            asdict(candidate),
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
        _atomic_write(self._candidate_path(candidate.id), payload)

    def _audit(self, candidate: LearningCandidate, action: str, *, actor: str) -> None:
        payload = {
            "time": int(time.time() * 1000),
            "candidateId": candidate.id,
            "sessionId": candidate.session_id,
            "target": candidate.target,
            "action": action,
            "approvedBy": actor,
            "oldHash": candidate.old_hash,
            "newHash": candidate.new_hash,
        }
        line = json.dumps(
            payload,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8") + b"\n"
        self.audit_path.parent.mkdir(parents=True, exist_ok=True)
        with self.audit_path.open("ab", buffering=0) as handle:
            handle.write(line)
            os.fsync(handle.fileno())

    @staticmethod
    def _require_user(approved_by: str) -> None:
        if approved_by != "user":
            raise CandidatePermissionError(
                "learning mutation requires explicit user approval"
            )


def re_full_candidate_id(value: str) -> bool:
    return len(str(value)) == 24 and all(ch in "0123456789abcdef" for ch in str(value))
