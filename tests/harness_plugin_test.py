"""Harness plugin protocol tests (plugin-kernel batch, plan T2).

Pins the DSH plugin shape rewritten in Python: ``name`` / ``inject`` /
optional ``config_schema`` + ``default_config`` / ``apply(ctx, config)``,
with directory discovery that isolates broken rows (one bad plugin never
takes the tree down) and honest missing-dependency reporting.
"""

from __future__ import annotations

import json
import textwrap
from pathlib import Path

import pytest

from app.harness.context import Context
from app.harness.plugin import (
    PluginSpec,
    discover_plugin_dir,
    mount_plugins,
    validate_config,
)


def _make_plugin(name="demo", inject=(), apply=None, schema=None, defaults=None):
    """Build a PluginSpec by executing plugin.py-style source in a temp module."""

    import types

    source = textwrap.dedent(
        f"""
        name = {name!r}
        inject = {tuple(inject)!r}
        config_schema = {schema!r}
        default_config = {defaults!r}

        def apply(ctx, config):
            apply_target.append((ctx, dict(config)))
        """
    )
    module = types.ModuleType(f"mp_test_plugin_{name}")
    module.apply_target = []
    exec(compile(source, f"<plugin:{name}>", "exec"), module.__dict__)
    spec = PluginSpec(
        name=name,
        inject=tuple(inject),
        config_schema=schema,
        default_config=defaults if defaults is not None else {},
        apply=apply if apply is not None else module.apply,
        source=f"<plugin:{name}>",
    )
    return spec, module.apply_target


def test_plugin_apply_receives_context_and_config():
    ctx = Context()
    ctx.provide("tools", object())
    spec, calls = _make_plugin(inject=["tools"], defaults={"mode": "fast"})
    results = mount_plugins(ctx, [spec], configs={})
    assert results[0].status == "active"
    assert len(calls) == 1
    plugin_ctx, config = calls[0]
    assert plugin_ctx.get("tools") is ctx.get("tools")
    assert config == {"mode": "fast"}


def test_mount_merges_row_config_over_defaults():
    ctx = Context()
    spec, calls = _make_plugin(defaults={"mode": "fast", "limit": 3})
    mount_plugins(ctx, [spec], configs={"demo": {"limit": 9}})
    _, config = calls[0]
    assert config == {"mode": "fast", "limit": 9}


def test_plugin_registrations_unwind_with_context():
    ctx = Context()
    disposed: list[str] = []

    def apply(plugin_ctx, config):
        plugin_ctx.effect(lambda: disposed.append("plugin"))

    spec, _ = _make_plugin(apply=apply)
    mount_plugins(ctx, [spec], configs={})
    ctx.unload()
    assert disposed == ["plugin"]


def test_plugin_waits_for_missing_dependency_then_activates():
    ctx = Context()
    calls: list[dict] = []

    def apply(plugin_ctx, config):
        calls.append(config)

    spec, _ = _make_plugin(inject=["tools"], defaults={}, apply=apply)
    results = mount_plugins(ctx, [spec], configs={})
    assert results[0].status == "waiting"
    assert results[0].missing_deps == ("tools",)
    assert calls == []
    ctx.provide("tools", object())
    assert calls == [{}]
    assert results[0].status == "active"
    assert results[0].missing_deps == ()
    ctx.revoke("tools")
    assert results[0].status == "waiting"
    assert results[0].missing_deps == ("tools",)
    ctx.provide("tools", object())
    assert calls == [{}, {}]
    assert results[0].status == "active"


def test_plugin_config_mutation_cannot_leak_into_reactivation_or_defaults():
    ctx = Context()
    seen: list[int] = []
    defaults = {"network": {"timeout": 5}}

    def apply(_plugin_ctx, config):
        seen.append(config["network"]["timeout"])
        config["network"]["timeout"] = 99

    spec, _ = _make_plugin(inject=["tools"], defaults=defaults, apply=apply)
    mount_plugins(ctx, [spec], configs={})
    ctx.provide("tools", object())
    ctx.revoke("tools")
    ctx.provide("tools", object())

    assert seen == [5, 5]
    assert defaults == {"network": {"timeout": 5}}


