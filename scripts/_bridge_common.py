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


MAX_BRIDGE_PAYLOAD_BYTES = 64 * 1024


class PayloadTooLargeError(ValueError):
    """Raised before parsing when a bridge payload exceeds its byte budget."""

    def __init__(self, max_bytes: int) -> None:
        self.max_bytes = max_bytes
        super().__init__(f"payload exceeds maximum of {max_bytes} UTF-8 bytes")


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


def read_bounded_json_payload(
    max_bytes: int = MAX_BRIDGE_PAYLOAD_BYTES,
) -> dict[str, Any]:
    """Read one UTF-8 JSON object through a limit-plus-one sentinel buffer."""
    if max_bytes <= 0:
        raise ValueError("max_bytes must be positive")

    binary_stream = getattr(sys.stdin, "buffer", None)
    if binary_stream is not None:
        raw_bytes = binary_stream.read(max_bytes + 1)
        if len(raw_bytes) > max_bytes:
            # Let pipe writers finish so they receive the structured limit error
            # instead of an EPIPE, while retaining only one bounded chunk at a time.
            del raw_bytes
            while binary_stream.read(max_bytes + 1):
                pass
            raise PayloadTooLargeError(max_bytes)
        raw = raw_bytes.decode("utf-8")
    else:
        raw = sys.stdin.read(max_bytes + 1)
        if len(raw.encode("utf-8")) > max_bytes:
            del raw
            while sys.stdin.read(max_bytes + 1):
                pass
            raise PayloadTooLargeError(max_bytes)

    raw = raw.lstrip("﻿").strip()
    if not raw:
        return {}
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
    """Insert the repository root and scripts/ into sys.path.

    Also evicts a poisoned ``scripts`` entry from sys.modules: pywin32 ships a
    ``scripts`` directory that lands on sys.path (Python312\\scripts,
    site-packages\\win32\\scripts), so an import attempted BEFORE the root is
    on the path caches ``scripts`` as a namespace package pointing at those
    directories, and every later ``from scripts.X import ...`` fails with
    ModuleNotFoundError even after the path is fixed. Real-machine failure,
    not theory: direct ``python scripts/conversation_bridge.py`` died at line
    55 on this machine.
    """
    scripts_dir = Path(__file__).resolve().parent
    root = scripts_dir.parent
    for entry in (str(root), str(scripts_dir)):
        if entry not in sys.path:
            sys.path.insert(0, entry)
    stale = sys.modules.get("scripts")
    if stale is not None and getattr(stale, "__file__", None) is None:
        # Namespace package (no __init__.py) → it cannot be ours; drop it so
        # the real package resolves against the freshly inserted root.
        del sys.modules["scripts"]
        for name in [key for key in sys.modules if key.startswith("scripts.")]:
            del sys.modules[name]
