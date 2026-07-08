from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any

from app.grounding.schema import GroundedObject, PointerSelection

JsonDict = dict[str, Any]


@dataclass(frozen=True)
class GroundingTrace:
    """Debug metadata emitted by a grounder without coupling callers to internals."""

    adapter: str
    messages: list[str] = field(default_factory=list)
    artifacts: JsonDict = field(default_factory=dict)

    def to_dict(self) -> JsonDict:
        return {
            "adapter": self.adapter,
            "messages": list(self.messages),
            "artifacts": dict(self.artifacts),
        }


@dataclass(frozen=True)
class GroundingBundle:
    """The object-level answer to 'what did the user point at?'."""

    selection: PointerSelection
    objects: list[GroundedObject] = field(default_factory=list)
    primary_object_id: str | None = None
    traces: list[GroundingTrace] = field(default_factory=list)

    @property
    def primary(self) -> GroundedObject | None:
        if self.primary_object_id:
            for obj in self.objects:
                if obj.id == self.primary_object_id:
                    return obj
        return self.objects[0] if self.objects else None

    def to_dict(self) -> JsonDict:
        return {
            "selection": self.selection.to_dict(),
            "objects": [obj.to_dict() for obj in self.objects],
            "primary_object_id": self.primary_object_id,
            "traces": [trace.to_dict() for trace in self.traces],
        }


class BaseGrounder(ABC):
    """Pure interface for local object grounding.

    Grounders may inspect OS/app state, but they must not execute actions.
    """

    name = "base"

    @abstractmethod
    def ground(self, selection: PointerSelection, **kwargs: Any) -> GroundingBundle:
        raise NotImplementedError
