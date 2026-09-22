
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.context_pack.chat_local_files import (  # noqa: E402
    discover_chat_stores,
    discovery_cache_path,
)


def main(argv: list[str]) -> int:
    extra: list[Path] = []
    for index, item in enumerate(argv):
        if item == "--root" and index + 1 < len(argv):
            extra.append(Path(argv[index + 1]))
    found = discover_chat_stores(extra_roots=extra)
    print(json.dumps(
        {key: [str(path) for path in paths] for key, paths in found.items()},
        ensure_ascii=False,
        indent=1,
    ))
    print(f"cache: {discovery_cache_path()}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
