from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse

from app.grounding.base import BaseGrounder, GroundingBundle, GroundingTrace
from app.grounding.schema import BoundingBox, GroundedObject, PointerSelection

JsonDict = dict[str, Any]
Point = tuple[int, int]

EXPLORER_CLASSES = {"CabinetWClass", "ExploreWClass"}


@dataclass(frozen=True)
class ExplorerItem:
    name: str
    path: str | None = None
    bbox: BoundingBox | None = None
    selected: bool = False
    source: str = "unknown"
    metadata: JsonDict = field(default_factory=dict)


def rect_area(rect: BoundingBox) -> int:
    return max(0, rect[2] - rect[0]) * max(0, rect[3] - rect[1])


def rect_intersection(a: BoundingBox, b: BoundingBox) -> BoundingBox | None:
    rect = (max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3]))
    return rect if rect_area(rect) > 0 else None


def rect_center(rect: BoundingBox) -> tuple[float, float]:
    return ((rect[0] + rect[2]) / 2, (rect[1] + rect[3]) / 2)


def dist_point_to_rect(point: tuple[float, float], rect: BoundingBox) -> float:
    x, y = point
    dx = max(rect[0] - x, 0, x - rect[2])
    dy = max(rect[1] - y, 0, y - rect[3])
    return (dx * dx + dy * dy) ** 0.5


def score_item_against_stroke(item_bbox: BoundingBox, selection_bbox: BoundingBox, stroke_points: list[Point]) -> float:
    """Score a candidate item using pointer samples and selection overlap."""

    score = 0.0
    inter = rect_intersection(item_bbox, selection_bbox)
    if inter:
        score += min(3.0, rect_area(inter) / max(1, rect_area(selection_bbox)) * 3.0)
    if stroke_points:
        hits = sum(1 for x, y in stroke_points if item_bbox[0] <= x <= item_bbox[2] and item_bbox[1] <= y <= item_bbox[3])
        score += 8.0 * hits / max(1, len(stroke_points))
        score += max(0.0, 2.5 - dist_point_to_rect(rect_center(selection_bbox), item_bbox) / 70.0)
        score += max(0.0, 1.8 - dist_point_to_rect(stroke_points[-1], item_bbox) / 60.0)
    return round(score, 3)


def file_metadata(path: str | None) -> JsonDict:
    if not path:
        return {}
    try:
        p = Path(path)
        stat = p.stat()
        return {
            "path": str(p),
            "name": p.name,
            "folder": str(p.parent),
            "suffix": p.suffix,
            "is_dir": p.is_dir(),
            "size": stat.st_size,
            "mtime": stat.st_mtime,
        }
    except OSError:
        return {"path": path, "name": os.path.basename(path)}


def is_explorer_window(window: JsonDict) -> bool:
    class_name = str(window.get("class_name") or "")
    title = str(window.get("title") or "")
    return class_name in EXPLORER_CLASSES or title.lower().endswith(" - file explorer") or title == "文件资源管理器"


def file_url_to_path(url: str | None) -> str | None:
    if not url:
        return None
    try:
        parsed = urlparse(url)
        if parsed.scheme.lower() != "file":
            return None
        path = unquote(parsed.path)
        # urlparse('file:///C:/x') yields '/C:/x'. Windows paths should not keep
        # the leading slash before the drive letter.
        if len(path) >= 3 and path[0] == "/" and path[2] == ":":
            path = path[1:]
        return path.replace("/", os.sep)
    except Exception:
        return None


