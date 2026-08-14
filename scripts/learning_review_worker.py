"""Detached entry point for one self-improvement review."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.self_evolution.worker import run_review, write_review_result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--user-root", type=Path, required=True)
    parser.add_argument("--session-root", type=Path, required=True)
    parser.add_argument("--session-id", required=True)
    parser.add_argument("--terminal-reason", required=True)
    args = parser.parse_args()
    try:
        result = run_review(
            user_root=args.user_root.resolve(),
            session_root=args.session_root.resolve(),
            session_id=args.session_id,
            terminal_reason=args.terminal_reason,
        )
    except Exception as exc:  # noqa: BLE001 - detached worker records failure
        result = {
            "ok": False,
            "sessionId": args.session_id,
            "error": f"{type(exc).__name__}: {exc}",
        }
    write_review_result(args.user_root.resolve(), args.session_id, result)
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
