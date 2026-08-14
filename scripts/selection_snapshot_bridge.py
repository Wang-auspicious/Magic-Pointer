from __future__ import annotations

import json
import math
import os
import sys
import time
import uuid
import ctypes
import hashlib
from dataclasses import replace as replace_dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from PIL import Image, ImageGrab

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
from app.grounding.evidence_binding import (
    EvidenceBindingError,
    bind_frozen_evidence,
)
from app.grounding.explorer_adapter import score_item_against_stroke
from app.grounding.explorer_context import read_explorer_file_context
from app.grounding.marked_read import rect_is_container, structured_read_covers_mark
from app.review import ReviewSessionError, ReviewSessionStore
from app.fabric.settings import FabricSettings, SettingsError, SettingsStore
from scripts.bridge_progress import PhaseClock
from scripts.frame_lease import FrameLeaseError, normalize_frame_lease
from app.system_context import enable_dpi_awareness, get_foreground_window_handle, list_visible_windows
from app.visual_annotation import make_pointer_annotated_image
from scripts._bridge_common import PayloadTooLargeError, read_bounded_json_payload

enable_dpi_awareness()

MAGIC_WINDOW_TITLES = {"Magic Pointer Overlay", "Magic Pointer Panel", "Magic Pointer Stage"}
SNAPSHOT_TTL_SECONDS = 120
VISUAL_REGION_WIDTH = 640
VISUAL_REGION_HEIGHT = 420
POINTER_ANCHOR_SIZE = 16
GESTURE_CAPTURE_PADDING_X = 96
GESTURE_CAPTURE_PADDING_Y = 64
GESTURE_CAPTURE_MIN_WIDTH = 320
GESTURE_CAPTURE_MIN_HEIGHT = 180
GESTURE_CAPTURE_MAX_WIDTH = 1280
GESTURE_CAPTURE_MAX_HEIGHT = 800


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


# What makes a window *that* window. A handle plus the process behind it, and the
# virtual desktop it lives on, because the same hwnd on another desktop is not
# something the user is looking at.
#
# Title and bbox are deliberately absent. They are state, not identity: WeChat
# retitles on an incoming message, a terminal retitles on every command, a window
# animates when it is restored. Treating those as identity changes aborted the
# capture — and for apps that expose nothing to UI Automation, the capture is the
# only way to read anything at all, so a retitle was taking the feature down. Every
# test written for this guard changes hwnd or desktop_id, which is its real intent.
IDENTITY_FIELDS = ("hwnd", "processId", "processName", "desktopId")


def _same_window_identity(expected: dict[str, Any], actual: dict[str, Any]) -> bool:
    for field in IDENTITY_FIELDS:
        expected_value = expected.get(field)
        if expected_value not in (None, "", 0) and actual.get(field) != expected_value:
            return False
    return bool(expected.get("hwnd") and expected.get("processId"))


def _same_window_geometry(expected: dict[str, Any], actual: dict[str, Any]) -> bool:
    """Are the window's pixels still where we thought they were?

    Separate from identity because the answer calls for something different: a
    window that moved is still the right window, it just needs grabbing again at
    its new position. Adapters that report no geometry are not "moved".
    """
    before, after = expected.get("bbox"), actual.get("bbox")
    if not before or not after:
        return True
    return list(before) == list(after)


def read_payload() -> dict[str, Any]:
    # Bounded like every other bridge: an oversized payload (a corrupt gesture,
    # a malicious caller) must be rejected, not buffered without limit.
    return read_bounded_json_payload()


def _window_dicts(
    preferred_hwnd: int = 0,
    target_point: dict[str, int] | None = None,
) -> list[dict[str, Any]]:
    windows: list[dict[str, Any]] = []
    for item in list_visible_windows():
        title = str(item.get("title") or "")
        if title in MAGIC_WINDOW_TITLES:
            continue
        windows.append(dict(item))
    # A foreground HWND captured at gesture start is a committed identity.  It
    # must outrank point containment: every maximized window contains the same
    # coordinates, and enumeration order is not z-order.  Point geometry is only
    # a fallback for callers that could not lock a window.
    requested_hwnd = int(preferred_hwnd or 0)
    if requested_hwnd:
        requested = next(
            (item for item in windows if int(item.get("hwnd") or 0) == requested_hwnd),
            None,
        )
        if requested is not None:
            return [requested]
    if target_point is not None:
        x, y = int(target_point["x"]), int(target_point["y"])
        pointed = next((
            item for item in windows
            if isinstance(item.get("bbox"), (list, tuple))
            and len(item["bbox"]) == 4
            and int(item["bbox"][0]) <= x < int(item["bbox"][2])
            and int(item["bbox"][1]) <= y < int(item["bbox"][3])
        ), None)
        if pointed is not None:
            return [pointed]
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
    target_region: dict[str, int] | None = None,
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
        target_region=target_region,
    )
    return target_window, resolution.context, resolution.trace


def _has_capability(app_ctx: Any, name: str) -> bool:
    if app_ctx is None:
        return False
    return any(cap.name == name and cap.enabled for cap in app_ctx.capabilities)


def _surface_attempt_is_signal(attempt: dict[str, Any]) -> bool:
    """True when the surface attempt carries information worth keeping."""
    if str(attempt.get("status") or "") == "error":
        return True
    return str(attempt.get("reason") or "") != "no_adapter_claims_window"


def _surface_adapter_attempt(
    windows: list[dict[str, Any]],
    gesture: dict[str, Any] | None,
    fallback_point: dict[str, int] | None,
):
    """SurfaceAdapter chain (design §8): first claiming adapter wins.

    Returns ``(AdapterReadContext | None, attempt | None)``. Text-bearing
    resolutions become the structured context; anchor-only resolutions
    (opaque trees) return ``(None, attempt)`` so the generic chain still
    runs and the attempt is recorded in the perception trace.
    """
    from app.adapters.base import AdapterReadContext
    from app.harness.builtin_bundle import boot_surface_context

    target = windows[0] if windows else None
    if not isinstance(target, dict) or not target.get("hwnd"):
        return None, None
    report = None
    try:
        report = boot_surface_context(root=ROOT)
        result = report.ctx.get("surface_adapters").try_resolve(
            dict(target), target_point=fallback_point, target_region=None
        )
    except Exception as exc:
        return None, {
            "layer": "surface_adapter",
            "adapter": "registry",
            "method": "matches",
            "status": "error",
            "reason": f"registry_error:{type(exc).__name__}",
        }
    finally:
        if report is not None:
            report.ctx.unload()
    if result is None:
        return None, {
            "layer": "surface_adapter",
            "adapter": "none",
            "method": "matches",
            "status": "empty",
            "reason": "no_adapter_claims_window",
        }
    if not result.objects:
        return None, {
            "layer": "surface_adapter",
            "adapter": result.adapter_id,
            "method": "resolve",
            "status": "empty",
            "reason": "adapter_claimed_but_empty",
        }
    text_objects = [obj for obj in result.objects if obj.text.strip()]
    if not text_objects:
        return None, {
            "layer": "surface_adapter",
            "adapter": result.adapter_id,
            "method": "resolve",
            "status": "empty",
            "reason": "opaque_surface_anchor_only",
        }
    content = "\n\n".join(f"[{obj.label}] {obj.text}" for obj in text_objects)
    ctx = AdapterReadContext(
        adapter=f"surface:{result.adapter_id}",
        app=str(result.adapter_id),
        window=dict(target),
        content=content,
        label=str(result.adapter_id),
        method="surface_adapter",
        artifacts={
            "surface_objects": [obj.to_dict() for obj in result.objects],
            "surface_adapter_id": result.adapter_id,
            "surface_notes": list(result.notes),
        },
    )
    return ctx, None


def _surface_adapter_trace(ctx) -> dict[str, Any]:
    return {
        "schemaVersion": 1,
        "selectedLayer": "surface_adapter",
        "selectedAdapter": str(ctx.adapter).removeprefix("surface:"),
        "selectedMethod": "resolve",
        "pixelFallbackUsed": False,
        "fallbackReason": None,
        "attempts": [{
            "layer": "surface_adapter",
            "adapter": str(ctx.adapter).removeprefix("surface:"),
            "method": "resolve",
            "status": "ok",
            "reason": "surface_adapter_objects",
        }],
    }


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
        "explorer": "文件资源管理器",
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


