"""Process host + cheap run-scope lifecycle contracts."""

from __future__ import annotations

import os
import shutil
import threading
import uuid
from pathlib import Path

import pytest

from app.agent_runtime.tool_registry import Effect, ToolRegistry, ToolSpec
from app.harness.composition import BundleRow
from app.harness.plugin import PluginSpec
from app.harness.runtime_host import HarnessRuntimeHost


def _empty_schema() -> dict:
    return {"type": "object", "properties": {}, "required": []}


@pytest.fixture
def plugin_sandbox():
    root = Path(__file__).resolve().parents[1]
    path = root / f"pytest-sandbox-{uuid.uuid4().hex[:12]}"
    os.mkdir(path)
    try:
        yield path
    finally:
        shutil.rmtree(path, ignore_errors=True)


def test_global_plugins_mount_once_and_run_plugins_unwind_per_scope() -> None:
    applied: list[str] = []

    def apply_global(ctx, _config):
        applied.append("global")
        ctx.get("tools").register(
            ToolSpec(
                name="global_tool",
                description="global",
                input_schema=_empty_schema(),
                execute=lambda: "global",
                effect=Effect.READ,
            )
        )

    def apply_run(ctx, config):
        value = str(config["value"])
        applied.append(f"run:{value}")
        ctx.get("tools").register(
            ToolSpec(
                name="run_tool",
                description="run",
                input_schema=_empty_schema(),
                execute=lambda: value,
                effect=Effect.READ,
            )
        )
        ctx.provide_up("run_value", value)

    plugins = {
        "global": PluginSpec(
            name="global", inject=("tools",), apply=apply_global, source="test"
        ),
        "run": PluginSpec(
            name="run", inject=("tools",), apply=apply_run, source="test"
        ),
    }
    host = HarnessRuntimeHost(
        global_rows=[BundleRow("global", "global")],
        builtin_plugins=plugins,
        core={"tools": ToolRegistry()},
    )

    first = host.open_scope(run_rows=[BundleRow("run", "run", {"value": "a"})])
    assert first.ctx.get("run_value") == "a"
    assert first.ctx.get("tools").get("global_tool").name == "global_tool"
    assert first.ctx.get("tools").get("run_tool").execute() == "a"
    first.close()

    assert host.ctx.has("run_value") is False
    try:
        host.ctx.get("tools").get("run_tool")
    except KeyError:
        pass
    else:
        raise AssertionError("run-scoped tool leaked into process host")

    second = host.open_scope(run_rows=[BundleRow("run", "run", {"value": "b"})])
    assert second.ctx.get("run_value") == "b"
    second.close()
    host.close()

    assert applied == ["global", "run:a", "run:b"]


def test_user_plugin_discovery_happens_once_for_multiple_scopes(
    plugin_sandbox, monkeypatch
) -> None:
    from app.harness import runtime_host as host_module

    calls = 0
    original = host_module.discover_plugin_dir

    def counted(path):
        nonlocal calls
        calls += 1
        return original(path)

    monkeypatch.setattr(host_module, "discover_plugin_dir", counted)
    host = HarnessRuntimeHost(
        global_rows=[],
        builtin_plugins={},
        core={"tools": ToolRegistry()},
        plugin_dir=plugin_sandbox,
    )

    one = host.open_scope(run_rows=[])
    one.close()
    two = host.open_scope(run_rows=[])
    two.close()
    host.close()

    assert calls == 1


def test_failed_scope_boot_unloads_the_unreturned_child_context() -> None:
    host = HarnessRuntimeHost(
        global_rows=[],
        builtin_plugins={},
        core={"tools": ToolRegistry()},
    )
    children_before = len(host.ctx._children)  # noqa: SLF001 - leak invariant

    with pytest.raises(ValueError, match="duplicate bundle row id"):
        host.open_scope(
            run_rows=[
                BundleRow("duplicate", "missing"),
                BundleRow("duplicate", "missing"),
            ]
        )

    assert len(host.ctx._children) == children_before  # noqa: SLF001
    host.close()


def test_scope_close_can_retry_after_rejection_from_owned_work() -> None:
    host = HarnessRuntimeHost(
        global_rows=[],
        builtin_plugins={},
        core={"tools": ToolRegistry()},
    )
    scope = host.open_scope(run_rows=[])

    with scope.ctx.work(), pytest.raises(RuntimeError, match="own active work"):
        scope.close()

    assert scope._closed is False  # noqa: SLF001 - retry contract
    scope.close()
    assert scope._closed is True  # noqa: SLF001
    host.close()


def test_host_close_can_retry_after_rejection_from_owned_work() -> None:
    host = HarnessRuntimeHost(
        global_rows=[],
        builtin_plugins={},
        core={"tools": ToolRegistry()},
    )

    with host.ctx.work(), pytest.raises(RuntimeError, match="own active work"):
        host.close()

    assert host._closed is False  # noqa: SLF001 - retry contract
    host.close()
    assert host._closed is True  # noqa: SLF001


def test_plugin_signature_does_not_follow_reparse_entries(
    plugin_sandbox, monkeypatch
) -> None:
    from app.harness import runtime_host as host_module

    linked = plugin_sandbox / "linked"
    linked.mkdir()
    (linked / "plugin.py").write_text("outside", encoding="utf-8")
    local = plugin_sandbox / "local"
    local.mkdir()
    (local / "plugin.py").write_text("inside", encoding="utf-8")
    linked_file = plugin_sandbox / "linked_file"
    linked_file.mkdir()
    linked_source = linked_file / "plugin.py"
    linked_source.write_text("outside", encoding="utf-8")

    blocked = {linked, linked_source}
    monkeypatch.setattr(
        host_module,
        "_is_reparse_path",
        lambda candidate: candidate in blocked,
        raising=False,
    )

    signature = host_module._plugin_tree_signature(plugin_sandbox)

    assert [row[0] for row in signature] == ["local/plugin.py"]


def test_run_scope_close_waits_for_plugin_tool_to_reach_quiescence() -> None:
    entered = threading.Event()
    release = threading.Event()
    closed = threading.Event()
    order: list[str] = []

    def apply_run(ctx, _config):
        def execute():
            entered.set()
            release.wait(timeout=2)
            order.append("tool-finished")
            return "ok"

        ctx.get("tools").register(ToolSpec(
            name="slow_plugin_tool",
            description="test owned work",
            input_schema=_empty_schema(),
            execute=execute,
            effect=Effect.READ,
        ))
        ctx.effect(lambda: order.append("plugin-disposed"))

    host = HarnessRuntimeHost(
        global_rows=[],
        builtin_plugins={
            "run": PluginSpec(
                name="run", inject=("tools",), apply=apply_run, source="test"
            )
        },
        core={"tools": ToolRegistry()},
    )
    scope = host.open_scope(run_rows=[BundleRow("run", "run")])
    tools = scope.ctx.get("tools")
    worker = threading.Thread(
        target=lambda: tools.execute_tool("slow_plugin_tool", {}),
        daemon=True,
    )
    worker.start()
    assert entered.wait(timeout=1)

    closer = threading.Thread(
        target=lambda: (scope.close(), closed.set()),
        daemon=True,
    )
    closer.start()
    assert closed.wait(timeout=0.05) is False

    release.set()
    worker.join(timeout=1)
    closer.join(timeout=1)
    host.close()

    assert closed.is_set()
    assert order == ["tool-finished", "plugin-disposed"]
