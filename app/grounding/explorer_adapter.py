from __future__ import annotations

import base64
import json
import os
import re
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse

from app.grounding.base import BaseGrounder, GroundingBundle, GroundingTrace
from app.grounding.schema import BoundingBox, GroundedObject, PointerSelection

JsonDict = dict[str, Any]
Point = tuple[int, int]


def _as_list(value: Any) -> list[Any]:
    if value is None:
        return []
    return value if isinstance(value, list) else [value]


def _match_key(value: str) -> str:
    # UIA/PowerShell can mangle Unicode punctuation (for example em dash -> replacement chars).
    # Compare a punctuation-insensitive key so visible Explorer names still resolve to files.
    value = value.replace(chr(0xFFFD), " ")
    value = re.sub(r"[^\w]+", " ", value.casefold(), flags=re.UNICODE)
    return " ".join(value.split())


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


def _horizontal_overlap_ratio(a_left: float, a_right: float, b_left: float, b_right: float) -> float:
    overlap = max(0.0, min(a_right, b_right) - max(a_left, b_left))
    return overlap / max(1.0, min(a_right - a_left, b_right - b_left))


def _horizontal_underline(stroke_points: list[Point]) -> tuple[bool, float, float, float]:
    if len(stroke_points) < 2:
        return False, 0.0, 0.0, 0.0
    xs = [float(p[0]) for p in stroke_points]
    ys = [float(p[1]) for p in stroke_points]
    x_min, x_max = min(xs), max(xs)
    y_min, y_max = min(ys), max(ys)
    x_range = x_max - x_min
    y_range = y_max - y_min
    is_horizontal = x_range >= 36 and y_range <= max(16.0, x_range * 0.18)
    y_mid = sorted(ys)[len(ys) // 2]
    return is_horizontal, y_mid, x_min, x_max


def _underline_semantic_bonus(item_bbox: BoundingBox, stroke_points: list[Point]) -> float:
    """Interpret a horizontal stroke just below text as an underline of the row above."""

    is_underline, stroke_y, stroke_x1, stroke_x2 = _horizontal_underline(stroke_points)
    if not is_underline:
        return 0.0

    left, top, right, bottom = item_bbox
    width_overlap = _horizontal_overlap_ratio(left, right, stroke_x1, stroke_x2)
    if width_overlap <= 0.08:
        return 0.0

    height = max(1.0, float(bottom - top))
    gap_below_item = stroke_y - bottom
    bonus = 0.0

    # The common user gesture here is an underline: the stroke is inside the
    # lower part of the file name row or in the small gap immediately below it.
    # In that case the semantic target is the row above the line, not the row
    # that starts below the line.
    if top <= stroke_y <= bottom:
        vertical_fraction = (stroke_y - top) / height
        if vertical_fraction >= 0.42:
            bonus += (4.0 + 3.0 * vertical_fraction) * width_overlap
    elif 0 <= gap_below_item <= min(24.0, height * 0.75):
        bonus += (7.0 - gap_below_item * 0.18) * width_overlap

    # Penalize rows that begin below the underline. This prevents a line drawn
    # under row N from being captured as row N+1 just because the line is closer
    # to that row's top edge.
    if top >= stroke_y - 2:
        bonus -= min(5.0, 3.0 + (top - stroke_y) / 12.0) * width_overlap

    return bonus


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
        score += _underline_semantic_bonus(item_bbox, stroke_points)
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


def resolve_child_path(folder_path: str | None, visible_name: str | None) -> str | None:
    """Resolve an Explorer UIA item name to a child path when possible."""

    if not folder_path or not visible_name:
        return None
    name = str(visible_name).strip().strip('"')
    if not name:
        return None
    folder = Path(folder_path)
    direct = folder / name
    if direct.exists():
        return str(direct)
    try:
        normalized = name.casefold()
        trimmed = name.rstrip("." + chr(0x2026)).casefold()
        normalized_key = _match_key(name)
        for child in folder.iterdir():
            child_name = child.name.casefold()
            child_stem = child.stem.casefold()
            child_key = _match_key(child.name)
            child_stem_key = _match_key(child.stem)
            if child_name == normalized or child_stem == normalized:
                return str(child)
            if trimmed and (child_name.startswith(trimmed) or child_stem.startswith(trimmed)):
                return str(child)
            if normalized_key and (normalized_key == child_key or normalized_key == child_stem_key):
                return str(child)
            if len(normalized_key) >= 12 and (normalized_key in child_key or child_key in normalized_key):
                return str(child)
    except OSError:
        return None
    return None


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

        # pywin32/pywinauto are often absent on user machines. PowerShell can
        # still access Explorer COM and Windows UI Automation without Python
        # packages, so use it as a no-extra-dependency fallback before giving up.
        if not selected_paths or not ui_items:
            ps_folder, ps_selected, ps_items, ps_messages = self._read_powershell_explorer_state(hwnd)
            if ps_folder and not folder_path:
                folder_path = ps_folder
            if ps_selected and not selected_paths:
                selected_paths = ps_selected
            if ps_items and not ui_items:
                ui_items = ps_items
            traces.append(
                GroundingTrace(
                    self.name + ":powershell",
                    ps_messages,
                    {"folder_path": ps_folder, "selected_paths": ps_selected, "item_count": len(ps_items)},
                )
            )

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

    def _read_powershell_explorer_state(self, hwnd: int) -> tuple[str | None, list[str], list[ExplorerItem], list[str]]:
        messages: list[str] = []
        if not hwnd:
            return None, [], [], ["missing hwnd"]

        script = f"""
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
$hwnd = [int64]{int(hwnd)}
$result = [ordered]@{{
  folder_path = $null
  selected_paths = @()
  items = @()
  messages = @()
}}
function Add-Message([string]$message) {{ $result.messages += $message }}
try {{
  $shell = New-Object -ComObject Shell.Application
  foreach ($window in @($shell.Windows())) {{
    try {{
      if ([int64]$window.HWND -ne $hwnd) {{ continue }}
      try {{
        $folderPath = [string]$window.Document.Folder.Self.Path
        if ($folderPath) {{ $result.folder_path = $folderPath }}
      }} catch {{ Add-Message("powershell folder path unavailable: " + $_.Exception.Message) }}
      try {{
        foreach ($item in @($window.Document.SelectedItems())) {{
          if ($item.Path) {{ $result.selected_paths += [string]$item.Path }}
        }}
      }} catch {{ Add-Message("powershell selected items unavailable: " + $_.Exception.Message) }}
      Add-Message("powershell com matched shell window")
      break
    }} catch {{ }}
  }}
}} catch {{ Add-Message("powershell com failed: " + $_.Exception.Message) }}

try {{
  Add-Type -AssemblyName WindowsBase
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$hwnd)
  if ($null -eq $root) {{
    Add-Message("powershell uia missing root")
  }} else {{
    $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    $limit = [Math]::Min($all.Count, 900)
    for ($i = 0; $i -lt $limit; $i++) {{
      try {{
        $element = $all.Item($i)
        $controlType = [string]$element.Current.ControlType.ProgrammaticName
        if ($controlType -notmatch '(ListItem|DataItem)') {{ continue }}
        $name = ([string]$element.Current.Name).Trim()
        if (-not $name) {{ continue }}
        $rect = $element.Current.BoundingRectangle
        if ($rect.Width -le 0 -or $rect.Height -le 0) {{ continue }}
        $selected = $false
        try {{
          $pattern = $null
          if ($element.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pattern)) {{
            $selected = [bool]$pattern.Current.IsSelected
          }}
        }} catch {{ }}
        $result.items += [ordered]@{{
          name = $name
          bbox = @([int]$rect.Left, [int]$rect.Top, [int]$rect.Right, [int]$rect.Bottom)
          selected = $selected
          control_type = $controlType
        }}
      }} catch {{ }}
    }}
    Add-Message("powershell uia items read: " + $result.items.Count)
  }}
}} catch {{ Add-Message("powershell uia failed: " + $_.Exception.Message) }}

$result | ConvertTo-Json -Depth 6 -Compress
"""
        encoded = base64.b64encode(script.encode("utf-16le")).decode("ascii")
        try:
            proc = subprocess.run(
                ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
                capture_output=True,
                text=True,
                timeout=5,
                encoding="utf-8",
                errors="replace",
            )
        except Exception as exc:
            return None, [], [], [f"powershell probe failed: {type(exc).__name__}: {exc}"]
        if proc.returncode != 0:
            err = (proc.stderr or proc.stdout).strip().replace("\r", " ").replace("\n", " ")[:500]
            return None, [], [], [f"powershell probe exited {proc.returncode}: {err}"]
        try:
            output_lines = [line for line in proc.stdout.splitlines() if line.strip()]
            data = json.loads(output_lines[-1]) if output_lines else {}
        except Exception as exc:
            raw = proc.stdout.strip().replace("\r", " ").replace("\n", " ")[:500]
            return None, [], [], [f"powershell probe invalid json: {type(exc).__name__}: {exc}; raw={raw}"]

        folder_path = data.get("folder_path") if isinstance(data.get("folder_path"), str) else None
        selected_paths = [str(item) for item in _as_list(data.get("selected_paths")) if item]
        raw_messages = _as_list(data.get("messages"))
        messages.extend(str(item) for item in raw_messages)

        items: list[ExplorerItem] = []
        for raw in _as_list(data.get("items")):
            if not isinstance(raw, dict):
                continue
            name = str(raw.get("name") or "").strip()
            bbox_data = raw.get("bbox") or []
            if not name or len(bbox_data) != 4:
                continue
            try:
                bbox: BoundingBox = tuple(int(v) for v in bbox_data)  # type: ignore[assignment]
            except Exception:
                continue
            path = resolve_child_path(folder_path, name)
            items.append(
                ExplorerItem(
                    name=name,
                    path=path,
                    bbox=bbox,
                    selected=bool(raw.get("selected")),
                    source="powershell_uia",
                    metadata={"control_type": raw.get("control_type")},
                )
            )
        return folder_path, selected_paths, items, messages

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
