from __future__ import annotations

import os
from pathlib import Path
from typing import Iterable

from PIL import Image, ImageDraw


def make_pointer_annotated_image(
    raw_path: Path,
    out_path: Path,
    bbox: tuple[int, int, int, int],
    points: list[tuple[int, int]],
    *,
    style: str = "pointer",
    element_rectangles: Iterable[Iterable[int | float]] | None = None,
) -> Path:
    """Render a user locator and optional structured-element boxes on a copy."""

    with Image.open(raw_path).convert("RGBA") as base:
        if points:
            local = [(x - bbox[0], y - bbox[1]) for x, y in points]
            overlay = Image.new("RGBA", base.size, (0, 0, 0, 0))
            draw = ImageDraw.Draw(overlay)
            if style == "locator":
                if len(local) >= 2:
                    draw.line(local, fill=(37, 99, 235, 72), width=12, joint="curve")
                    draw.line(local, fill=(219, 234, 254, 235), width=3, joint="curve")
                if local:
                    left = min(point[0] for point in local) - 10
                    top = min(point[1] for point in local) - 10
                    right = max(point[0] for point in local) + 10
                    bottom = max(point[1] for point in local) + 10
                    draw.rounded_rectangle(
                        (left, top, right, bottom), radius=8,
                        outline=(59, 130, 246, 235), width=3,
                        fill=(37, 99, 235, 18),
                    )
                    tag_top = max(0, top - 24)
                    draw.rounded_rectangle(
                        (left, tag_top, left + 48, tag_top + 18), radius=5,
                        fill=(30, 64, 175, 230),
                    )
                    draw.text((left + 7, tag_top + 3), "THIS", fill=(255, 255, 255, 255))
                for index, raw_rectangle in enumerate(element_rectangles or (), 1):
                    values = list(raw_rectangle)
                    if len(values) != 4:
                        continue
                    try:
                        left, top, width, height = (int(round(float(value))) for value in values)
                    except (TypeError, ValueError):
                        continue
                    if width <= 0 or height <= 0:
                        continue
                    rect = (left - bbox[0], top - bbox[1], left - bbox[0] + width, top - bbox[1] + height)
                    draw.rounded_rectangle(rect, radius=4, outline=(103, 232, 249, 220), width=2)
                    if index <= 24:
                        draw.ellipse((rect[0] - 8, rect[1] - 8, rect[0] + 8, rect[1] + 8), fill=(8, 145, 178, 235))
                        draw.text((rect[0] - 3, rect[1] - 6), str(index), fill=(255, 255, 255, 255))
            else:
                if len(local) >= 2:
                    draw.line(local, fill=(96, 165, 250, 70), width=44, joint="curve")
                    draw.line(local, fill=(59, 130, 246, 115), width=24, joint="curve")
                    draw.line(local, fill=(37, 99, 235, 210), width=10, joint="curve")
                    draw.line(local, fill=(220, 238, 255, 240), width=3, joint="curve")
                ex, ey = local[-1]
                arrow = [
                    (ex, ey),
                    (ex + 22, ey + 10),
                    (ex + 11, ey + 15),
                    (ex + 16, ey + 30),
                    (ex + 8, ey + 33),
                    (ex + 2, ey + 17),
                ]
                draw.polygon(arrow, fill=(255, 255, 255, 245), outline=(37, 99, 235, 255))
            base = Image.alpha_composite(base, overlay)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        temporary = out_path.with_suffix(f"{out_path.suffix}.tmp")
        base.convert("RGB").save(temporary, format="PNG")
        os.replace(temporary, out_path)
    return out_path
