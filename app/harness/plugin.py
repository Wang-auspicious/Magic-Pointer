
from __future__ import annotations

import importlib.util
import json
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from app.harness.context import Context, InjectionHandle

__all__ = [
    "PluginActivationError",
    "PluginSpec",
    "MountResult",
    "discover_plugin_dir",
    "mount_plugins",
    "validate_config",
]

_NAME_PATTERN = "abcdefghijklmnopqrstuvwxyz0123456789_"
_WINDOWS_REPARSE_POINT = 0x0400


class PluginActivationError(Exception):

    def __init__(self, row_id: str, message: str, cause: BaseException | None = None) -> None:
        super().__init__(f"plugin {row_id!r}: {message}")
        self.row_id = row_id
        self.cause = cause


@dataclass(frozen=True)
class PluginSpec:

    name: str
    inject: tuple[str, ...] = ()
    scopes: tuple[str, ...] = ("agent",)
    config_schema: dict[str, Any] | None = None
    default_config: dict[str, Any] = field(default_factory=dict)
    apply: Callable[[Context, dict[str, Any]], None] | None = None
    description: str = ""
    source: str = ""


class MountResult:

    def __init__(
        self,
        row_id: str,
        status: str,
        missing_deps: tuple[str, ...] = (),
        error: str = "",
        handle: InjectionHandle | None = None,
    ) -> None:
        self.row_id = row_id
        self._status = status
        self._missing_deps = missing_deps
        self._error = error
        self.handle = handle

    @property
    def status(self) -> str:
        if self.handle is None:
            return self._status
        return {
            "active": "active",
            "pending": "waiting",
            "error": "error",
            "disposed": "unmounted",
        }.get(self.handle.state, self._status)

    @property
    def missing_deps(self) -> tuple[str, ...]:
        if self.handle is not None:
            return self.handle.missing_deps
        return self._missing_deps

    @property
    def error(self) -> str:
        if self.handle is not None and self.handle.error is not None:
            return f"{type(self.handle.error).__name__}: {self.handle.error}"
        return self._error


def _matches_json_schema_type(value: Any, type_name: Any) -> bool | None:
    if type_name == "string":
        return isinstance(value, str)
    if type_name == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if type_name == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if type_name == "boolean":
        return isinstance(value, bool)
    if type_name == "array":
        return isinstance(value, list)
    if type_name == "object":
        return isinstance(value, dict)
    if type_name == "null":
        return value is None
    return None


def validate_config(schema: dict[str, Any] | None, config: dict[str, Any]) -> list[str]:
    if schema is None:
        return []
    if not isinstance(config, dict):
        return ["plugin config must be an object"]
    if schema.get("type") != "object":
        return ["plugin config_schema type must be 'object'"]
    properties = schema.get("properties") or {}
    if not isinstance(properties, dict):
        return ["plugin config_schema properties must be an object"]
    errors: list[str] = []
    for key in schema.get("required") or []:
        if key not in config:
            errors.append(f"missing required config field {key!r}")
    for key, value in config.items():
        prop = properties.get(key)
        if not isinstance(prop, dict):
            continue
        matched = _matches_json_schema_type(value, prop.get("type"))
        if matched is False:
            errors.append(
                f"config field {key!r} expects type {prop.get('type')!r}, "
                f"got {type(value).__name__}"
            )
    return errors


def _merged(defaults: dict[str, Any], row: dict[str, Any]) -> dict[str, Any]:
    merged = dict(defaults or {})
    merged.update(row or {})
    return merged


def _activation_config(value: Any, active: set[int] | None = None) -> Any:
    if not isinstance(value, (dict, list, tuple)):
        return value
    active = set() if active is None else active
    marker = id(value)
    if marker in active:
        raise ValueError("plugin config must not contain cyclic containers")
    active.add(marker)
    try:
        if isinstance(value, dict):
            return {key: _activation_config(item, active) for key, item in value.items()}
        if isinstance(value, list):
            return [_activation_config(item, active) for item in value]
        return tuple(_activation_config(item, active) for item in value)
    finally:
        active.remove(marker)


def mount_plugins(
    ctx: Context,
    specs: list[PluginSpec],
    configs: dict[str, dict[str, Any]],
) -> list[MountResult]:
    results: list[MountResult] = []
    for spec in specs:
        if spec.apply is None:
            results.append(
                MountResult(spec.name, "error", error="plugin has no apply()")
            )
            continue
        row_config = _merged(spec.default_config, configs.get(spec.name, {}))
        config_errors = validate_config(spec.config_schema, row_config)
        if config_errors:
            results.append(
                MountResult(
                    spec.name,
                    "error",
                    error="; ".join(config_errors),
                )
            )
            continue
        missing = tuple(dep for dep in spec.inject if not ctx.has(dep))
        try:
            handle = ctx.inject(spec.inject, _wrapped(ctx, spec, row_config))
            results.append(
                MountResult(
                    spec.name,
                    "waiting" if missing else "active",
                    missing_deps=missing,
                    handle=handle,
                )
            )
        except PluginActivationError as exc:
            results.append(MountResult(spec.name, "error", error=str(exc)))
        except Exception as exc:  # noqa: BLE001 - isolation promise
            results.append(
                MountResult(
                    spec.name,
                    "error",
                    error=f"{type(exc).__name__}: {exc}",
                )
            )
    return results


def _wrapped(
    ctx: Context, spec: PluginSpec, config: dict[str, Any]
) -> Callable[[Context], None]:
    def activate(fork: Context) -> None:
        try:
            spec.apply(fork, _activation_config(config))  # type: ignore[misc]
        except PluginActivationError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise PluginActivationError(
                spec.name, f"{type(exc).__name__}: {exc}", exc
            ) from exc

    return activate




