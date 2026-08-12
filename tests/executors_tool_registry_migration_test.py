"""Tool-registry migration tests: high-traffic fabric actions as tools.

Every migrated action is exercised through its envelope with the underlying
executor method monkeypatched — nothing here touches a real clipboard, OCR
engine, model, browser, agent starter or file store. The old executor paths
keep their own suite (clipboard_history_executor_test.py, image_prompt_test.py,
inplace_write_back_honesty_test.py, overlay_translation_executor_test.py,
screen_memory_executor_test.py); this file only tests the new registration
surface and its call chain.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.agent_runtime.tool_registry import Effect, ToolRegistry
from app.agent_runtime.tool_registry import FailureType  # errors.py fallback-safe
from app.fabric.executors import FabricExecutors, register_fabric_tools
from app.fabric.schema import ExecutionReceipt

# (tool name, recipe id, provider, used_backend, effect, is_concurrency_safe)
MIGRATED_TOOLS: list[tuple[str, str, str, str, Effect, bool]] = [
    ("ocr_copy", "text.ocr_copy", "native.ocr", "ocr", Effect.REVERSIBLE_WRITE, False),
    ("ocr_clean", "text.ocr_clean", "clipboard", "ocr", Effect.REVERSIBLE_WRITE, False),
    ("rewrite_in_place", "text.rewrite_in_place", "inplace.text", "model", Effect.REVERSIBLE_WRITE, False),
    ("translate_in_place", "text.translate_in_place", "inplace.text", "model", Effect.REVERSIBLE_WRITE, False),
    ("summarize_route", "text.summarize_route", "model.text", "model", Effect.REVERSIBLE_WRITE, False),
    ("selection_expand", "selection.expand", "inplace.text", "model", Effect.REVERSIBLE_WRITE, False),
    ("selection_condense", "selection.condense", "inplace.text", "model", Effect.REVERSIBLE_WRITE, False),
    ("to_spreadsheet", "table.to_spreadsheet", "artifact.table", "local", Effect.REVERSIBLE_WRITE, False),
    ("merge_tables", "table.merge", "artifact.table", "local", Effect.REVERSIBLE_WRITE, False),
    ("evidence_card", "research.evidence_card", "artifact.evidence", "local", Effect.REVERSIBLE_WRITE, False),
    ("image_to_prompt", "image.to_prompt", "artifact.visual_context", "local", Effect.REVERSIBLE_WRITE, False),
    ("map_route", "map.route", "maps.deep_link", "local", Effect.EXTERNAL_SEND, False),
    ("agent_handoff", "agent.handoff", "agent.task", "agent", Effect.EXTERNAL_SEND, False),
    ("background_task", "agent.background_task", "agent.task", "agent", Effect.EXTERNAL_SEND, False),
    ("task_route", "task.route", "local.task", "local", Effect.EXTERNAL_SEND, False),
    ("screen_translate", "screen.translate", "overlay.translation", "model", Effect.READ, True),
    ("clipboard_history", "clipboard.history", "clipboard.history", "local", Effect.REVERSIBLE_WRITE, False),
    ("memory_recall", "memory.recall", "local.memory", "local", Effect.READ, True),
]

# tool name -> existing executor method the envelope must call
TOOL_METHOD: dict[str, str] = {
    "ocr_copy": "_ocr",
    "ocr_clean": "_clipboard",
    "rewrite_in_place": "_inplace_text",
    "translate_in_place": "_inplace_text",
    "summarize_route": "_model_text",
    "selection_expand": "_inplace_text",
    "selection_condense": "_inplace_text",
    "to_spreadsheet": "_table",
    "merge_tables": "_table",
    "evidence_card": "_evidence",
    "image_to_prompt": "_image_prompt",
    "map_route": "_map",
    "agent_handoff": "_agent",
    "background_task": "_agent",
    "task_route": "_task",
    "screen_translate": "_overlay_translation",
    "clipboard_history": "_clipboard_history",
    "memory_recall": "_memory_recall",
}

# tools whose recipe allows zero objects (minObjects == 0)
NO_OBJECT_REQUIRED: set[str] = {"background_task", "clipboard_history", "memory_recall"}

# extra action-specific arguments and the plan parameter they must land in
EXTRA_PARAM: dict[str, dict[str, object]] = {
    "image_to_prompt": {"question": "这是什么？"},
    "map_route": {"travelMode": "transit"},
    "agent_handoff": {"agent": "codex", "cwd": r"C:\work"},
    "screen_translate": {"targetLanguage": "德语"},
    "clipboard_history": {"query": "magic"},
    "memory_recall": {"query": "上午看的", "enabled": True},
}


def _receipt_for(plan) -> ExecutionReceipt:
    return ExecutionReceipt(
        id="receipt-1",
        plan_id=plan.id,
        recipe_id=plan.recipe_id,
        status="succeeded",
        provider=plan.provider,
        output={"ok": True},
        verified=True,
    )


def _sample_args(name: str) -> dict[str, object]:
    args: dict[str, object] = {
        "command": "do it",
        "objects": [
            {"id": "obj-1", "kind": "text", "content": "hello world", "source": {"app": "notepad"}}
        ],
        "idempotencyKey": "idem-1",
    }
    if name == "screen_translate":
        args["objects"] = [{"id": "obj-1", "blocks": [{"text": "Hello"}, {"text": "World"}]}]
    elif name == "map_route":
        args["objects"] = [
            {"id": "a", "kind": "text", "content": "北京"},
            {"id": "b", "kind": "text", "content": "上海"},
        ]
    elif name == "image_to_prompt":
        args["objects"] = [{"id": "obj-1", "kind": "image", "source": {"path": "x.png"}}]
    elif name in NO_OBJECT_REQUIRED:
        del args["objects"]
    args.update(EXTRA_PARAM.get(name, {}))
    return args


def _registered_runner(monkeypatch, tmp_path: Path, name: str) -> tuple[FabricExecutors, ToolRegistry, list]:
    """Runner with the tool's method replaced by a capturing fake, plus registry."""
    runner = FabricExecutors(root=tmp_path)
    calls: list = []

    def fake_method(plan):
        calls.append(plan)
        return _receipt_for(plan)

    monkeypatch.setattr(runner, TOOL_METHOD[name], fake_method)
    registry = ToolRegistry()
    register_fabric_tools(registry, executors=runner)
    return runner, registry, calls


