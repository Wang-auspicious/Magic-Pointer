"""Selection-direct custom text action request contract.

This module is intentionally UI- and adapter-agnostic.  It describes the
request handed from a captured native selection to a user-defined action; it
does not claim to invoke or write back into any external application.
"""

from __future__ import annotations

from typing import Any, Mapping


def _required_text(mapping: Mapping[str, Any], field: str, path: str) -> str:
    value = mapping.get(field)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{path} must be a non-blank string")
    return value


def compile_custom_text_action_request(
    selection: Mapping[str, Any], action: Mapping[str, Any]
) -> dict[str, Any]:
    """Build a portable request for running an action directly on selection text."""
    text = _required_text(selection, "text", "selection.text")
    action_id = _required_text(action, "id", "action.id")

    return {
        "version": "custom-text-action-request-v1",
        "invocation": "selection-direct",
        "action": {
            "id": action_id,
            "label": action.get("label"),
            "instructions": action.get("instructions"),
        },
        "selection": {
            "text": text,
            "source_app": selection.get("source_app"),
            "snapshot_id": selection.get("snapshot_id"),
            "range_ref": selection.get("range_ref"),
        },
    }
