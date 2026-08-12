"""Offline (no-egress) mode (harness gap review L10).

When offline, no content may leave the machine: model endpoints, external
sends and remote MCP calls are forbidden; local-only perception (OCR, local
models) still works. The declaration is a process-wide singleton so every
egress path consults the same state.

This module is pure Python and has no I/O or platform dependencies.
"""

from __future__ import annotations

import threading

FORBIDDEN_SCOPES: frozenset[str] = frozenset(
    {"model_text", "model_vision", "external_send", "mcp_remote"}
)

LOCAL_SCOPES: frozenset[str] = frozenset({"local_ocr", "local_model"})


class OfflineForbiddenError(Exception):
    """Raised when an egress scope is used while offline."""

    def __init__(self, scope: str) -> None:
        super().__init__(f"offline mode forbids scope {scope!r}")
        self.scope = scope


class OfflineMode:
    """Process-wide singleton declaration of the no-egress state."""

    _instance: OfflineMode | None = None
    _singleton_lock = threading.Lock()

    def __new__(cls) -> OfflineMode:
        with cls._singleton_lock:
            if cls._instance is None:
                instance = super().__new__(cls)
                instance._offline = False
                instance._lock = threading.RLock()
                cls._instance = instance
            return cls._instance

    def set(self, offline: bool) -> None:
        """Declare whether the machine may leave the local perimeter."""
        with self._lock:
            self._offline = bool(offline)

    def is_offline(self) -> bool:
        """True when the machine is currently offline."""
        with self._lock:
            return self._offline

    def assert_allowed(self, scope: str) -> None:
        """Raise :class:`OfflineForbiddenError` for egress scopes while offline.

        Local scopes (``local_ocr``/``local_model``) and unknown scopes are
        always allowed; when online every scope is allowed.
        """
        with self._lock:
            if self._offline and scope in FORBIDDEN_SCOPES:
                raise OfflineForbiddenError(scope)

    def impact_summary(self) -> dict[str, object]:
        """Declare which scopes are forbidden and which remain usable."""
        with self._lock:
            offline = self._offline
        return {
            "offline": offline,
            "forbidden_scopes": sorted(FORBIDDEN_SCOPES) if offline else [],
            "local_scopes": sorted(LOCAL_SCOPES),
        }
