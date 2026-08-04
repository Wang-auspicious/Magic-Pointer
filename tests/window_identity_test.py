"""Identity is hwnd + process. Title and position are state, not identity.

2026-08-04 / 08-05, reported from real use: "截图目标已变化，未保存或外发图像；请重新
指向后重试". The attestation that guards a capture was comparing the window's
**title** and **bbox** alongside its hwnd and pid. Both of those change constantly
and legitimately — WeChat retitles on an incoming message, a terminal retitles on
every command, a window animates when restored — and each change aborted the
capture. Aborting the capture means no pixels, and for the very apps that expose
nothing to UI Automation (WeChat 4.x is one opaque render surface; so are most Qt
and self-drawing apps) pixels are the *only* path. So a title change was taking
the whole feature down.

The safety this guard exists for is real: we must never hand the user pixels of a
different window. Every pre-existing test for it changes `hwnd` or `desktop_id` —
never a title alone — which is the guard's actual intent.
"""

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.adapters.base import AdapterReadContext  # noqa: E402
from scripts.selection_snapshot_bridge import (  # noqa: E402
    _same_window_geometry,
    _same_window_identity,
    _window_identity,
    capture_snapshot,
)


class _FakeAdapter:
    def read_context(self, window, **_kwargs):
        return AdapterReadContext(
            adapter="uia_text_selection",
            app="word",
            window=window,
            content="被选中的一段文字",
            method="uia:text-pattern.selection",
            artifacts={"selection_text_chars": 8},
        )


class _FakeRegistry:
    def __init__(self, supported=True):
        self.supported = supported
        self.seen = []

    def matching_adapter(self, window):
        self.seen.append(window)
        return _FakeAdapter() if self.supported else None


WINDOW = {
    "title": "文件传输助手",
    "hwnd": 20,
    "pid": 42,
    "process_name": "Weixin.exe",
    "desktop_id": "desktop-1",
    "bbox": (100, 200, 1100, 900),
}


def _grabber(calls):
    def grab(*, bbox, all_screens):
        calls.append((bbox, all_screens))
        return Image.new("RGB", (bbox[2] - bbox[0], bbox[3] - bbox[1]), "white")
    return grab


# --- the policy ------------------------------------------------------------


def test_a_retitled_window_is_the_same_window() -> None:
    expected = _window_identity(WINDOW)
    retitled = _window_identity({**WINDOW, "title": "文件传输助手 (3)"})
    assert _same_window_identity(expected, retitled) is True


def test_a_moved_window_is_the_same_window() -> None:
    expected = _window_identity(WINDOW)
    moved = _window_identity({**WINDOW, "bbox": (140, 260, 1140, 960)})
    assert _same_window_identity(expected, moved) is True
    # ...but its pixels are somewhere else now, and that is a separate question.
    assert _same_window_geometry(expected, moved) is False


def test_a_different_hwnd_is_a_different_window() -> None:
    assert _same_window_identity(
        _window_identity(WINDOW),
        _window_identity({**WINDOW, "hwnd": 99}),
    ) is False


def test_a_different_process_is_a_different_window() -> None:
    assert _same_window_identity(
        _window_identity(WINDOW),
        _window_identity({**WINDOW, "pid": 99}),
    ) is False
    assert _same_window_identity(
        _window_identity(WINDOW),
        _window_identity({**WINDOW, "process_name": "notepad.exe"}),
    ) is False


def test_another_virtual_desktop_is_a_different_target() -> None:
    assert _same_window_identity(
        _window_identity(WINDOW),
        _window_identity({**WINDOW, "desktop_id": "desktop-2"}),
    ) is False


def test_geometry_comparison_tolerates_a_missing_bbox() -> None:
    # Adapters that do not report geometry must not be treated as "moved".
    assert _same_window_geometry(_window_identity(WINDOW), _window_identity({**WINDOW, "bbox": None})) is True


# --- end to end through capture_snapshot -----------------------------------


