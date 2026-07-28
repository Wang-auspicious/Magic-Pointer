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
from app.fabric.audit import AuditStore
from app.fabric.capture_policy import CapturePolicyEngine
from app.grounding.perception_cascade import (
    append_perception_attempt,
    resolve_structured_perception,
)
from app.review import ReviewSessionError, ReviewSessionStore
from app.fabric.settings import FabricSettings, SettingsError, SettingsStore
from app.system_context import get_foreground_window_handle, list_visible_windows
from app.visual_annotation import make_pointer_annotated_image

MAGIC_WINDOW_TITLES = {"Magic Pointer Overlay", "Magic Pointer Panel"}
SNAPSHOT_TTL_SECONDS = 120
VISUAL_REGION_WIDTH = 640
VISUAL_REGION_HEIGHT = 420


class TargetMismatchError(RuntimeError):
    def __init__(self, attestation: dict[str, Any]) -> None:
        super().__init__("target_mismatch")
        self.attestation = attestation


def _window_identity(window: dict[str, Any] | None) -> dict[str, Any]:
    value = dict(window or {})
    pid = value.get("process_id") or value.get("processId") or value.get("pid") or 0
    desktop_id = value.get("desktop_id") or value.get("desktopId") or value.get("space_id") or value.get("spaceId")
    bbox = value.get("bbox")
    return {
        "hwnd": int(value.get("hwnd") or 0),
        "processId": int(pid or 0),
        "processName": str(value.get("process_name") or value.get("processName") or ""),
        "title": str(value.get("title") or ""),
        "desktopId": str(desktop_id or ""),
        "bbox": list(bbox) if isinstance(bbox, (list, tuple)) and len(bbox) == 4 else None,
    }


