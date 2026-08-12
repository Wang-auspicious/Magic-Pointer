"""Perception privacy infrastructure: app blacklist, sensitive redaction,
offline (no-egress) mode, and the per-app capability matrix (review L10/L14).

Pure Python, stdlib-only. No I/O, no Electron coupling, no UI automation.
"""

from .app_blacklist import AppBlacklist, BlacklistDecision, BlacklistRule
from .capability_matrix import (
    KNOWN_CAPABILITIES,
    Capability,
    CapabilityEntry,
    CapabilityMatrix,
    CapabilityMatrixError,
    CapabilityStatus,
    entry_dict,
)
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
    "KNOWN_CAPABILITIES",
    "Capability",
    "CapabilityEntry",
    "CapabilityMatrix",
    "CapabilityMatrixError",
    "CapabilityStatus",
    "entry_dict",
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
