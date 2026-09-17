"""Tool exposure is a real loop contract, not just a registry inventory."""
from __future__ import annotations

import asyncio
import json

import pytest

from app.agent_runtime.loop import _select_tool_schemas
from app.agent_runtime.model_client import LoopModelClient, ToolCallArrived, TurnDone
from app.agent_runtime.session import FileSessionStore
from app.agent_runtime.tool_registry import ToolRegistry, ToolSpec
from app.agent_runtime.types import ToolCall, TransitionReason
from app.agent_runtime.tool_discovery import register_find_capability
from app.harness.builtin_bundle import LoopHarnessHost, boot_loop_context
from agent_runtime_loop_test import ScriptedBackend, collect, make_params
from harness_builtin_bundle_test import _runtime

RETIRED = {
    "text_transform", "clipboard_text", "data_export", "image_ops", "screen_help",
    "task_route", "place_route", "agent_handoff", "table_merge", "compare_objects",
    "research_card", "vision_bridge", "canvas_transform", "recipe_scale",
}


def _registry():
    registry = ToolRegistry()
    for name in ("SpecialRead", "OtherRead"):
        registry.register(ToolSpec(
            name=name,
            description=f"Read a {name} record. More detail follows. " + "detail " * 80,
            input_schema={"type": "object", "properties": {"item": {"type": "string"}}, "required": ["item"]},
            execute=lambda item, scope=None: f"read:{item}",
            deferred=True,
        ))
    register_find_capability(registry)
    return registry


def test_boot_removes_recipe_wrappers_but_keeps_real_tools(tmp_path):
    for resident in (False, True):
        host = LoopHarnessHost(root=tmp_path, plugin_dir=tmp_path / "plugins") if resident else None
        report = host.open(_runtime()) if host else boot_loop_context(_runtime(), root=tmp_path)
        try:
            registry = report.ctx.get("tools")
            names = {spec.name for spec in registry.list()}
            assert not (names & RETIRED)
            assert {"Around", "Recall", "Click", "act_ui", "Tools"} <= names
            assert not registry.search("text_transform")
            schemas = _select_tool_schemas(make_params(registry=registry, tool_limit=128))
            offered = {s["name"] for s in schemas}
            assert {"AskUser", "Todo", "Search", "Fetch", "Tools", "ListApps", "Observe"} <= offered
            assert not ({"Click", "Type", "act_ui", "inspect_ui"} & offered)
        finally:
            report.close() if host else report.ctx.unload()
            if host:
                host.close()


def test_initial_directory_names_every_deferred_tool_without_parameters():
    registry = _registry()
    schemas = _select_tool_schemas(make_params(registry=registry, tool_limit=128))
    assert [s["name"] for s in schemas] == ["Tools"]
    description = schemas[0]["description"]
    assert "SpecialRead" in description and "OtherRead" in description
    assert "Read a SpecialRead record" in description
    assert "required" not in description
    assert len(description) < 700


def test_exact_batch_load_does_not_return_siblings_or_duplicate_schemas():
    registry = _registry()
    result = registry.execute_tool("Tools", {"names": ["SpecialRead", "OtherRead"]})
    assert not result.is_error, result.error_message
    payload = json.loads(result.value)
    assert [s["name"] for s in payload["tools"]] == ["SpecialRead", "OtherRead"]
    assert all("parameters" not in s for s in payload["tools"])
    single = registry.execute_tool("Tools", {"names": ["SpecialRead"]})
    assert [s["name"] for s in json.loads(single.value)["tools"]] == ["SpecialRead"]
    missing = registry.execute_tool("Tools", {"names": ["RemovedTool"]})
    assert missing.is_error
    assert "Unknown tools: RemovedTool" in missing.error_message


def test_loader_is_never_truncated_by_registration_order_or_loaded_tools():
    registry = _registry()
    registry.register(ToolSpec(name="Core", description="core", input_schema={"type": "object", "properties": {}, "required": []}, execute=lambda: "ok"))
    schemas = _select_tool_schemas(make_params(registry=registry, tool_limit=2), extra_names=["SpecialRead", "OtherRead"])
    assert "Tools" in {s["name"] for s in schemas}


def test_exact_name_search_wins_over_description_mentions():
    registry = _registry()
    registry.register(ToolSpec(name="AAExample", description="SpecialRead item read", input_schema={"type": "object", "properties": {}, "required": []}, execute=lambda: "ok"))
    assert registry.search("SpecialRead", limit=1)[0].name == "SpecialRead"


@pytest.mark.parametrize("arguments, loaded", [
    ({"keyword": "SpecialRead"}, {"Tools", "SpecialRead"}),
    ({"names": ["SpecialRead", "OtherRead"]}, {"Tools", "SpecialRead", "OtherRead"}),
])
def test_real_loop_loads_executes_and_restores_tools_after_reopen(tmp_path, arguments, loaded):
    registry = _registry()
    session = FileSessionStore(tmp_path).create("tool-loading")
    backend = ScriptedBackend(
        [ToolCallArrived(call=ToolCall(id="load", name="Tools", arguments=arguments)), TurnDone(usage=None, raw_text=None)],
        [ToolCallArrived(call=ToolCall(id="read", name="SpecialRead", arguments={"item": "fixture"})), TurnDone(usage=None, raw_text=None)],
        [TurnDone(usage=None, raw_text="read:fixture")],
    )
    _, terminal = asyncio.run(collect(make_params(registry=registry, client=LoopModelClient(backend), session=session, tool_limit=128)))
    assert terminal.reason is TransitionReason.COMPLETED
    assert not any(result.is_error for result in terminal.results)
    assert {s["name"] for s in backend.received[1][1]} == loaded
    assert terminal.results[-1].value == "read:fixture"

    session.replace_messages([], reason="test compaction discards tool history")

    reopened = FileSessionStore(tmp_path).resume(session.id)
    next_backend = ScriptedBackend([TurnDone(usage=None, raw_text="continued")])
    asyncio.run(collect(make_params(registry=_registry(), client=LoopModelClient(next_backend), session=reopened, tool_limit=128)))
    assert {s["name"] for s in next_backend.received[0][1]} == loaded


def test_prior_eager_schema_is_not_mistaken_for_a_loaded_tool(tmp_path):
    from dataclasses import replace

    registry = _registry()
    for name in ("SpecialRead", "OtherRead"):
        spec = registry.get(name)
        registry.unregister(name)
        registry.register(replace(spec, deferred=False))
    session = FileSessionStore(tmp_path).create("old-eager-session")
    backend = ScriptedBackend([TurnDone(usage=None, raw_text="hello")])
    asyncio.run(collect(make_params(registry=registry, client=LoopModelClient(backend), session=session, tool_limit=128)))
    next_backend = ScriptedBackend([TurnDone(usage=None, raw_text="hello again")])
    asyncio.run(collect(make_params(registry=_registry(), client=LoopModelClient(next_backend), session=session, tool_limit=128)))
    assert {s["name"] for s in next_backend.received[0][1]} == {"Tools"}