def _normalized_gesture(value: Any | None) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None

    def point(raw: Any) -> dict[str, int] | None:
        if not isinstance(raw, dict):
            return None
        try:
            x = float(raw.get("x"))
            y = float(raw.get("y"))
            t = float(raw.get("t", 0))
        except (TypeError, ValueError):
            return None
        if not all(math.isfinite(item) for item in (x, y, t)):
            return None
        return {"x": round(x), "y": round(y), "t": round(t)}

    raw_strokes = value.get("strokes") if isinstance(value.get("strokes"), list) else None
    if raw_strokes:
        strokes = []
        remaining = 512
        for raw_stroke in raw_strokes[:8]:
            raw_points = raw_stroke.get("points") if isinstance(raw_stroke, dict) else None
            stroke_points = [
                item for item in (point(raw) for raw in list(raw_points or [])[:remaining]) if item
            ]
            remaining -= len(stroke_points)
            if len(stroke_points) >= 2:
                strokes.append({"points": stroke_points})
            if remaining <= 0:
                break
        points = [item for stroke in strokes for item in stroke["points"]]
    else:
        points = [item for item in (point(raw) for raw in list(value.get("points") or [])[:512]) if item]
        strokes = [{"points": points}] if len(points) >= 2 else []
    if len(points) < 2:
        return None
    release = point(value.get("releasePoint"))
    raw_bbox = value.get("bbox") if isinstance(value.get("bbox"), dict) else {}
    try:
        bbox = {
            "x": round(float(raw_bbox.get("x"))),
            "y": round(float(raw_bbox.get("y"))),
            "width": max(0, round(float(raw_bbox.get("width")))),
            "height": max(0, round(float(raw_bbox.get("height")))),
        }
    except (TypeError, ValueError):
        bbox = None
    if release is None:
        release = dict(points[-1])
    if bbox is None:
        xs = [item["x"] for item in points]
        ys = [item["y"] for item in points]
        bbox = {
            "x": min(xs), "y": min(ys),
            "width": max(xs) - min(xs), "height": max(ys) - min(ys),
        }
    # A line is a physical stroke corridor, not a zero-area mathematical
    # segment. External callers and perfectly steady automation can still send
    # a 0px axis even though Electron normally expands by 8 DIPs × display DPI.
    # Keep the corridor centered so grounding, capture and OCR share one scope.
    minimum_thickness = 8
    if bbox["width"] < minimum_thickness:
        center_x = bbox["x"] + bbox["width"] / 2
        bbox["x"] = round(center_x - minimum_thickness / 2)
        bbox["width"] = minimum_thickness
    if bbox["height"] < minimum_thickness:
        center_y = bbox["y"] + bbox["height"] / 2
        bbox["y"] = round(center_y - minimum_thickness / 2)
        bbox["height"] = minimum_thickness
    if release is None or bbox is None:
        return None
    release.pop("t", None)
    semantic = point(value.get("semanticPoint"))
    if semantic is not None:
        semantic.pop("t", None)
    if raw_strokes or int(value.get("schemaVersion") or 0) == 2:
        return {
            "schemaVersion": 2,
            "coordinateSpace": str(value.get("coordinateSpace") or "physical_screen_pixels")[:64],
            "kind": str(value.get("kind") or "freeform")[:32],
            "semanticPoint": semantic,
            "releasePoint": release,
            "bbox": bbox,
            "strokes": strokes,
        }
    if semantic is None:
        return None
    return {
        "kind": str(value.get("kind") or "freeform")[:32],
        "coordinateSpace": str(value.get("coordinateSpace") or "electron_dip_screen")[:64],
        "releasePoint": release,
        "semanticPoint": semantic,
        "bbox": bbox,
        "points": points,
    }


def _gesture_points(gesture: dict[str, Any] | None) -> list[tuple[int, int]]:
    if not isinstance(gesture, dict):
        return []
    strokes = gesture.get("strokes") if isinstance(gesture.get("strokes"), list) else []
    return [
        (int(point["x"]), int(point["y"]))
        for stroke in strokes
        if isinstance(stroke, dict)
        for point in list(stroke.get("points") or [])
        if isinstance(point, dict) and "x" in point and "y" in point
    ]


# Wall-clock ceiling for the per-sample fallback cascade. Measured 2026-08-04:
# one cascade costs 0.3-3.7s depending on the window (Chromium's devtools
# adapter alone is ~2.1s), so nine in series can reach 13s. 3.5s buys the first
# two or three samples on a slow window and all nine on a fast one, and the
# capsule stays usable either way. Always attempts at least one sample.
GESTURE_SAMPLE_BUDGET_S = 3.5


def _sample_gesture_points(points: list[tuple[int, int]], limit: int = 9) -> list[dict[str, int]]:
    if len(points) <= limit:
        selected = points
    else:
        selected = [points[round(index * (len(points) - 1) / (limit - 1))] for index in range(limit)]
    deduplicated: list[dict[str, int]] = []
    for x, y in selected:
        value = {"x": int(x), "y": int(y)}
        if not deduplicated or deduplicated[-1] != value:
            deduplicated.append(value)
    return deduplicated


def _is_enclosed_gesture(gesture: dict[str, Any] | None, points: list[tuple[int, int]]) -> bool:
    if not isinstance(gesture, dict) or len(points) < 5:
        return False
    strokes = gesture.get("strokes") if isinstance(gesture.get("strokes"), list) else []
    if len(strokes) != 1:
        return False
    raw_bbox = gesture.get("bbox") if isinstance(gesture.get("bbox"), dict) else {}
    try:
        width = float(raw_bbox.get("width") or 0)
        height = float(raw_bbox.get("height") or 0)
    except (TypeError, ValueError):
        return False
    if width < 28 or height < 28:
        return False
    closure_tolerance = max(30.0, min(width, height) * 0.70)
    required_area = width * height * 0.18
    best_loop_area = 0.0
    # A user often finishes a lasso with a short exit stroke. Look for the
    # largest near-closed subpath instead of requiring the whole stroke's last
    # point to return to its first point.
    for start in range(0, len(points) - 4):
        for end in range(start + 4, len(points)):
            closure_distance = math.hypot(
                points[end][0] - points[start][0],
                points[end][1] - points[start][1],
            )
            if closure_distance > closure_tolerance:
                continue
            loop = points[start:end + 1]
            loop_width = max(point[0] for point in loop) - min(point[0] for point in loop)
            loop_height = max(point[1] for point in loop) - min(point[1] for point in loop)
            if loop_width < 20 or loop_height < 20:
                continue
            perimeter = sum(
                math.hypot(loop[index][0] - loop[index - 1][0], loop[index][1] - loop[index - 1][1])
                for index in range(1, len(loop))
            )
            if perimeter < 0.42 * 2.0 * (loop_width + loop_height):
                continue
            polygon_area = abs(sum(
                loop[index][0] * loop[index + 1][1]
                - loop[index + 1][0] * loop[index][1]
                for index in range(len(loop) - 1)
            )) / 2.0
            best_loop_area = max(best_loop_area, polygon_area)
    return best_loop_area >= required_area


def _union_xywh(rectangles: list[list[int]]) -> list[int] | None:
    if not rectangles:
        return None
    left = min(rect[0] for rect in rectangles)
    top = min(rect[1] for rect in rectangles)
    right = max(rect[0] + rect[2] for rect in rectangles)
    bottom = max(rect[1] + rect[3] for rect in rectangles)
    return [left, top, right - left, bottom - top]


def _context_rectangles(context: Any) -> list[list[int]]:
    artifacts = dict(getattr(context, "artifacts", {}) or {})
    raw_rectangles = artifacts.get("selection_rectangles") or artifacts.get("rectangles") or []
    fmt = str(artifacts.get("selection_rectangles_format") or "xywh")
    result: list[list[int]] = []
    for raw in list(raw_rectangles)[:32]:
        if not isinstance(raw, (list, tuple)) or len(raw) != 4:
            continue
        try:
            left, top, third, fourth = (int(round(float(value))) for value in raw)
        except (TypeError, ValueError):
            continue
        if fmt == "ltrb":
            width, height = third - left, fourth - top
        else:
            width, height = third, fourth
        if width > 0 and height > 0:
            result.append([left, top, width, height])
    return result


