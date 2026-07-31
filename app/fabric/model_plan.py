from __future__ import annotations

"""Model-produced structured plan contract.

Responsibility split (2026-07-31 review audit follow-ups):
- Local system owns speed and determinism: capture, OCR, object extraction,
  execution, verification, undo.
- The model owns understanding and planning: intent, target objects, and a
  small set of tool calls from a fixed registry.

A :class:`ModelPlan` is the only artifact a model is allowed to produce.  It
never names screen coordinates or mouse actions directly; execution stays in
the local executor layer.  Keyword recipe routing remains the offline
fallback when no model plan is available.
"""

import json
from dataclasses import dataclass, field
from typing import Any

from app.fabric.schema import RiskLevel

MAX_TOOL_CALLS = 16
MAX_TARGET_OBJECT_IDS = 32
MAX_INTENT_CHARS = 200
MAX_RESULT_CHARS = 500
MAX_VERIFICATION_CHARS = 200
MAX_ARGUMENT_KEY_CHARS = 80
MAX_ARGUMENT_VALUE_CHARS = 16_000
MAX_PLAN_BYTES = 64 * 1024

_SCALAR_ARGUMENT_TYPES = (str, int, float, bool)


@dataclass(frozen=True)
class ToolSpec:
    """Registry entry describing how a model tool maps to a local recipe."""

    tool: str
    recipe_id: str | None
    risk: RiskLevel
    min_objects: int = 1
    max_objects: int = 1
    required_arguments: tuple[str, ...] = ()
    implemented: bool = True

    def to_dict(self) -> dict[str, Any]:
        return {
            "tool": self.tool,
            "recipeId": self.recipe_id,
            "risk": self.risk.value,
            "minObjects": self.min_objects,
            "maxObjects": self.max_objects,
            "requiredArguments": list(self.required_arguments),
            "implemented": self.implemented,
        }


def _spec(
    tool: str,
    recipe_id: str,
    risk: RiskLevel,
    *,
    min_objects: int = 1,
    max_objects: int = 1,
    required: tuple[str, ...] = (),
) -> ToolSpec:
    return ToolSpec(
        tool=tool,
        recipe_id=recipe_id,
        risk=risk,
        min_objects=min_objects,
        max_objects=max_objects,
        required_arguments=required,
    )


# Model-friendly tool names -> local recipes.  Tools without a recipe_id are
# recognized (so the model can request them) but not yet implemented; the
# validator rejects execution attempts until a local executor exists.
TOOL_REGISTRY: dict[str, ToolSpec] = {
    "copy_text": _spec("copy_text", "text.ocr_copy", RiskLevel.LOCAL_WRITE),
    "clean_ocr_text": _spec("clean_ocr_text", "text.ocr_clean", RiskLevel.LOCAL_WRITE),
    "rewrite_text": _spec("rewrite_text", "text.rewrite_in_place", RiskLevel.LOCAL_WRITE, required=("style",)),
    "replace_text": _spec("replace_text", "text.rewrite_in_place", RiskLevel.LOCAL_WRITE, required=("text",)),
    "translate_text": _spec("translate_text", "text.translate_in_place", RiskLevel.LOCAL_WRITE, required=("language",)),
    "summarize_text": _spec("summarize_text", "text.summarize_route", RiskLevel.LOCAL_WRITE),
    "insert_text": ToolSpec("insert_text", None, RiskLevel.LOCAL_WRITE, implemented=False),
    "fill_form": ToolSpec("fill_form", None, RiskLevel.LOCAL_WRITE, implemented=False),
    "extract_table": _spec("extract_table", "table.to_spreadsheet", RiskLevel.LOCAL_WRITE),
    "merge_tables": _spec("merge_tables", "table.merge", RiskLevel.LOCAL_WRITE, min_objects=2, max_objects=12),
    "extract_chart_data": _spec("extract_chart_data", "chart.extract_data", RiskLevel.LOCAL_WRITE),
    "create_calendar_event": _spec("create_calendar_event", "calendar.create_from_screen", RiskLevel.EXTERNAL_SEND, required=("title",)),
    "open_map_route": _spec("open_map_route", "map.route", RiskLevel.EXTERNAL_SEND, min_objects=2, max_objects=2, required=("destination",)),
    "create_task": _spec("create_task", "task.route", RiskLevel.EXTERNAL_SEND),
    "save_evidence_card": _spec("save_evidence_card", "research.evidence_card", RiskLevel.LOCAL_WRITE, max_objects=8),
    "compare_objects": _spec("compare_objects", "objects.compare", RiskLevel.LOCAL_WRITE, min_objects=2, max_objects=12),
    "handoff_to_agent": _spec("handoff_to_agent", "agent.handoff", RiskLevel.EXTERNAL_SEND, required=("agent",)),
    "background_agent_task": _spec("background_agent_task", "agent.background_task", RiskLevel.EXTERNAL_SEND, min_objects=0, max_objects=12),
}

