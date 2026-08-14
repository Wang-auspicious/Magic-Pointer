"""SurfaceAdapter SDK (design §8, Phase D).

New applications enter through the SurfaceAdapter/Capability contract,
never through app-specific if/else in core code. An adapter owns the
surface semantics of one app family (self-drawn apps like WeChat whose
UIA tree is an opaque container): it declares what it matches, resolves
the raw object graph under the gesture, and reports evidence honestly.

Pure Python contract layer here; adapters live in
``app/surface_adapter/adapters/`` and manifests (display metadata only)
in ``data/surface_adapters/``.
"""

from app.surface_adapter.manifest import SurfaceAdapterManifest
from app.surface_adapter.protocol import RawObject, ResolveResult, SurfaceResolver
from app.surface_adapter.registry import SurfaceAdapterRegistry, get_surface_registry

__all__ = [
    "RawObject",
    "ResolveResult",
    "SurfaceAdapterManifest",
    "SurfaceAdapterRegistry",
    "SurfaceResolver",
    "get_surface_registry",
]
