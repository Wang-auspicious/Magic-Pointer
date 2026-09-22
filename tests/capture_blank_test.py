
from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.selection_snapshot_bridge import _capture_is_blank  # noqa: E402


def _flat(colour) -> Image.Image:
    return Image.new("RGB", (400, 300), colour)


def test_the_wechat_capture_that_produced_no_result_is_recognised_as_blank() -> None:
    assert _capture_is_blank(_flat((42, 42, 42))) is True


def test_a_pure_black_compositor_frame_is_still_caught() -> None:
    assert _capture_is_blank(_flat((0, 0, 0))) is True
    assert _capture_is_blank(_flat((2, 1, 0))) is True


def test_a_flat_white_frame_is_just_as_useless() -> None:
    assert _capture_is_blank(_flat((255, 255, 255))) is True


def test_a_window_with_any_real_content_is_not_blank() -> None:
    image = _flat((42, 42, 42))
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
    image = _flat((42, 42, 42))
    image.putpixel((10, 10), (43, 42, 42))
    image.putpixel((20, 20), (41, 42, 43))
    assert _capture_is_blank(image) is True


def test_a_broken_image_object_is_not_reported_as_blank() -> None:
    assert _capture_is_blank(None) is False
    assert _capture_is_blank("not an image") is False
