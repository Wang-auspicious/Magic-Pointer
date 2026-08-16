"""Steer / followup 输入模型：用户在 agent 运行中继续输入的家。

四家参考源码的共同形状（Pi 的 steerQueue/followUpQueue、DSH 的 Inbox
target、CC 的 queueMode、Hermes 的 /steer pre-API drain）收敛成最小版：

- ``next-step``（steer）：在下一轮模型调用前注入本轮消息——模型正在
  跑的时候用户插的话，下一轮就看见，不吞、不等收工。
- ``next-turn``（followup）：模型想停时若队列非空，续跑新轮——排队不
  伪装成已发送，也不杀循环。

与 :func:`app.agent_runtime.loop.LoopParams.interrupt_check` 的分工：
interrupt 是 cancel（硬停），inbox 是 steer（改向）。线程安全：put 可以来自
工具执行线程 / UI 线程，drain 只发生在 loop 的边界上。
"""

from __future__ import annotations

import itertools
import threading
from collections import deque
from dataclasses import dataclass

__all__ = ["Inbox", "InboxTarget", "InboxItem"]

InboxTarget = str  # "next-step" | "next-turn"（字面量语义，勿造第三种）

DEFAULT_CAPACITY = 32


@dataclass(frozen=True, slots=True)
class InboxItem:
    """一条排队输入。"""

    text: str
    target: InboxTarget
    sequence: int


class Inbox:
    """按 target 分队列的有界 FIFO；溢出挤掉最旧的（保住用户最近的话）。"""

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

    def put(self, text: str, target: InboxTarget = "next-step") -> bool:
        """排队一条输入；空白文本拒绝（False），溢出挤掉最旧并计数。"""
        cleaned = str(text or "").strip()
        if not cleaned:
            return False
        queue = self._queues.get(target)
        if queue is None:
            raise ValueError(f"unknown inbox target {target!r}")
        with self._lock:
            queue.append(InboxItem(cleaned, target, next(self._sequence)))
            while len(queue) > self._capacity:
                queue.popleft()
                self.dropped += 1
        return True

    def drain(self, target: InboxTarget) -> list[str]:
        """取出并清空一条队列（FLO 按入队序）。"""
        queue = self._queues.get(target)
        if queue is None:
            raise ValueError(f"unknown inbox target {target!r}")
        with self._lock:
            items = list(queue)
            queue.clear()
        return [item.text for item in items]

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
