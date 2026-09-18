"""Project already acquired source content without another read or model call."""

from typing import Any


def available_content(identity: dict[str, Any], *, max_chars: int) -> dict[str, Any] | None:
    material = identity.get("initialRead") or identity.get("frozenSelection")
    if not isinstance(material, dict) or max_chars <= 0:
        return None
    text = str(material.get("text") or "")
    if not text.strip():
        return None
    coverage = dict(material.get("coverage") or {})
    truncated = bool(material.get("truncated")) or len(text) > max_chars
    if truncated:
        # A unit cursor from the full preview would skip text omitted here.
        coverage.update(complete=False, nextCursor=None, missingReason="initial-evidence-budget")
    return {
        "text": text[:max_chars],
        "coverage": coverage,
        "usedBackend": str(material.get("usedBackend") or "selection_snapshot"),
        "temporalScope": "gesture_capture",
        "truncated": truncated,
        "readFromStart": truncated,
    }
