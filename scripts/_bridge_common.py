
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any


MAX_BRIDGE_PAYLOAD_BYTES = 64 * 1024
MAX_SELECTION_PAYLOAD_BYTES = 8 * 1024 * 1024


class PayloadTooLargeError(ValueError):

    def __init__(self, max_bytes: int) -> None:
        self.max_bytes = max_bytes
        super().__init__(f"payload exceeds maximum of {max_bytes} UTF-8 bytes")


def force_utf8_stdio() -> None:
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            reconfigure(encoding="utf-8", errors="strict")


def read_json_line() -> dict[str, Any]:
    raw = sys.stdin.read().lstrip("﻿") or "{}"
    value = json.loads(raw)
    if not isinstance(value, dict):
        raise ValueError("payload must be an object")
    return value


def read_bounded_json_payload(
    max_bytes: int = MAX_BRIDGE_PAYLOAD_BYTES,
) -> dict[str, Any]:
    if max_bytes <= 0:
        raise ValueError("max_bytes must be positive")

    binary_stream = getattr(sys.stdin, "buffer", None)
    if binary_stream is not None:
        raw_bytes = binary_stream.read(max_bytes + 1)
        if len(raw_bytes) > max_bytes:
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
    print(json.dumps(obj, ensure_ascii=False))


def resolve_root() -> Path:
    return Path(__file__).resolve().parents[1]


def ensure_root_on_path() -> None:
    scripts_dir = Path(__file__).resolve().parent
    root = scripts_dir.parent
    for entry in (str(root), str(scripts_dir)):
        if entry not in sys.path:
            sys.path.insert(0, entry)
    stale = sys.modules.get("scripts")
    if stale is not None and getattr(stale, "__file__", None) is None:
        del sys.modules["scripts"]
        for name in [key for key in sys.modules if key.startswith("scripts.")]:
            del sys.modules[name]
