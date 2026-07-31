from __future__ import annotations

import pytest

from app.fabric.model_plan import (
    TOOL_REGISTRY,
    ModelPlanError,
    parse_model_plan,
    tool_registry_public,
    validate_model_plan,
)
from app.fabric.schema import RiskLevel


def _valid_translate() -> dict:
    return {
        "intent": "translate the selected text to English",
        "targetObjectIds": ["object_1"],
        "requestedResult": "translated text written back in place",
        "toolCalls": [{"tool": "translate_text", "arguments": {"language": "en"}}],
        "riskLevel": "local_write",
        "needsConfirmation": False,
        "expectedVerification": "read_back_and_compare",
        "model": "test-model",
    }


def test_valid_plan_parses_and_round_trips() -> None:
    plan = parse_model_plan(_valid_translate())
    assert plan.intent == "translate the selected text to English"
    assert plan.target_object_ids == ("object_1",)
    assert plan.tool_calls[0].tool == "translate_text"
    assert plan.tool_calls[0].arguments == {"language": "en"}
    assert plan.risk_level is RiskLevel.LOCAL_WRITE
    assert plan.needs_confirmation is False
    assert plan.expected_verification == "read_back_and_compare"
    assert plan.model == "test-model"

    reparsed = parse_model_plan(plan.to_dict())
    assert reparsed == plan


def test_validator_wrapper_returns_structured_result() -> None:
    result = validate_model_plan(_valid_translate())
    assert result.ok is True
    assert result.errors == ()
    assert result.plan is not None

    bad = dict(_valid_translate())
    bad["toolCalls"] = [{"tool": "no_such_tool"}]
    failed = validate_model_plan(bad)
    assert failed.ok is False
    assert failed.plan is None
    assert "unknown tool" in failed.errors[0]


@pytest.mark.parametrize(
    ("mutate", "message"),
    [
        (lambda value: value.update({"intent": ""}), "intent must not be empty"),
        (lambda value: value.update({"intent": "x" * 201}), "intent exceeds 200 characters"),
        (lambda value: value.update({"targetObjectIds": []}), "targetObjectIds must be a non-empty list"),
        (lambda value: value.update({"targetObjectIds": ["ok", 42]}), "targetObjectIds entries"),
        (lambda value: value.update({"toolCalls": []}), "toolCalls must be a non-empty list"),
        (lambda value: value.update({"toolCalls": [{"tool": "mystery_tool"}]}), "unknown tool"),
        (lambda value: value.update({"toolCalls": [{"tool": "insert_text"}]}), "not implemented yet"),
        (lambda value: value.update({"toolCalls": [{"tool": "translate_text"}]}), "requires argument"),
        (lambda value: value.update({"riskLevel": "read"}), "lower than tool"),
        (lambda value: value.update({"needsConfirmation": "yes"}), "must be a boolean"),
        (lambda value: value.update({"toolCalls": [{"tool": "translate_text", "arguments": {"language": {"nested": 1}}}]}), "unsupported type"),
    ],
)
def test_invalid_plans_fail_closed(mutate, message) -> None:
    value = _valid_translate()
    mutate(value)
    with pytest.raises(ModelPlanError, match=message):
        parse_model_plan(value)


def test_destructive_plan_requires_confirmation() -> None:
    value = {
        "intent": "delete the selected rows",
        "targetObjectIds": ["object_1"],
        "requestedResult": "rows removed",
        "toolCalls": [{"tool": "replace_text", "arguments": {"text": ""}}],
        "riskLevel": "destructive",
        "needsConfirmation": False,
        "expectedVerification": "read_back_and_compare",
    }
    with pytest.raises(ModelPlanError, match="needsConfirmation=true"):
        parse_model_plan(value)
    value["needsConfirmation"] = True
    assert parse_model_plan(value).needs_confirmation is True


def test_tool_object_count_bounds_are_enforced() -> None:
    value = _valid_translate()
    value["targetObjectIds"] = ["object_1", "object_2"]
    with pytest.raises(ModelPlanError, match="expects 1-1 target objects"):
        parse_model_plan(value)

    multi = {
        "intent": "compare these two selections",
        "targetObjectIds": ["object_1", "object_2"],
        "requestedResult": "comparison",
        "toolCalls": [{"tool": "compare_objects"}],
        "riskLevel": "local_write",
        "needsConfirmation": False,
        "expectedVerification": "source_ids_and_comparison_hash",
    }
    assert parse_model_plan(multi).target_object_ids == ("object_1", "object_2")


def test_advisor_tool_names_are_registered() -> None:
    for tool in (
        "replace_text",
        "insert_text",
        "copy_text",
        "translate_text",
        "fill_form",
        "create_calendar_event",
        "extract_table",
        "open_map_route",
        "handoff_to_agent",
    ):
        assert tool in TOOL_REGISTRY, f"advisor tool {tool} must be registered"


def test_registry_public_view_is_serializable() -> None:
    public = tool_registry_public()
    assert len(public) == len(TOOL_REGISTRY)
    for entry in public:
        assert set(entry) == {
            "tool", "recipeId", "risk", "minObjects", "maxObjects", "requiredArguments", "implemented",
        }
    by_tool = {entry["tool"]: entry for entry in public}
    assert by_tool["translate_text"]["recipeId"] == "text.translate_in_place"
    assert by_tool["insert_text"]["implemented"] is False
