
from __future__ import annotations

import threading

FORBIDDEN_SCOPES: frozenset[str] = frozenset(
    {"model_text", "model_vision", "external_send", "mcp_remote"}
)

LOCAL_SCOPES: frozenset[str] = frozenset({"local_ocr", "local_model"})


class OfflineForbiddenError(Exception):

    def __init__(self, scope: str) -> None:
        super().__init__(f"offline mode forbids scope {scope!r}")
        self.scope = scope


class OfflineMode:

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
        with self._lock:
            self._offline = bool(offline)

    def is_offline(self) -> bool:
        with self._lock:
            return self._offline

    def assert_allowed(self, scope: str) -> None:
        with self._lock:
            if self._offline and scope in FORBIDDEN_SCOPES:
                raise OfflineForbiddenError(scope)

    def impact_summary(self) -> dict[str, object]:
        with self._lock:
            offline = self._offline
        return {
            "offline": offline,
            "forbidden_scopes": sorted(FORBIDDEN_SCOPES) if offline else [],
            "local_scopes": sorted(LOCAL_SCOPES),
        }
