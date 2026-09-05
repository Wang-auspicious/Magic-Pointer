"""Task-scoped durable action broker.

The broker is the recovery boundary above ``SafeActionExecutor``.  The
executor performs the write and returns a precise undo proposal; this module
persists that proposal and rebuilds the in-memory compensation after a bridge
or Runtime process restarts.  The journal is an append-only local JSONL file,
so an incomplete or corrupted tail cannot erase earlier recovery records.
"""

from __future__ import annotations

import json
import os
import threading
from pathlib import Path
from typing import Any

from app.action_guard.undo_log import Compensation, UndoLog
from app.actions.schema import ActionProposal, ExecutionResult, ExecutionStatus

JsonDict = dict[str, Any]
_JOURNAL_LOCKS: dict[str, threading.RLock] = {}
_JOURNAL_LOCKS_GUARD = threading.Lock()


def _default_journal_path(task_id: str) -> Path:
    root = Path(os.environ.get("MAGIC_POINTER_USER_DATA_DIR") or Path.home() / ".magic-pointer")
    safe_task = "".join(char if char.isalnum() or char in "-_" else "_" for char in task_id)
    return root / "action-ledger" / f"{safe_task or 'default'}.jsonl"


def _lock_for(path: Path) -> threading.RLock:
    key = str(path.resolve())
    with _JOURNAL_LOCKS_GUARD:
        return _JOURNAL_LOCKS.setdefault(key, threading.RLock())


class ActionBroker:
    """Durable, task-scoped facade for execution and verified undo."""

    def __init__(
        self,
        *,
        task_id: str,
        journal_path: Path | str | None = None,
        executor: Any | None = None,
        undo_log: UndoLog | None = None,
    ) -> None:
        self.task_id = str(task_id).strip() or "default"
        self.journal_path = Path(journal_path) if journal_path is not None else _default_journal_path(self.task_id)
        self._journal_lock = _lock_for(self.journal_path)
        self.undo_log = undo_log or UndoLog()
        if executor is None:
            from app.actions.executor import SafeActionExecutor

            executor = SafeActionExecutor(undo_log=self.undo_log)
        self.executor = executor
        self._rehydrate()

    def execute(self, proposal: ActionProposal, *, confirmed: bool = False) -> ExecutionResult:
        result = self.executor.execute(proposal, confirmed=confirmed)
        if result.status is not ExecutionStatus.SUCCEEDED:
            return result
        raw = result.output.get("undo_proposal")
        if isinstance(raw, dict):
            self._append({
                "kind": "record",
                "task_id": self.task_id,
                "action_id": result.proposal_id,
                "tool_name": result.action_type or "action",
                "undo_proposal": raw,
                "target_ref": self._target_ref(raw),
            })
        return result

    def undo(self, action_id: str | None = None) -> Compensation:
        compensation = self.undo_log.undo(action_id)
        self._append({
            "kind": "undone",
            "task_id": self.task_id,
            "action_id": compensation.action_id,
        })
        return compensation

    def can_undo(self) -> bool:
        return self.undo_log.can_undo()

    def _rehydrate(self) -> None:
        records: dict[str, JsonDict] = {}
        undone: set[str] = set()
        with self._journal_lock:
            if not self.journal_path.exists():
                return
            try:
                lines = self.journal_path.read_text(encoding="utf-8").splitlines()
            except OSError:
                return
        for line in lines:
            try:
                event = json.loads(line)
            except (TypeError, ValueError):
                continue
            if not isinstance(event, dict) or event.get("task_id") != self.task_id:
                continue
            action_id = str(event.get("action_id") or "")
            if not action_id:
                continue
            if event.get("kind") == "record" and isinstance(event.get("undo_proposal"), dict):
                records[action_id] = event
                undone.discard(action_id)
            elif event.get("kind") == "undone":
                undone.add(action_id)
                records.pop(action_id, None)
        for action_id, event in records.items():
            raw = event["undo_proposal"]
            try:
                proposal = ActionProposal.from_dict(raw)
            except (KeyError, TypeError, ValueError):
                continue

            def compensate(_: Compensation, proposal: ActionProposal = proposal) -> None:
                result = self.executor.execute(proposal, confirmed=True)
                if result.status is not ExecutionStatus.SUCCEEDED:
                    raise RuntimeError(result.error or f"undo action returned {result.status.value}")

            self.undo_log.record(Compensation(
                action_id=action_id,
                tool_name=str(event.get("tool_name") or "action"),
                target_ref=event.get("target_ref"),
                prior_content=None,
                cursor_position=None,
                was_created=False,
                captured_at_utc="rehydrated",
                compensate=compensate,
            ))

    def _append(self, event: JsonDict) -> None:
        line = json.dumps(event, ensure_ascii=False, separators=(",", ":")) + "\n"
        with self._journal_lock:
            self.journal_path.parent.mkdir(parents=True, exist_ok=True)
            with self.journal_path.open("a", encoding="utf-8") as handle:
                handle.write(line)

    @staticmethod
    def _target_ref(raw: JsonDict) -> str | None:
        target = raw.get("target")
        if not isinstance(target, dict):
            return None
        value = target.get("selection_id") or target.get("object_id")
        return str(value) if value else None
