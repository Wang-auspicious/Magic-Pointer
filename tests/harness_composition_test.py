"""Harness layered composition tests (plugin-kernel batch, plan T3).

Pins the DSH profile/bundle/patch idea rewritten in Python: bundle rows
mount in order, a patch replaces a whole row config by id or inserts new
rows, disabled rows are skipped, unknown/broken plugins are isolated to
their row, missing dependencies are reported honestly, and ``dump_config``
shows the tree the runtime actually booted.
"""

from __future__ import annotations

import textwrap
import types

import pytest

from app.harness.composition import BundleRow, boot
from app.harness.plugin import PluginSpec


def _spec(name, inject=(), *, apply=None, defaults=None, schema=None, calls=None):
    """Execute plugin.py-style source into a temp module, return PluginSpec."""
    if calls is None:
        calls = []
    source = textwrap.dedent(
        f"""
        name = {name!r}
        inject = {tuple(inject)!r}
        config_schema = {schema!r}
        default_config = {defaults!r}

        def apply(ctx, config):
            calls.append((ctx, dict(config)))
        """
    )
    module = types.ModuleType(f"mp_comp_test_{name}")
    module.calls = calls
    exec(compile(source, f"<plugin:{name}>", "exec"), module.__dict__)
    return PluginSpec(
        name=name,
        inject=tuple(inject),
        config_schema=schema,
        default_config=defaults if defaults is not None else {},
        apply=apply if apply is not None else module.apply,
        source=f"<plugin:{name}>",
    )


def test_bundle_rows_mount_in_order():
    calls: list[tuple] = []
    alpha = _spec("alpha", defaults={"n": 1}, calls=calls)
    beta = _spec("beta", inject=["alpha_svc"], calls=calls)
    report = boot(
        bundle_rows=[BundleRow("row-a", "alpha", {"n": 2}), BundleRow("row-b", "beta")],
        builtin_plugins={"alpha": alpha, "beta": beta},
        core={"alpha_svc": object()},
    )
    assert [row.id for row in report.rows] == ["row-a", "row-b"]
    assert [row.status for row in report.rows] == ["active", "active"]
    assert len(calls) == 2
    # row-a saw its patched-by-row config; beta saw defaults merged with {} 
    assert calls[0][1] == {"n": 2}
    assert calls[1][1] == {}
    report.ctx.unload()


def test_patch_replaces_whole_row_config_by_id():
    calls: list[tuple] = []
    alpha = _spec("alpha", defaults={"n": 1, "mode": "slow"}, calls=calls)
    report = boot(
        bundle_rows=[BundleRow("row-a", "alpha", {"n": 9, "mode": "fast"})],
        builtin_plugins={"alpha": alpha},
        patch={"row-a": {"config": {"mode": "off"}}},
    )
    assert calls[0][1] == {"n": 1, "mode": "off"}  # defaults re-applied, mode replaced
    report.ctx.unload()


def test_patch_inserts_new_rows_and_can_disable():
    calls: list[tuple] = []
    alpha = _spec("alpha", calls=calls)
    beta = _spec("beta", calls=calls)
    report = boot(
        bundle_rows=[BundleRow("row-a", "alpha")],
        builtin_plugins={"alpha": alpha, "beta": beta},
        patch={
            "row-b": {"plugin": "beta"},
            "row-a": {"disabled": True},
        },
    )
    statuses = {row.id: row.status for row in report.rows}
    assert statuses == {"row-a": "disabled", "row-b": "active"}
    assert len(calls) == 1  # only beta mounted
    report.ctx.unload()


def test_malformed_patch_config_is_isolated_instead_of_crashing_boot():
    calls: list[tuple] = []
    alpha = _spec("alpha", defaults={"mode": "safe"}, calls=calls)
    report = boot(
        bundle_rows=[BundleRow("row-a", "alpha")],
        builtin_plugins={"alpha": alpha},
        patch={
            "row-a": {"config": "not-an-object"},
            "row-b": {"plugin": "alpha", "config": None},
        },
    )

    assert [(row.id, row.status) for row in report.rows] == [("row-a", "active")]
    assert calls[0][1] == {"mode": "safe"}
    assert sum("config must be an object" in warning for warning in report.warnings) == 2
    report.ctx.unload()


