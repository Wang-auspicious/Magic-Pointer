#!/usr/bin/env python
"""Print the tree the harness would actually boot (the ``dsh --dump-config``
idea from the plugin-kernel batch, plan T5).

Shows the composed plugin tree: core seam services, every row's resolved
config (env knobs already applied), row status, and any discovery warnings
from the user plugin directory. Purely diagnostic: nothing is executed
beyond plugin registration, and no model request is made.

Usage:
    python scripts/harness_dump_config.py
    MAGIC_POINTER_PLUGIN_DIR=/path/to/plugins python scripts/harness_dump_config.py
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

CORE_SEAM_KEYS = (
    "tools",
    "hooks",
    "prompt",
    "perception",
    "vision",
    "guard_probe",
    "selection_anchor",
)

_SECRET_KEY = re.compile(r"(?i)(api[_-]?key|token|secret|password|passwd|pwd|credential|authorization)")


def _plain(value):
    """Render a config value for display (callables -> <callable>).

    Secret-shaped keys and absolute paths are redacted: this output is meant
    to be pasted into issues/shared (harness audit P2 — a patch config can
    carry api keys, and paths leak the user's home directory).
    """
    if callable(value):
        return "<callable>"
    if isinstance(value, dict):
        return {
            key if isinstance(key, str) else key: (
                "[REDACTED]"
                if isinstance(key, str) and _SECRET_KEY.search(key)
                else _plain(item)
            )
            for key, item in value.items()
        }
    if isinstance(value, (list, tuple)):
        return [_plain(item) for item in value]
    if isinstance(value, set):
        return sorted(str(item) for item in value)
    if isinstance(value, (str, Path)):
        text = str(value)
        home = str(Path.home())
        if home and text.startswith(home):
            return "~" + text[len(home):]
        return text
    return value


def main() -> int:
    from app.harness.builtin_bundle import boot_loop_context

    report = boot_loop_context(
        {
            "perception_backend": object(),
            "vision_backend": None,
            "frame_crop": None,
            "guard_probe": None,
            "selection_anchor": None,
            "propose": lambda recipe_id, args: {"ok": False},
            "execute_plan": None,
            "enabled_recipes": None,
            "summarize": lambda text: "",
            "content": "",
            "capture_path": "",
            "target_window": {},
            "command": "(dump-config)",
        }
    )
    core_seams = {
        key: "provided" if report.ctx.has(key) else "missing" for key in CORE_SEAM_KEYS
    }
    plugin_services = {
        key: "provided" if report.ctx.has(key) else "missing"
        for key in ("precondition_factory", "model_client", "compactor", "token_estimator")
    }
    payload = {
        "coreSeams": core_seams,
        "pluginServices": plugin_services,
        "rows": [
            {
                "id": row["id"],
                "plugin": row["plugin"],
                "status": row["status"],
                "config": _plain(row["config"]),
                "resolvedConfig": _plain(row["resolved_config"]),
                "error": row["error"],
                "missingDeps": row["missingDeps"],
            }
            for row in report.dump_config()
        ],
        "warnings": report.warnings,
    }
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    report.ctx.unload()
    return 0


if __name__ == "__main__":
    sys.exit(main())