def _gesture_mark_bbox(gesture: dict[str, Any] | None) -> list[int] | None:
    """The bounding box of the mark the user actually drew, in screen pixels.

    Deliberately the gesture's *own* box rather than whatever the grounding step
    settled on: this is the yardstick a structured read is measured against, and
    measuring it against a box the same read produced would prove nothing.
    """
    raw = dict((gesture or {}).get("bbox") or {}) if isinstance(gesture, dict) else {}
    try:
        x = int(raw.get("x") or 0)
        y = int(raw.get("y") or 0)
        width = max(0, int(raw.get("width") or 0))
        height = max(0, int(raw.get("height") or 0))
        if width <= 0 and height <= 0:
            return None
        geometry = dict((gesture or {}).get("geometry") or {})
        corridor = max(8, min(64, int(round(float(geometry.get("widthPx") or 16)))))
        # A mouse can produce a perfectly horizontal/vertical line. Its raw
        # min/max box then has one zero dimension, but it is still a real mark,
        # not a point click. Preserve the line's visual corridor so capture,
        # OCR and the stage all keep gesture-region semantics.
        if width <= 0:
            x -= corridor // 2
            width = corridor
        if height <= 0:
            y -= corridor // 2
            height = corridor
        return [x, y, width, height]
    except (TypeError, ValueError):
        return None


def _bounded_gesture_capture_bbox(
    gesture: dict[str, Any] | None,
    target_window: dict[str, Any] | None,
    screen_bbox: tuple[int, int, int, int] | None,
) -> tuple[int, int, int, int] | None:
    """Build a small evidence frame around the mark, never the whole desktop.

    The gesture is the user's scope contract.  A little surrounding context is
    useful for labels and line height, but unrelated windows and distant rows
    are neither useful nor safe to send to OCR or a model.
    """
    mark = _gesture_mark_bbox(gesture)
    if mark is None:
        return None
    x, y, width, height = mark
    bounds = screen_bbox
    raw_window = (target_window or {}).get("bbox")
    if isinstance(raw_window, (list, tuple)) and len(raw_window) == 4:
        try:
            window_bounds = tuple(int(value) for value in raw_window)
        except (TypeError, ValueError):
            window_bounds = None
        if window_bounds is not None:
            if bounds is None:
                bounds = window_bounds
            else:
                bounds = (
                    max(bounds[0], window_bounds[0]),
                    max(bounds[1], window_bounds[1]),
                    min(bounds[2], window_bounds[2]),
                    min(bounds[3], window_bounds[3]),
                )
    if bounds is None or bounds[2] <= bounds[0] or bounds[3] <= bounds[1]:
        return None

    desired_width = min(
        GESTURE_CAPTURE_MAX_WIDTH,
        max(GESTURE_CAPTURE_MIN_WIDTH, width + 2 * GESTURE_CAPTURE_PADDING_X),
        bounds[2] - bounds[0],
    )
    desired_height = min(
        GESTURE_CAPTURE_MAX_HEIGHT,
        max(GESTURE_CAPTURE_MIN_HEIGHT, height + 2 * GESTURE_CAPTURE_PADDING_Y),
        bounds[3] - bounds[1],
    )
    center_x = x + width / 2
    center_y = y + height / 2
    left = round(center_x - desired_width / 2)
    top = round(center_y - desired_height / 2)
    left = max(bounds[0], min(left, bounds[2] - desired_width))
    top = max(bounds[1], min(top, bounds[3] - desired_height))
    return left, top, left + desired_width, top + desired_height


def _gesture_strokes(gesture: dict[str, Any] | None) -> list[list[tuple[int, int]]]:
    """Independent stroke polylines in physical screen pixels."""
    if not isinstance(gesture, dict):
        return []
    strokes: list[list[tuple[int, int]]] = []
    for stroke in list(gesture.get("strokes") or [])[:8]:
        raw_points = list(stroke.get("points") or []) if isinstance(stroke, dict) else []
        points: list[tuple[int, int]] = []
        for raw in raw_points[:256]:
            if not isinstance(raw, dict):
                continue
            try:
                points.append((int(round(float(raw.get("x")))), int(round(float(raw.get("y"))))))
            except (TypeError, ValueError):
                continue
        if len(points) >= 2:
            strokes.append(points)
    return strokes


def _segment_hits_rect(
    ax: float,
    ay: float,
    bx: float,
    by: float,
    left: float,
    top: float,
    right: float,
    bottom: float,
) -> bool:
    """True when segment [a,b] intersects the axis-aligned rect (Liang-Barsky)."""

    def inside(x: float, y: float) -> bool:
        return left <= x <= right and top <= y <= bottom

    if inside(ax, ay) or inside(bx, by):
        return True
    dx, dy = bx - ax, by - ay
    if dx == 0 and dy == 0:
        return False
    p = [-dx, dx, -dy, dy]
    q = [ax - left, right - ax, ay - top, bottom - ay]
    u1, u2 = 0.0, 1.0
    for pi, qi in zip(p, q):
        if pi == 0:
            if qi < 0:
                return False
        else:
            ratio = qi / pi
            if pi < 0:
                if ratio > u2:
                    return False
                if ratio > u1:
                    u1 = ratio
            else:
                if ratio < u1:
                    return False
                if ratio < u2:
                    u2 = ratio
    return True


def _polyline_hits_rect(
    points: list[tuple[int, int]],
    rect_xywh: list[int] | tuple[int, int, int, int],
    tolerance: float = 6.0,
) -> bool:
    """True when any stroke segment crosses (or tightly covers) the rect."""
    if not points or len(rect_xywh) != 4:
        return False
    try:
        rx, ry, rw, rh = (float(value) for value in rect_xywh)
    except (TypeError, ValueError):
        return False
    if rw <= 0 or rh <= 0:
        return False
    left, top = rx - tolerance, ry - tolerance
    right, bottom = rx + rw + tolerance, ry + rh + tolerance
    for index in range(len(points) - 1):
        ax, ay = points[index]
        bx, by = points[index + 1]
        if _segment_hits_rect(ax, ay, bx, by, left, top, right, bottom):
            return True
    return False


def _select_region_elements_by_strokes(
    region_elements: list[dict[str, Any]],
    strokes: list[list[tuple[int, int]]],
    *,
    tolerance: float = 6.0,
) -> tuple[list[dict[str, Any]], list[list[int]]]:
    """Keep only elements actually crossed by a stroke.

    Returns (selected_elements, segments) where each segment is the union
    rectangle of the elements hit by one stroke. Multi-stroke selections stay
    separate instead of collapsing into one big bounding box.
    """
    if not strokes:
        return [], []
    selected: list[dict[str, Any]] = []
    seen: set[str] = set()
    segments: list[list[int]] = []
    for stroke in strokes:
        stroke_rects: list[list[int]] = []
        for element in list(region_elements or [])[:64]:
            if not isinstance(element, dict):
                continue
            rect = element.get("rect")
            if not isinstance(rect, (list, tuple)) or len(rect) != 4:
                continue
            if not _polyline_hits_rect(stroke, list(rect), tolerance=tolerance):
                continue
            key = json.dumps(element, ensure_ascii=False, sort_keys=True)
            if key not in seen:
                seen.add(key)
                selected.append(element)
            stroke_rects.append([int(round(float(value))) for value in rect])
        if stroke_rects:
            merged = _union_xywh(stroke_rects)
            if merged is not None and merged not in segments:
                segments.append(merged)
    return selected, segments


def _region_context_selected(
    region_context: Any,
    selected: list[dict[str, Any]],
    segments: list[list[int]],
) -> Any:
    """Rebuild a region context limited to stroke-selected elements."""
    texts = [
        str(element.get("text") or "").strip()
        for element in selected
        if str(element.get("text") or "").strip()
    ]
    if segments and len(segments) > 1:
        content = "\n".join(
            f"[segment {index}] {text}"
            for index, text in enumerate(texts, 1)
        )
    else:
        content = "\n".join(texts)
    rects = [
        [int(round(float(value))) for value in element["rect"]]
        for element in selected
        if isinstance(element.get("rect"), (list, tuple)) and len(element.get("rect")) == 4
    ]
    artifacts = dict(getattr(region_context, "artifacts", {}) or {})
    region_elements = list(artifacts.get("region_elements") or [])
    artifacts.update({
        "selection_rectangles": rects,
        "region_elements": selected,
        "region_elements_total": len(region_elements),
        "region_elements_selected": len(selected),
        "selection_segments": segments,
    })
    return replace_dataclass(region_context, content=content, artifacts=artifacts)


