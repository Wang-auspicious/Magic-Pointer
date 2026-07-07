from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

from PIL import Image, ImageDraw

from app.system_context import list_visible_windows

Rect = tuple[int, int, int, int]


@dataclass
class WindowObject:
    index: int
    title: str
    class_name: str
    pid: int
    z_order: int
    bbox: Rect
    clipped_bbox: Rect
    intersection_area: int
    selection_coverage: float
    window_coverage: float
    estimated_visible_area: int
    estimated_visible_selection_coverage: float


@dataclass
class ScreenContext:
    selection_bbox: Rect
    windows: list[WindowObject]
    annotated_image_path: Path | None

    def to_prompt_context(self) -> str:
        if not self.windows:
            return ""
        lines = [
            "通用屏幕对象上下文 v1：",
            "这些是系统枚举到的、与用户框选区域相交的可见顶层窗口。",
            "请把它们当作屏幕对象底盘参考；回答窗口/软件/界面/目标位置相关问题时，优先结合这些结构化对象，而不是只凭截图像素猜。",
            f"selection_bbox={self.selection_bbox}",
            "字段：index, title, class_name, pid, z_order(越小越靠上), bbox, clipped_bbox, selection_coverage, window_coverage, estimated_visible_selection_coverage。",
        ]
        for w in self.windows:
            lines.append(
                f"{w.index}. title={w.title!r}, class={w.class_name!r}, pid={w.pid}, z_order={w.z_order}, "
                f"bbox={w.bbox}, clipped_bbox={w.clipped_bbox}, "
                f"selection_coverage={w.selection_coverage:.3f}, window_coverage={w.window_coverage:.3f}, "
                f"estimated_visible_selection_coverage={w.estimated_visible_selection_coverage:.3f}"
            )
        return "\n".join(lines)


def rect_area(r: Rect) -> int:
    return max(0, r[2] - r[0]) * max(0, r[3] - r[1])


def intersect(a: Rect, b: Rect) -> Rect | None:
    r = (max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3]))
    return r if rect_area(r) > 0 else None


def subtract_rect(base: Rect, cutter: Rect) -> list[Rect]:
    """Return rectangles left after subtracting cutter from base."""

    inter = intersect(base, cutter)
    if inter is None:
        return [base]
    x1, y1, x2, y2 = base
    ix1, iy1, ix2, iy2 = inter
    pieces: list[Rect] = []
    # Top
    if y1 < iy1:
        pieces.append((x1, y1, x2, iy1))
    # Bottom
    if iy2 < y2:
        pieces.append((x1, iy2, x2, y2))
    # Left middle
    if x1 < ix1:
        pieces.append((x1, iy1, ix1, iy2))
    # Right middle
    if ix2 < x2:
        pieces.append((ix2, iy1, x2, iy2))
    return [p for p in pieces if rect_area(p) > 0]


def subtract_many(base: Rect, cutters: Iterable[Rect]) -> list[Rect]:
    pieces = [base]
    for cutter in cutters:
        next_pieces: list[Rect] = []
        for piece in pieces:
            next_pieces.extend(subtract_rect(piece, cutter))
        pieces = next_pieces
        if not pieces:
            break
    return pieces


def build_screen_context(selection_bbox: Rect, image_path: Path) -> ScreenContext:
    selection_area = max(1, rect_area(selection_bbox))
    raw = list_visible_windows()
    intersecting: list[dict[str, object]] = []
    for item in raw:
        bbox = item.get("bbox")
        if not (isinstance(bbox, tuple) and len(bbox) == 4):
            continue
        clipped = intersect(selection_bbox, bbox)
        if clipped is None:
            continue
        item = dict(item)
        item["clipped_bbox"] = clipped
        intersecting.append(item)

    # EnumWindows is top-to-bottom z-order. For each window, estimate visible
    # portion by subtracting the clipped rectangles of windows above it.
    windows: list[WindowObject] = []
    above_clips: list[Rect] = []
    for idx, item in enumerate(intersecting, 1):
        bbox = item["bbox"]  # type: ignore[assignment]
        clipped = item["clipped_bbox"]  # type: ignore[assignment]
        if not isinstance(bbox, tuple) or not isinstance(clipped, tuple):
            continue
        visible_pieces = subtract_many(clipped, above_clips)
        visible_area = sum(rect_area(p) for p in visible_pieces)
        area = rect_area(clipped)
        window_area = max(1, rect_area(bbox))
        windows.append(
            WindowObject(
                index=idx,
                title=str(item.get("title", "")),
                class_name=str(item.get("class_name", "")),
                pid=int(item.get("pid", 0) or 0),
                z_order=int(item.get("z_order", idx) or idx),
                bbox=bbox,
                clipped_bbox=clipped,
                intersection_area=area,
                selection_coverage=area / selection_area,
                window_coverage=area / window_area,
                estimated_visible_area=visible_area,
                estimated_visible_selection_coverage=visible_area / selection_area,
            )
        )
        above_clips.append(clipped)

    annotated = annotate_windows(image_path, selection_bbox, windows)
    return ScreenContext(selection_bbox=selection_bbox, windows=windows, annotated_image_path=annotated)


def annotate_windows(image_path: Path, selection_bbox: Rect, windows: list[WindowObject]) -> Path | None:
    if not windows:
        return None
    try:
        img = Image.open(image_path).convert("RGBA")
        overlay = Image.new("RGBA", img.size, (0, 0, 0, 0))
        draw = ImageDraw.Draw(overlay)
        colors = [
            (66, 133, 244, 230),
            (52, 168, 83, 230),
            (251, 188, 5, 235),
            (234, 67, 53, 230),
            (171, 71, 188, 230),
            (0, 172, 193, 230),
        ]
        sx, sy, _, _ = selection_bbox
        for w in windows[:12]:
            color = colors[(w.index - 1) % len(colors)]
            x1, y1, x2, y2 = w.clipped_bbox
            rel = (x1 - sx, y1 - sy, x2 - sx, y2 - sy)
            for inset in range(3):
                draw.rectangle((rel[0] + inset, rel[1] + inset, rel[2] - inset, rel[3] - inset), outline=color, width=1)
            label = str(w.index)
            lx, ly = rel[0] + 4, rel[1] + 4
            draw.rounded_rectangle((lx, ly, lx + 24, ly + 22), radius=5, fill=color)
            draw.text((lx + 7, ly + 2), label, fill=(255, 255, 255, 255))
        out = Image.alpha_composite(img, overlay).convert("RGB")
        annotated_path = image_path.with_name(image_path.stem + ".objects.png")
        out.save(annotated_path)
        return annotated_path
    except Exception:
        return None