_RISK_ORDER = {
    RiskLevel.READ: 0,
    RiskLevel.LOCAL_WRITE: 1,
    RiskLevel.EXTERNAL_SEND: 2,
    RiskLevel.DESTRUCTIVE: 3,
    RiskLevel.PURCHASE: 4,
}


@dataclass(frozen=True)
class ModelToolCall:
    tool: str
    arguments: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {"tool": self.tool, "arguments": dict(self.arguments)}


@dataclass(frozen=True)
class ModelPlan:
    intent: str
    target_object_ids: tuple[str, ...]
    requested_result: str
    tool_calls: tuple[ModelToolCall, ...]
    risk_level: RiskLevel
    needs_confirmation: bool
    expected_verification: str
    model: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "intent": self.intent,
            "targetObjectIds": list(self.target_object_ids),
            "requestedResult": self.requested_result,
            "toolCalls": [call.to_dict() for call in self.tool_calls],
            "riskLevel": self.risk_level.value,
            "needsConfirmation": self.needs_confirmation,
            "expectedVerification": self.expected_verification,
            "model": self.model,
        }


class ModelPlanError(ValueError):
    """Raised when a model-produced plan violates the contract."""


def _bounded_str(value: Any, name: str, max_chars: int, *, allow_empty: bool = False) -> str:
    if not isinstance(value, str):
        raise ModelPlanError(f"{name} must be a string")
    if not allow_empty and not value.strip():
        raise ModelPlanError(f"{name} must not be empty")
    if len(value) > max_chars:
        raise ModelPlanError(f"{name} exceeds {max_chars} characters")
    return value


def _clean_arguments(raw: Any) -> dict[str, Any]:
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        raise ModelPlanError("toolCalls[].arguments must be an object")
    cleaned: dict[str, Any] = {}
    for key, value in raw.items():
        if not isinstance(key, str) or not key or len(key) > MAX_ARGUMENT_KEY_CHARS:
            raise ModelPlanError(f"toolCalls[].arguments key is invalid: {key!r}")
        if isinstance(value, str):
            if len(value) > MAX_ARGUMENT_VALUE_CHARS:
                raise ModelPlanError(f"argument {key!r} exceeds {MAX_ARGUMENT_VALUE_CHARS} characters")
            cleaned[key] = value
        elif isinstance(value, bool) or isinstance(value, (int, float)):
            cleaned[key] = value
        elif isinstance(value, list):
            if len(value) > 64:
                raise ModelPlanError(f"argument {key!r} list exceeds 64 items")
            cleaned[key] = [
                item if isinstance(item, _SCALAR_ARGUMENT_TYPES) else str(item)[:MAX_ARGUMENT_VALUE_CHARS]
                for item in value
            ]
        else:
            raise ModelPlanError(f"argument {key!r} has unsupported type {type(value).__name__}")
    return cleaned


def _tool_call_from_dict(raw: Any) -> ModelToolCall:
    if not isinstance(raw, dict):
        raise ModelPlanError("toolCalls[] must be an object")
    tool = _bounded_str(raw.get("tool"), "toolCalls[].tool", 80)
    spec = TOOL_REGISTRY.get(tool)
    if spec is None:
        raise ModelPlanError(f"unknown tool {tool!r}")
    if not spec.implemented:
        raise ModelPlanError(f"tool {tool!r} is not implemented yet")
    arguments = _clean_arguments(raw.get("arguments"))
    for required in spec.required_arguments:
        if required not in arguments:
            raise ModelPlanError(f"tool {tool!r} requires argument {required!r}")
    return ModelToolCall(tool=tool, arguments=arguments)


def _risk_from_value(value: Any) -> RiskLevel:
    try:
        return RiskLevel(str(value or RiskLevel.READ.value))
    except ValueError as exc:
        raise ModelPlanError(f"invalid riskLevel {value!r}") from exc


