from __future__ import annotations

import json
import os
import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from PIL import ImageGrab

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.adapters import default_adapter_registry
from app.context_pack import ContextSessionError, ContextSessionStore
from app.review import ReviewSessionError, ReviewSessionStore
from app.fabric.settings import FabricSettings, SettingsError, SettingsStore
from app.system_context import get_foreground_window_handle, list_visible_windows

MAGIC_WINDOW_TITLES = {"Magic Pointer Overlay", "Magic Pointer Panel"}
SNAPSHOT_TTL_SECONDS = 120
VISUAL_REGION_WIDTH = 640
VISUAL_REGION_HEIGHT = 420


def read_payload() -> dict[str, Any]:
    raw = sys.stdin.read().lstrip("\ufeff").strip()
    return json.loads(raw) if raw else {}


def _window_dicts() -> list[dict[str, Any]]:
    windows: list[dict[str, Any]] = []
    for item in list_visible_windows():
        title = str(item.get("title") or "")
        if title in MAGIC_WINDOW_TITLES:
            continue
        windows.append(dict(item))
    foreground_hwnd = get_foreground_window_handle()
    if foreground_hwnd:
        foreground = next(
            (item for item in windows if int(item.get("hwnd") or 0) == foreground_hwnd),
            None,
        )
        return [foreground] if foreground is not None else []
    return []


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
        "browser": "\u6d4f\u89c8\u5668",
        "pdf": "PDF",
        "application": "\u5e94\u7528",
    }.get(app_name, app_name)
    if app_ctx.error and not content.strip():
        return {
            "state": "error",
            "label": f"{display_app} \u00b7 \u9009\u533a\u8bfb\u53d6\u5931\u8d25",
            "detail": "\u672a\u80fd\u53ef\u9760\u8bfb\u53d6\u5f53\u524d\u9009\u533a\uff0c\u8bf7\u91cd\u8bd5",
            "excerpt": "",
            "app": app_name,
            "hasContent": False,
            "canRewrite": False,
            "error": str(app_ctx.error),
        }
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


def _suggested_commands(summary: dict[str, Any]) -> list[dict[str, Any]]:
    if not summary.get("hasContent"):
        if summary.get("hasActiveContext"):
            count = int(summary.get("activeContextItemCount") or 0)
            if summary.get("activeContextWorkflowKind") == "runtime_issue":
                return [{
                    "label": f"填入现场任务（{count} 条证据）",
                    "command": "发送到这里",
                    "autoRun": True,
                }]
            return [{
                "label": f"发送 {count} 条上下文",
                "command": "发送到这里",
                "autoRun": True,
            }]
        if summary.get("hasActiveReview"):
            count = int(summary.get("activeReviewAnchorCount") or 0)
            return [{
                "label": f"填入 {count} 条验收意见",
                "command": "把验收意见填到这里",
                "autoRun": True,
            }]
        if summary.get("hasVisual"):
            return [
                {
                    "label": "生成视觉提示",
                    "command": "为这个屏幕对象生成给非多模态模型使用的详细视觉提示",
                },
                {
                    "label": "交给 Agent",
                    "command": "让 Pi 基于这个屏幕对象识别内容、判断当前阻塞并给出可执行下一步",
                },
                {
                    "label": "识别并复制",
                    "command": "识别这个屏幕对象中的文字并复制",
                },
            ]
        return []
    app = str(summary.get("app") or "")
    if summary.get("canRewrite"):
        if app == "powerpoint":
            return [
                {"label": "改写并写回", "command": "改写这段内容并写回当前位置"},
                {"label": "交给 Agent", "command": "让 Pi 处理这个并统一当前页面"},
                {"label": "保存证据卡", "command": "把这段和来源保存成证据卡"},
            ]
        return [
            {"label": "原位改写", "command": "改写这段内容并写回当前位置"},
            {"label": "翻译并写回", "command": "翻译成英文并写回当前位置"},
            {"label": "交给 Agent", "command": "让 Pi 处理这个"},
        ]
    if app == "excel":
        return [
            {"label": "导出 CSV", "command": "把这个表格导出 CSV"},
            {"label": "后台查异常", "command": "交给 Pi 在后台处理并检查异常"},
            {"label": "保存证据卡", "command": "把这块表格和来源保存成证据卡"},
        ]
    return [
        {"label": "保存证据卡", "command": "把这段和来源保存成证据卡"},
        {"label": "交给 Agent", "command": "让 Pi 处理这个"},
        {"label": "复制原文", "command": "复制这段文字"},
    ]