def test_broken_apply_is_isolated_to_its_row():
    ctx = Context()
    ctx.provide("tools", object())

    def broken(plugin_ctx, config):
        raise RuntimeError("boom")

    broken_spec, _ = _make_plugin(name="broken", apply=broken)
    good_spec, good_calls = _make_plugin(name="good", inject=["tools"])
    results = mount_plugins(ctx, [broken_spec, good_spec], configs={})
    assert results[0].status == "error"
    assert "boom" in results[0].error
    assert results[1].status == "active"
    assert len(good_calls) == 1
    # the broken row must not have poisoned the tree
    assert ctx.has("tools")


def test_config_validation_failure_reports_row_error_without_applying():
    ctx = Context()
    schema = {
        "type": "object",
        "properties": {"limit": {"type": "integer"}},
        "required": ["limit"],
    }
    spec, calls = _make_plugin(schema=schema, defaults={})
    results = mount_plugins(ctx, [spec], configs={"demo": {"limit": "many"}})
    assert results[0].status == "error"
    assert "limit" in results[0].error
    assert calls == []


def test_config_schema_accepts_valid_config():
    ctx = Context()
    schema = {
        "type": "object",
        "properties": {"limit": {"type": "integer"}},
        "required": ["limit"],
    }
    spec, calls = _make_plugin(schema=schema, defaults={"limit": 4})
    results = mount_plugins(ctx, [spec], configs={})
    assert results[0].status == "active"
    assert calls[0][1] == {"limit": 4}


def test_validate_config_checks_types_and_required():
    schema = {
        "type": "object",
        "properties": {
            "name": {"type": "string"},
            "count": {"type": "integer"},
            "flag": {"type": "boolean"},
        },
        "required": ["name"],
    }
    assert validate_config(schema, {"name": "ok", "count": 2, "flag": True}) == []
    errors = validate_config(schema, {})
    assert any("name" in e for e in errors)
    errors = validate_config(schema, {"name": "ok", "count": "two"})
    assert any("count" in e for e in errors)
    assert validate_config(None, {"anything": 1}) == []


def _write_plugin(sandbox, name, *, source=None, manifest=None):
    plugin_dir = sandbox / name
    plugin_dir.mkdir()
    if source is not None:
        (plugin_dir / "plugin.py").write_text(source, encoding="utf-8")
    if manifest is not None:
        (plugin_dir / "plugin.json").write_text(
            json.dumps(manifest), encoding="utf-8"
        )
    return plugin_dir


@pytest.fixture
def sandbox():
    """A writable plugin directory sandbox at the repo root.

    Deliberately not pytest ``tmp_path``: in this environment any directory
    created with mode 0o700 (pytest's basetemp and ``tempfile.mkdtemp``
    default) gets an ACL that denies listing, which breaks both the tests
    and pytest's own session cleanup. ``os.mkdir`` with the default mode is
    listable and removable, so the sandbox is built that way.
    """
    import os
    import shutil
    import uuid

    root = Path(__file__).resolve().parents[1]
    path = root / f"pytest-sandbox-{uuid.uuid4().hex[:12]}"
    os.mkdir(path)
    try:
        yield path
    finally:
        shutil.rmtree(path, ignore_errors=True)


def test_discover_plugin_dir_finds_good_plugins(sandbox):
    _write_plugin(
        sandbox,
        "alpha",
        source='name = "alpha"\ninject = ()\ndef apply(ctx, config):\n    pass\n',
    )
    _write_plugin(
        sandbox,
        "beta",
        source='name = "beta"\ninject = ("tools",)\ndef apply(ctx, config):\n    pass\n',
    )
    specs, warnings = discover_plugin_dir(sandbox)
    assert [s.name for s in specs] == ["alpha", "beta"]
    assert specs[1].inject == ("tools",)
    assert warnings == []


