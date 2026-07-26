from __future__ import annotations

import uuid
from typing import Any

from app.actions.schema import ActionProposal, ActionTarget, SafetyLevel
from app.fabric.schema import RiskLevel


_SAFETY = {
    RiskLevel.READ: SafetyLevel.READ_ONLY,
    RiskLevel.LOCAL_WRITE: SafetyLevel.LOW,
    RiskLevel.EXTERNAL_SEND: SafetyLevel.HIGH,
    RiskLevel.DESTRUCTIVE: SafetyLevel.DESTRUCTIVE,
    RiskLevel.PURCHASE: SafetyLevel.DESTRUCTIVE,
}


def make_fabric_action_proposal(plan: dict[str, Any]) -> ActionProposal:
    recipe_id = str(plan.get("recipeId") or "")
    plan_id = str(plan.get("id") or "")
    integrity_token = str(plan.get("integrityToken") or "")
    if not recipe_id or not plan_id or not integrity_token:
        raise ValueError("fabric plan is incomplete or unsigned")
    risk = RiskLevel(str(plan.get("risk") or RiskLevel.READ.value))
    return ActionProposal(
        id=str(uuid.uuid4()),
        action_type="fabric_recipe_execute",
        target=ActionTarget(
            object_id=f"magic-pointer://fabric/recipe/{recipe_id}",
            description=str((plan.get("preview") or {}).get("title") or recipe_id),
            metadata={"recipe_id": recipe_id, "plan_id": plan_id},
        ),
        parameters={"plan": plan},
        safety_level=_SAFETY[risk],
        confirmation_required=plan.get("requiresConfirmation") is True,
        rationale=str((plan.get("preview") or {}).get("description") or ""),
        metadata={
            "trusted_local_intent": True,
            "fabric_plan_signed": True,
            "recipe_id": recipe_id,
            "plan_id": plan_id,
            "auto_execute": plan.get("requiresConfirmation") is not True,
        },
    )