@pytest.fixture
def registry() -> ToolRegistry:
    reg = ToolRegistry()
    register_fabric_tools(reg)
    return reg


# -- 1. registration surface --------------------------------------------------


def test_registration_lists_all_migrated_tools(registry: ToolRegistry) -> None:
    names = [spec.name for spec in registry.list()]
    assert set(names) == {entry[0] for entry in MIGRATED_TOOLS}
    assert len(names) == len(MIGRATED_TOOLS)

    schemas = registry.schemas_for_model()
    assert len(schemas) == len(MIGRATED_TOOLS)
    by_name = {entry["name"]: entry for entry in schemas}
    for name, recipe, provider, *_ in MIGRATED_TOOLS:
        entry = by_name[name]
        assert recipe in entry["description"]
        assert provider in entry["description"]
        params = entry["parameters"]
        assert params["type"] == "object"
        assert isinstance(params["properties"], dict)
        assert isinstance(params["required"], list)


def test_re_registration_is_idempotent(registry: ToolRegistry) -> None:
    before = [spec.name for spec in registry.list()]
    register_fabric_tools(registry)  # must not raise
    register_fabric_tools(registry)
    after = [spec.name for spec in registry.list()]
    assert after == before


# -- 2. envelope call chain (monkeypatched, no real side effects) -------------


@pytest.mark.parametrize(
    "name,recipe,provider,backend,effect,concurrent",
    MIGRATED_TOOLS,
)
def test_execute_envelopes_existing_method(
    monkeypatch,
    tmp_path: Path,
    name: str,
    recipe: str,
    provider: str,
    backend: str,
    effect: Effect,
    concurrent: bool,
) -> None:
    _, registry, calls = _registered_runner(monkeypatch, tmp_path, name)
    args = _sample_args(name)
    result = registry.execute_tool(name, args)

    assert result.is_error is False
    assert result.used_backend == backend
    assert len(calls) == 1
    plan = calls[0]
    assert plan.recipe_id == recipe
    assert plan.provider == provider
    assert plan.command == args["command"]
    assert plan.idempotency_key == args["idempotencyKey"]
    if "objects" in args:
        assert plan.parameters["objects"] == args["objects"]
        assert plan.object_ids == ("obj-1",) or plan.object_ids == ("a", "b")
    for key, value in EXTRA_PARAM.get(name, {}).items():
        assert plan.parameters.get(key) == value

    assert isinstance(result.value, str)
    payload = json.loads(result.value)
    assert payload["recipeId"] == recipe
    assert payload["status"] == "succeeded"
    assert payload["provider"] == provider


