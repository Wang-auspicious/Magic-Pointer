"""Capability tools tests: merged orthogonal tools, model picks by description.

Covers the review Q2/Q5 answers: schemas live in code (single source of
truth), the manifest keeps display metadata, every destination recipe is
reachable through exactly the merged/individual tool set, in-loop reversible
execution is opt-in and guarded.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.agent_runtime.tool_registry import Effect, ToolRegistry  # noqa: E402
from app.fabric.capability_tools import (  # noqa: E402
    CAPABILITY_TOOLS,
    recipe_ids_for_tool,
    register_capability_tools,
    register_find_capability,
)
from app.fabric.catalog import RECIPE_CATALOG  # noqa: E402
from app.fabric.intent_router import is_non_destination_recipe  # noqa: E402


def _registry(*, propose=None, **kwargs) -> ToolRegistry:
    registry = ToolRegistry()
    register_capability_tools(
        registry, propose if propose is not None else lambda *a: {"ok": True}, **kwargs
    )
    return registry


def _spec(registry: ToolRegistry, name: str):
    return next(spec for spec in registry.list() if spec.name == name)


def test_merged_tools_have_real_schemas_and_read_effect() -> None:
    registry = _registry()

    assert len(registry.list()) >= 14
    for spec in registry.list():
        assert spec.effect is Effect.READ
        assert spec.input_schema.get("type") == "object"
        assert "properties" in spec.input_schema
        assert isinstance(spec.description, str) and len(spec.description) > 10
    names = {spec.name for spec in registry.list()}
    assert "text_transform" in names
    assert "compare_objects" in names
    assert "text__translate_in_place" not in names


def test_plumbing_recipes_are_not_offered() -> None:
    registry = _registry()
    names = {spec.name for spec in registry.list()}
    assert "ground__this" not in names
    assert "activate__wiggle" not in names


def test_text_transform_translate_dispatches_to_recipe() -> None:
    proposals: list = []

    def propose(recipe_id, args):
        proposals.append((recipe_id, args))
        return {"ok": True, "requiresConfirmation": True, "recipeId": recipe_id}

    registry = _registry(propose=propose)
    spec = _spec(registry, "text_transform")

    payload = json.loads(spec.execute(operation="translate", language="英文"))
    assert payload["ok"] is True
    assert payload["recipeId"] == "text.translate_in_place"
    assert proposals[-1] == ("text.translate_in_place", {"language": "英文"})


def test_text_transform_screen_scope_dispatches_screen_translate() -> None:
    proposals: list = []

    def propose(recipe_id, args):
        proposals.append((recipe_id, args))
        return {"ok": True, "recipeId": recipe_id}

    registry = _registry(propose=propose)
    spec = _spec(registry, "text_transform")

    payload = json.loads(spec.execute(operation="translate", coverage="screen"))
    assert payload["recipeId"] == "screen.translate"


def test_unknown_operation_returns_honest_error() -> None:
    registry = _registry()
    spec = _spec(registry, "text_transform")

    payload = json.loads(spec.execute(operation="bogus"))
    assert payload["ok"] is False
    assert payload["error"] == "unknown_operation"


def test_individual_tool_forwards_arguments() -> None:
    captured = {}

    def propose(recipe_id, args):
        captured.update(args)
        return {"ok": True}

    registry = _registry(propose=propose)
    spec = _spec(registry, "compare_objects")
    spec.execute(aspect="价格")
    assert captured == {"aspect": "价格"}


def test_every_destination_recipe_is_reachable() -> None:
    registry = _registry()
    reachable: set[str] = set()
    for spec in registry.list():
        reachable.update(recipe_ids_for_tool(spec.name))
    expected = {
        recipe.id
        for recipe in RECIPE_CATALOG
        if not is_non_destination_recipe(recipe)
    }
    missing = expected - reachable
    assert not missing, f"recipes unreachable through any tool: {sorted(missing)}"
    assert "text.translate_in_place" in reachable
    assert "screen.translate" in reachable
    assert "agent.handoff" in reachable


def test_inloop_reversible_registers_write_effect_with_preconditions() -> None:
    receipts: list = []

    def execute_plan(recipe_id, args):
        receipts.append((recipe_id, args))
        return {"ok": True, "status": "executed", "recipeId": recipe_id}

    registry = _registry(execute_plan=execute_plan, inloop_reversible=True)

    transform = _spec(registry, "text_transform")
    assert transform.effect is Effect.REVERSIBLE_WRITE
    assert len(transform.preconditions) == 3

    payload = json.loads(transform.execute(operation="rewrite", style="更简洁"))
    assert payload["status"] == "executed"
    assert receipts[-1] == ("text.rewrite_in_place", {"style": "更简洁"})

    handoff = _spec(registry, "agent_handoff")
    assert handoff.effect is Effect.READ


def test_inloop_without_execute_plan_degrades_to_propose() -> None:
    registry = _registry(execute_plan=None, inloop_reversible=True)
    transform = _spec(registry, "text_transform")
    assert transform.effect is Effect.READ
    assert transform.preconditions == ()
    payload = json.loads(transform.execute(operation="translate"))
    assert payload["ok"] is True


def test_inloop_unverified_execution_receipt_is_returned_as_tool_error() -> None:
    registry = _registry(
        execute_plan=lambda recipe_id, args: {
            "status": "verification_failed",
            "verified": False,
            "recipeId": recipe_id,
            "error": "write_readback_mismatch",
        },
        inloop_reversible=True,
    )

    result = registry.execute_tool(
        "text_transform", {"operation": "rewrite", "style": "更简洁"}
    )

    assert result.is_error is True
    assert "write_readback_mismatch" in (result.error_message or "")


def test_enabled_recipes_filter_removes_fully_disabled_tools() -> None:
    registry = _registry(enabled_recipes={"agent.handoff"})
    names = {spec.name for spec in registry.list()}
    assert "text_transform" not in names
    assert "agent_handoff" in names


def test_find_capability_searches_merged_descriptions() -> None:
    registry = _registry()
    register_find_capability(registry)

    spec = next(s for s in registry.list() if s.name == "find_capability")
    translated = json.loads(spec.execute("翻译"))
    names = {tool["name"] for tool in translated["tools"]}
    assert "text_transform" in names
    tabled = json.loads(spec.execute("表格"))
    names = {tool["name"] for tool in tabled["tools"]}
    assert "data_export" in names
    for tool in tabled["tools"]:
        assert tool["parameters"]["type"] == "object"