@dataclass(frozen=True)
class ValidationResult:
    ok: bool
    errors: tuple[str, ...]
    plan: ModelPlan | None

    def to_dict(self) -> dict[str, Any]:
        return {"ok": self.ok, "errors": list(self.errors), "plan": None if self.plan is None else self.plan.to_dict()}


def parse_model_plan(value: Any) -> ModelPlan:
    """Strictly parse and validate a model-produced plan.  Raises ModelPlanError."""
    if not isinstance(value, dict):
        raise ModelPlanError("model plan must be an object")
    intent = _bounded_str(value.get("intent"), "intent", MAX_INTENT_CHARS)
    requested_result = _bounded_str(value.get("requestedResult") or "", "requestedResult", MAX_RESULT_CHARS, allow_empty=True)
    expected_verification = _bounded_str(
        value.get("expectedVerification") or "", "expectedVerification", MAX_VERIFICATION_CHARS, allow_empty=True
    )

    raw_targets = value.get("targetObjectIds") or value.get("target_object_ids")
    if not isinstance(raw_targets, list) or not raw_targets:
        raise ModelPlanError("targetObjectIds must be a non-empty list")
    if len(raw_targets) > MAX_TARGET_OBJECT_IDS:
        raise ModelPlanError(f"targetObjectIds exceeds {MAX_TARGET_OBJECT_IDS} entries")
    target_ids: list[str] = []
    for raw in raw_targets:
        if not isinstance(raw, str) or not raw.strip() or len(raw) > 160:
            raise ModelPlanError("targetObjectIds entries must be non-empty strings no longer than 160 characters")
        target_ids.append(raw)

    raw_calls = value.get("toolCalls") or value.get("tool_calls")
    if not isinstance(raw_calls, list) or not raw_calls:
        raise ModelPlanError("toolCalls must be a non-empty list")
    if len(raw_calls) > MAX_TOOL_CALLS:
        raise ModelPlanError(f"toolCalls exceeds {MAX_TOOL_CALLS} entries")
    calls = tuple(_tool_call_from_dict(item) for item in raw_calls)

    declared_risk = _risk_from_value(value.get("riskLevel") or value.get("risk_level"))
    needs_confirmation_raw = value.get("needsConfirmation", value.get("needs_confirmation", False))
    if not isinstance(needs_confirmation_raw, bool):
        raise ModelPlanError("needsConfirmation must be a boolean")
    needs_confirmation = needs_confirmation_raw

    effective_risk = declared_risk
    for call in calls:
        spec = TOOL_REGISTRY[call.tool]
        if _RISK_ORDER[spec.risk] > _RISK_ORDER[declared_risk]:
            raise ModelPlanError(
                f"riskLevel {declared_risk.value!r} is lower than tool {call.tool!r} requires ({spec.risk.value})"
            )
        if len(target_ids) < spec.min_objects or len(target_ids) > spec.max_objects:
            raise ModelPlanError(
                f"tool {call.tool!r} expects {spec.min_objects}-{spec.max_objects} target objects, got {len(target_ids)}"
            )
        if _RISK_ORDER[spec.risk] > _RISK_ORDER[effective_risk]:
            effective_risk = spec.risk

    if effective_risk in {RiskLevel.DESTRUCTIVE, RiskLevel.PURCHASE} and not needs_confirmation:
        raise ModelPlanError("destructive or purchase plans must set needsConfirmation=true")

    model = _bounded_str(value.get("model") or "", "model", 120, allow_empty=True)
    encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(encoded) > MAX_PLAN_BYTES:
        raise ModelPlanError(f"model plan exceeds {MAX_PLAN_BYTES} UTF-8 bytes")

    return ModelPlan(
        intent=intent,
        target_object_ids=tuple(target_ids),
        requested_result=requested_result,
        tool_calls=calls,
        risk_level=effective_risk,
        needs_confirmation=needs_confirmation,
        expected_verification=expected_verification,
        model=model,
    )


def validate_model_plan(value: Any) -> ValidationResult:
    """Non-raising wrapper used by callers that must not crash on model output."""
    try:
        plan = parse_model_plan(value)
    except ModelPlanError as exc:
        return ValidationResult(ok=False, errors=(str(exc),), plan=None)
    return ValidationResult(ok=True, errors=(), plan=plan)


def tool_registry_public() -> list[dict[str, Any]]:
    """Machine-readable tool list for model prompts and the dashboard."""
    return [spec.to_dict() for spec in TOOL_REGISTRY.values()]
