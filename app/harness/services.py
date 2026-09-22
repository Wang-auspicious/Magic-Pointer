
from __future__ import annotations

from typing import Any, Protocol, runtime_checkable

__all__ = ["LlmProvider", "SessionProvider"]


@runtime_checkable
class LlmProvider(Protocol):

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

    def open_or_create(self, session_id: str, *, repair: bool = True) -> Any: ...

    def fork(self, source_id: str, child_id: str) -> Any: ...