def test_unknown_plugin_is_isolated_to_its_row():
    alpha = _spec("alpha")
    report = boot(
        bundle_rows=[
            BundleRow("row-a", "alpha"),
            BundleRow("row-b", "ghost"),
        ],
        builtin_plugins={"alpha": alpha},
    )
    assert report.rows[0].status == "active"
    assert report.rows[1].status == "error"
    assert "ghost" in report.rows[1].error
    assert any("ghost" in w for w in report.warnings)
    report.ctx.unload()


def test_explicit_row_cannot_mount_plugin_outside_declared_scope():
    calls: list[dict] = []
    surface_only = PluginSpec(
        name="surface_only",
        scopes=("surface",),
        apply=lambda _ctx, config: calls.append(dict(config)),
        source="test",
    )

    report = boot(
        bundle_rows=[BundleRow("wrong-scope", "surface_only")],
        builtin_plugins={"surface_only": surface_only},
        scope_name="agent",
    )

    assert report.rows[0].status == "error"
    assert "scope" in report.rows[0].error
    assert calls == []
    report.ctx.unload()


def test_broken_plugin_row_does_not_poison_the_tree():
    def broken(ctx, config):
        raise RuntimeError("boom")

    broken_spec = _spec("broken", apply=broken)
    good_spec = _spec("good")
    report = boot(
        bundle_rows=[BundleRow("row-1", "broken"), BundleRow("row-2", "good")],
        builtin_plugins={"broken": broken_spec, "good": good_spec},
    )
    assert report.rows[0].status == "error"
    assert "boom" in report.rows[0].error
    assert report.rows[1].status == "active"
    report.ctx.unload()


def test_missing_dependency_row_reports_waiting():
    waiting = _spec("waiter", inject=["not_there_yet"])
    report = boot(
        bundle_rows=[BundleRow("row-w", "waiter")],
        builtin_plugins={"waiter": waiting},
    )
    assert report.rows[0].status == "waiting"
    assert report.rows[0].missing_deps == ("not_there_yet",)
    report.ctx.unload()


def test_core_services_are_visible_to_plugins():
    calls: list[tuple] = []
    spec = _spec("consumer", inject=["tools"], calls=calls)
    tools = object()
    report = boot(
        bundle_rows=[BundleRow("row-c", "consumer")],
        builtin_plugins={"consumer": spec},
        core={"tools": tools},
    )
    assert report.rows[0].status == "active"
    assert calls[0][0].get("tools") is tools
    report.ctx.unload()


def test_dump_config_shows_the_composed_tree():
    alpha = _spec("alpha", defaults={"n": 1, "mode": "slow"})
    report = boot(
        bundle_rows=[BundleRow("row-a", "alpha", {"mode": "fast"})],
        builtin_plugins={"alpha": alpha},
    )
    dump = report.dump_config()
    assert isinstance(dump, list)
    row = dump[0]
    assert row["id"] == "row-a"
    assert row["plugin"] == "alpha"
    assert row["status"] == "active"
    assert row["resolved_config"] == {"n": 1, "mode": "fast"}
    report.ctx.unload()


def test_duplicate_row_ids_fail_loud():
    alpha = _spec("alpha")
    with pytest.raises(ValueError):
        boot(
            bundle_rows=[BundleRow("row-a", "alpha"), BundleRow("row-a", "alpha")],
            builtin_plugins={"alpha": alpha},
        )


