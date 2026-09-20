"""首次运行时扫一遍：这台机器的聊天软件仓库在哪。

每台电脑的仓库位置都不一样——微信安装时就让人挑盘，钉钉/飞书各有各的默认。靠一张
写死的候选表等于赌对方和你一样，所以安装时扫一次，结果落盘，之后每次直接读缓存。

    python scripts/discover_chat_stores.py
    python scripts/discover_chat_stores.py --root D:\MyTencent      # 手动补一条

扫描只到每个固定盘的前两层目录名，不做全盘遍历。找不到就报找不到——不猜。
"""

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