def test_discover_plugin_dir_reads_scopes_and_infers_surface_plugins(sandbox):
    _write_plugin(
        sandbox,
        "agent_only",
        source=(
            'name = "agent_only"\n'
            'scopes = ("agent",)\n'
            'def apply(ctx, config):\n    pass\n'
        ),
    )
    _write_plugin(
        sandbox,
        "surface_legacy",
        source=(
            'name = "surface_legacy"\n'
            'inject = ("surface_adapters",)\n'
            'def apply(ctx, config):\n    pass\n'
        ),
    )

    specs, warnings = discover_plugin_dir(sandbox)

    assert {spec.name: spec.scopes for spec in specs} == {
        "agent_only": ("agent",),
        "surface_legacy": ("surface",),
    }
    assert warnings == []


def test_discover_plugin_dir_rejects_invalid_scopes(sandbox):
    _write_plugin(
        sandbox,
        "bad_scope",
        source=(
            'name = "bad_scope"\n'
            'scopes = "surface"\n'
            'def apply(ctx, config):\n    pass\n'
        ),
    )

    specs, warnings = discover_plugin_dir(sandbox)

    assert specs == []
    assert any("scopes must be a list/tuple" in warning for warning in warnings)


def test_discover_plugin_dir_isolates_broken_entries(sandbox):
    _write_plugin(sandbox, "good", source='name = "good"\ndef apply(ctx, config):\n    pass\n')
    _write_plugin(sandbox, "broken_import", source="import not_a_real_module_xyz\n")
    _write_plugin(sandbox, "bad_manifest", manifest={"not": "valid json shape"})
    _write_plugin(
        sandbox,
        "mismatched",
        source='name = "other_name"\ndef apply(ctx, config):\n    pass\n',
    )
    _write_plugin(sandbox, "manifest_only", manifest={"name": "manifest_only"})
    specs, warnings = discover_plugin_dir(sandbox)
    assert [s.name for s in specs] == ["good"]
    assert len(warnings) >= 3  # broken import / mismatched / manifest-only
    assert any("broken_import" in w for w in warnings)
    assert any("mismatched" in w for w in warnings)
    assert any("manifest_only" in w for w in warnings)


def test_discover_empty_or_missing_dir_returns_nothing(sandbox):
    specs, warnings = discover_plugin_dir(sandbox / "does-not-exist")
    assert specs == []
    assert warnings == []


def test_discovery_rejects_reparse_plugin_directories_and_files(
    sandbox, monkeypatch
):
    """Plugin discovery must never follow a symlink/junction out of its root."""
    from app.harness import plugin as plugin_module

    linked_dir = _write_plugin(
        sandbox,
        "linked_dir",
        source='name = "linked_dir"\ndef apply(ctx, config):\n    pass\n',
    )
    linked_code = _write_plugin(
        sandbox,
        "linked_code",
        source='name = "linked_code"\ndef apply(ctx, config):\n    pass\n',
    )
    linked_manifest = _write_plugin(
        sandbox,
        "linked_manifest",
        source='name = "linked_manifest"\ndef apply(ctx, config):\n    pass\n',
        manifest={"description": "outside"},
    )
    _write_plugin(
        sandbox,
        "local",
        source='name = "local"\ndef apply(ctx, config):\n    pass\n',
    )

    blocked = {
        linked_dir,
        linked_code / "plugin.py",
        linked_manifest / "plugin.json",
    }
    monkeypatch.setattr(
        plugin_module,
        "_is_reparse_path",
        lambda candidate: candidate in blocked,
        raising=False,
    )

    specs, warnings = discover_plugin_dir(sandbox)

    assert [spec.name for spec in specs] == ["local"]
    assert any("linked_dir" in warning and "link" in warning for warning in warnings)
    assert any("linked_code" in warning and "plugin.py" in warning for warning in warnings)
    assert any(
        "linked_manifest" in warning and "plugin.json" in warning
        for warning in warnings
    )
