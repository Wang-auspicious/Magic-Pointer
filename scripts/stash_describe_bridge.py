"""stash 收藏箱图片的悬停摘要桥。

读一条收藏的本地图片路径，用配置的视觉模型（qwen3.7-plus）给 3-4 句
简介。输入是本地文件——不是截屏上传，不走 upload_screenshots 开关。

stdin: {"imagePath": "..."}
stdout: {"ok": true, "summary": "..."} 或 {"ok": false, "error": "..."}
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.ai_client import ask_vision_model  # noqa: E402


def _read_payload() -> dict:
    try:
        text = sys.stdin.read()
    except Exception:
        return {}
    if not text:
        return {}
    try:
        return json.loads(text)
    except Exception:
        return {}


def main() -> int:
    payload = _read_payload()
    image_path = str(payload.get("imagePath") or "").strip()
    if not image_path:
        print(json.dumps({"ok": False, "error": "missing_image_path"}, ensure_ascii=True))
        return 2
    path = Path(image_path)
    if not path.is_file():
        print(json.dumps({"ok": False, "error": "image_not_found"}, ensure_ascii=True))
        return 2
    try:
        summary = ask_vision_model(
            path,
            "用三到四句中文简要描述这张图片的内容：主要对象、场景、可见文字（如有）。"
            "只描述你确定看到的，不要编造。",
        )
    except Exception as exc:
        print(json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"}, ensure_ascii=True))
        return 1
    if not summary or "AI 调用失败" in summary:
        print(json.dumps({"ok": False, "error": "vision_unavailable"}, ensure_ascii=True))
        return 1
    print(json.dumps({"ok": True, "summary": summary}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
