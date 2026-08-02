from __future__ import annotations

import json
import math
import os
import sys
import uuid
import ctypes
from dataclasses import replace as replace_dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from PIL import ImageGrab

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.adapters import AdapterReadContext, default_adapter_registry
from app.context_pack import ContextSessionError, ContextSessionStore
from app.fabric.audit import AuditStore
from app.fabric.capture_policy import CapturePolicyEngine
from app.grounding.perception_cascade import (
    append_perception_attempt,
    resolve_structured_perception,
)
from app.grounding.explorer_adapter import score_item_against_stroke
from app.review import ReviewSessionError, ReviewSessionStore
from app.fabric.settings import FabricSettings, SettingsError, SettingsStore
from app.system_context import enable_dpi_awareness, get_foreground_window_handle, list_visible_windows
from app.visual_annotation import make_pointer_annotated_image

enable_dpi_awareness()

MAGIC_WINDOW_TITLES = {"Magic Pointer Overlay", "Magic Pointer Panel", "Magic Pointer Stage"}
SNAPSHOT_TTL_SECONDS = 120
VISUAL_REGION_WIDTH = 640
VISUAL_REGION_HEIGHT = 420
POINTER_ANCHOR_SIZE = 16


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
    requested_hwnd = int(preferred_hwnd or 0)
    if requested_hwnd:
        requested = next(
            (item for item in windows if int(item.get("hwnd") or 0) == requested_hwnd),
            None,
        )
        if requested is not None:
            return [requested]
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
                    return (
                        region_window,
                        resolved_context,
                        region_trace,
                        grounding,
                        _union_xywh(_context_rectangles(resolved_context)),
                    )
            grounding["candidate_count"] = len(list(region_artifacts.get("region_elements") or []))
            return region_window, region_context, region_trace, grounding, _union_xywh(region_rectangles)

    sampled = _sample_gesture_points(points)
    candidates: dict[str, dict[str, Any]] = {}
    target_window = windows[0] if windows else None
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
        return target_window, None, unresolved_trace, {
            "schemaVersion": 1,
            "state": "unresolved",
            "candidate_count": 0,
            "sample_count": len(sampled),
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
        coverage = len(candidate["samples"]) / max(1, len(sampled))
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
        "sample_count": len(sampled),
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


def _capture_is_blank(image: Any) -> bool:
    """Detect compositor/GPU black frames before they become model evidence."""
    try:
        extrema = image.convert("RGB").getextrema()
    except Exception:
        return False
    return all(int(channel[1]) <= 2 for channel in extrema)


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
) -> dict[str, Any] | None:
    bbox = capture_bbox or _visual_bbox(target_window, target_point)
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
    if visual_capture is not None:
        image = visual_capture(bbox=bbox, all_screens=True)
    else:
        hwnd = int(target_window.get("hwnd") or 0) if capture_bbox is None and target_window else 0
        window_bbox = target_window.get("bbox")
        if hwnd and isinstance(window_bbox, (list, tuple)) and len(window_bbox) == 4:
            # Capture the committed source HWND directly. The conversation
            # capsule may already be visible above it, but never contaminates
            # this backing-window image.
            window_image = ImageGrab.grab(window=hwnd)
            win_left, win_top, win_right, win_bottom = (int(value) for value in window_bbox)
            if _capture_is_blank(window_image):
                # Electron/Chromium GPU surfaces can return an all-black
                # PrintWindow frame even while the desktop visibly contains
                # the app. Retry through the physical desktop compositor.
                image = ImageGrab.grab(bbox=bbox, all_screens=True)
            else:
                scale_x = window_image.width / max(1, win_right - win_left)
                scale_y = window_image.height / max(1, win_bottom - win_top)
                local_bbox = (
                    round((bbox[0] - win_left) * scale_x),
                    round((bbox[1] - win_top) * scale_y),
                    round((bbox[2] - win_left) * scale_x),
                    round((bbox[3] - win_top) * scale_y),
                )
                image = window_image.crop(local_bbox)
                expected_size = (bbox[2] - bbox[0], bbox[3] - bbox[1])
                if image.size != expected_size:
                    image = image.resize(expected_size)
        else:
            image = ImageGrab.grab(bbox=bbox, all_screens=True)
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
) -> dict[str, Any]:
    captured = datetime.now(timezone.utc)
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
        target_window, app_ctx, perception_trace, gesture_grounding, gesture_selection_bbox = (
            _read_gesture_target_context(
                available_windows,
                registry=registry,
                gesture=normalized_gesture,
                fallback_point=normalized_target_point,
            )
        )
        perception_trace["policyMode"] = (
            capture_decision.mode if capture_decision is not None else "unconfigured"
        )
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
    structured_succeeded = bool(
        app_ctx is not None
        and bool(perception_trace.get("selectedLayer"))
        and bool(str(getattr(app_ctx, "content", "") or "").strip())
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
    global_bbox = global_capture_bbox or _global_screen_bbox() if gesture_points else None
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
        # A completed gesture always gets one full-screen visual record. Its
        # raw pixels preserve the surrounding layout, while UIA/DOM may still
        # provide the higher-confidence exact text and element geometry.
        and (bool(gesture_points) or not perception_trace.get("selectedLayer"))
        and (bool(gesture_points) or not summary.get("hasContent"))
        and not summary["hasActiveContext"]
        and not summary["hasActiveReview"]
    )
    if should_capture_visual:
        try:
            visual = _capture_visual_region(
                target_window,
                visual_target_point,
                capture_bbox=global_bbox,
                visual_capture=visual_capture,
                capture_dir=capture_dir,
                retain_days=retain_captures_days,
                identity_probe=active_identity_probe,
                gesture_points=gesture_points,
            )
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
        pointer_anchor = _pointer_anchor_ltrb(normalized_target_point)
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
                "selection_rectangles": [],
                "selection_rectangles_coordinate_space": "physical_screen_pixels",
                "selection_rectangles_format": "xywh",
                "selection_geometry_kind": "pointer_anchor",
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
        gesture=payload.get("gesture"),
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
    ), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
