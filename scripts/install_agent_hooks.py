from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]


def _hook_command(provider: str, *, python: Path, data_root: Path) -> dict[str, Any]:
    common = {
        "type": "command",
        "command": str(python.resolve()),
        "args": [
            str((ROOT / "scripts" / "agent_hook_bridge.py").resolve()),
            "--provider",
            provider,
            "--root",
            str(data_root.resolve()),
        ],
        "timeout": 5 if provider == "claude" else 5000,
    }
    if provider == "gemini":
        common.update({
            "name": "magic-pointer-context",
            "description": "Inject a fresh frozen Magic Pointer object when the prompt refers to it.",
        })
    return common


def merged_settings(
    provider: str,
    existing: dict[str, Any],
    *,
    python: Path,
    data_root: Path,
) -> dict[str, Any]:
    event = "UserPromptSubmit" if provider == "claude" else "BeforeAgent"
    value = json.loads(json.dumps(existing or {}))
    hooks = value.setdefault("hooks", {})
    groups = hooks.setdefault(event, [])
    command = _hook_command(provider, python=python, data_root=data_root)
    signature = str((ROOT / "scripts" / "agent_hook_bridge.py").resolve())
    already_present = any(
        any(
            signature in [str(arg) for arg in hook.get("args") or []]
            for hook in group.get("hooks") or []
            if isinstance(hook, dict)
        )
        for group in groups
        if isinstance(group, dict)
    )
    if not already_present:
        groups.append({
            "matcher": "*" if provider == "gemini" else "",
            "hooks": [command],
        })
    return value


def _settings_path(provider: str, home: Path) -> Path:
    folder = ".claude" if provider == "claude" else ".gemini"
    return home / folder / "settings.json"


def _read(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"settings must be a JSON object: {path}")
    return value


def _write_atomic(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(".json.tmp")
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    os.replace(temp, path)


def main() -> int:
    parser = argparse.ArgumentParser(description="Preview or install native Agent hooks for Magic Pointer.")
    parser.add_argument("--provider", choices=("claude", "gemini", "all"), default="all")
    parser.add_argument("--apply", action="store_true", help="Write settings. Without this flag the command is read-only.")
    parser.add_argument("--home", type=Path, default=Path.home())
    parser.add_argument(
        "--data-root",
        type=Path,
        default=Path(os.environ.get("MAGIC_POINTER_USER_DATA_DIR") or ROOT / "data" / "runtime"),
    )
    args = parser.parse_args()
    providers = ("claude", "gemini") if args.provider == "all" else (args.provider,)
    output: dict[str, Any] = {"ok": True, "applied": args.apply, "providers": {}}
    for provider in providers:
        path = _settings_path(provider, args.home)
        merged = merged_settings(
            provider,
            _read(path),
            python=Path(sys.executable),
            data_root=args.data_root,
        )
        if args.apply:
            _write_atomic(path, merged)
        output["providers"][provider] = {
            "path": str(path),
            "event": "UserPromptSubmit" if provider == "claude" else "BeforeAgent",
            "hook": _hook_command(provider, python=Path(sys.executable), data_root=args.data_root),
        }
    print(json.dumps(output, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
