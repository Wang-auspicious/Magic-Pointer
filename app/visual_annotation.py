from __future__ import annotations

import os
from pathlib import Path

from PIL import Image, ImageDraw


def make_pointer_annotated_image(
    raw_path: Path,
    out_path: Path,
    bbox: tuple[int, int, int, int],
    points: list[tuple[int, int]],
) -> Path:
    """Render the user's pointer path and final cursor tip onto a local crop."""

    with Image.open(raw_path).convert("RGBA") as base:
        if points:
            local = [(x - bbox[0], y - bbox[1]) for x, y in points]
            overlay = Image.new("RGBA", base.size, (0, 0, 0, 0))
            draw = ImageDraw.Draw(overlay)
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
