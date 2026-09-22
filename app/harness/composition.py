
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from app.harness.context import Context
from app.harness.plugin import MountResult, PluginSpec, discover_plugin_dir, mount_plugins

__all__ = ["BootReport", "BundleRow", "RowReport", "boot", "load_patch_file"]

_PATCH_KEYS = ("plugin", "config", "disabled")


def load_patch_file(path: Path | str) -> tuple[dict[str, dict[str, Any]], list[str]]:
    source = Path(path)
    if not source.is_file():
        return {}, []
    try:
        payload = json.loads(source.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        return {}, [f"harness patch {source}: {type(exc).__name__}: {exc}"]
    if not isinstance(payload, dict):
        return {}, [f"harness patch {source}: root must be an object"]
    patch = payload.get("patch")
    if not isinstance(patch, dict):
        return {}, [f"harness patch {source}: 'patch' must be an object"]
    normalized: dict[str, dict[str, Any]] = {}
    warnings: list[str] = []
    for row_id, entry in patch.items():
        if not isinstance(row_id, str) or not row_id:
            warnings.append(f"harness patch {source}: row id must be a non-empty string")
            continue
        if not isinstance(entry, dict):
            warnings.append(f"harness patch {source}: row {row_id!r} must be an object")
            continue
        normalized[row_id] = dict(entry)
    return normalized, warnings


@dataclass(frozen=True)
class BundleRow:

    id: str
    plugin: str
    config: dict[str, Any] = field(default_factory=dict)
    disabled: bool = False


@dataclass
class RowReport:

    id: str
    plugin: str
    config: dict[str, Any]
    status: str
    resolved_config: dict[str, Any] = field(default_factory=dict)
    error: str = ""
    missing_deps: tuple[str, ...] = ()
    mount_result: MountResult | None = field(default=None, repr=False)

    def refresh(self) -> None:
        if self.mount_result is None or self.status in {"disabled", "unmounted"}:
            return
        self.status = self.mount_result.status
        self.error = self.mount_result.error
        self.missing_deps = self.mount_result.missing_deps


@dataclass
class BootReport:

    ctx: Context
    rows: list[RowReport]
    warnings: list[str]

    def dump_config(self) -> list[dict[str, Any]]:
        for row in self.rows:
            row.refresh()
        return [
            {
                "id": row.id,
                "plugin": row.plugin,
                "status": row.status,
                "config": dict(row.config),
                "resolved_config": dict(row.resolved_config),
                "error": row.error,
                "missingDeps": list(row.missing_deps),
            }
            for row in self.rows
        ]

    def unmount(self, row_id: str) -> bool:
        for row in self.rows:
            if row.id != row_id or row.mount_result is None:
                continue
            handle = row.mount_result.handle
            if handle is None or handle.disposed:
                return False
            handle.dispose()
            row.status = "unmounted"
            row.error = ""
            row.missing_deps = ()
            return True
        return False


@dataclass
class _MutableRow:
    id: str
    plugin: str
    config: dict[str, Any]
    disabled: bool = False
    status: str = "pending"
    resolved_config: dict[str, Any] = field(default_factory=dict)
    error: str = ""
    missing_deps: tuple[str, ...] = ()
    mount_result: MountResult | None = None


def boot(
    *,
    bundle_rows: list[BundleRow] | None = None,
    builtin_plugins: dict[str, PluginSpec] | None = None,
    plugin_dir: Path | str | None = None,
    scope_name: str = "agent",
    patch: dict[str, dict[str, Any]] | None = None,
    core: dict[str, Any] | None = None,
    context: Context | None = None,
    preloaded_plugins: list[PluginSpec] | tuple[PluginSpec, ...] = (),
) -> BootReport:
    ctx = context if context is not None else Context()
    for key, service in (core or {}).items():
        ctx.provide(key, service)

    warnings: list[str] = []
    specs: dict[str, PluginSpec] = dict(builtin_plugins or {})
    user_plugin_names: list[str] = []
    for spec in preloaded_plugins:
        if spec.name in specs:
            warnings.append(
                f"user plugin {spec.name!r} conflicts with an existing plugin; ignored"
            )
            continue
        specs[spec.name] = spec
        if scope_name in spec.scopes:
            user_plugin_names.append(spec.name)
    if plugin_dir is not None:
        discovered, discovery_warnings = discover_plugin_dir(Path(plugin_dir))
        warnings.extend(discovery_warnings)
        for spec in discovered:
            if spec.name in specs:
                warnings.append(
                    f"user plugin {spec.name!r} conflicts with an existing plugin; ignored"
                )
                continue
            specs[spec.name] = spec
            if scope_name in spec.scopes:
                user_plugin_names.append(spec.name)

    rows: list[_MutableRow] = []
    row_by_id: dict[str, _MutableRow] = {}
    for row in bundle_rows or []:
        if row.id in row_by_id:
            raise ValueError(f"duplicate bundle row id {row.id!r}")
        mutable = _MutableRow(
            id=row.id, plugin=row.plugin, config=dict(row.config), disabled=row.disabled
        )
        rows.append(mutable)
        row_by_id[row.id] = mutable

    for plugin_name in user_plugin_names:
        row_id = f"user:{plugin_name}"
        if row_id in row_by_id:
            warnings.append(f"auto plugin row {row_id!r} conflicts with bundle id; ignored")
            continue
        mutable = _MutableRow(id=row_id, plugin=plugin_name, config={})
        rows.append(mutable)
        row_by_id[row_id] = mutable

    for row_id, entry in (patch or {}).items():
        if not isinstance(row_id, str) or not row_id:
            warnings.append("patch row id must be a non-empty string; ignored")
            continue
        if not isinstance(entry, dict):
            warnings.append(f"patch row {row_id!r} is not an object; ignored")
            continue
        unknown = sorted(set(entry) - set(_PATCH_KEYS))
        if unknown:
            warnings.append(
                f"patch row {row_id!r} has unknown keys {unknown}; ignored"
            )
            continue
        if "config" in entry and not isinstance(entry["config"], dict):
            warnings.append(
                f"patch row {row_id!r} config must be an object; ignored"
            )
            continue
        if "plugin" in entry and (
            not isinstance(entry["plugin"], str) or not entry["plugin"].strip()
        ):
            warnings.append(
                f"patch row {row_id!r} plugin must be a non-empty string; ignored"
            )
            continue
        if "disabled" in entry and not isinstance(entry["disabled"], bool):
            warnings.append(
                f"patch row {row_id!r} disabled must be a boolean; ignored"
            )
            continue
        if row_id in row_by_id:
            target = row_by_id[row_id]
            if "plugin" in entry:
                target.plugin = entry["plugin"].strip()
            if "config" in entry:
                target.config = dict(entry["config"])
            if "disabled" in entry:
                target.disabled = entry["disabled"]
        else:
            if "plugin" not in entry:
                warnings.append(
                    f"patch row {row_id!r} has no 'plugin'; cannot insert"
                )
                continue
            inserted = _MutableRow(
                id=row_id,
                plugin=entry["plugin"].strip(),
                config=dict(entry.get("config", {})),
                disabled=entry.get("disabled", False),
            )
            rows.append(inserted)
            row_by_id[row_id] = inserted

    explicit_plugins = {
        row.plugin for row in rows if not row.id.startswith("user:")
    }
    rows = [
        row
        for row in rows
        if not (row.id.startswith("user:") and row.plugin in explicit_plugins)
    ]

    for mutable in rows:
        _mount_row(ctx, mutable, specs, warnings, scope_name=scope_name)

    reports = [
        RowReport(
            id=mutable.id,
            plugin=mutable.plugin,
            config=dict(mutable.config),
            status=mutable.status,
            resolved_config=dict(mutable.resolved_config),
            error=mutable.error,
            missing_deps=mutable.missing_deps,
            mount_result=mutable.mount_result,
        )
        for mutable in rows
    ]
    return BootReport(ctx=ctx, rows=reports, warnings=warnings)


def _mount_row(
    ctx: Context,
    row: _MutableRow,
    specs: dict[str, PluginSpec],
    warnings: list[str],
    *,
    scope_name: str,
) -> None:
    if row.disabled:
        row.status = "disabled"
        return
    spec = specs.get(row.plugin)
    if spec is None:
        row.status = "error"
        row.error = f"unknown plugin {row.plugin!r}"
        warnings.append(f"row {row.id!r}: {row.error}")
        return
    if scope_name not in spec.scopes:
        row.status = "error"
        row.error = (
            f"plugin {row.plugin!r} does not declare runtime scope "
            f"{scope_name!r}"
        )
        warnings.append(f"row {row.id!r}: {row.error}")
        return
    result = mount_plugins(ctx, [spec], configs={spec.name: row.config})[0]
    row.mount_result = result
    row.status = result.status
    row.error = result.error
    row.missing_deps = result.missing_deps
    row.resolved_config = dict(spec.default_config)
    row.resolved_config.update(row.config)
    if result.status == "error":
        warnings.append(f"row {row.id!r} ({spec.name}): {result.error}")
    elif result.status == "waiting":
        warnings.append(
            f"row {row.id!r} ({spec.name}): waiting for services {result.missing_deps}"
        )
