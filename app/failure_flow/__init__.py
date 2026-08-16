"""Failure flow (harness gap review L15/L16): repair dialogue and capability hints.

Pure Python data modules consumed by the UI; no I/O, no Electron coupling.
"""

from .repair_prompt import (
    RepairAction,
    RepairSuggestion,
    build_repair,
    to_dict,
)

__all__ = [
    "MAX_HINTS",
    "MIN_HINTS",
    "Hint",
    "HintSpec",
    "hints_for",
    "RepairAction",
    "RepairSuggestion",
    "build_repair",
    "to_dict",
]
