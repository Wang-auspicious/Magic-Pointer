"""Change event model for event-driven perception (harness gap review L9).

UIA exposes ``StructureChanged`` / ``TextChanged`` / ``FocusChanged`` /
``PropertyChanged``; this module is the transport-agnostic event shape plus
the injectable source contract. Real event hosts plug in later; tests use
fake sources.

This module is pure Python and has no I/O or platform dependencies.
"""

from __future__ import annotations

import enum
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Protocol


class ChangeKind(enum.StrEnum):
    """The four UIA-style surface change classes we subscribe to."""

    STRUCTURE_CHANGED = "structure_changed"
    TEXT_CHANGED = "text_changed"
    FOCUS_CHANGED = "focus_changed"
    PROPERTY_CHANGED = "property_changed"


@dataclass(frozen=True, slots=True)
class SurfaceChangeEvent:
    """One observed surface change from an event source.

    Validation invariants:
    - ``event_id`` is a non-empty string (audit/ordering key).
    - ``window_ref`` is a non-empty string (hwnd or stable window id).
    - ``kind`` is a :class:`ChangeKind` member.
    """

    event_id: str
    kind: ChangeKind
    window_ref: str
    element_ref: str | None
    t_utc: str
    args: dict = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not isinstance(self.event_id, str) or not self.event_id.strip():
            raise ValueError(f"event_id must be a non-empty string, got {self.event_id!r}")
        if not isinstance(self.window_ref, str) or not self.window_ref.strip():
            raise ValueError(f"window_ref must be a non-empty string, got {self.window_ref!r}")
        if not isinstance(self.kind, ChangeKind):
            raise ValueError(f"kind must be a ChangeKind, got {self.kind!r}")


class EventSource(Protocol):
    """An injectable producer of :class:`SurfaceChangeEvent` objects.

    The host pushes events by calling the handler installed via
    ``set_handler``. ``start``/``stop`` are lifecycle hooks; whether the
    source owns its own thread is the implementation's business.
    """

    def start(self) -> None: ...

    def stop(self) -> None: ...

    def set_handler(self, handler: Callable[[SurfaceChangeEvent], None] | None) -> None: ...
