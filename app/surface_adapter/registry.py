"""SurfaceAdapter registry: the only entry core code calls (design §8).

Adapters register themselves (built-ins) or load from manifests; the
registry asks each adapter ``matches`` on the target window and returns
the first claiming adapter's resolution. No app-specific logic lives
outside the adapter modules — core code sees the protocol only.
"""

from __future__ import annotations

from typing import Any

from app.surface_adapter.protocol import ResolveResult, SurfaceResolver

__all__ = ["SurfaceAdapterRegistry", "get_surface_registry"]


class SurfaceAdapterRegistry:
    def __init__(self) -> None:
        self._adapters: list[SurfaceResolver] = []

    def register(self, adapter: SurfaceResolver) -> SurfaceResolver:
        self._adapters.append(adapter)
        return adapter

    def unregister(self, adapter: SurfaceResolver) -> bool:
        for index, current in enumerate(self._adapters):
            if current is adapter:
                del self._adapters[index]
                return True
        return False

    def scope_for(self, context: Any) -> _ScopedSurfaceAdapterRegistry:
        return _ScopedSurfaceAdapterRegistry(self, context)

    def list_adapters(self) -> list[SurfaceResolver]:
        return list(self._adapters)

    def try_resolve(
        self,
        window: dict[str, Any],
        target_point: dict[str, int] | None,
        target_region: dict[str, int] | None = None,
    ) -> ResolveResult | None:
        """First claiming adapter wins; None when nobody claims the window."""
        for adapter in self._adapters:
            try:
                claimed = bool(adapter.matches(window))
            except Exception:
                claimed = False
            if not claimed:
                continue
            try:
                return adapter.resolve(window, target_point, target_region)
            except Exception:
                # An adapter failure is one perception attempt failing, never
                # the chain dying: the caller records the miss and moves on.
                return None
        return None


class _ScopedSurfaceAdapterRegistry:
    """Context-bound adapter registry view with exact unload."""

    def __init__(self, registry: SurfaceAdapterRegistry, context: Any) -> None:
        self._registry = registry
        self._context = context

    def register(self, adapter: SurfaceResolver) -> SurfaceResolver:
        registered = self._registry.register(_OwnedSurfaceAdapter(adapter, self._context))
        try:
            self._context.effect(lambda: self._registry.unregister(registered))
        except Exception:
            self._registry.unregister(registered)
            raise
        return registered

    def __getattr__(self, name: str) -> Any:
        return getattr(self._registry, name)


class _OwnedSurfaceAdapter:
    """Keep plugin resources alive for every adapter callback."""

    def __init__(self, adapter: SurfaceResolver, context: Any) -> None:
        self._adapter = adapter
        self._context = context

    def matches(self, window: dict[str, Any]) -> bool:
        with self._context.work():
            return self._adapter.matches(window)

    def resolve(
        self,
        window: dict[str, Any],
        target_point: dict[str, int] | None,
        target_region: dict[str, int] | None,
    ) -> ResolveResult | None:
        with self._context.work():
            return self._adapter.resolve(window, target_point, target_region)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._adapter, name)


_default_registry: SurfaceAdapterRegistry | None = None


def get_surface_registry() -> SurfaceAdapterRegistry:
    """Process-wide registry; built-in adapters register on first use."""
    global _default_registry
    if _default_registry is None:
        _default_registry = SurfaceAdapterRegistry()
        from app.surface_adapter.adapters.wechat_adapter import WeChatSurfaceAdapter

        _default_registry.register(WeChatSurfaceAdapter())
    return _default_registry
