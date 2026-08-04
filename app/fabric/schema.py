from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any

JsonDict = dict[str, Any]


class RiskLevel(str, Enum):
    READ = "read"
    LOCAL_WRITE = "local_write"
    EXTERNAL_SEND = "external_send"
    DESTRUCTIVE = "destructive"
    PURCHASE = "purchase"


@dataclass(frozen=True)
class RecipeDefinition:
    id: str
    title_zh: str
    description_zh: str
    input_kinds: tuple[str, ...]
    output_kind: str
    provider_strategies: tuple[str, ...]
    risk: RiskLevel
    verification: str
    # Which executor actually does the work, or "unavailable:<reason>" when this
    # machine cannot. It lives on the recipe rather than in a second table keyed
    # by id, because two tables that must agree eventually do not: adding a
    # recipe to one and forgetting the other used to be a KeyError at run time.
    provider: str = "internal"
    keywords_zh: tuple[str, ...] = ()
    keywords_en: tuple[str, ...] = ()
    min_objects: int = 1
    max_objects: int = 1
    platforms: tuple[str, ...] = ("windows", "macos")
    version: int = 1

    def to_public_dict(self) -> JsonDict:
        return {
            "id": self.id,
            "title": self.title_zh,
            "description": self.description_zh,
            "inputKinds": list(self.input_kinds),
            "outputKind": self.output_kind,
            "providerStrategies": list(self.provider_strategies),
            "risk": self.risk.value,
            "verification": self.verification,
            "provider": self.provider,
            "minObjects": self.min_objects,
            "maxObjects": self.max_objects,
            "platforms": list(self.platforms),
            "version": self.version,
        }


@dataclass(frozen=True)
class IntentMatch:
    recipe_id: str | None
    confidence: float
    reference_mode: str
    reason: str
    alternatives: tuple[str, ...] = ()

    def to_dict(self) -> JsonDict:
        return {
            "recipeId": self.recipe_id,
            "confidence": round(float(self.confidence), 4),
            "referenceMode": self.reference_mode,
            "reason": self.reason,
            "alternatives": list(self.alternatives),
        }


@dataclass(frozen=True)
class OperationPlan:
    id: str
    recipe_id: str
    command: str
    risk: RiskLevel
    provider: str
    object_ids: tuple[str, ...]
    parameters: JsonDict = field(default_factory=dict)
    preview: JsonDict = field(default_factory=dict)
    requires_confirmation: bool = False
    idempotency_key: str = ""
    integrity_token: str = ""

    def to_dict(self) -> JsonDict:
        return {
            "id": self.id,
            "recipeId": self.recipe_id,
            "command": self.command,
            "risk": self.risk.value,
            "provider": self.provider,
            "objectIds": list(self.object_ids),
            "parameters": dict(self.parameters),
            "preview": dict(self.preview),
            "requiresConfirmation": self.requires_confirmation,
            "idempotencyKey": self.idempotency_key,
            "integrityToken": self.integrity_token,
        }

    @classmethod
    def from_dict(cls, value: JsonDict) -> "OperationPlan":
        if not isinstance(value, dict):
            raise ValueError("operation plan must be an object")
        return cls(
            id=str(value.get("id") or ""),
            recipe_id=str(value.get("recipeId") or value.get("recipe_id") or ""),
            command=str(value.get("command") or ""),
            risk=RiskLevel(str(value.get("risk") or RiskLevel.READ.value)),
            provider=str(value.get("provider") or ""),
            object_ids=tuple(str(item) for item in value.get("objectIds") or value.get("object_ids") or []),
            parameters=dict(value.get("parameters") or {}),
            preview=dict(value.get("preview") or {}),
            requires_confirmation=value.get("requiresConfirmation") is True or value.get("requires_confirmation") is True,
            idempotency_key=str(value.get("idempotencyKey") or value.get("idempotency_key") or ""),
            integrity_token=str(value.get("integrityToken") or value.get("integrity_token") or ""),
        )


@dataclass(frozen=True)
class ExecutionReceipt:
    id: str
    plan_id: str
    recipe_id: str
    status: str
    provider: str
    output: JsonDict = field(default_factory=dict)
    verified: bool = False
    verification: JsonDict = field(default_factory=dict)
    undo: JsonDict | None = None
    error: str | None = None

    def to_dict(self) -> JsonDict:
        return {
            "id": self.id,
            "planId": self.plan_id,
            "recipeId": self.recipe_id,
            "status": self.status,
            "provider": self.provider,
            "output": dict(self.output),
            "verified": self.verified,
            "verification": dict(self.verification),
            "undo": None if self.undo is None else dict(self.undo),
            "error": self.error,
        }