def _gesture_context_key(context: Any) -> str:
    rectangles = _context_rectangles(context)
    artifacts = dict(getattr(context, "artifacts", {}) or {})
    browser = artifacts.get("browser_context") if isinstance(artifacts.get("browser_context"), dict) else {}
    return json.dumps({
        "adapter": str(getattr(context, "adapter", "") or ""),
        "method": str(getattr(context, "method", "") or ""),
        "content": str(getattr(context, "content", "") or "")[:4000],
        "label": str(getattr(context, "label", "") or "")[:1000],
        "selector": str(browser.get("selector") or "")[:1000],
        "rectangles": rectangles,
    }, ensure_ascii=False, sort_keys=True)


def _read_gesture_target_context(
    windows: list[dict[str, Any]],
    *,
    registry: Any | None,
    gesture: dict[str, Any] | None,
    fallback_point: dict[str, int] | None,
) -> tuple[dict[str, Any] | None, Any, dict[str, Any], dict[str, Any] | None, list[int] | None]:
    points = _gesture_points(gesture)
    if not points or str((gesture or {}).get("coordinateSpace") or "") != "physical_screen_pixels":
        window, context, trace = _read_target_context(windows, registry=registry, target_point=fallback_point)
        return window, context, trace, None, None

    raw_bbox = dict((gesture or {}).get("bbox") or {})
    target_region = {
        "x": int(raw_bbox.get("x") or 0),
        "y": int(raw_bbox.get("y") or 0),
        "width": max(0, int(raw_bbox.get("width") or 0)),
        "height": max(0, int(raw_bbox.get("height") or 0)),
    }
    if target_region["width"] >= 8 and target_region["height"] >= 8:
        semantic = (gesture or {}).get("semanticPoint")
        region_window, region_context, region_trace = _read_target_context(
            windows,
            registry=registry,
            target_point=semantic if isinstance(semantic, dict) else fallback_point,
            target_region=target_region,
        )
        region_artifacts = dict(getattr(region_context, "artifacts", {}) or {})
        region_rectangles = _context_rectangles(region_context) if region_context is not None else []
        region_bbox = _union_xywh(region_rectangles)
        mark_bbox = _gesture_mark_bbox(gesture)
        region_attempts = [
            item for item in list(region_trace.get("attempts") or [])
            if isinstance(item, dict)
        ]
        if (
            not region_trace.get("selectedLayer")
            and region_attempts
            and all(str(item.get("status") or "") == "error" for item in region_attempts)
        ):
            # A bounded read already exercised the complete adapter cascade and
            # every provider failed. Repeating that same expensive failure at
            # each point on the stroke cannot reveal a semantic candidate; it
            # only multiplies a 1-3s provider timeout. Preserve the real error
            # trace once and hand the literal stroke to the pixel fallback.
            return region_window, region_context, region_trace, {
                "schemaVersion": 1,
                "state": "unresolved",
                "mode": "stroke_region",
                "candidate_count": 0,
                "sample_count": 0,
                "reason": "structured_region_hard_failure",
            }, mark_bbox
        if (
            region_context is not None
            and region_trace.get("selectedLayer")
            and region_artifacts.get("perception_result_kind") == "terminal_buffer"
            and region_rectangles
        ):
            coverage = structured_read_covers_mark(
                content=str(getattr(region_context, "content", "") or ""),
                window=region_window,
                element_rects=region_rectangles,
                mark_bbox=mark_bbox,
            )
            if coverage.covers:
                # Windows Terminal's TextPattern gives us the exact anchored
                # line in one bounded region probe. Sampling the same line at
                # several more points only repeats an expensive COM/UIA round
                # trip. Keep the user's literal stroke as the public geometry:
                # the terminal provider commonly reports the entire 2000px row
                # even when the person underlined a short phrase.
                return region_window, region_context, region_trace, {
                    "schemaVersion": 1,
                    "state": "resolved",
                    "mode": "terminal_line",
                    "candidate_count": 1,
                    "sample_count": 0,
                    "score": 1.0,
                    "margin": 1.0,
                    "reason": coverage.reason,
                }, mark_bbox
        if (
            region_context is not None
            and region_trace.get("selectedLayer")
            and region_rectangles
            and rect_is_container(region_bbox, window=region_window, mark_bbox=mark_bbox)
        ):
            # Point-sampling the same document-sized UIA container four more
            # times cannot discover line geometry that the provider does not
            # expose. Stop after the bounded region probe and let pixels read
            # the literal mark instead of spending the whole gesture budget.
            return region_window, region_context, region_trace, {
                "schemaVersion": 1,
                "state": "unresolved",
                "mode": "stroke_region",
                "candidate_count": 1,
                "sample_count": 0,
                "reason": "structured_container_only",
            }, mark_bbox
        if (
            region_context is not None
            and region_trace.get("selectedLayer")
            and region_artifacts.get("perception_result_kind") == "region_elements"
            and region_rectangles
        ):
            mode = "enclosed_region" if _is_enclosed_gesture(gesture, points) else "stroke_region"
            grounding = {
                "schemaVersion": 1,
                "state": "resolved",
                "mode": mode,
                "sample_count": 0,
                "score": 1.0,
                "margin": 1.0,
            }
            # Open strokes are underline/strike-through semantics: only the
            # elements the line actually crosses (or tightly covers) count,
            # and independent strokes stay independent multi-segments.
            if mode == "stroke_region":
                selected, segments = _select_region_elements_by_strokes(
                    list(region_artifacts.get("region_elements") or []),
                    _gesture_strokes(gesture),
                )
                if selected:
                    resolved_context = _region_context_selected(region_context, selected, segments)
                    grounding.update({
                        "candidate_count": len(selected),
                        "segment_count": len(segments),
                        "segments": segments,
                    })
                    resolved_bbox = _union_xywh(_context_rectangles(resolved_context))
                    mark_bbox = _gesture_mark_bbox(gesture)
                    # A container element is crossed by every stroke drawn inside
                    # it, so "crossed" alone does not mean "chosen". Reporting the
                    # whole console as the selection is how a 1175×30 underline
                    # became a 2346×1142 selection on 2026-08-04.
                    if rect_is_container(resolved_bbox, window=region_window, mark_bbox=mark_bbox):
                        grounding.update({
                            "state": "unresolved",
                            "reason": "only_container_elements_crossed",
                        })
                        resolved_bbox = mark_bbox
                    return (
                        region_window,
                        resolved_context,
                        region_trace,
                        grounding,
                        resolved_bbox,
                    )
                # The line crossed nothing the structured layer knows about. That
                # is a real outcome, not a reason to hand back everything in the
                # region: widening a 1175×30 underline to the whole 2346×1142
                # console both loses the user's intent and makes a failed read
                # look like a resolved one. Keep the mark as drawn and let the
                # pixel layer answer for it.
                grounding.update({
                    "state": "unresolved",
                    "candidate_count": 0,
                    "segment_count": 0,
                    "reason": "stroke_crossed_no_element",
                })
                return (
                    region_window,
                    region_context,
                    region_trace,
                    grounding,
                    _gesture_mark_bbox(gesture),
                )
            grounding["candidate_count"] = len(list(region_artifacts.get("region_elements") or []))
            return region_window, region_context, region_trace, grounding, _union_xywh(region_rectangles)

    sampled = _sample_gesture_points(points)
    candidates: dict[str, dict[str, Any]] = {}
    target_window = windows[0] if windows else None
    # Each sample is a full adapter cascade, and a cascade against a slow
    # automation provider costs 0.3-3s. Nine of them in series is how a
    # first-run read reached 12.9 seconds on 2026-08-04 — long enough that the
    # user was told their selection had failed while it was still working.
    #
    # The budget is the honest fix: sample until we have enough agreeing
    # candidates or the clock runs out, and report how far we got. Stopping
    # early costs precision on the hardest windows; spending 13s costs the
    # user the feature.
    deadline = time.monotonic() + GESTURE_SAMPLE_BUDGET_S
    samples_attempted = 0
    unresolved_trace: dict[str, Any] = {
        "schemaVersion": 1,
        "selectedLayer": None,
        "selectedAdapter": None,
        "selectedMethod": None,
        "pixelFallbackUsed": False,
        "fallbackReason": "gesture_no_bounded_candidate",
        "policyMode": None,
        "attempts": [],
    }
    for sample in sampled:
        if samples_attempted and time.monotonic() >= deadline:
            unresolved_trace["sampleBudgetExhausted"] = True
            break
        samples_attempted += 1
        window, context, trace = _read_target_context(windows, registry=registry, target_point=sample)
        if window is not None:
            target_window = window
        unresolved_trace["attempts"].extend(list(trace.get("attempts") or [])[:2])
        rectangles = _context_rectangles(context) if context is not None else []
        if context is None or not trace.get("selectedLayer") or not rectangles:
            continue
        key = _gesture_context_key(context)
        candidate = candidates.setdefault(key, {
            "context": context,
            "trace": trace,
            "rectangles": rectangles,
            "samples": [],
        })
        candidate["samples"].append(sample)

    if not candidates:
        unresolved_trace["attempts"] = unresolved_trace["attempts"][:12]
        # Report the samples actually tried, not the samples planned. Claiming
        # nine when the budget stopped us at two would hide the reason a hard
        # window failed.
        return target_window, None, unresolved_trace, {
            "schemaVersion": 1,
            "state": "unresolved",
            "candidate_count": 0,
            "sample_count": samples_attempted,
            "sample_count_planned": len(sampled),
            "budget_exhausted": bool(unresolved_trace.get("sampleBudgetExhausted")),
            "reason": "gesture_no_bounded_candidate",
        }, None

    selection_bbox = (
        int(raw_bbox.get("x") or 0),
        int(raw_bbox.get("y") or 0),
        int(raw_bbox.get("x") or 0) + int(raw_bbox.get("width") or 0),
        int(raw_bbox.get("y") or 0) + int(raw_bbox.get("height") or 0),
    )
    semantic_pt = (gesture or {}).get("semanticPoint")
    def _proximity(rect):
        if not isinstance(semantic_pt, dict):
            return 0.0
        rx = rect[0] + rect[2] / 2
        ry = rect[1] + rect[3] / 2
        sx = semantic_pt.get("x", rx)
        sy = semantic_pt.get("y", ry)
        dist = math.hypot(rx - sx, ry - sy)
        max_dist = math.hypot(
            selection_bbox[2] - selection_bbox[0],
            selection_bbox[3] - selection_bbox[1],
        ) or 1.0
        return max(0.0, 1.0 - dist / max_dist)

    ranked: list[tuple[float, str, dict[str, Any]]] = []
    for key, candidate in candidates.items():
        rectangles = candidate["rectangles"]
        rectangle_scores = [
            (score_item_against_stroke(
                (rect[0], rect[1], rect[0] + rect[2], rect[1] + rect[3]),
                selection_bbox,
                points,
            ), rect)
            for rect in rectangles
        ]
        geometric, best_rectangle = max(rectangle_scores, key=lambda item: item[0])
        proximity = _proximity(best_rectangle)
        # Coverage is over the samples we actually ran, not the samples planned.
        # Dividing by the plan would make every candidate look weak whenever the
        # budget cut sampling short — penalising exactly the slow windows the
        # budget exists to rescue.
        coverage = len(candidate["samples"]) / max(1, samples_attempted)
        ranked.append((geometric + 3.0 * proximity + 4.0 * coverage, key, {**candidate, "best_rectangle": best_rectangle}))
    ranked.sort(key=lambda item: (-item[0], item[1]))
    best_score, best_key, best = ranked[0]
    second_score = ranked[1][0] if len(ranked) > 1 else 0.0
    chosen_rect = best["best_rectangle"]
    grounding = {
        "schemaVersion": 1,
        "state": "resolved",
        "mode": "path_target",
        "candidate_count": len(ranked),
        "sample_count": samples_attempted,
        "sample_count_planned": len(sampled),
        "budget_exhausted": bool(unresolved_trace.get("sampleBudgetExhausted")),
        "selected_candidate_id": f"sha256:{__import__('hashlib').sha256(best_key.encode('utf-8')).hexdigest()}",
        "score": round(best_score, 3),
        "margin": round(best_score - second_score, 3),
    }
    return target_window, best["context"], best["trace"], grounding, chosen_rect


