from __future__ import annotations

import json
import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.adapters import default_adapter_registry
from app.system_context import list_visible_windows

MAGIC_WINDOW_MARKERS = ("Magic Pointer", "Electron Overlay")
SNAPSHOT_TTL_SECONDS = 120


def read_payload() -> dict[str, Any]:
    raw = sys.stdin.read().lstrip("\ufeff").strip()
    return json.loads(raw) if raw else {}


def _window_dicts() -> list[dict[str, Any]]:
    windows: list[dict[str, Any]] = []
    for item in list_visible_windows():
        title = str(item.get("title") or "")
        if any(marker in title for marker in MAGIC_WINDOW_MARKERS):
            continue
        windows.append(dict(item))
    return windows


def _read_target_context(
    windows: list[dict[str, Any]],
    *,
    registry: Any | None = None,
) -> tuple[dict[str, Any] | None, Any]:
    target_window = windows[0] if windows else None
    if target_window is None:
        return None, None
    active_registry = registry or default_adapter_registry()
    adapter = active_registry.matching_adapter(target_window)
    if adapter is None:
        return target_window, None
    return target_window, adapter.read_context(target_window, command="")


def _has_capability(app_ctx: Any, name: str) -> bool:
    if app_ctx is None:
        return False
    return any(cap.name == name and cap.enabled for cap in app_ctx.capabilities)


def _summary_for(target_window: dict[str, Any] | None, app_ctx: Any) -> dict[str, Any]:
    title = str((target_window or {}).get("title") or "当前应用")
    if app_ctx is None:
        return {
            "state": "unsupported",
            "label": title,
            "detail": "当前应用还没有可靠的原生对象适配",
            "excerpt": "",
            "app": None,
            "hasContent": False,
            "canRewrite": False,
        }

    content = str(app_ctx.content or "")
    artifacts = dict(app_ctx.artifacts or {})
    app_name = str(app_ctx.app or "application")
    display_app = {
        "word": "Word/WPS",
        "excel": "Excel",
        "powerpoint": "PowerPoint",
    }.get(app_name, app_name)
    count = int(artifacts.get("selection_text_chars") or len(content))
    label = f"THIS · {display_app} 选区" if content.strip() else f"{display_app} · 未检测到文本选区"
    detail_parts = []
    if count:
        detail_parts.append(f"{count} 字")
    document = str(artifacts.get("document_name") or artifacts.get("document") or app_ctx.label or "")
    if document:
        detail_parts.append(Path(document).name or document)
    detail = " · ".join(detail_parts) or title
    excerpt = " ".join(content.replace("\r", "\n").split())[:140]
    return {
        "state": "ready" if content.strip() else "empty",
        "label": label,
        "detail": detail,
        "excerpt": excerpt,
        "app": app_name,
        "hasContent": bool(content.strip()),
        "canRewrite": (
            _has_capability(app_ctx, "rewrite_selection")
            or _has_capability(app_ctx, "replace_selection")
        ),
    }


def _suggested_commands(summary: dict[str, Any]) -> list[dict[str, str]]:
    if not summary.get("hasContent"):
        return []
    commands = [
        {"label": "解释", "command": "解释这段内容"},
        {"label": "总结", "command": "总结这段内容"},
        {"label": "翻译", "command": "把这段内容翻译成中文"},
    ]
    if summary.get("canRewrite"):
        commands[1] = {"label": "改写", "command": "改写这段内容，让它更清晰简洁"}
    return commands


def capture_snapshot(
    windows: list[dict[str, Any]] | None = None,
    *,
    registry: Any | None = None,
) -> dict[str, Any]:
    captured = datetime.now(timezone.utc)
    target_window, app_ctx = _read_target_context(
        _window_dicts() if windows is None else windows,
        registry=registry,
    )
    summary = _summary_for(target_window, app_ctx)
    snapshot = {
        "snapshot_id": f"selection-{uuid.uuid4().hex[:16]}",
        "captured_at": captured.isoformat(),
        "expires_at": (captured + timedelta(seconds=SNAPSHOT_TTL_SECONDS)).isoformat(),
        "status": summary["state"],
        "source_kind": "native_selection" if app_ctx is not None else "foreground_window",
        "source_window": target_window,
        "context": None if app_ctx is None else app_ctx.to_dict(),
    }
    return {
        "ok": True,
        "selectionSnapshot": snapshot,
        "captureSummary": summary,
        "suggestedCommands": _suggested_commands(summary),
    }


def main() -> int:
    read_payload()
    print(json.dumps(capture_snapshot(), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
