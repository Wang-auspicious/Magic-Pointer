"""Undo/compensation ledger for action_guard (harness gap review L5).

Every mutating action records a :class:`Compensation` before it runs:
what was written, where the cursor was, whether the target was newly
created. :class:`UndoLog` is the thread-safe stack that replays those
compensations on demand, newest first (LIFO) or by ``action_id``.

Failure semantics (documented contract):
  * ``undo()`` on an empty stack raises :class:`UndoEmptyError`.
  * ``undo(action_id)`` with no matching entry raises
    :class:`UndoNotFoundError`; undoing the same id twice therefore
    fails with ``UndoNotFoundError`` the second time.
  * If ``compensate`` raises, :class:`UndoFailedError` carries the
    ``action_id`` and the original cause. The entry is still removed:
    a failed compensation is never silently re-queued, and a single
    failure never blocks later undos. Callers decide whether to retry.

Pure Python (``threading.Lock`` only); timestamps are supplied by the
caller so the ledger stays deterministic and clock-free.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass
from typing import Callable

DEFAULT_UNDO_CAPACITY = 20


class UndoEmptyError(RuntimeError):
    """Raised when ``undo()`` is asked to pop an empty stack."""


class UndoNotFoundError(RuntimeError):
    """Raised when ``undo(action_id)`` cannot find the given id."""


class UndoFailedError(RuntimeError):
    """A compensation ran and failed; the entry was still removed.

    ``action_id`` identifies the failed action; ``cause`` is the original
    exception raised by ``compensate``.
    """

    __slots__ = ("action_id", "cause")

    def __init__(self, action_id: str, cause: BaseException) -> None:
        super().__init__(
            f"compensation failed for action {action_id!r}: {cause}"
        )
        self.action_id = action_id
        self.cause = cause


@dataclass(frozen=True)
class Compensation:
    """Everything needed to undo one action.

    ``compensate`` is injected (e.g. a closure over the real target) so
    tests can use fake targets and production code stays free of
    action-specific logic.
    """

    action_id: str
    tool_name: str
    target_ref: str | None
    prior_content: str | None
    cursor_position: tuple[int, int] | None
    was_created: bool
    captured_at_utc: str
    compensate: Callable[["Compensation"], None]


class UndoLog:
    """Thread-safe, capacity-bounded stack of compensations."""

    __slots__ = ("_capacity", "_lock", "_stack")

    def __init__(self, capacity: int = DEFAULT_UNDO_CAPACITY) -> None:
        if capacity < 1:
            raise ValueError("capacity must be >= 1")
        self._capacity = capacity
        self._lock = threading.Lock()
        self._stack: list[Compensation] = []

    def record(self, compensation: Compensation) -> None:
        """Push a compensation; evict the oldest entry when over capacity."""
        with self._lock:
            self._stack.append(compensation)
            if len(self._stack) > self._capacity:
                del self._stack[0]

    def undo(self, action_id: str | None = None) -> Compensation:
        """Undo newest entry (``action_id=None``) or the entry with id.

        The matched entry is removed *before* ``compensate`` runs. If
        ``compensate`` raises, :class:`UndoFailedError` is raised and the
        entry stays removed; later ``undo`` calls still work.
        """
        with self._lock:
            if action_id is None:
                if not self._stack:
                    raise UndoEmptyError("undo log is empty")
                compensation = self._stack.pop()
            else:
                for index in range(len(self._stack) - 1, -1, -1):
                    if self._stack[index].action_id == action_id:
                        compensation = self._stack.pop(index)
                        break
                else:
                    raise UndoNotFoundError(
                        f"no compensation for action {action_id!r}"
                    )
        try:
            compensation.compensate(compensation)
        except BaseException as cause:
            raise UndoFailedError(compensation.action_id, cause) from cause
        return compensation

    def can_undo(self) -> bool:
        with self._lock:
            return bool(self._stack)

    def size(self) -> int:
        with self._lock:
            return len(self._stack)

    def peek(self) -> Compensation | None:
        with self._lock:
            if not self._stack:
                return None
            return self._stack[-1]

    def all_actions(self) -> list[Compensation]:
        """Audit view of the stack, oldest first (record order)."""
        with self._lock:
            return list(self._stack)
