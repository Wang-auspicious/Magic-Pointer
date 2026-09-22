
from __future__ import annotations

import itertools
import threading
from collections import deque
from dataclasses import dataclass
from typing import Any, Mapping

__all__ = ["Inbox", "InboxTarget", "InboxItem"]

InboxTarget = str

DEFAULT_CAPACITY = 32


@dataclass(frozen=True, slots=True)
class InboxItem:

    text: str
    target: InboxTarget
    sequence: int
    payload: dict[str, Any] | None = None


class Inbox:

    def __init__(self, capacity: int = DEFAULT_CAPACITY) -> None:
        if capacity < 1:
            raise ValueError("inbox capacity must be >= 1")
        self._capacity = capacity
        self._lock = threading.Lock()
        self._queues: dict[str, deque[InboxItem]] = {
            "next-step": deque(),
            "next-turn": deque(),
        }
        self._sequence = itertools.count()
        self.dropped = 0

    def put(
        self,
        text: str,
        target: InboxTarget = "next-step",
        *,
        payload: Mapping[str, Any] | None = None,
    ) -> bool:
        cleaned = str(text or "").strip()
        normalized_payload = dict(payload) if payload is not None else None
        if not cleaned and not normalized_payload:
            return False
        queue = self._queues.get(target)
        if queue is None:
            raise ValueError(f"unknown inbox target {target!r}")
        with self._lock:
            if normalized_payload is not None and len(queue) >= self._capacity:
                return False
            queue.append(InboxItem(cleaned, target, next(self._sequence), normalized_payload))
            while len(queue) > self._capacity:
                queue.popleft()
                self.dropped += 1
        return True

    def drain_items(self, target: InboxTarget) -> list[InboxItem]:
        queue = self._queues.get(target)
        if queue is None:
            raise ValueError(f"unknown inbox target {target!r}")
        with self._lock:
            items = list(queue)
            queue.clear()
        return items

    def drain(self, target: InboxTarget) -> list[str]:
        return [item.text for item in self.drain_items(target)]

    def pending(self, target: InboxTarget) -> int:
        queue = self._queues.get(target)
        if queue is None:
            raise ValueError(f"unknown inbox target {target!r}")
        with self._lock:
            return len(queue)

    def clear(self) -> None:
        with self._lock:
            for queue in self._queues.values():
                queue.clear()
