"""Stable service definitions exposed to harness plugins.

Providers implement these protocols; consumers depend on the service key and
protocol rather than importing a concrete backend. This is the small Python
form of DSH's Service Definition / Provider / Consumer seam triangle.
"""

from __future__ import annotations

from typing import Any, Protocol, runtime_checkable

__all__ = ["LlmProvider", "SessionProvider"]


@runtime_checkable
class LlmProvider(Protocol):
    """Factory seam behind ``ctx.get("llm")``."""

    @property
    def used_backend(self) -> str: ...

    def create_client(
        self,
        *,
        system_prompt: str,
        max_tokens: int,
        effort: str,
    ) -> Any: ...


@runtime_checkable
class SessionProvider(Protocol):
    """Persistence/fork seam behind ``ctx.get("sessions")``."""

    def open_or_create(self, session_id: str, *, repair: bool = True) -> Any: ...

    def fork(self, source_id: str, child_id: str) -> Any: ...
