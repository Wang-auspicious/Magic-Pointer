"""Stable mapping from a selection-session token to the durable agent session id.

Electron mid-run steer and the selection bridge must agree on this string or a
steer is appended to a JSONL the live loop never reads.
"""

from __future__ import annotations

import hashlib
import re

__all__ = ["agent_session_id"]

_TOKEN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,121}$")


def agent_session_id(selection_session_id: str) -> str:
    raw = str(selection_session_id or "").strip()
    if not raw:
        raise ValueError("selection_session_id required")
    if _TOKEN.fullmatch(raw):
        return f"agent-{raw}"
    digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()[:32]
    return f"agent-{digest}"
