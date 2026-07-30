"""Shared helpers for Magic Pointer bridge scripts (agent, fabric, selection, etc.).

Every bridge reads a single JSON object from stdin and prints a single JSON
object to stdout. This module provides one-line helpers so callers don't repeat
the reconfigure / BOM / parse / serialize dance.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any


def force_utf8_stdio() -> None:
    """Reconfigure stdin/stdout to UTF-8, best-effort on both OS and PyPy."""
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            reconfigure(encoding="utf-8", errors="strict")


def read_json_line() -> dict[str, Any]:
    """Read one JSON object from stdin, returning {} on empty input."""
    raw = sys.stdin.read().lstrip("﻿") or "{}"
    value = json.loads(raw)
    if not isinstance(value, dict):
        raise ValueError("payload must be an object")
    return value


def write_json(obj: Any) -> None:
    """Print a JSON object followed by newline to stdout."""
    print(json.dumps(obj, ensure_ascii=False))


def resolve_root() -> Path:
    """Return the Magic Pointer repository root (parent of scripts/)."""
    return Path(__file__).resolve().parents[1]


def ensure_root_on_path() -> None:
    """Insert the repository root and scripts/ into sys.path."""
    scripts_dir = Path(__file__).resolve().parent
    root = scripts_dir.parent
    for entry in (str(root), str(scripts_dir)):
        if entry not in sys.path:
            sys.path.insert(0, entry)