def test_a_title_change_during_capture_no_longer_throws_the_pixels_away(tmp_path) -> None:
    """The reported failure. A new WeChat message must not cost the user their capture."""
    calls = []
    payload = capture_snapshot(
        [WINDOW],
        registry=_FakeRegistry(supported=False),
        target_point={"x": 600, "y": 500},
        visual_capture=_grabber(calls),
        capture_dir=tmp_path,
        identity_probe=lambda: {**WINDOW, "title": "文件传输助手 (3)"},
    )
    snapshot = payload["selectionSnapshot"]
    assert snapshot["status"] != "target_mismatch"
    assert snapshot["capture_path"] is not None
    assert Path(snapshot["capture_path"]).is_file()
    assert snapshot["capture_attestation"]["status"] == "verified"
    assert len(calls) == 1


def test_a_window_that_moved_is_recaptured_where_it_now_is(tmp_path) -> None:
    # Far enough that the region, which is clamped inside the window, has to move
    # with it. A small nudge legitimately produces the same pointer-centred box.
    moved = {**WINDOW, "bbox": (500, 400, 1500, 1100)}
    calls = []
    payload = capture_snapshot(
        [WINDOW],
        registry=_FakeRegistry(supported=False),
        target_point={"x": 600, "y": 500},
        visual_capture=_grabber(calls),
        capture_dir=tmp_path,
        identity_probe=lambda: moved,
    )
    snapshot = payload["selectionSnapshot"]
    assert snapshot["status"] != "target_mismatch"
    assert snapshot["capture_path"] is not None
    # Grabbed twice: once where it was, once where it turned out to be.
    assert len(calls) == 2
    assert calls[0][0] != calls[1][0]
    # And the region we kept is the one taken against its current position.
    assert snapshot["capture_bbox"] == list(calls[1][0])
    assert snapshot["capture_attestation"]["status"] == "verified"
    assert snapshot["capture_attestation"]["recaptured"] is True


def test_a_window_that_keeps_moving_is_still_reported_honestly(tmp_path) -> None:
    """Two drifting reads in a row means we cannot vouch for the pixels."""
    boxes = iter([
        {**WINDOW, "bbox": (140, 260, 1140, 960)},
        {**WINDOW, "bbox": (180, 300, 1180, 1000)},
        {**WINDOW, "bbox": (220, 340, 1220, 1040)},
        {**WINDOW, "bbox": (260, 380, 1260, 1080)},
    ])
    payload = capture_snapshot(
        [WINDOW],
        registry=_FakeRegistry(supported=False),
        target_point={"x": 600, "y": 500},
        visual_capture=_grabber([]),
        capture_dir=tmp_path,
        identity_probe=lambda: next(boxes),
    )
    snapshot = payload["selectionSnapshot"]
    assert snapshot["capture_attestation"]["status"] == "geometry_unstable"
    # Still a capture: an unstable window is a reason to caveat, not to refuse.
    assert snapshot["capture_path"] is not None


def test_a_different_window_still_refuses_and_writes_nothing(tmp_path) -> None:
    calls = []
    payload = capture_snapshot(
        [WINDOW],
        registry=_FakeRegistry(supported=False),
        target_point={"x": 600, "y": 500},
        visual_capture=_grabber(calls),
        capture_dir=tmp_path,
        identity_probe=lambda: {**WINDOW, "hwnd": 99},
    )
    snapshot = payload["selectionSnapshot"]
    assert snapshot["status"] == "target_mismatch"
    assert snapshot["capture_path"] is None
    assert calls == []
    assert list(tmp_path.glob("*.png")) == []


def test_a_structured_read_survives_a_retitle(tmp_path) -> None:
    payload = capture_snapshot(
        [WINDOW],
        registry=_FakeRegistry(),
        target_point={"x": 600, "y": 500},
        identity_probe=lambda: {**WINDOW, "title": "文件传输助手 (3)"},
        allow_visual_fallback=False,
    )
    snapshot = payload["selectionSnapshot"]
    assert snapshot["status"] != "target_mismatch"
    assert snapshot["context"] is not None
