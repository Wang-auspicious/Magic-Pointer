"""A featureless window capture is a failed capture, whatever its colour.

2026-08-05, reported from real use: underlining a WeChat message a second time
produced "no result at all". The capture on disk explains it — a solid dark-grey
rectangle exactly where WeChat was, surrounded by white. Zero OCR blocks, so zero
content, so nothing to answer with.

`ImageGrab.grab(window=hwnd)` is PrintWindow, and PrintWindow does not composite
hardware-rendered surfaces. WeChat 4.x paints its chat area into
`MMUIRenderSubWindowHW` — the HW is not decoration — and the same is true of
GPU-accelerated Electron, Qt, Flutter and games. **These are the same apps that
expose nothing to UI Automation**, so both of our reading paths were failing on
exactly the windows that need them most.

The desktop grab does composite: it returns what is genuinely on screen. The code
already fell back to it when the window grab looked blank; the blank check just
demanded pure black (`max <= 2` per channel) and WeChat's grey is 42.
"""

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.selection_snapshot_bridge import _capture_is_blank  # noqa: E402


def _flat(colour) -> Image.Image:
    return Image.new("RGB", (400, 300), colour)


def test_the_wechat_capture_that_produced_no_result_is_recognised_as_blank() -> None:
    # The measured colour of the dead WeChat capture.
    assert _capture_is_blank(_flat((42, 42, 42))) is True


def test_a_pure_black_compositor_frame_is_still_caught() -> None:
    assert _capture_is_blank(_flat((0, 0, 0))) is True
    assert _capture_is_blank(_flat((2, 1, 0))) is True


def test_a_flat_white_frame_is_just_as_useless() -> None:
    assert _capture_is_blank(_flat((255, 255, 255))) is True


def test_a_window_with_any_real_content_is_not_blank() -> None:
    image = _flat((42, 42, 42))
    # One line of lighter text is enough variation to be a real capture.
    for x in range(40, 360):
        image.putpixel((x, 150), (230, 230, 230))
    assert _capture_is_blank(image) is False


def test_a_faint_but_present_gradient_is_not_blank() -> None:
    image = Image.new("RGB", (400, 300))
    for y in range(300):
        for x in range(400):
            image.putpixel((x, y), (40 + x // 20, 40, 40))
    assert _capture_is_blank(image) is False


def test_noise_below_the_threshold_still_counts_as_blank() -> None:
    """Compression and rounding leave a point or two of jitter in a dead frame."""
    image = _flat((42, 42, 42))
    image.putpixel((10, 10), (43, 42, 42))
    image.putpixel((20, 20), (41, 42, 43))
    assert _capture_is_blank(image) is True


def test_a_broken_image_object_is_not_reported_as_blank() -> None:
    assert _capture_is_blank(None) is False
    assert _capture_is_blank("not an image") is False