def _valid_plugin_name(name: str) -> bool:
    return bool(name) and all(ch in _NAME_PATTERN for ch in name)


def _is_reparse_path(path: Path) -> bool:
    try:
        info = path.lstat()
    except OSError:
        return False
    return path.is_symlink() or bool(
        getattr(info, "st_file_attributes", 0) & _WINDOWS_REPARSE_POINT
    )


def _resolves_within(root: Path, candidate: Path) -> bool:
    try:
        resolved_root = root.resolve(strict=True)
        resolved_candidate = candidate.resolve(strict=True)
        resolved_candidate.relative_to(resolved_root)
    except (OSError, RuntimeError, ValueError):
        return False
    return True


def _load_plugin_module(path: Path) -> tuple[Any, str]:
    module_name = f"mp_plugin_{path.parent.name}"
    try:
        spec = importlib.util.spec_from_file_location(module_name, path)
        if spec is None or spec.loader is None:
            return None, "cannot build import spec"
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module, ""
    except Exception as exc:  # noqa: BLE001 - discovery isolation
        return None, f"{type(exc).__name__}: {exc}"


def _read_manifest(path: Path) -> tuple[dict[str, Any], str]:
    if not path.is_file():
        return {}, ""
    try:
        with path.open("r", encoding="utf-8") as handle:
            data = json.load(handle)
        if not isinstance(data, dict):
            return {}, "manifest must be a JSON object"
        return data, ""
    except Exception as exc:  # noqa: BLE001
        return {}, f"{type(exc).__name__}: {exc}"


def discover_plugin_dir(path: Path) -> tuple[list[PluginSpec], list[str]]:
    if not path.is_dir():
        return [], []
    specs: list[PluginSpec] = []
    warnings: list[str] = []
    try:
        entries = sorted(path.iterdir(), key=lambda entry: entry.name.casefold())
    except OSError as exc:
        return [], [f"plugin directory cannot be read: {type(exc).__name__}: {exc}"]
    for entry in entries:
        name = entry.name
        if _is_reparse_path(entry):
            warnings.append(
                f"{name}: linked/reparse plugin directories are not allowed"
            )
            continue
        if not entry.is_dir():
            continue
        if not _resolves_within(path, entry):
            warnings.append(f"{name}: plugin directory resolves outside plugin root")
            continue
        if not _valid_plugin_name(name):
            warnings.append(f"{name}: invalid plugin name (must match [a-z0-9_]+)")
            continue
        manifest_path = entry / "plugin.json"
        if _is_reparse_path(manifest_path):
            warnings.append(f"{name}: linked/reparse plugin.json is not allowed")
            continue
        if manifest_path.exists() and not _resolves_within(path, manifest_path):
            warnings.append(f"{name}: plugin.json resolves outside plugin root")
            continue
        manifest, manifest_error = _read_manifest(manifest_path)
        if manifest_error:
            warnings.append(f"{name}: bad plugin.json: {manifest_error}")
            continue
        module_path = entry / "plugin.py"
        if _is_reparse_path(module_path):
            warnings.append(f"{name}: linked/reparse plugin.py is not allowed")
            continue
        if not module_path.is_file():
            warnings.append(
                f"{name}: no plugin.py (declarative-only rows are not "
                "supported; every row mounts behaviour)"
            )
            continue
        if not _resolves_within(path, module_path):
            warnings.append(f"{name}: plugin.py resolves outside plugin root")
            continue
        module, module_error = _load_plugin_module(module_path)
        if module_error:
            warnings.append(f"{name}: plugin.py failed to load: {module_error}")
            continue
        apply = getattr(module, "apply", None)
        if not callable(apply):
            warnings.append(f"{name}: plugin.py has no callable apply(ctx, config)")
            continue
        module_name = getattr(module, "name", None)
        if module_name != name:
            warnings.append(
                f"{name}: module name {module_name!r} must match directory name"
            )
            continue
        inject = getattr(module, "inject", ())
        if isinstance(inject, str) or not isinstance(inject, (list, tuple)):
            warnings.append(f"{name}: inject must be a list/tuple of service keys")
            continue
        raw_scopes = getattr(module, "scopes", None)
        if raw_scopes is None:
            scopes = ("surface",) if "surface_adapters" in inject else ("agent",)
        else:
            if isinstance(raw_scopes, str) or not isinstance(raw_scopes, (list, tuple)):
                warnings.append(f"{name}: scopes must be a list/tuple of runtime names")
                continue
            scopes = tuple(str(scope).strip() for scope in raw_scopes)
            if (
                not scopes
                or any(not scope or not _valid_plugin_name(scope) for scope in scopes)
                or len(set(scopes)) != len(scopes)
            ):
                warnings.append(
                    f"{name}: scopes must contain unique non-empty [a-z0-9_]+ names"
                )
                continue
        schema = getattr(module, "config_schema", None)
        defaults = getattr(module, "default_config", {}) or {}
        if schema is not None and not isinstance(schema, dict):
            warnings.append(f"{name}: config_schema must be a dict")
            continue
        if not isinstance(defaults, dict):
            warnings.append(f"{name}: default_config must be a dict")
            continue
        specs.append(
            PluginSpec(
                name=name,
                inject=tuple(str(dep) for dep in inject),
                scopes=scopes,
                config_schema=schema,
                default_config=dict(defaults),
                apply=apply,
                description=str(manifest.get("description") or ""),
                source=str(module_path),
            )
        )
    return specs, warnings
