"""Perception privacy infrastructure: app blacklist, sensitive redaction,
and offline (no-egress) mode (harness gap review L10, task A2).

Pure Python, stdlib-only. No I/O, no Electron coupling, no UI automation.
"""

from .app_blacklist import AppBlacklist, BlacklistDecision, BlacklistRule
from .offline_mode import (
    FORBIDDEN_SCOPES,
    LOCAL_SCOPES,
    OfflineForbiddenError,
    OfflineMode,
)
from .sensitive_detect import (
    PASSWORD_FIELD_MARKER,
    RedactionHit,
    RedactionResult,
    contains_sensitive,
    redact,
)

__all__ = [
    "AppBlacklist",
    "BlacklistDecision",
    "BlacklistRule",
    "FORBIDDEN_SCOPES",
    "LOCAL_SCOPES",
    "OfflineForbiddenError",
    "OfflineMode",
    "PASSWORD_FIELD_MARKER",
    "RedactionHit",
    "RedactionResult",
    "contains_sensitive",
    "redact",
]
