"""Reusable, platform-neutral schemas for proposed actions and results."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from app.grounding.schema import (
    BoundingBox,
    GroundedObject,
    JsonDict,
    Point,
    bbox_from_json,
    bbox_to_json,
    point_from_json,
    point_to_json,
)


class SafetyLevel(str, Enum):
    READ_ONLY = "read_only"
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    DESTRUCTIVE = "destructive"


_SAFETY_RANK: dict[SafetyLevel, int] = {
    SafetyLevel.READ_ONLY: 0,
    SafetyLevel.LOW: 1,
    SafetyLevel.MEDIUM: 2,
    SafetyLevel.HIGH: 3,
    SafetyLevel.DESTRUCTIVE: 4,
}


def _coerce_safety_level(value: SafetyLevel | str) -> SafetyLevel:
    if isinstance(value, SafetyLevel):
        return value
    return SafetyLevel(str(value))


def _coerce_status(value: "ExecutionStatus | str") -> "ExecutionStatus":
    if isinstance(value, ExecutionStatus):
        return value
    return ExecutionStatus(str(value))


def _optional_bool(value: Any) -> bool | None:
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"true", "1", "yes"}:
            return True
        if normalized in {"false", "0", "no"}:
            return False
    return bool(value)


@dataclass(frozen=True)
class ConfirmationPolicy:
    """Threshold-based confirmation strategy.

    Explicit confirmation requests are honored, but explicit ``False`` does not
    downgrade actions at or above the configured safety threshold.
    """

    confirm_at_or_above: SafetyLevel = SafetyLevel.MEDIUM

    def requires_confirmation(
        self,
        safety_level: SafetyLevel | str,
        explicit_confirmation: bool | None = None,
    ) -> bool:
        if explicit_confirmation is True:
            return True
        level = _coerce_safety_level(safety_level)
        threshold = _coerce_safety_level(self.confirm_at_or_above)
        return _SAFETY_RANK[level] >= _SAFETY_RANK[threshold]

    def to_dict(self) -> JsonDict:
        return {"confirm_at_or_above": _coerce_safety_level(self.confirm_at_or_above).value}

    @classmethod
    def from_dict(cls, data: JsonDict) -> "ConfirmationPolicy":
        return cls(confirm_at_or_above=_coerce_safety_level(data.get("confirm_at_or_above", SafetyLevel.MEDIUM.value)))


@dataclass(frozen=True)
class ActionTarget:
    """Serializable reference to a grounded object, point, or region."""

    object_id: str | None = None
    selection_id: str | None = None
    point: Point | None = None
    bbox: BoundingBox | None = None
    description: str | None = None
    metadata: JsonDict = field(default_factory=dict)

    @classmethod
    def from_grounded_object(cls, obj: GroundedObject, *, point: Point | None = None) -> "ActionTarget":
        return cls(
            object_id=obj.id,
            selection_id=obj.source_selection_id,
            point=point,
            bbox=obj.bbox,
            description=obj.label or obj.text or obj.kind,
            metadata={"kind": obj.kind, **dict(obj.metadata)},
        )

    def to_dict(self) -> JsonDict:
        return {
            "object_id": self.object_id,
            "selection_id": self.selection_id,
            "point": point_to_json(self.point),
            "bbox": bbox_to_json(self.bbox),
            "description": self.description,
            "metadata": dict(self.metadata),
        }

    @classmethod
    def from_dict(cls, data: JsonDict) -> "ActionTarget":
        return cls(
            object_id=data.get("object_id"),
            selection_id=data.get("selection_id"),
            point=point_from_json(data.get("point")),
            bbox=bbox_from_json(data.get("bbox")),
            description=data.get("description"),
            metadata=dict(data.get("metadata") or {}),
        )


@dataclass(frozen=True)
class ActionProposal:
    """A proposed action before execution."""

    id: str
    action_type: str
    target: ActionTarget | None = None
    parameters: JsonDict = field(default_factory=dict)
    safety_level: SafetyLevel = SafetyLevel.LOW
    confirmation_required: bool | None = None
    rationale: str | None = None
    created_at: str | None = None
    metadata: JsonDict = field(default_factory=dict)

    def needs_confirmation(self, policy: ConfirmationPolicy | None = None) -> bool:
        active_policy = policy or ConfirmationPolicy()
        return active_policy.requires_confirmation(self.safety_level, self.confirmation_required)

    def to_dict(self, policy: ConfirmationPolicy | None = None) -> JsonDict:
        level = _coerce_safety_level(self.safety_level)
        return {
            "id": self.id,
            "action_type": self.action_type,
            "target": None if self.target is None else self.target.to_dict(),
            "parameters": dict(self.parameters),
            "safety_level": level.value,
            "confirmation_required": self.needs_confirmation(policy),
            "rationale": self.rationale,
            "created_at": self.created_at,
            "metadata": dict(self.metadata),
        }

    @classmethod
    def from_dict(cls, data: JsonDict) -> "ActionProposal":
        target_data = data.get("target")
        return cls(
            id=str(data["id"]),
            action_type=str(data["action_type"]),
            target=ActionTarget.from_dict(target_data) if isinstance(target_data, dict) else None,
            parameters=dict(data.get("parameters") or {}),
            safety_level=_coerce_safety_level(data.get("safety_level", SafetyLevel.LOW.value)),
            confirmation_required=_optional_bool(data.get("confirmation_required")),
            rationale=data.get("rationale"),
            created_at=data.get("created_at"),
            metadata=dict(data.get("metadata") or {}),
        )


class ExecutionStatus(str, Enum):
    PENDING = "pending"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"
    SKIPPED = "skipped"


@dataclass(frozen=True)
class ExecutionResult:
    """Result record for an attempted action execution."""

    proposal_id: str
    status: ExecutionStatus
    action_type: str | None = None
    output: JsonDict = field(default_factory=dict)
    error: str | None = None
    started_at: str | None = None
    finished_at: str | None = None
    confirmed_by_user: bool | None = None
    metadata: JsonDict = field(default_factory=dict)

    def to_dict(self) -> JsonDict:
        return {
            "proposal_id": self.proposal_id,
            "status": _coerce_status(self.status).value,
            "action_type": self.action_type,
            "output": dict(self.output),
            "error": self.error,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "confirmed_by_user": self.confirmed_by_user,
            "metadata": dict(self.metadata),
        }

    @classmethod
    def from_dict(cls, data: JsonDict) -> "ExecutionResult":
        return cls(
            proposal_id=str(data["proposal_id"]),
            status=_coerce_status(data["status"]),
            action_type=data.get("action_type"),
            output=dict(data.get("output") or {}),
            error=data.get("error"),
            started_at=data.get("started_at"),
            finished_at=data.get("finished_at"),
            confirmed_by_user=_optional_bool(data.get("confirmed_by_user")),
            metadata=dict(data.get("metadata") or {}),
        )

