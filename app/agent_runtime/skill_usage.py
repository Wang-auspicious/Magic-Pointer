
from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path

__all__ = ["SkillUsageStore", "bump_skill_usage"]

USAGE_FILE_NAME = "skill-usage.json"


class SkillUsageStore:

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
            pass

    def count(self, name: str) -> int:
        record = self.usage().get(str(name or "").strip())
        return int(record.get("count") or 0) if isinstance(record, dict) else 0


def bump_skill_usage(user_dir: Path | str, name: str) -> None:
    SkillUsageStore(user_dir).bump(name)


def usage_env_user_dir(fallback_root: Path | str) -> Path:
    env_dir = os.environ.get("MAGIC_POINTER_USER_DATA_DIR", "").strip()
    return Path(env_dir) if env_dir else Path(fallback_root)
