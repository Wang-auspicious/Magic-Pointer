
from __future__ import annotations

import threading
from dataclasses import dataclass
from typing import Callable

DEFAULT_UNDO_CAPACITY = 20


class UndoEmptyError(RuntimeError):
    pass


class UndoNotFoundError(RuntimeError):
    pass


class UndoFailedError(RuntimeError):

    __slots__ = ("action_id", "cause")

    def __init__(self, action_id: str, cause: BaseException) -> None:
        super().__init__(
            f"compensation failed for action {action_id!r}: {cause}"
        )
        self.action_id = action_id
        self.cause = cause


@dataclass(frozen=True)
class Compensation:

    action_id: str
    tool_name: str
    target_ref: str | None
    prior_content: str | None
    cursor_position: tuple[int, int] | None
    was_created: bool
    captured_at_utc: str
    compensate: Callable[["Compensation"], None]


class UndoLog:

    __slots__ = ("_capacity", "_lock", "_stack")

    def __init__(self, capacity: int = DEFAULT_UNDO_CAPACITY) -> None:
        if capacity < 1:
            raise ValueError("capacity must be >= 1")
        self._capacity = capacity
        self._lock = threading.Lock()
        self._stack: list[Compensation] = []

    def record(self, compensation: Compensation) -> None:
        with self._lock:
            self._stack.append(compensation)
            if len(self._stack) > self._capacity:
                del self._stack[0]

    def undo(self, action_id: str | None = None) -> Compensation:
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
        with self._lock:
            return list(self._stack)
