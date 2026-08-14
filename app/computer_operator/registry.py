"""Plugin-scoped registry for optional computer operator providers."""

from __future__ import annotations

import re
from typing import Any

from .protocol import ComputerOperatorBackend

_BACKEND_NAME = re.compile(r"[a-z0-9][a-z0-9_-]*")


class ComputerOperatorRegistry:
    def __init__(self) -> None:
        self._backends: dict[str, ComputerOperatorBackend] = {}

    def register(self, backend: ComputerOperatorBackend) -> ComputerOperatorBackend:
        name = str(getattr(backend, "backend_name", "") or "")
        if not _BACKEND_NAME.fullmatch(name):
            raise ValueError("computer operator backend_name is invalid")
        if name in self._backends:
            raise ValueError(f"computer operator {name!r} is already registered")
        for method_name in ("observe", "execute", "abort"):
            if not callable(getattr(backend, method_name, None)):
                raise TypeError(f"computer operator {name!r} has no {method_name}()")
        self._backends[name] = backend
        return backend

    def unregister(
        self,
        name: str,
        *,
        expected: ComputerOperatorBackend | None = None,
    ) -> bool:
        current = self._backends.get(str(name))
        if current is None or (expected is not None and current is not expected):
            return False
        del self._backends[str(name)]
        return True

    def get(self, name: str) -> ComputerOperatorBackend:
        try:
            return self._backends[str(name)]
        except KeyError as exc:
            raise KeyError(f"unknown computer operator {name!r}") from exc

    def list_names(self) -> tuple[str, ...]:
        return tuple(self._backends)

    def scope_for(self, context: Any) -> _ScopedComputerOperatorRegistry:
        return _ScopedComputerOperatorRegistry(self, context)


class _OwnedBackend:
    """Every provider call owns plugin work until it returns."""

    def __init__(self, backend: ComputerOperatorBackend, context: Any) -> None:
        self._backend = backend
        self._context = context
        self.backend_name = backend.backend_name

    def observe(self, grant, *, scope=None):
        with self._context.work():
            return self._backend.observe(grant, scope=scope)

    def execute(self, action, grant, *, scope=None):
        with self._context.work():
            return self._backend.execute(action, grant, scope=scope)

    def abort(self, operation_id: str) -> bool:
        with self._context.work():
            return self._backend.abort(operation_id)


class _ScopedComputerOperatorRegistry:
    def __init__(self, registry: ComputerOperatorRegistry, context: Any) -> None:
        self._registry = registry
        self._context = context

    def register(self, backend: ComputerOperatorBackend) -> ComputerOperatorBackend:
        owned = _OwnedBackend(backend, self._context)
        registered = self._registry.register(owned)
        try:
            self._context.effect(
                lambda: self._registry.unregister(
                    registered.backend_name,
                    expected=registered,
                )
            )
        except Exception:
            self._registry.unregister(registered.backend_name, expected=registered)
            raise
        return registered

    def __getattr__(self, name: str) -> Any:
        return getattr(self._registry, name)

