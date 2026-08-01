from __future__ import annotations

import json
import subprocess
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw


ROOT = Path(__file__).resolve().parents[1]
ELECTRON = ROOT / "node_modules" / "electron" / "dist" / "electron.exe"
CAPTURE = ROOT / "scripts" / "capture_live_sweep_visual.js"
OUTPUT = ROOT / "data" / "runtime" / "live-sweep-20260801"


def blue_rows(image: Image.Image) -> list[int]:
    width, height = image.size
    center_y = round(height * (274 / 640))
    crop = image.convert("RGB").crop((
        round(width * 0.17),
        center_y - round(height * 0.085),
        round(width * 0.48),
        center_y + round(height * 0.085),
    ))
    rows: list[int] = []
    for y in range(crop.height):
        count = 0
        for red, green, blue in (crop.getpixel((x, y)) for x in range(crop.width)):
            if blue >= red + 16 and blue >= green + 5 and blue >= 125:
                count += 1
        if count >= 12:
            rows.append(y)
    return rows


def main() -> int:
    if not ELECTRON.exists():
        raise RuntimeError("electron_runtime_not_found")
    subprocess.run([str(ELECTRON), str(CAPTURE)], cwd=ROOT, check=True, timeout=60)

    names = ["baseline", "early", "active", "curve", "released", "clear"]
    images = {name: Image.open(OUTPUT / f"{name}.png").convert("RGB") for name in names}
    active_rows = blue_rows(images["active"])
    if not active_rows:
        raise AssertionError("active sweep has no measurable blue component")
    active_height = max(active_rows) - min(active_rows) + 1

    baseline = images["baseline"]
    clear_diff = ImageChops.difference(baseline, images["clear"])
    clear_bbox = clear_diff.getbbox()
    clear_changed = 0 if clear_bbox is None else sum(
        1 for pixel in clear_diff.getdata() if max(pixel) >= 8
    )
    if active_height < 32 or active_height > 112:
        raise AssertionError(f"blue feather envelope out of bounds: {active_height}px")
    if clear_changed > 20:
        raise AssertionError(f"clear frame retained {clear_changed} changed pixels")

    curve_diff = ImageChops.difference(baseline, images["curve"])
    curve_crop = curve_diff.crop((
        round(curve_diff.width * 0.14),
        round(curve_diff.height * 0.32),
        round(curve_diff.width * 0.62),
        round(curve_diff.height * 0.55),
    ))
    changed_rows = [
        y for y in range(curve_crop.height)
        if sum(1 for x in range(curve_crop.width) if max(curve_crop.getpixel((x, y))) >= 14) >= 12
    ]
    curve_height = max(changed_rows) - min(changed_rows) + 1 if changed_rows else 0
    if curve_height < round(curve_diff.height * 0.07):
        raise AssertionError("freehand fixture collapsed into an unnaturally straight visual band")
    curve_columns = []
    for x in range(curve_crop.width):
        rows = [
            y for y in range(curve_crop.height)
            if max(curve_crop.getpixel((x, y))) >= 14
        ]
        if rows:
            curve_columns.append(max(rows) - min(rows) + 1)
    curve_max_column = max(curve_columns, default=0)
    if curve_max_column > 96:
        raise AssertionError("freehand ribbon produced a self-intersection spike instead of a continuous curve")

    panel_width, panel_height = images["active"].size
    contact = Image.new("RGB", (panel_width * 2, panel_height * 2), "white")
    draw = ImageDraw.Draw(contact)
    for index, name in enumerate(["baseline", "early", "active", "released"]):
        x = (index % 2) * panel_width
        y = (index // 2) * panel_height
        contact.paste(images[name], (x, y))
        draw.rectangle((x + 12, y + 12, x + 116, y + 40), fill="#101722")
        draw.text((x + 22, y + 20), name, fill="white")
    contact_path = OUTPUT / "contact-sheet.png"
    contact.save(contact_path)

    metrics = {
        "passed": True,
        "activeBlueEnvelopePx": active_height,
        "curveVisualHeightPx": curve_height,
        "curveMaxColumnPx": curve_max_column,
        "clearChangedPixels": clear_changed,
        "contactSheet": str(contact_path),
    }
    (OUTPUT / "metrics.json").write_text(
        json.dumps(metrics, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(metrics, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