def _pointer_anchor_ltrb(target_point: dict[str, int]) -> list[int]:
    half = POINTER_ANCHOR_SIZE // 2
    return [
        target_point["x"] - half,
        target_point["y"] - half,
        target_point["x"] + half,
        target_point["y"] + half,
    ]


def _grab_capture_image(
    bbox: tuple[int, int, int, int],
    *,
    target_window: dict[str, Any] | None,
    visual_capture: Any | None,
) -> Any:
    """Produce the pixels for one region, preferring the target's own content.

    Capture the committed source HWND directly whenever we have one. A desktop
    grab returns whatever is painted at those pixels, which is how a Notepad
    selection came back holding the text of a CMD window sitting behind it: the
    gesture path asks for a screen-sized bbox, so an earlier `capture_bbox is
    None` guard turned the window capture off exactly when the region was largest
    and the bleed worst.

    PrintWindow gives us the target's own content even where another window covers
    it, and anything in the requested region that is not the target stays blank
    rather than being read as if it belonged to the object.
    """
    if visual_capture is not None:
        return visual_capture(bbox=bbox, all_screens=True)
    hwnd = int(target_window.get("hwnd") or 0) if target_window else 0
    window_bbox = target_window.get("bbox") if target_window else None
    image = None
    if hwnd and isinstance(window_bbox, (list, tuple)) and len(window_bbox) == 4:
        try:
            window_image = ImageGrab.grab(window=hwnd)
        except (OSError, ValueError, TypeError):
            window_image = None
        if window_image is not None and not _capture_is_blank(window_image):
            win_left, win_top, win_right, win_bottom = (int(value) for value in window_bbox)
            scale_x = window_image.width / max(1, win_right - win_left)
            scale_y = window_image.height / max(1, win_bottom - win_top)
            local_bbox = (
                round((bbox[0] - win_left) * scale_x),
                round((bbox[1] - win_top) * scale_y),
                round((bbox[2] - win_left) * scale_x),
                round((bbox[3] - win_top) * scale_y),
            )
            expected_size = (bbox[2] - bbox[0], bbox[3] - bbox[1])
            if _rect_within(local_bbox, window_image.size):
                image = window_image.crop(local_bbox)
                if image.size != expected_size:
                    image = image.resize(expected_size)
            else:
                # The requested region reaches past the window. Keep the window's
                # pixels where they exist and leave the rest blank.
                image = _paste_window_into_region(window_image, local_bbox, expected_size)
    # A hardware-composited window can return a plausible title bar while its
    # client-area crop is a flat black/grey surface. Validate the evidence ROI,
    # not merely the full PrintWindow frame, before trusting it.
    if image is None or _capture_is_blank(image):
        image = ImageGrab.grab(bbox=bbox, all_screens=True)
    return image


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


def _global_screen_bbox() -> tuple[int, int, int, int] | None:
    """Physical virtual-desktop bounds, including negative-monitor origins."""
    try:
        user32 = ctypes.windll.user32
        left = int(user32.GetSystemMetrics(76))   # SM_XVIRTUALSCREEN
        top = int(user32.GetSystemMetrics(77))    # SM_YVIRTUALSCREEN
        width = int(user32.GetSystemMetrics(78))  # SM_CXVIRTUALSCREEN
        height = int(user32.GetSystemMetrics(79)) # SM_CYVIRTUALSCREEN
        if width > 0 and height > 0:
            return left, top, left + width, top + height
    except Exception:
        pass
    return None


def _structured_context_with_visual_evidence(
    app_ctx: Any,
    visual: dict[str, Any] | None,
    structured_succeeded: bool,
) -> dict[str, Any]:
    """Keep the structured read as the authoritative context; attach any
    full-screen visual record as supporting evidence instead of replacing it."""
    if not structured_succeeded or app_ctx is None:
        return dict(app_ctx.to_dict()) if app_ctx is not None else {}
    structured_dict = dict(app_ctx.to_dict())
    if visual is not None:
        artifacts = dict(structured_dict.get("artifacts") or {})
        artifacts.update({
            "capture_path": visual["path"],
            "annotated_path": visual["annotated_path"],
            "capture_bbox": visual["bbox"],
            "capture_bbox_coordinate_space": "physical_screen_pixels",
            "capture_bbox_format": "ltrb",
        })
        structured_dict["artifacts"] = artifacts
    return structured_dict


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


# A whole-window capture with this little variation in every channel carries no
# content. Two or three points of jitter survive rounding in a genuinely dead
# frame, so the threshold is not zero.
BLANK_CAPTURE_SPREAD = 4


