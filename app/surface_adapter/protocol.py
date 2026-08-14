"""SurfaceAdapter resolution protocol (design §8).

A resolver turns the window + gesture point into an ordered graph of raw
objects. Every object carries its evidence source; nothing here claims a
structured guarantee it does not have. ``text`` may be empty for a
pixel-only object — the caller merges OCR/vision evidence on top and the
object stays the anchor for that evidence.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol, runtime_checkable

__all__ = ["RawObject", "ResolveResult", "SurfaceResolver"]


@dataclass(frozen=True)
class RawObject:
    id: str
    kind: str
    label: str
    text: str
    rect_xywh: tuple[int, int, int, int] | None
    order_index: int
    confidence: float
    evidence: str
    fields: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "kind": self.kind,
            "label": self.label,
            "text": self.text,
            "rect_xywh": None if self.rect_xywh is None else list(self.rect_xywh),
            "order_index": self.order_index,
            "confidence": round(float(self.confidence), 4),
            "evidence": self.evidence,
            "fields": dict(self.fields),
        }


@dataclass(frozen=True)
class ResolveResult:
    adapter_id: str
    objects: tuple[RawObject, ...]
    window: dict[str, Any]
    notes: tuple[str, ...] = ()

    @property
    def ordered_text(self) -> str:
        return "\n".join(
            f"[{index}] {obj.label}: {obj.text}"
            for index, obj in enumerate(self.objects)
            if obj.text.strip()
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "adapterId": self.adapter_id,
            "objects": [obj.to_dict() for obj in self.objects],
            "window": dict(self.window),
            "notes": list(self.notes),
        }


@runtime_checkable
class SurfaceResolver(Protocol):
    """One application family's surface semantics."""

    def matches(self, window: dict[str, Any]) -> bool: ...

    def resolve(
        self,
        window: dict[str, Any],
        target_point: dict[str, int] | None,
        target_region: dict[str, int] | None,
    ) -> ResolveResult | None: ...
