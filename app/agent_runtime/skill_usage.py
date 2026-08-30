"""技能使用频次计数（Hermes ``tools/skill_usage.py`` 范式）。

skill 被注入提示词（:class:`~app.agent_runtime.memory.SkillLoader`）或被
斜杠显式加载时 bump 计数 + 时间戳，落 ``<user_data>/skill-usage.json``。
SkillLoader 用计数做同分排序：高频技能排前，模型更常看到它、也更常调
用它——用户要的就是这个反馈回路。

文件损坏按空表处理（计数是提示词排序信号，不是账本；重建比报错有用）。
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path

__all__ = ["SkillUsageStore", "bump_skill_usage"]

USAGE_FILE_NAME = "skill-usage.json"


class SkillUsageStore:
    """每个技能一个 ``{"count": int, "lastUsed": iso}`` 记录。"""

    def __init__(self, user_dir: Path | str) -> None:
        self._path = Path(user_dir) / USAGE_FILE_NAME

    def usage(self) -> dict[str, dict[str, object]]:
        try:
            data = json.loads(self._path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, ValueError):
            return {}
        if not isinstance(data, dict):
            return {}
        return {
            str(name): record
            for name, record in data.items()
            if isinstance(record, dict) and isinstance(record.get("count"), int)
        }

    def bump(self, name: str) -> None:
        name = str(name or "").strip()
        if not name:
            return
        usage = self.usage()
        record = usage.get(name) if isinstance(usage.get(name), dict) else {}
        usage[name] = {
            "count": int(record.get("count") or 0) + 1,
            "lastUsed": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        }
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            self._path.write_text(
                json.dumps(usage, ensure_ascii=False, indent=2), encoding="utf-8"
            )
        except OSError:
            pass  # 计数失败不该连累技能注入

    def count(self, name: str) -> int:
        record = self.usage().get(str(name or "").strip())
        return int(record.get("count") or 0) if isinstance(record, dict) else 0


def bump_skill_usage(user_dir: Path | str, name: str) -> None:
    """斜杠显式加载路径的计数入口（与注入路径共用同一份 JSON）。"""
    SkillUsageStore(user_dir).bump(name)


def usage_env_user_dir(fallback_root: Path | str) -> Path:
    """与 selection_bridge 同源的用户目录解析：环境变量优先。"""
    env_dir = os.environ.get("MAGIC_POINTER_USER_DATA_DIR", "").strip()
    return Path(env_dir) if env_dir else Path(fallback_root)