def _capture_is_blank(image: Any) -> bool:
    """Is this capture featureless — and therefore a failed capture?

    Not "is it black". PrintWindow returns a flat surface for hardware-composited
    windows, and the colour it returns is whatever that window's background is:
    WeChat 4.x came back a uniform grey of 42, sailed past a `max <= 2` black
    check, and produced an image OCR found nothing in and a user who got no
    result. What marks a failed grab is the absence of *variation*; a real window
    is never one flat colour. Callers fall back to the compositing desktop grab,
    which is cheap and correct even in the rare case a real region is uniform.
    """
    try:
        extrema = image.convert("RGB").getextrema()
    except Exception:
        return False
    try:
        return all(int(high) - int(low) <= BLANK_CAPTURE_SPREAD for low, high in extrema)
    except (TypeError, ValueError):
        return False


def _rect_within(rect: tuple[int, int, int, int], size: tuple[int, int]) -> bool:
    left, top, right, bottom = rect
    return left >= 0 and top >= 0 and right <= size[0] and bottom <= size[1]


def _paste_window_into_region(
    window_image: Any,
    local_bbox: tuple[int, int, int, int],
    expected_size: tuple[int, int],
) -> Any:
    """Place the window's pixels inside a region larger than the window itself.

    Everything the window does not cover stays a flat neutral field. That is the
    honest rendering: those pixels belong to some other window, and letting OCR
    read them would attribute another app's text to this object.
    """
    from PIL import Image

    canvas = Image.new("RGB", expected_size, (255, 255, 255))
    left, top, right, bottom = local_bbox
    src_left = max(0, left)
    src_top = max(0, top)
    src_right = min(window_image.width, right)
    src_bottom = min(window_image.height, bottom)
    if src_right <= src_left or src_bottom <= src_top:
        return canvas
    patch = window_image.convert("RGB").crop((src_left, src_top, src_right, src_bottom))
    canvas.paste(patch, (src_left - left, src_top - top))
    return canvas


def _capture_visual_region(
    target_window: dict[str, Any] | None,
    target_point: dict[str, int] | None,
    *,
    capture_bbox: tuple[int, int, int, int] | None = None,
    visual_capture: Any | None = None,
    capture_dir: Path | str | None = None,
    retain_days: int = 3,
    identity_probe: Any | None = None,
    gesture_points: list[tuple[int, int]] | None = None,
    clock: PhaseClock | None = None,
) -> dict[str, Any] | None:
    bbox = capture_bbox or _visual_bbox(target_window, target_point)
    if bbox is None:
        return None
    expected_identity = _window_identity(target_window)
    before_window = identity_probe() if callable(identity_probe) else dict(target_window or {})
    before_identity = _window_identity(before_window)
    if callable(identity_probe) and not _same_window_identity(expected_identity, before_identity):
        raise TargetMismatchError({
            "status": "target_mismatch",
            "phase": "before_capture",
            "expected": expected_identity,
            "before": before_identity,
            "after": None,
        })

    # Grab, then check. Identity changing means the wrong window and we refuse.
    # Geometry changing means the *right* window somewhere else, so grab again
    # where it now is — a window that animated into place is not a reason to make
    # the user re-point. Only a window that will not hold still gets a caveat, and
    # even then it gets a capture: an unstable target is worth reporting, not worth
    # withholding. An explicit capture_bbox (the gesture path's full-screen frame)
    # does not depend on where the window sits, so it never re-grabs.
    geometry_matters = capture_bbox is None and callable(identity_probe)
    max_attempts = 3 if geometry_matters else 1
    # The reference is the window whose position produced `bbox`, which on the
    # first pass is the committed target — not what the probe just reported.
    reference_window = dict(target_window or {})
    recaptured = False
    unstable = False
    image = None
    after_identity = before_identity
    for attempt in range(max_attempts):
        if attempt:
            retry_bbox = _visual_bbox(reference_window, target_point)
            if retry_bbox is None:
                unstable = True
                break
            bbox = retry_bbox
            recaptured = True
        image = _grab_capture_image(
            bbox,
            target_window=target_window,
            visual_capture=visual_capture,
        )
        after_window = identity_probe() if callable(identity_probe) else before_window
        after_identity = _window_identity(after_window)
        if callable(identity_probe) and not _same_window_identity(expected_identity, after_identity):
            raise TargetMismatchError({
                "status": "target_mismatch",
                "phase": "after_capture",
                "expected": expected_identity,
                "before": before_identity,
                "after": after_identity,
            })
        if not geometry_matters or _same_window_geometry(_window_identity(reference_window), after_identity):
            break
        reference_window = after_window
    else:
        unstable = True
    # The pixels are now ours and verified to be the window the user pointed at.
    # Everything after this line — saving, annotating, OCR — happens on a frozen
    # copy, so any surface we draw from here on cannot contaminate the capture.
    # This is the earliest moment it is safe to show the conversation capsule.
    if clock is not None:
        clock.mark("pixels_frozen", w=image.width, h=image.height)
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
    annotation_points = list(gesture_points or []) or [(tip[0] - 24, tip[1] - 24), tip]
    annotated = output.with_name(f"{output.stem}.pointer.png")
    make_pointer_annotated_image(
        output,
        annotated,
        bbox,
        annotation_points,
    )
    return {
        "path": str(output.resolve()),
        "annotated_path": str(annotated.resolve()),
        "bbox": list(bbox),
        "width": bbox[2] - bbox[0],
        "height": bbox[3] - bbox[1],
        "capture_attestation": {
            "status": (
                "geometry_unstable" if unstable
                else "verified" if callable(identity_probe)
                else "unverified"
            ),
            "phase": "complete",
            "expected": expected_identity,
            "before": before_identity,
            "after": after_identity,
            "recaptured": recaptured,
        },
    }


def _verify_frozen_lease_artifact(frozen_lease: dict[str, Any]) -> str | None:
    """Verify the committed artifact is still exactly what the lease promises.

    Returns a fail-closed reason code, or None when the artifact matches. A
    mismatch never triggers a recapture: the current screen may have changed.
    """
    artifact = frozen_lease.get("localArtifact")
    if not isinstance(artifact, dict):
        return "artifact_missing"
    artifact_path = Path(str(artifact.get("path") or ""))
    if not artifact_path.exists():
        return "artifact_missing"
    try:
        with Image.open(artifact_path) as probe:
            width, height = probe.size
    except (OSError, ValueError, TypeError):
        return "artifact_unreadable"
    if width != int(artifact.get("width") or 0) or height != int(artifact.get("height") or 0):
        return "artifact_dimension_mismatch"
    expected_hash = str(frozen_lease.get("contentHash") or "")
    if expected_hash.startswith("sha256:"):
        actual_hash = "sha256:" + hashlib.sha256(artifact_path.read_bytes()).hexdigest()
        if actual_hash != expected_hash:
            return "artifact_hash_mismatch"
    return None


def _frame_lease_failure_snapshot(captured: datetime, reason: str) -> dict[str, Any]:
    """Fail closed: an invalid/missing frozen frame never recaptures the screen."""
    summary = {
        "state": "invalid_frame_lease",
        "label": "画面未冻结",
        "detail": f"冻结帧校验失败（{reason}），未重新截取当前屏幕。",
        "app": None,
        "hasContent": False,
        "hasVisual": False,
        "canRewrite": False,
    }
    snapshot = {
        "snapshot_id": f"selection-{uuid.uuid4().hex[:16]}",
        "captured_at": captured.isoformat(),
        "expires_at": (captured + timedelta(seconds=SNAPSHOT_TTL_SECONDS)).isoformat(),
        "status": "invalid_frame_lease",
        "source_kind": "none",
        "structured_covers_mark": False,
        "structured_gap_reason": f"invalid_frame_lease:{reason}",
        "target_point": None,
        "target_point_space": None,
        "source_window": None,
        "context": None,
        "capture_path": None,
        "annotated_path": None,
        "capture_bbox": None,
        "capture_attestation": None,
        "capture_policy": None,
        "perception_trace": {
            "schemaVersion": 1,
            "selectedLayer": None,
            "selectedAdapter": None,
            "selectedMethod": None,
            "pixelFallbackUsed": False,
            "fallbackReason": reason,
            "attempts": [{
                "layer": "screen_region",
                "adapter": "frame-lease",
                "method": "verify",
                "status": "error",
                "reason": reason,
            }],
        },
        "selection_bbox": None,
        "selection_segments": None,
        "pointer_anchor_bbox": None,
        "selection_gesture": None,
        "gesture_grounding": None,
        "frame_lease": None,
    }
    return {
        "ok": False,
        "error": "invalid_frame_lease",
        "selectionSnapshot": snapshot,
        "captureSummary": summary,
        "suggestedCommands": [],
    }


