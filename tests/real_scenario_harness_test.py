from __future__ import annotations

from PIL import Image, ImageDraw

from scripts.real_scenario_test import (
    _lease_with_mismatched_target_hwnd,
    _scenario_window,
    _unicode_code_units,
    image_has_visible_document_content,
    select_document_window,
    virtual_screen_bounds,
    wait_for_foreground,
    window_scale_factor,
)


class _Clock:
    def __init__(self, values: list[float]) -> None:
        self._values = iter(values)
        self._last = values[-1]

    def __call__(self) -> float:
        try:
            self._last = next(self._values)
        except StopIteration:
            pass
        return self._last


def test_wait_for_foreground_requires_the_requested_hwnd() -> None:
    observed = iter([11, 11, 42])
    assert wait_for_foreground(
        42,
        reader=lambda: next(observed),
        clock=_Clock([0.0, 0.1, 0.2, 0.3]),
        sleeper=lambda _delay: None,
        timeout=0.5,
    ) is True


def test_wait_for_foreground_times_out_instead_of_capturing_wrong_window() -> None:
    assert wait_for_foreground(
        42,
        reader=lambda: 11,
        clock=_Clock([0.0, 0.1, 0.6]),
        sleeper=lambda _delay: None,
        timeout=0.5,
    ) is False


def test_virtual_screen_bounds_use_origin_plus_size() -> None:
    metrics = {76: -1920, 77: -200, 78: 5760, 79: 2360}
    assert virtual_screen_bounds(lambda key: metrics[key]) == [
        -1920,
        -200,
        3840,
        2160,
    ]


def test_window_scale_factor_uses_window_dpi() -> None:
    assert window_scale_factor(42, dpi_reader=lambda _hwnd: 192) == 2.0
    assert window_scale_factor(42, dpi_reader=lambda _hwnd: 0) == 1.0


def test_unicode_input_preserves_non_bmp_characters_as_utf16_units() -> None:
    assert _unicode_code_units("A中😀") == [0x0041, 0x4E2D, 0xD83D, 0xDE00]


def test_scenario_window_preserves_real_process_identity() -> None:
    observed = {
        "hwnd": 42,
        "pid": 771,
        "process_name": "notepad.exe",
        "title": "Notes - Notepad",
        "class_name": "Notepad",
    }
    assert _scenario_window(observed, [10, 20, 810, 620]) == {
        "hwnd": 42,
        "pid": 771,
        "process_name": "notepad.exe",
        "title": "Notes - Notepad",
        "class_name": "Notepad",
        "rect": [10, 20, 810, 620],
    }


def test_select_document_window_never_reuses_an_unrelated_notepad_tab() -> None:
    windows = [
        {
            "hwnd": 11,
            "title": "reward-secrets.json - Notepad",
            "class_name": "Notepad",
            "bbox": [0, 0, 900, 1200],
        },
        {
            "hwnd": 42,
            "title": "mp-notepad-crossref-123.txt - Notepad",
            "class_name": "Notepad",
            "bbox": [0, 0, 800, 1000],
        },
    ]

    selected = select_document_window(windows, "mp-notepad-crossref-123.txt")

    assert selected is not None
    assert selected["hwnd"] == 42
    assert select_document_window(windows, "missing.txt") is None


def test_visible_document_content_rejects_blank_client_and_accepts_text() -> None:
    blank = Image.new("RGB", (800, 1000), (31, 31, 31))
    with_text = blank.copy()
    ImageDraw.Draw(with_text).text((40, 200), "Magic Pointer 3.6s", fill="white")

    assert image_has_visible_document_content(blank) is False
    assert image_has_visible_document_content(with_text) is True


def test_mismatch_probe_changes_only_cloned_lease_target_hwnd() -> None:
    lease = {
        "frameLeaseId": "lease-1",
        "targetWindow": {
            "hwnd": 42,
            "processId": 771,
            "processName": "notepad.exe",
            "title": "Scenario - Notepad",
        },
        "localArtifact": {"path": "frame.png"},
    }

    mismatched = _lease_with_mismatched_target_hwnd(lease)

    assert lease["targetWindow"]["hwnd"] == 42
    assert mismatched["targetWindow"]["hwnd"] != 42
    assert mismatched["targetWindow"]["processId"] == 771
    assert mismatched["localArtifact"] == lease["localArtifact"]
