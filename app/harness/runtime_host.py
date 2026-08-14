"""Process-lifetime harness host with cheap, isolated request scopes."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

from app.harness.composition import BootReport, BundleRow, boot
from app.harness.context import Context
from app.harness.plugin import (
    PluginSpec,
    _is_reparse_path,
    _resolves_within,
    discover_plugin_dir,
)

__all__ = ["HarnessRuntimeHost", "RuntimeScope"]


@dataclass(slots=True)
class RuntimeScope:
    """One request/run scope owned by a process host."""

    report: BootReport
    _closed: bool = False

    @property
    def ctx(self) -> Context:
        return self.report.ctx

    def close(self) -> None:
        if self._closed:
            return
        self.report.ctx.unload()
        self._closed = True

    def __enter__(self) -> RuntimeScope:
        return self

    def __exit__(self, exc_type: object, exc: object, tb: object) -> bool:
        self.close()
        return False


class HarnessRuntimeHost:
    """Mount stable services once and create a lightweight scope per run.

    User plugin discovery/import happens at construction only. Run scopes read
    process services through their parent, receive scoped views for registries,
    and own every run registration/export. Closing a scope therefore removes
    its tools and services without rebuilding or stopping the process host.
    """

    def __init__(
        self,
        *,
        global_rows: list[BundleRow],
        builtin_plugins: dict[str, PluginSpec],
        core: dict[str, Any],
        plugin_dir: Path | str | None = None,
        scope_name: str = "agent",
        patch: dict[str, dict[str, Any]] | None = None,
    ) -> None:
        self._builtin_plugins = dict(builtin_plugins)
        self._scope_name = scope_name
        self._patch = {key: dict(value) for key, value in (patch or {}).items()}
        self._closed = False
        self._plugin_dir = Path(plugin_dir) if plugin_dir is not None else None
        self._plugin_signature: tuple[tuple[str, int, int], ...] = ()
        self._user_plugins: list[PluginSpec] = []
        discovery_warnings: list[str] = []
        if self._plugin_dir is not None:
            self._user_plugins, discovery_warnings = discover_plugin_dir(
                self._plugin_dir
            )
            self._plugin_signature = _plugin_tree_signature(self._plugin_dir)

        global_ids = {row.id for row in global_rows}
        global_patch = {
            key: value for key, value in self._patch.items() if key in global_ids
        }
        self.report = boot(
            bundle_rows=global_rows,
            builtin_plugins=self._builtin_plugins,
            patch=global_patch,
            core=core,
        )
        self.report.warnings[:0] = discovery_warnings

    @property
    def ctx(self) -> Context:
        return self.report.ctx

    def open_scope(
        self,
        *,
        run_rows: list[BundleRow],
        core: dict[str, Any] | None = None,
    ) -> RuntimeScope:
        if self._closed:
            raise RuntimeError("harness runtime host is closed")
        self._refresh_user_plugins()
        child = self.ctx.scope(service_boundary=True)
        run_ids = {row.id for row in run_rows}
        run_patch = {
            key: value
            for key, value in self._patch.items()
            if key in run_ids or key not in {row.id for row in self.report.rows}
        }
        try:
            report = boot(
                bundle_rows=run_rows,
                builtin_plugins=self._builtin_plugins,
                preloaded_plugins=self._user_plugins,
                scope_name=self._scope_name,
                patch=run_patch,
                core=core,
                context=child,
            )
        except BaseException:
            # The caller cannot close a scope it never received.  Unwind all
            # partially mounted plugins/services before propagating startup
            # failures (including cancellation-style BaseException values).
            child.unload()
            raise
        return RuntimeScope(report)

    def _refresh_user_plugins(self) -> None:
        """Adopt plugin file changes for future request scopes only."""
        if self._plugin_dir is None:
            return
        signature = _plugin_tree_signature(self._plugin_dir)
        if signature == self._plugin_signature:
            return
        plugins, warnings = discover_plugin_dir(self._plugin_dir)
        self._user_plugins = plugins
        self._plugin_signature = signature
        self.report.warnings.extend(warnings)

    def close(self) -> None:
        if self._closed:
            return
        self.ctx.unload()
        self._closed = True


def _plugin_tree_signature(path: Path) -> tuple[tuple[str, int, int], ...]:
    """Cheap request-boundary fingerprint; never imports plugin code."""
    if not path.is_dir():
        return ()
    rows: list[tuple[str, int, int]] = []
    try:
        entries = sorted(path.iterdir(), key=lambda entry: entry.name.casefold())
    except OSError:
        return ()
    for entry in entries:
        if (
            _is_reparse_path(entry)
            or not entry.is_dir()
            or not _resolves_within(path, entry)
        ):
            continue
        for filename in ("plugin.py", "plugin.json"):
            source = entry / filename
            if _is_reparse_path(source) or not source.is_file():
                continue
            if not _resolves_within(path, source):
                continue
            try:
                info = source.stat()
            except OSError:
                continue
            rows.append((f"{entry.name}/{filename}", info.st_mtime_ns, info.st_size))
    return tuple(rows)
