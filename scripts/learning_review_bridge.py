"""Electron-managed background review bridge (stdin JSON -> stdout JSON)."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.self_evolution.worker import run_review, write_review_result
from scripts._bridge_common import read_bounded_json_payload


def main() -> int:
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            reconfigure(encoding="utf-8", errors="strict")
    payload = read_bounded_json_payload()
    session_id = str(payload.get("sessionId") or "")
    terminal_reason = str(payload.get("terminalReason") or "")
    runtime_root = Path(
        os.environ.get("MAGIC_POINTER_USER_DATA_DIR") or ROOT / "data" / "runtime"
    ).resolve()
    user_root = runtime_root / "data" if os.environ.get("MAGIC_POINTER_USER_DATA_DIR") else ROOT / "data"
    try:
        result = run_review(
            user_root=user_root.resolve(),
            session_root=runtime_root / "agent-sessions",
            session_id=session_id,
            terminal_reason=terminal_reason,
        )
    except Exception as exc:  # noqa: BLE001
        result = {
            "ok": False,
            "sessionId": session_id,
            "error": f"{type(exc).__name__}: {exc}",
        }
    write_review_result(user_root.resolve(), session_id or "invalid", result)
    sys.stdout.write(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