def capture_snapshot(
    windows: list[dict[str, Any]] | None = None,
    *,
    registry: Any | None = None,
    target_point: Any | None = None,
    target_point_space: str | None = "physical_screen_pixels",
    gesture: dict[str, Any] | None = None,
    target_hwnd: int = 0,
    active_context: dict[str, Any] | None = None,
    active_review: dict[str, Any] | None = None,
    visual_capture: Any | None = None,
    global_capture_bbox: tuple[int, int, int, int] | None = None,
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
    clock: PhaseClock | None = None,
    frame_lease: dict[str, Any] | None = None,
) -> dict[str, Any]:
    def mark(phase: str, **fields: Any) -> None:
        if clock is not None:
            clock.mark(phase, **fields)

    captured = datetime.now(timezone.utc)
    # A FrameLease is the authoritative frozen surface. Validate it before any
    # structured read and never fall back to recapturing the current screen.
    frozen_lease: dict[str, Any] | None = None
    frozen_visual: dict[str, Any] | None = None
    if frame_lease is not None:
        invalid_reason: str | None = None
        try:
            frozen_lease = normalize_frame_lease(frame_lease)
        except FrameLeaseError:
            invalid_reason = "invalid_frame_lease"
        if invalid_reason is None and frozen_lease is not None:
            invalid_reason = _verify_frozen_lease_artifact(frozen_lease)
        if invalid_reason is not None:
            return _frame_lease_failure_snapshot(captured, invalid_reason)
        mark(
            "pixels_frozen",
            w=frozen_lease["localArtifact"]["width"],
            h=frozen_lease["localArtifact"]["height"],
        )
        frozen_visual = {
            "path": str(Path(frozen_lease["localArtifact"]["path"]).resolve()),
            "annotated_path": None,
            "bbox": list(frozen_lease["surfaceBoundsPx"]),
            "width": int(frozen_lease["localArtifact"]["width"]),
            "height": int(frozen_lease["localArtifact"]["height"]),
            "capture_attestation": {
                "status": "frame_lease",
                "backend": frozen_lease["source"],
                "content_hash": frozen_lease["contentHash"],
                "overlay_excluded": frozen_lease["overlayExcluded"],
                "phase": "complete",
            },
        }
    live_window_source = windows is None
    normalized_target_point = _normalized_point(target_point)
    normalized_gesture = _normalized_gesture(gesture)
    requested_hwnd = int(target_hwnd or 0)
    available_windows = (
        _window_dicts(requested_hwnd, normalized_target_point)
        if windows is None
        else list(windows)
    )
    if requested_hwnd and windows is not None:
        preferred = next(
            (item for item in available_windows if int(item.get("hwnd") or 0) == requested_hwnd),
            None,
        )
        available_windows = [preferred] if preferred is not None else []
    target_window = available_windows[0] if available_windows else None
    mark("windows_enumerated", n=len(available_windows), live=live_window_source)
    if frozen_lease is not None:
        try:
            frozen_binding = bind_frozen_evidence(
                frozen_lease,
                target_window,
                normalized_gesture,
            )
        except EvidenceBindingError as exc:
            return _frame_lease_failure_snapshot(captured, exc.reason)
        if frozen_visual is not None:
            frozen_visual["capture_attestation"].update({
                "binding_status": frozen_binding.status,
                "capture_kind": frozen_binding.capture_kind,
                "target": dict(frozen_binding.target),
                "surface_bounds_px": list(frozen_binding.surface_bounds_px),
            })
    gesture_grounding = None
    gesture_selection_bbox = None
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
        explorer_context, explorer_grounding, explorer_trace = read_explorer_file_context(
            available_windows,
            gesture=normalized_gesture,
            fallback_point=normalized_target_point,
        )
        if explorer_context is not None and explorer_trace is not None:
            target_window = available_windows[0]
            app_ctx = explorer_context
            perception_trace = explorer_trace
            gesture_grounding = explorer_grounding
            gesture_selection_bbox = _gesture_mark_bbox(normalized_gesture)
        else:
            # SurfaceAdapter chain first (design §8): an adapter that claims
            # this app family owns its surface semantics. Text-bearing
            # resolutions become the structured context; anchor-only
            # resolutions are recorded as an attempt and the generic chain
            # (UIA/COM/OCR) still runs on top.
            surface_ctx, surface_attempt = _surface_adapter_attempt(
                available_windows, normalized_gesture, normalized_target_point
            )
            target_window, app_ctx, perception_trace, gesture_grounding, gesture_selection_bbox = (
                _read_gesture_target_context(
                    available_windows,
                    registry=registry,
                    gesture=normalized_gesture,
                    fallback_point=normalized_target_point,
                )
            )
            if surface_ctx is not None:
                target_window = available_windows[0]
                app_ctx = surface_ctx
                perception_trace = _surface_adapter_trace(surface_ctx)
                gesture_grounding = None
                gesture_selection_bbox = _gesture_mark_bbox(normalized_gesture)
            elif surface_attempt is not None and _surface_attempt_is_signal(surface_attempt):
                # Only record attempts that carry signal (an adapter claimed
                # the window, or the registry errored): "no adapter claims
                # this window" is the default for every normal window and
                # must not pollute the perception trace ordering.
                perception_trace["attempts"] = [
                    surface_attempt,
                    *(perception_trace.get("attempts") or []),
                ]
        perception_trace["policyMode"] = (
            capture_decision.mode if capture_decision is not None else "unconfigured"
        )
    mark("structured_read", layer=perception_trace.get("selectedLayer") or "none")
    active_identity_probe = identity_probe
    if active_identity_probe is None and live_window_source:
        def active_identity_probe() -> dict[str, Any]:
            current = _window_dicts(requested_hwnd, normalized_target_point)
            return dict(current[0]) if current else {}
    structured_target_mismatch = False
    structured_attestation = None
    if app_ctx is not None and target_window is not None and callable(active_identity_probe):
        expected_identity = _window_identity(target_window)
        observed_identity = _window_identity(active_identity_probe())
        if not _same_window_identity(expected_identity, observed_identity):
            structured_target_mismatch = True
            structured_attestation = {
                "status": "target_mismatch",
                "phase": "after_structured_read",
                "expected": expected_identity,
                "before": expected_identity,
                "after": observed_identity,
            }
            app_ctx = None
            perception_trace = {
                **perception_trace,
                "selectedLayer": None,
                "selectedAdapter": None,
                "selectedMethod": None,
                "pixelFallbackUsed": False,
                "fallbackReason": "target_mismatch",
                "attempts": [
                    *(perception_trace.get("attempts") or []),
                    {
                        "layer": "structured",
                        "adapter": "foreground-identity",
                        "method": "foreground:post-read-attestation",
                        "status": "error",
                        "reason": "target_mismatch",
                    },
                ],
            }
    # A non-empty string is not the same thing as an answer. A UIA read of a
    # console or a chat window happily returns the container's accessible name —
    # on 2026-08-04 that was the literal path to powershell.exe — and treating it
    # as content is what switched the pixel fallback off and left the user with
    # "I can see which window you mean but not what you underlined".
    mark_coverage = structured_read_covers_mark(
        content=str(getattr(app_ctx, "content", "") or ""),
        window=target_window,
        element_rects=_context_rectangles(app_ctx) if app_ctx is not None else [],
        mark_bbox=_gesture_mark_bbox(normalized_gesture),
    )
    if normalized_gesture is not None and not mark_coverage.covers:
        # The structured candidate can be useful as a clue and still be too
        # broad to represent the selection.  Once it fails the mark-coverage
        # gate, the user's own gesture becomes authoritative again.
        gesture_selection_bbox = _gesture_mark_bbox(normalized_gesture) or gesture_selection_bbox
    structured_succeeded = bool(
        app_ctx is not None
        and bool(perception_trace.get("selectedLayer"))
        and mark_coverage.covers
    )
    if app_ctx is not None and not mark_coverage.covers:
        # Say it in the trace rather than only in the outcome: the diagnostics
        # page has to be able to show *why* pixels were needed.
        perception_trace = append_perception_attempt(
            perception_trace,
            layer=str(perception_trace.get("selectedLayer") or "uia"),
            adapter=str(perception_trace.get("selectedAdapter") or "unknown"),
            method=str(perception_trace.get("selectedMethod") or "unknown"),
            status="empty",
            reason=mark_coverage.reason,
        )
    summary = _summary_for(target_window, app_ctx)
    if not mark_coverage.covers:
        summary["hasContent"] = False
        summary["excerpt"] = ""
        summary["canRewrite"] = False
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
    capture_attestation = structured_attestation
    target_mismatch = structured_target_mismatch
    visual_attempt_recorded = False
    visual_target_point = normalized_target_point
    gesture_points = _gesture_points(normalized_gesture)
    screen_bbox = global_capture_bbox or _global_screen_bbox() if gesture_points else None
    gesture_capture_bbox = _bounded_gesture_capture_bbox(
        normalized_gesture,
        target_window,
        screen_bbox,
    ) if gesture_points else None
    if gesture_points:
        raw_gesture_bbox = dict((normalized_gesture or {}).get("bbox") or {})
        visual_target_point = {
            "x": int(raw_gesture_bbox.get("x") or 0) + int(raw_gesture_bbox.get("width") or 0) // 2,
            "y": int(raw_gesture_bbox.get("y") or 0) + int(raw_gesture_bbox.get("height") or 0) // 2,
        }
    should_capture_visual = bool(
        allow_visual_fallback
        and not target_mismatch
        and not sensitive_target
        and (capture_decision is None or capture_decision.allow_local_pixels)
        # A completed gesture gets a bounded visual record around the mark.
        # UIA/DOM can still provide exact text and geometry, but neither a
        # failed structured read nor a model call may silently widen the user's
        # selection to the whole desktop.
        and (bool(gesture_points) or not perception_trace.get("selectedLayer"))
        and (bool(gesture_points) or not summary.get("hasContent"))
        and not summary["hasActiveContext"]
        and not summary["hasActiveReview"]
    )
    if frozen_lease is not None and frozen_visual is not None:
        # The committed artifact is the only visual evidence; the current
        # screen is never grabbed for this snapshot.
        visual = dict(frozen_visual)
        visual_attempt_recorded = True
        capture_attestation = visual["capture_attestation"]
        mark("visual_saved", got=True)
        if gesture_selection_bbox is None and gesture_points:
            raw_bbox = dict((normalized_gesture or {}).get("bbox") or {})
            width = max(0, int(raw_bbox.get("width") or 0))
            height = max(0, int(raw_bbox.get("height") or 0))
            if width > 0 and height > 0:
                gesture_selection_bbox = [
                    int(raw_bbox.get("x") or 0),
                    int(raw_bbox.get("y") or 0),
                    width,
                    height,
                ]
        perception_trace = append_perception_attempt(
            perception_trace,
            layer="screen_region",
            adapter="screen-capture",
            method="frame-lease:frozen-surface",
            status="succeeded",
            reason="frame_lease_consumed",
            select=not structured_succeeded,
            policy_mode=capture_decision.mode if capture_decision is not None else "unconfigured",
        )
    elif should_capture_visual:
        try:
            visual = _capture_visual_region(
                target_window,
                visual_target_point,
                capture_bbox=gesture_capture_bbox,
                visual_capture=visual_capture,
                capture_dir=capture_dir,
                retain_days=retain_captures_days,
                identity_probe=active_identity_probe,
                gesture_points=gesture_points,
                clock=clock,
            )
            mark("visual_saved", got=visual is not None)
            capture_attestation = visual.get("capture_attestation") if visual is not None else None
            if visual is not None:
                if gesture_points:
                    make_pointer_annotated_image(
                        Path(visual["path"]),
                        Path(visual["annotated_path"]),
                        tuple(visual["bbox"]),
                        gesture_points,
                        style="locator",
                        element_rectangles=_context_rectangles(app_ctx)[:24],
                    )
                    mark("annotated")
                if gesture_selection_bbox is None and gesture_points:
                    raw_bbox = dict((normalized_gesture or {}).get("bbox") or {})
                    width = max(0, int(raw_bbox.get("width") or 0))
                    height = max(0, int(raw_bbox.get("height") or 0))
                    if width > 0 and height > 0:
                        gesture_selection_bbox = [
                            int(raw_bbox.get("x") or 0),
                            int(raw_bbox.get("y") or 0),
                            width,
                            height,
                        ]
                perception_trace = append_perception_attempt(
                    perception_trace,
                    layer="screen_region",
                    adapter="screen-capture",
                    method="pointer:bounded-screen-region",
                    status="succeeded",
                    reason=(
                        "bounded_visual_evidence"
                        if structured_succeeded
                        else str(perception_trace.get("fallbackReason") or "structured_context_unavailable")
                    ),
                    # A local evidence crop is not a pixel fallback when DOM/UIA
                    # already grounded the user's mark. Keep the structured
                    # layer authoritative and record pixels as corroboration.
                    select=not structured_succeeded,
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
        elif target_mismatch:
            visual_status, visual_reason = "blocked", "target_mismatch"
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
    elif visual is not None and not structured_succeeded:
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
    if structured_succeeded and visual is not None:
        summary["hasVisual"] = True
    source_kind = (
        "native_selection"
        if structured_succeeded
        else "screen_region"
        if visual is not None
        else "native_selection"
        if app_ctx is not None and perception_trace.get("selectedLayer")
        else "foreground_window"
    )
    visual_context = None
    pointer_anchor = None
    if visual is not None and not structured_succeeded:
        # The cursor may be absent for gesture-only captures; the gesture bbox
        # center was already chosen as the capture anchor above (visual_target_point).
        anchor_point = normalized_target_point or visual_target_point
        pointer_anchor = (
            _pointer_anchor_ltrb(anchor_point)
            if anchor_point is not None
            else None
        )
        visual_selection_rectangles = (
            [list(gesture_selection_bbox)] if gesture_selection_bbox is not None else []
        )
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
                "capture_bbox": visual["bbox"],
                "capture_bbox_coordinate_space": "physical_screen_pixels",
                "capture_bbox_format": "ltrb",
                "selection_rectangles": visual_selection_rectangles,
                "selection_rectangles_coordinate_space": "physical_screen_pixels",
                "selection_rectangles_format": "xywh",
                "selection_geometry_kind": (
                    "gesture_region" if visual_selection_rectangles else "pointer_anchor"
                ),
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
        # Whether the structured layer read the marked content, and when it did
        # not, which way it failed. The command bridge uses this to decide that
        # OCR still owes the user an answer; without it, a read that returned
        # only the app's own name looks identical to a real one.
        "structured_covers_mark": bool(mark_coverage.covers),
        "structured_gap_reason": "" if mark_coverage.covers else mark_coverage.reason,
        "target_point": normalized_target_point,
        "target_point_space": (
            "physical_screen_pixels"
            if normalized_target_point is not None and target_point_space == "physical_screen_pixels"
            else None
        ),
        "source_window": target_window,
        "context": _structured_context_with_visual_evidence(
            app_ctx, visual, structured_succeeded
        ) if structured_succeeded else (
            visual_context if visual_context is not None else (
                None if app_ctx is None else app_ctx.to_dict()
            )
        ),
        "capture_path": visual["path"] if visual is not None else None,
        "annotated_path": visual["annotated_path"] if visual is not None else None,
        "capture_bbox": visual["bbox"] if visual is not None else None,
        "capture_attestation": capture_attestation,
        "capture_policy": capture_decision.to_dict() if capture_decision is not None else None,
        "perception_trace": perception_trace,
        "selection_bbox": gesture_selection_bbox,
        "selection_segments": (
            list((gesture_grounding or {}).get("segments") or [])
            if isinstance(gesture_grounding, dict)
            else None
        ),
        "pointer_anchor_bbox": pointer_anchor,
        "selection_gesture": normalized_gesture,
        "gesture_grounding": gesture_grounding,
        "frame_lease": frozen_lease,
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
    clock = PhaseClock("selection_snapshot")
    try:
        payload = read_payload()
    except PayloadTooLargeError as exc:
        print(json.dumps({
            "ok": False,
            "error": "payload_too_large",
            "maxPayloadBytes": exc.max_bytes,
        }, ensure_ascii=False))
        return 2
    clock.mark("payload_read")
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
    clock.mark("settings_loaded")
    result = capture_snapshot(
        target_point=payload.get("cursor"),
        target_point_space=payload.get("cursorSpace"),
        gesture=payload.get("gesture"),
        frame_lease=payload.get("frameLease"),
        target_hwnd=int(payload.get("foregroundHwnd") or 0),
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
        clock=clock,
    )
    clock.total(status=str(result.get("status") or "unknown"))
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