def test_plugin_dir_plugins_mount_beside_builtin():
    import os
    import shutil
    import uuid
    from pathlib import Path

    root = Path(__file__).resolve().parents[1]
    plugin_dir = root / f"pytest-sandbox-{uuid.uuid4().hex[:12]}"
    os.mkdir(plugin_dir)
    try:
        (plugin_dir / "extra").mkdir()
        (plugin_dir / "extra" / "plugin.py").write_text(
            'name = "extra"\ndef apply(ctx, config):\n    pass\n',
            encoding="utf-8",
        )
        builtin = _spec("builtin")
        report = boot(
            bundle_rows=[BundleRow("row-1", "builtin"), BundleRow("row-2", "extra")],
            builtin_plugins={"builtin": builtin},
            plugin_dir=plugin_dir,
        )
        assert [row.status for row in report.rows] == ["active", "active"]
        report.ctx.unload()
    finally:
        shutil.rmtree(plugin_dir, ignore_errors=True)


def test_plugin_dir_entry_auto_mounts_as_user_row() -> None:
    import os
    import shutil
    import uuid
    from pathlib import Path

    root = Path(__file__).resolve().parents[1]
    plugin_dir = root / f"pytest-sandbox-{uuid.uuid4().hex[:12]}"
    os.mkdir(plugin_dir)
    try:
        (plugin_dir / "extra").mkdir()
        (plugin_dir / "extra" / "plugin.py").write_text(
            'name = "extra"\ndef apply(ctx, config):\n    ctx.provide_up("extra_service", "ready")\n',
            encoding="utf-8",
        )
        report = boot(plugin_dir=plugin_dir)

        assert [(row.id, row.plugin, row.status) for row in report.rows] == [
            ("user:extra", "extra", "active")
        ]
        assert report.ctx.get("extra_service") == "ready"
        report.ctx.unload()
    finally:
        shutil.rmtree(plugin_dir, ignore_errors=True)


def test_auto_user_rows_only_mount_in_the_requested_runtime_scope() -> None:
    import os
    import shutil
    import uuid
    from pathlib import Path

    root = Path(__file__).resolve().parents[1]
    plugin_dir = root / f"pytest-sandbox-{uuid.uuid4().hex[:12]}"
    os.mkdir(plugin_dir)
    try:
        for name, scopes in (
            ("agent_plugin", '("agent",)'),
            ("surface_plugin", '("surface",)'),
        ):
            (plugin_dir / name).mkdir()
            (plugin_dir / name / "plugin.py").write_text(
                f'name = "{name}"\nscopes = {scopes}\n'
                f'def apply(ctx, config):\n    ctx.provide_up("{name}", True)\n',
                encoding="utf-8",
            )

        agent = boot(plugin_dir=plugin_dir, scope_name="agent")
        surface = boot(plugin_dir=plugin_dir, scope_name="surface")

        assert [row.id for row in agent.rows] == ["user:agent_plugin"]
        assert agent.ctx.has("agent_plugin")
        assert not agent.ctx.has("surface_plugin")
        assert [row.id for row in surface.rows] == ["user:surface_plugin"]
        assert surface.ctx.has("surface_plugin")
        assert not surface.ctx.has("agent_plugin")
        agent.ctx.unload()
        surface.ctx.unload()
    finally:
        shutil.rmtree(plugin_dir, ignore_errors=True)


def test_boot_report_can_unmount_one_plugin_row_without_stopping_tree() -> None:
    from app.agent_runtime.tool_registry import ToolRegistry, ToolSpec

    empty_schema = {"type": "object", "properties": {}, "required": []}

    def apply_tool(plugin_ctx, _config):
        plugin_ctx.get("tools").register(
            ToolSpec(
                name="temporary_tool",
                description="temporary",
                input_schema=empty_schema,
                execute=lambda: "ok",
            )
        )

    registry = ToolRegistry()
    report = boot(
        bundle_rows=[BundleRow("temporary", "tool-plugin")],
        builtin_plugins={"tool-plugin": _spec("tool-plugin", inject=("tools",), apply=apply_tool)},
        core={"tools": registry, "unrelated": object()},
    )
    assert registry.get("temporary_tool").name == "temporary_tool"

    assert report.unmount("temporary") is True

    assert registry.list() == ()
    assert report.ctx.has("unrelated")
    assert report.rows[0].status == "unmounted"
    assert report.unmount("temporary") is False
    report.ctx.unload()
