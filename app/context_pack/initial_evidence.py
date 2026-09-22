
from typing import Any


def available_content(identity: dict[str, Any], *, max_chars: int) -> dict[str, Any] | None:
    material = identity.get("initialRead") or identity.get("frozenSelection")
    if not isinstance(material, dict) or max_chars <= 0:
        return None
    text = str(material.get("text") or "")
    if not text.strip():
        return None
    coverage = dict(material.get("coverage") or {})
    coverage.pop("readRanges", None)
    truncated = bool(material.get("truncated")) or len(text) > max_chars
    if truncated:
        coverage.update(complete=False, nextCursor=None, missingReason="initial-evidence-budget")
    return {
        "text": text[:max_chars],
        "coverage": coverage,
        "usedBackend": str(material.get("usedBackend") or "selection_snapshot"),
        "temporalScope": "gesture_capture",
        "truncated": truncated,
        "readFromStart": truncated,
    }