def test_execute_scope_kwarg_is_accepted(monkeypatch, tmp_path: Path) -> None:
    """The harness forwards its cancellation token; envelopes must not break."""
    _, registry, calls = _registered_runner(monkeypatch, tmp_path, "summarize_route")
    result = registry.execute_tool(
        "summarize_route",
        {"objects": [{"id": "obj-1", "content": "x"}]},
        scope="cancel-token",
    )
    assert result.is_error is False
    assert len(calls) == 1


def test_execute_tool_wraps_executor_exception(monkeypatch, tmp_path: Path) -> None:
    runner = FabricExecutors(root=tmp_path)

    def boom(plan):
        raise RuntimeError("no model configured")

    monkeypatch.setattr(runner, "_model_text", boom)
    registry = ToolRegistry()
    register_fabric_tools(registry, executors=runner)

    result = registry.execute_tool("summarize_route", {"objects": [{"content": "x"}]})
    assert result.is_error is True
    assert result.failure_type == FailureType.TOOL_ERROR
    assert "no model configured" in (result.error_message or "")


# -- 3. effect / concurrency / backend mapping ---------------------------------


@pytest.mark.parametrize(
    "name,recipe,provider,backend,effect,concurrent",
    MIGRATED_TOOLS,
)
def test_effect_concurrency_backend_mapping(
    registry: ToolRegistry,
    name: str,
    recipe: str,
    provider: str,
    backend: str,
    effect: Effect,
    concurrent: bool,
) -> None:
    spec = registry.get(name)
    assert spec.effect == effect
    assert spec.is_concurrency_safe is concurrent
    assert spec.used_backend == backend
    assert spec.timeout_ms > 0


def test_read_recipes_are_concurrency_safe_reads() -> None:
    for name, _recipe, _provider, _backend, effect, concurrent in MIGRATED_TOOLS:
        assert (effect == Effect.READ) == concurrent, name


def test_clipboard_history_is_reversible_write_not_pure_read(
    registry: ToolRegistry,
) -> None:
    spec = registry.get("clipboard_history")
    assert spec.effect is Effect.REVERSIBLE_WRITE
    assert spec.is_concurrency_safe is False
    assert "restore" in spec.description
    assert "read" in spec.description


def test_write_recipes_are_reversible_or_external_sends() -> None:
    for name, _recipe, _provider, _backend, effect, _concurrent in MIGRATED_TOOLS:
        if effect == Effect.READ:
            continue
        assert effect in (Effect.REVERSIBLE_WRITE, Effect.EXTERNAL_SEND), name


def test_concurrency_partition(registry: ToolRegistry) -> None:
    names = [entry[0] for entry in MIGRATED_TOOLS]
    parallel, sequential = registry.concurrency_partition(names)
    assert set(parallel) == {entry[0] for entry in MIGRATED_TOOLS if entry[5]}
    assert set(sequential) == {entry[0] for entry in MIGRATED_TOOLS if not entry[5]}
    # order preserved within each partition
    assert parallel == [n for n in names if n in set(parallel)]
    assert sequential == [n for n in names if n in set(sequential)]


# -- 4. schema gate ------------------------------------------------------------


def test_validate_input_requires_objects_where_recipe_needs_them(registry: ToolRegistry) -> None:
    for name, _recipe, _provider, _backend, _effect, _concurrent in MIGRATED_TOOLS:
        spec = registry.get(name)
        if name in NO_OBJECT_REQUIRED:
            assert registry.validate_input(spec, {"command": "x"}) == []
        else:
            errors = registry.validate_input(spec, {"command": "x"})
            assert any("objects" in error for error in errors), name


def test_validate_input_rejects_unexpected_fields(registry: ToolRegistry) -> None:
    spec = registry.get("ocr_copy")
    errors = registry.validate_input(spec, {"objects": [{}], "bogusField": 1})
    assert any("bogusField" in error for error in errors)


def test_validate_input_type_checks(registry: ToolRegistry) -> None:
    spec = registry.get("memory_recall")
    errors = registry.validate_input(spec, {"enabled": "yes"})
    assert any("enabled" in error for error in errors)
