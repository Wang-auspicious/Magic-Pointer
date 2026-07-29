#!/usr/bin/env python3
"""Deterministically rasterize Magic Pointer's checked-in vector geometry to ICO.

The companion SVG is the reviewable brand source. Pillow renders the same
documented vector primitives at 4x resolution, then writes Windows ICO frames.
Run from the repository root: python assets/app/generate_icon.py
"""
from pathlib import Path
import struct
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent
OUTPUT = ROOT / "icon.ico"
SIZES = (16, 24, 32, 48, 64, 128, 256)
SCALE = 4
CANVAS = 256 * SCALE


def point(x, y):
    return (round(x * SCALE), round(y * SCALE))


def lerp(first, second, fraction):
    return tuple(round(a + (b - a) * fraction) for a, b in zip(first, second))


def draw_gradient_polygon(image, vertices, start, end):
    mask = Image.new("L", image.size, 0)
    ImageDraw.Draw(mask).polygon([point(*vertex) for vertex in vertices], fill=255)
    gradient = Image.new("RGBA", image.size)
    pixels = gradient.load()
    for y in range(CANVAS):
        blend = min(1.0, max(0.0, (y / SCALE - 44) / 144))
        color = lerp(start, end, blend)
        for x in range(CANVAS):
            pixels[x, y] = (*color, 255)
    image.alpha_composite(Image.composite(gradient, Image.new("RGBA", image.size), mask))


def make_icon():
    image = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    trail = ImageDraw.Draw(image, "RGBA")
    # The sampled cubic follows SVG: M37 190 C56 159 78 136 109 116.
    curve = []
    for i in range(61):
        t = i / 60
        u = 1 - t
        x = u**3 * 37 + 3 * u**2 * t * 56 + 3 * u * t**2 * 78 + t**3 * 109
        y = u**3 * 190 + 3 * u**2 * t * 159 + 3 * u * t**2 * 136 + t**3 * 116
        curve.append(point(x, y))
    for width, color in ((15, (99, 102, 241, 135)), (8, (46, 215, 255, 150))):
        trail.line(curve, fill=color, width=width * SCALE, joint="curve")
    for x, y, radius, color in (
        (36, 191, 8, (46, 215, 255, 122)),
        (63, 157, 7, (85, 166, 255, 184)),
        (91, 132, 6, (123, 109, 244, 235)),
    ):
        trail.ellipse((point(x - radius, y - radius), point(x + radius, y + radius)), fill=color)

    pointer = ((76, 44), (195, 98), (139, 120), (117, 188))
    draw_gradient_polygon(image, pointer, (57, 184, 255), (177, 68, 244))
    outline = ImageDraw.Draw(image, "RGBA")
    outline.line([point(*vertex) for vertex in (*pointer, pointer[0])], fill=(238, 247, 255, 255), width=8 * SCALE, joint="curve")
    outline.line([point(119, 111), point(144, 137)], fill=(238, 247, 255, 217), width=7 * SCALE)
    return image


if __name__ == "__main__":
    icon = make_icon()
    # BMP-backed frames are larger than PNG-backed ICO frames, but they remain
    # readable by Windows' legacy and current shell icon decoders.
    icon.save(OUTPUT, format="ICO", sizes=tuple((size, size) for size in SIZES), bitmap_format="bmp")
    # Pillow writes zero into the ICO directory's color-plane field for PNG
    # frames. Windows' native System.Drawing.Icon parser rejects that otherwise
    # valid container, so normalize every directory entry to the ICO-required 1.
    encoded = bytearray(OUTPUT.read_bytes())
    image_count = struct.unpack_from("<H", encoded, 4)[0]
    for index in range(image_count):
        struct.pack_into("<H", encoded, 6 + index * 16 + 4, 1)
    OUTPUT.write_bytes(encoded)
    print(f"wrote {OUTPUT} with frames: {', '.join(map(str, SIZES))}")
