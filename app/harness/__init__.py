"""Magic Pointer harness kernel (plugin-kernel batch, plan T1–T3).

The DSH-Cordis five ideas rewritten in Python; see
``docs/2026-08-14-plugin-architecture-review.md`` for the gold-standard
reference and the migration rationale. Modules:

- ``context``: service repository, inject, reversible effects, typed events.
- ``plugin``: the Plugin protocol, directory discovery, broken-row isolation.
- ``composition``: layered boot (bundle rows -> user plugins -> patch) and
  ``dump_config``.
- ``services``: stable Provider/Consumer seam protocols such as ``ctx.llm``.
"""

from app.harness.context import (
    Context,
    Disposable,
    EventDispatchError,
    InjectionHandle,
    UndeclaredEventError,
)
from app.harness.services import LlmProvider, SessionProvider

__all__ = [
    "Context",
    "Disposable",
    "EventDispatchError",
    "InjectionHandle",
    "LlmProvider",
    "SessionProvider",
    "UndeclaredEventError",
]
