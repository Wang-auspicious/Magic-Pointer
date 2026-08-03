"""One-off latency probe for the UIA selection probe timeout change.

Not part of the test suite: it needs live windows, so it only makes sense run by
hand with real HWNDs passed on the command line.
"""
from __future__ import annotations

import sys
import time

from _bridge_common import ensure_root_on_path

ensure_root_on_path()

from app.adapters.uia_text_adapter import _run_uia_selection_probe  # noqa: E402


def main(argv: list[str]) -> int:
    if not argv:
        print("usage: measure_uia_probe.py <label:hwnd> [<label:hwnd> ...]")
        return 2
    for spec in argv:
        label, _, raw = spec.partition(":")
        try:
            hwnd = int(raw)
        except ValueError:
            print(f"skip {spec!r}: not a hwnd")
            continue
        for _ in range(3):
            started = time.monotonic()
            result = _run_uia_selection_probe(hwnd)
            wall_ms = (time.monotonic() - started) * 1000
            internal = result.data.get("elapsed_ms", "?")
            error = (result.error or "(none)")[:48]
            print(
                f"{label:10s} wall={wall_ms:7.1f}ms "
                f"internal={internal:>5}ms ok={str(result.ok):5s} err={error}"
            )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
