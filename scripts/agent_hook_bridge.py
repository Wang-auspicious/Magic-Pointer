from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.fabric.hooks import build_hook_response


def _force_utf8_stdio() -> None:
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            reconfigure(encoding="utf-8", errors="strict")


def main() -> int:
    _force_utf8_stdio()
    parser = argparse.ArgumentParser(description="Inject a frozen Magic Pointer object into an Agent hook.")
    parser.add_argument("--provider", choices=("claude", "gemini"), required=True)
    parser.add_argument("--root", default=os.environ.get("MAGIC_POINTER_USER_DATA_DIR") or str(ROOT / "data" / "runtime"))
    args = parser.parse_args()
    try:
        payload = json.loads(sys.stdin.read().lstrip("\ufeff") or "{}")
        result = build_hook_response(
            args.provider,
            dict(payload),
            root=Path(args.root),
            auto_context=os.environ.get("MAGIC_POINTER_AUTO_CONTEXT") == "1",
        )
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except Exception as exc:
        print(json.dumps({"systemMessage": f"Magic Pointer hook warning: {type(exc).__name__}"}, ensure_ascii=False))
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