class ExplorerFileGrounder(BaseGrounder):
    """Best-effort Windows Explorer grounding.

    Order of preference:
    1. UIA list-item rectangles, scored against the user's stroke.
    2. Explorer COM selected items, when the user has an explicit Explorer selection.
    3. Explorer window/folder object as low-confidence context.

    All optional Windows-specific dependencies are imported lazily. The adapter
    remains safe to import on non-Windows systems and in tests.
    """

    name = "explorer"

    def ground(self, selection: PointerSelection, **kwargs: Any) -> GroundingBundle:
        windows = list(kwargs.get("windows") or [])
        stroke_points = list(kwargs.get("stroke_points") or [])
        row_candidates = list(kwargs.get("row_candidates") or [])
        traces: list[GroundingTrace] = []
        objects: list[GroundedObject] = []

        explorer_windows = [w for w in windows if is_explorer_window(w)]
        if not explorer_windows:
            return GroundingBundle(selection=selection, traces=[GroundingTrace(self.name, ["no explorer window intersected selection"])])

        # Prefer the topmost/highest coverage Explorer window from screen_context.
        explorer_windows.sort(key=lambda w: (int(w.get("z_order", 999) or 999), -float(w.get("selection_coverage", 0) or 0)))
        window = explorer_windows[0]
        hwnd = int(window.get("hwnd") or 0)
        folder_path, selected_paths, com_messages = self._read_shell_window(hwnd)
        traces.append(GroundingTrace(self.name + ":com", com_messages, {"hwnd": hwnd, "folder_path": folder_path, "selected_paths": selected_paths}))

        ui_items, uia_messages = self._read_uia_items(hwnd, folder_path)
        traces.append(GroundingTrace(self.name + ":uia", uia_messages, {"item_count": len(ui_items)}))

        scored_items: list[tuple[float, ExplorerItem]] = []
        if selection.bbox:
            for item in ui_items:
                if not item.bbox:
                    continue
                score = score_item_against_stroke(item.bbox, selection.bbox, stroke_points)
                if item.selected:
                    score += 2.0
                if score > 0.25:
                    scored_items.append((score, item))
        scored_items.sort(key=lambda pair: pair[0], reverse=True)

        if scored_items:
            for rank, (score, item) in enumerate(scored_items[:5], 1):
                objects.append(self._object_from_item(selection, item, rank, score, window, folder_path))
            return GroundingBundle(selection=selection, objects=objects, primary_object_id=objects[0].id, traces=traces)

        # If UIA is unavailable, an explicit Explorer selection is still a strong
        # local signal. This does not infer a file merely from row order.
        for idx, path in enumerate(selected_paths[:5], 1):
            item = ExplorerItem(name=os.path.basename(path), path=path, bbox=selection.bbox, selected=True, source="com_selected")
            objects.append(self._object_from_item(selection, item, idx, 0.86, window, folder_path))
        if objects:
            return GroundingBundle(selection=selection, objects=objects, primary_object_id=objects[0].id, traces=traces)

        # Low-confidence context only. Useful for model prompts and debugging, but
        # not a file hit.
        if folder_path or window:
            metadata = {
                "adapter": self.name,
                "window": window,
                "folder_path": folder_path,
                "row_candidates": row_candidates[:5],
                "reason": "Explorer window detected, but no UIA/COM item hit was available.",
            }
            objects.append(
                GroundedObject.from_selection(
                    id=f"{selection.id}:explorer_window",
                    kind="explorer_window",
                    selection=selection,
                    label=str(window.get("title") or "Explorer"),
                    confidence=0.35,
                    app_title=str(window.get("title") or "Explorer"),
                    metadata=metadata,
                )
            )
        return GroundingBundle(selection=selection, objects=objects, primary_object_id=objects[0].id if objects else None, traces=traces)

    def _object_from_item(
        self,
        selection: PointerSelection,
        item: ExplorerItem,
        rank: int,
        confidence: float,
        window: JsonDict,
        folder_path: str | None,
    ) -> GroundedObject:
        meta = file_metadata(item.path)
        kind = "folder" if meta.get("is_dir") else "file"
        if not item.path:
            kind = "explorer_item"
        meta.update({
            "adapter": self.name,
            "source": item.source,
            "selected": item.selected,
            "rank": rank,
            "folder_path": folder_path,
            "window": window,
            **dict(item.metadata),
        })
        return GroundedObject.from_selection(
            id=f"{selection.id}:explorer_item:{rank}",
            kind=kind,
            selection=selection,
            bbox=item.bbox or selection.bbox,
            label=item.name,
            confidence=max(0.0, min(1.0, confidence / 10.0 if confidence > 1 else confidence)),
            text=item.name,
            app_title=str(window.get("title") or "Explorer"),
            metadata=meta,
        )

    def _read_shell_window(self, hwnd: int) -> tuple[str | None, list[str], list[str]]:
        messages: list[str] = []
        if not hwnd:
            return None, [], ["missing hwnd"]
        try:
            import win32com.client  # type: ignore
        except Exception as exc:
            return None, [], [f"win32com unavailable: {type(exc).__name__}: {exc}"]
        try:
            shell = win32com.client.Dispatch("Shell.Application")
            for shell_window in shell.Windows():
                try:
                    if int(shell_window.HWND) != hwnd:
                        continue
                    folder = file_url_to_path(str(shell_window.LocationURL))
                    selected: list[str] = []
                    try:
                        for item in shell_window.Document.SelectedItems():
                            selected.append(str(item.Path))
                    except Exception as exc:
                        messages.append(f"selected items unavailable: {type(exc).__name__}: {exc}")
                    messages.append("matched shell window")
                    return folder, selected, messages
                except Exception:
                    continue
            return None, [], ["no matching Shell.Application window"]
        except Exception as exc:
            return None, [], [f"shell dispatch failed: {type(exc).__name__}: {exc}"]

    def _read_uia_items(self, hwnd: int, folder_path: str | None) -> tuple[list[ExplorerItem], list[str]]:
        messages: list[str] = []
        if not hwnd:
            return [], ["missing hwnd"]
        try:
            import pywinauto  # type: ignore
        except Exception as exc:
            return [], [f"pywinauto unavailable: {type(exc).__name__}: {exc}"]
        try:
            app = pywinauto.Application(backend="uia").connect(handle=hwnd)
            win = app.window(handle=hwnd)
            descendants = []
            for control_type in ("ListItem", "DataItem"):
                try:
                    descendants.extend(win.descendants(control_type=control_type))
                except Exception as exc:
                    messages.append(f"descendants({control_type}) failed: {type(exc).__name__}: {exc}")
            items: list[ExplorerItem] = []
            seen: set[tuple[str, BoundingBox]] = set()
            for elem in descendants:
                try:
                    name = (elem.window_text() or getattr(elem.element_info, "name", "") or "").strip()
                    if not name:
                        continue
                    rect = elem.rectangle()
                    bbox: BoundingBox = (int(rect.left), int(rect.top), int(rect.right), int(rect.bottom))
                    if rect_area(bbox) <= 0:
                        continue
                    key = (name, bbox)
                    if key in seen:
                        continue
                    seen.add(key)
                    path = str(Path(folder_path) / name) if folder_path else None
                    # Avoid claiming a path when the visible UI name is not a child of this folder.
                    if path and not Path(path).exists():
                        path = None
                    selected = False
                    try:
                        selected = bool(elem.iface_selection_item.CurrentIsSelected)  # type: ignore[attr-defined]
                    except Exception:
                        selected = False
                    items.append(ExplorerItem(name=name, path=path, bbox=bbox, selected=selected, source="uia"))
                except Exception as exc:
                    messages.append(f"item parse failed: {type(exc).__name__}: {exc}")
            messages.append(f"uia items read: {len(items)}")
            return items, messages
        except Exception as exc:
            return [], [f"uia read failed: {type(exc).__name__}: {exc}"]
