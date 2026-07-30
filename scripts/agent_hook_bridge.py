from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

_scripts_dir = str(Path(__file__).resolve().parent)
if _scripts_dir not in sys.path:
    sys.path.insert(0, _scripts_dir)

from _bridge_common import ensure_root_on_path, force_utf8_stdio, read_json_line, resolve_root, write_json  # noqa: E402

ensure_root_on_path()

from app.fabric.hooks import build_hook_response

_SUPPORTED_PROVIDERS = ("claude", "gemini", "cursor", "windsurf", "opencode", "aider")


def main() -> int:
    force_utf8_stdio()
    parser = argparse.ArgumentParser(description="Inject a frozen Magic Pointer object into an Agent hook.")
    parser.add_argument(
        "--provider",
        choices=_SUPPORTED_PROVIDERS,
        required=True,
    )
    parser.add_argument(
        "--root",
        default=os.environ.get("MAGIC_POINTER_USER_DATA_DIR")
        or str(resolve_root() / "data" / "runtime"),
    )
    args = parser.parse_args()
    try:
        payload = read_json_line()
        result = build_hook_response(
            args.provider,
            dict(payload),
            root=Path(args.root),
            auto_context=os.environ.get("MAGIC_POINTER_AUTO_CONTEXT") == "1",
        )
        write_json(result)
        return 0
    except Exception as exc:
        write_json({"systemMessage": f"Magic Pointer hook warning: {type(exc).__name__}"})
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