def _same_window_identity(expected: dict[str, Any], actual: dict[str, Any]) -> bool:
    for field in ("hwnd", "processId", "processName", "title", "desktopId", "bbox"):
        expected_value = expected.get(field)
        if expected_value not in (None, "", 0) and actual.get(field) != expected_value:
            return False
    return bool(expected.get("hwnd") and expected.get("processId"))


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
    target_point: dict[str, int] | None = None,
) -> tuple[dict[str, Any] | None, Any, dict[str, Any]]:
    target_window = windows[0] if windows else None
    if target_window is None:
        return None, None, {
            "schemaVersion": 1,
            "selectedLayer": None,
            "selectedAdapter": None,
            "selectedMethod": None,
            "pixelFallbackUsed": False,
            "fallbackReason": "foreground_window_unavailable",
            "policyMode": None,
            "attempts": [{
                "layer": "structured",
                "adapter": "registry",
                "method": "none",
                "status": "unavailable",
                "reason": "foreground_window_unavailable",
            }],
        }
    active_registry = registry or default_adapter_registry()
    resolution = resolve_structured_perception(
        target_window,
        active_registry,
        command="",
        target_point=target_point,
    )
    return target_window, resolution.context, resolution.trace


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
    identity_probe: Any | None = None,
) -> dict[str, Any] | None:
    bbox = _visual_bbox(target_window, target_point)
    if bbox is None:
        return None
    expected_identity = _window_identity(target_window)
    before_identity = _window_identity(identity_probe()) if callable(identity_probe) else expected_identity
    if callable(identity_probe) and not _same_window_identity(expected_identity, before_identity):
        raise TargetMismatchError({
            "status": "target_mismatch",
            "phase": "before_capture",
            "expected": expected_identity,
            "before": before_identity,
            "after": None,
        })
    grabber = visual_capture or ImageGrab.grab
    image = grabber(bbox=bbox, all_screens=True)
    after_identity = _window_identity(identity_probe()) if callable(identity_probe) else before_identity
    if callable(identity_probe) and not _same_window_identity(expected_identity, after_identity):
        raise TargetMismatchError({
            "status": "target_mismatch",
            "phase": "after_capture",
            "expected": expected_identity,
            "before": before_identity,
            "after": after_identity,
        })
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
    point = target_point or {"x": (bbox[0] + bbox[2]) // 2, "y": (bbox[1] + bbox[3]) // 2}
    tip = (int(point["x"]), int(point["y"]))
    annotated = output.with_name(f"{output.stem}.pointer.png")
    make_pointer_annotated_image(
        output,
        annotated,
        bbox,
        [(tip[0] - 24, tip[1] - 24), tip],
    )
    return {
        "path": str(output.resolve()),
        "annotated_path": str(annotated.resolve()),
        "bbox": list(bbox),
        "width": bbox[2] - bbox[0],
        "height": bbox[3] - bbox[1],
        "capture_attestation": {
            "status": "verified" if callable(identity_probe) else "unverified",
            "phase": "complete",
            "expected": expected_identity,
            "before": before_identity,
            "after": after_identity,
        },
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
    identity_probe: Any | None = None,
    upload_screenshots: bool | None = None,
    default_capture_mode: str | None = None,
    app_capture_modes: dict[str, str] | None = None,
    audit_store: Any | None = None,
) -> dict[str, Any]:
    captured = datetime.now(timezone.utc)
    live_window_source = windows is None
    available_windows = _window_dicts() if windows is None else windows
    target_window = available_windows[0] if available_windows else None
    normalized_target_point = _normalized_point(target_point)
    capture_decision = None
    if default_capture_mode is not None:
        capture_decision = CapturePolicyEngine(
            upload_screenshots is True,
            default_capture_mode,
            sensitive_apps or (),
            app_capture_modes or {},
        ).decide({
            "id": "foreground-target",
            "kind": "foreground_window",
            "source": {
                "app": foreground_app,
                "processName": str((target_window or {}).get("process_name") or ""),
                "title": str((target_window or {}).get("title") or ""),
            },
        })
    if capture_decision is not None and capture_decision.mode == "deny":
        app_ctx = None
        perception_trace = {
            "schemaVersion": 1,
            "selectedLayer": None,
            "selectedAdapter": None,
            "selectedMethod": None,
            "pixelFallbackUsed": False,
            "fallbackReason": "capture_policy_deny",
            "policyMode": "deny",
            "attempts": [{
                "layer": "structured",
                "adapter": "policy",
                "method": "none",
                "status": "blocked",
                "reason": "capture_policy_deny",
            }],
        }
    else:
        target_window, app_ctx, perception_trace = _read_target_context(
            available_windows,
            registry=registry,
            target_point=normalized_target_point,
        )
        perception_trace["policyMode"] = (
            capture_decision.mode if capture_decision is not None else "unconfigured"
        )
    active_identity_probe = identity_probe
    if active_identity_probe is None and live_window_source:
        def active_identity_probe() -> dict[str, Any]:
            current = _window_dicts()
            return dict(current[0]) if current else {}
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
    sensitive_target = _is_sensitive_target(
        target_window,
        sensitive_apps=sensitive_apps,
        foreground_app=foreground_app,
    )
    visual = None
    capture_attestation = None
    target_mismatch = False
    visual_attempt_recorded = False
    should_capture_visual = bool(
        allow_visual_fallback
        and not sensitive_target
        and (capture_decision is None or capture_decision.allow_local_pixels)
        and not perception_trace.get("selectedLayer")
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
                identity_probe=active_identity_probe,
            )
            capture_attestation = visual.get("capture_attestation") if visual is not None else None
            if visual is not None:
                perception_trace = append_perception_attempt(
                    perception_trace,
                    layer="screen_region",
                    adapter="screen-capture",
                    method="pointer:bounded-screen-region",
                    status="succeeded",
                    reason=str(perception_trace.get("fallbackReason") or "structured_context_unavailable"),
                    select=True,
                    policy_mode=capture_decision.mode if capture_decision is not None else "unconfigured",
                )
            else:
                perception_trace = append_perception_attempt(
                    perception_trace,
                    layer="screen_region",
                    adapter="screen-capture",
                    method="pointer:bounded-screen-region",
                    status="unavailable",
                    reason="capture_geometry_unavailable",
                    policy_mode=capture_decision.mode if capture_decision is not None else "unconfigured",
                )
            visual_attempt_recorded = True
        except TargetMismatchError as exc:
            target_mismatch = True
            capture_attestation = exc.attestation
            visual = None
            perception_trace = append_perception_attempt(
                perception_trace,
                layer="screen_region",
                adapter="screen-capture",
                method="pointer:bounded-screen-region",
                status="error",
                reason="target_mismatch",
                policy_mode=capture_decision.mode if capture_decision is not None else "unconfigured",
            )
            visual_attempt_recorded = True
        except (OSError, ValueError, RuntimeError):
            visual = None
            perception_trace = append_perception_attempt(
                perception_trace,
                layer="screen_region",
                adapter="screen-capture",
                method="pointer:bounded-screen-region",
                status="error",
                reason="local_capture_failed",
                policy_mode=capture_decision.mode if capture_decision is not None else "unconfigured",
            )
            visual_attempt_recorded = True
    if not visual_attempt_recorded:
        if perception_trace.get("selectedLayer"):
            visual_status, visual_reason = "skipped", "structured_context_succeeded"
        elif capture_decision is not None and capture_decision.mode == "deny":
            visual_status, visual_reason = "blocked", "capture_policy_deny"
        elif capture_decision is not None and not capture_decision.allow_local_pixels:
            visual_status, visual_reason = "blocked", f"capture_policy_{capture_decision.mode}"
        elif sensitive_target:
            visual_status, visual_reason = "blocked", "sensitive_app"
        elif not allow_visual_fallback:
            visual_status, visual_reason = "blocked", "visual_fallback_disabled"
        elif summary["hasActiveContext"] or summary["hasActiveReview"]:
            visual_status, visual_reason = "skipped", "existing_context_delivery_target"
        else:
            visual_status, visual_reason = "unavailable", "capture_preconditions_unmet"
        perception_trace = append_perception_attempt(
            perception_trace,
            layer="screen_region",
            adapter="screen-capture",
            method="pointer:bounded-screen-region",
            status=visual_status,
            reason=visual_reason,
            policy_mode=capture_decision.mode if capture_decision is not None else "unconfigured",
        )
    if capture_decision is not None and capture_decision.mode == "deny":
        summary.update({
            "state": "denied",
            "label": "永不捕获",
            "detail": "当前应用的逐应用隐私策略已阻止结构读取、OCR 与截图",
            "hasContent": False,
            "hasVisual": False,
            "canRewrite": False,
        })
    elif target_mismatch:
        summary.update({
            "state": "target_mismatch",
            "label": "目标已变化",
            "detail": "截图前后台窗口、标题或桌面发生变化；未保存或上传任何图像。",
            "hasVisual": False,
        })
    elif (
        capture_decision is not None
        and capture_decision.mode == "structured_only"
        and not summary.get("hasContent")
    ):
        summary.update({
            "state": "structured_only",
            "label": "只读结构",
            "detail": "当前应用仅允许 UIA / AX / DOM；未读取到可用结构，未启用 OCR 或截图",
            "hasVisual": False,
        })
    elif sensitive_target and not summary.get("hasContent"):
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
        if app_ctx is not None and perception_trace.get("selectedLayer")
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
                "annotated_path": visual["annotated_path"],
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
        "annotated_path": visual["annotated_path"] if visual is not None else None,
        "capture_attestation": capture_attestation,
        "capture_policy": capture_decision.to_dict() if capture_decision is not None else None,
        "perception_trace": perception_trace,
        "selection_bbox": visual["bbox"] if visual is not None else None,
    }
    if audit_store is not None:
        try:
            audit_store.append("perception.resolved", {
                "snapshotId": snapshot["snapshot_id"],
                "status": snapshot["status"],
                "sourceKind": snapshot["source_kind"],
                "selectedLayer": perception_trace.get("selectedLayer"),
                "selectedAdapter": perception_trace.get("selectedAdapter"),
                "selectedMethod": perception_trace.get("selectedMethod"),
                "pixelFallbackUsed": perception_trace.get("pixelFallbackUsed") is True,
                "fallbackReason": perception_trace.get("fallbackReason"),
                "policyMode": perception_trace.get("policyMode"),
                "attempts": perception_trace.get("attempts") or [],
            })
            terminal_evidence = (
                (app_ctx.artifacts or {}).get("terminal_evidence")
                if app_ctx is not None
                else None
            )
            if isinstance(terminal_evidence, dict):
                terminal_window = dict(terminal_evidence.get("window") or {})
                audit_store.append("terminal.evidence", {
                    "snapshotId": snapshot["snapshot_id"],
                    "state": str(terminal_evidence.get("state") or ""),
                    "method": str(terminal_evidence.get("method") or "")[:120],
                    "exitCodeObserved": terminal_evidence.get("exitCode") is not None,
                    "exitCode": terminal_evidence.get("exitCode"),
                    "windowLineCount": int(terminal_window.get("lineCount") or 0),
                    "pixelFallbackUsed": False,
                })
            browser_context = (
                (app_ctx.artifacts or {}).get("browser_context")
                if app_ctx is not None
                else None
            )
            if isinstance(browser_context, dict):
                browser_node = dict(browser_context.get("node") or {})
                browser_coordinates = dict(browser_context.get("coordinates") or {})
                audit_store.append("browser.evidence", {
                    "snapshotId": snapshot["snapshot_id"],
                    "state": str(browser_context.get("state") or ""),
                    "method": str(browser_context.get("method") or "")[:120],
                    "selectorObserved": bool(browser_context.get("selector")),
                    "accessibleNameObserved": bool(browser_node.get("accessibleName")),
                    "networkFailureCount": len(browser_context.get("networkFailures") or []),
                    "coordinatesObserved": bool(browser_coordinates.get("pointerScreenPhysical")),
                    "pixelFallbackUsed": False,
                })
        except Exception:
            pass
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
        upload_screenshots=settings.privacy.upload_screenshots,
        default_capture_mode=settings.privacy.default_capture_mode,
        app_capture_modes=settings.privacy.app_capture_modes,
        retain_captures_days=settings.privacy.retain_captures_days,
        foreground_app=str(payload.get("foregroundApp") or ""),
        registry=default_adapter_registry(
            browser_devtools_enabled=settings.connections.browser_devtools_enabled,
            browser_devtools_endpoints=settings.connections.browser_devtools_endpoints,
        ),
        audit_store=AuditStore(),
    ), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