def _normalized_point(target_point: Any | None) -> dict[str, int] | None:
    if isinstance(target_point, dict):
        return {
            "x": int(target_point.get("x") or 0),
            "y": int(target_point.get("y") or 0),
        }
    if isinstance(target_point, (list, tuple)) and len(target_point) == 2:
        return {"x": int(target_point[0]), "y": int(target_point[1])}
    return None


def _visual_bbox(
    target_window: dict[str, Any] | None,
    target_point: dict[str, int] | None,
) -> tuple[int, int, int, int] | None:
    if target_window is None or target_point is None:
        return None
    raw = target_window.get("bbox")
    if not isinstance(raw, (list, tuple)) or len(raw) != 4:
        return None
    try:
        left, top, right, bottom = (int(value) for value in raw)
    except (TypeError, ValueError):
        return None
    x, y = target_point["x"], target_point["y"]
    if right - left < 32 or bottom - top < 32 or not (left <= x < right and top <= y < bottom):
        return None
    width = min(VISUAL_REGION_WIDTH, right - left)
    height = min(VISUAL_REGION_HEIGHT, bottom - top)
    capture_left = max(left, min(x - width // 2, right - width))
    capture_top = max(top, min(y - height // 2, bottom - height))
    return (capture_left, capture_top, capture_left + width, capture_top + height)


def _is_sensitive_target(
    target_window: dict[str, Any] | None,
    *,
    sensitive_apps: list[str] | tuple[str, ...] | None,
    foreground_app: str,
) -> bool:
    window = target_window or {}
    identity = " ".join(
        str(window.get(key) or "")
        for key in ("title", "process_name", "class_name")
    )
    identity = f"{identity} {foreground_app}".casefold()
    return any(str(item).strip().casefold() in identity for item in sensitive_apps or () if str(item).strip())


def _prune_capture_dir(
    capture_dir: Path | str,
    retain_days: int,
    *,
    now: datetime | None = None,
) -> int:
    """Remove only expired Magic Pointer screen captures from one known directory."""
    output_dir = Path(capture_dir).resolve()
    if not output_dir.is_dir():
        return 0
    keep_days = max(0, int(retain_days))
    cutoff = (now or datetime.now(timezone.utc)).timestamp() - (keep_days * 86400)
    removed = 0
    for candidate in output_dir.glob("screen-*.png"):
        try:
            resolved = candidate.resolve()
            if resolved.parent != output_dir or not resolved.is_file():
                continue
            if resolved.stat().st_mtime < cutoff:
                resolved.unlink()
                removed += 1
        except OSError:
            continue
    return removed


def _capture_visual_region(
    target_window: dict[str, Any] | None,
    target_point: dict[str, int] | None,
    *,
    visual_capture: Any | None = None,
    capture_dir: Path | str | None = None,
    retain_days: int = 3,
) -> dict[str, Any] | None:
    bbox = _visual_bbox(target_window, target_point)
    if bbox is None:
        return None
    grabber = visual_capture or ImageGrab.grab
    image = grabber(bbox=bbox, all_screens=True)
    output_dir = Path(capture_dir) if capture_dir is not None else (
        Path(os.environ.get("MAGIC_POINTER_USER_DATA_DIR") or ROOT / "data" / "runtime")
        / "selection-captures"
    )
    output_dir.mkdir(parents=True, exist_ok=True)
    _prune_capture_dir(output_dir, retain_days)
    output = output_dir / f"screen-{uuid.uuid4().hex[:16]}.png"
    temp = output.with_suffix(".png.tmp")
    image.convert("RGB").save(temp, format="PNG")
    os.replace(temp, output)
    return {
        "path": str(output.resolve()),
        "bbox": list(bbox),
        "width": bbox[2] - bbox[0],
        "height": bbox[3] - bbox[1],
    }


def capture_snapshot(
    windows: list[dict[str, Any]] | None = None,
    *,
    registry: Any | None = None,
    target_point: Any | None = None,
    target_point_space: str | None = "physical_screen_pixels",
    active_context: dict[str, Any] | None = None,
    active_review: dict[str, Any] | None = None,
    visual_capture: Any | None = None,
    capture_dir: Path | str | None = None,
    allow_visual_fallback: bool = True,
    sensitive_apps: list[str] | tuple[str, ...] | None = None,
    foreground_app: str = "",
    retain_captures_days: int = 3,
) -> dict[str, Any]:
    captured = datetime.now(timezone.utc)
    target_window, app_ctx = _read_target_context(
        _window_dicts() if windows is None else windows,
        registry=registry,
    )
    summary = _summary_for(target_window, app_ctx)
    context_session = active_context if isinstance(active_context, dict) else None
    summary["hasActiveContext"] = bool(context_session and context_session.get("item_count"))
    summary["activeContextItemCount"] = int((context_session or {}).get("item_count") or 0)
    summary["activeContextWorkflowKind"] = str(
        (context_session or {}).get("workflow_kind") or "context_pack"
    )
    review = active_review if isinstance(active_review, dict) else None
    summary["hasActiveReview"] = bool(review and review.get("anchor_count"))
    summary["activeReviewAnchorCount"] = int((review or {}).get("anchor_count") or 0)
    normalized_target_point = _normalized_point(target_point)
    sensitive_target = _is_sensitive_target(
        target_window,
        sensitive_apps=sensitive_apps,
        foreground_app=foreground_app,
    )
    visual = None
    should_capture_visual = bool(
        allow_visual_fallback
        and not sensitive_target
        and not summary.get("hasContent")
        and not summary["hasActiveContext"]
        and not summary["hasActiveReview"]
    )
    if should_capture_visual:
        try:
            visual = _capture_visual_region(
                target_window,
                normalized_target_point,
                visual_capture=visual_capture,
                capture_dir=capture_dir,
                retain_days=retain_captures_days,
            )
        except (OSError, ValueError, RuntimeError):
            visual = None
    if sensitive_target and not summary.get("hasContent"):
        summary.update({
            "state": "sensitive",
            "label": "敏感应用 · 未截取屏幕",
            "detail": "隐私策略已阻止视觉回退",
            "hasVisual": False,
        })
    elif visual is not None:
        title = str((target_window or {}).get("title") or "当前应用")
        summary.update({
            "state": "ready",
            "label": f"THIS · {title} 屏幕对象",
            "detail": f"已锁定指针附近 {visual['width']} × {visual['height']} 区域 · 仅保存在本机",
            "app": "screen",
            "hasContent": False,
            "hasVisual": True,
            "canRewrite": False,
        })
    else:
        summary["hasVisual"] = False
    source_kind = (
        "screen_region"
        if visual is not None
        else "native_selection"
        if app_ctx is not None and summary["state"] in {"ready", "empty"}
        else "foreground_window"
    )
    visual_context = None
    if visual is not None:
        visual_context = {
            "adapter": "screen_region",
            "app": "screen",
            "window": target_window,
            "content": "",
            "label": summary["label"],
            "method": "pointer:bounded-screen-region",
            "path": visual["path"],
            "artifacts": {
                "capture_path": visual["path"],
                "selection_rectangles": [visual["bbox"]],
            },
            "capabilities": [],
            "error": None,
        }
    snapshot = {
        "snapshot_id": f"selection-{uuid.uuid4().hex[:16]}",
        "captured_at": captured.isoformat(),
        "expires_at": (captured + timedelta(seconds=SNAPSHOT_TTL_SECONDS)).isoformat(),
        "status": summary["state"],
        "source_kind": source_kind,
        "target_point": normalized_target_point,
        "target_point_space": (
            "physical_screen_pixels"
            if normalized_target_point is not None and target_point_space == "physical_screen_pixels"
            else None
        ),
        "source_window": target_window,
        "context": visual_context if visual_context is not None else (
            None if app_ctx is None else app_ctx.to_dict()
        ),
        "capture_path": visual["path"] if visual is not None else None,
        "selection_bbox": visual["bbox"] if visual is not None else None,
    }
    return {
        "ok": True,
        "selectionSnapshot": snapshot,
        "captureSummary": summary,
        "suggestedCommands": _suggested_commands(summary),
    }


def main() -> int:
    payload = read_payload()
    try:
        settings = SettingsStore().load()
    except SettingsError:
        settings = FabricSettings.defaults()
    try:
        active_context = ContextSessionStore().active()
    except ContextSessionError:
        active_context = None
    try:
        active_review = ReviewSessionStore().active()
    except ReviewSessionError:
        active_review = None
    print(json.dumps(capture_snapshot(
        target_point=payload.get("cursor"),
        target_point_space=payload.get("cursorSpace"),
        active_context=active_context,
        active_review=active_review,
        allow_visual_fallback=payload.get("allowVisualFallback") is not False,
        sensitive_apps=settings.privacy.sensitive_apps,
        retain_captures_days=settings.privacy.retain_captures_days,
        foreground_app=str(payload.get("foregroundApp") or ""),
    ), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
