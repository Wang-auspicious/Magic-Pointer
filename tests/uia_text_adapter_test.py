from __future__ import annotations

import hashlib

import app.adapters.uia_text_adapter as uia_module
from app.adapters.pdf_selection_recovery import PdfSelectionRecovery
from app.adapters.uia_text_adapter import (
    UiaProbeResult,
    UiaTextSelectionAdapter,
    uia_app_from_window,
)


def _browser_window() -> dict[str, object]:
    return {
        "hwnd": 1234,
        "pid": 5678,
        "class_name": "Chrome_WidgetWin_1",
        "title": "Example - Microsoft Edge",
    }


def _pdf_window() -> dict[str, object]:
    return {
        "hwnd": 1234,
        "pid": 5678,
        "class_name": "Chrome_WidgetWin_1",
        "title": "paper.pdf - Microsoft Edge",
    }


def test_uia_window_matching_and_app_classification() -> None:
    adapter = UiaTextSelectionAdapter()
    assert adapter.match_window(_browser_window()) is True
    assert adapter.match_window({
        "class_name": "Chrome_WidgetWin_1",
        "title": "Magic Pointer UIA Selection Fixture - Microsoft Edge",
    }) is True
    assert adapter.match_window({
        "class_name": "Chrome_WidgetWin_1",
        "title": "Magic Pointer Panel",
    }) is False
    assert adapter.match_window({"class_name": "OpusApp", "title": "Document - Word"}) is False
    assert uia_app_from_window(_browser_window()) == "browser"
    assert uia_app_from_window({
        "class_name": "Chrome_WidgetWin_1",
        "title": "paper.pdf - Microsoft Edge",
    }) == "pdf"
    assert uia_app_from_window({
        "class_name": "AcrobatSDIWindow",
        "title": "paper.pdf - Adobe Acrobat",
    }) == "pdf"
    assert uia_app_from_window({
        "class_name": "Chrome_WidgetWin_1",
        "title": "ChatGPT",
    }) == "application"
    assert uia_app_from_window({
        "class_name": "Chrome_WidgetWin_1",
        "title": "How to read .pdf files - Microsoft Edge",
    }) == "browser"


def test_uia_context_exposes_read_only_native_selection(monkeypatch) -> None:
    monkeypatch.setattr(
        uia_module,
        "_run_uia_selection_probe",
        lambda hwnd: UiaProbeResult(True, {
            "ok": True,
            "hwnd": 1234,
            "process_id": 5678,
            "root_hwnd": 1234,
            "text": "Selected browser text",
            "truncated": False,
            "range_count": 1,
            "rectangle_count_total": 1,
            "rectangles_truncated": False,
            "element_name": "Example",
            "automation_id": "RootWebArea",
            "control_type": "ControlType.Document",
            "rectangles": [[10, 20, 300, 40]],
            "elapsed_ms": 24,
        }),
    )
    ctx = UiaTextSelectionAdapter().read_context(_browser_window())
    assert ctx.app == "browser"
    assert ctx.content == "Selected browser text"
    assert ctx.method == "uia:text-pattern.selection"
    assert ctx.artifacts["source_hwnd"] == 1234
    assert ctx.artifacts["source_pid"] == 5678
    assert ctx.artifacts["selection_rectangles"] == [[10, 20, 300, 40]]
    assert ctx.artifacts["selection_rectangles_coordinate_space"] == "physical_screen_pixels"
    assert ctx.artifacts["selection_rectangle_count_total"] == 1
    assert ctx.artifacts["selection_rectangles_truncated"] is False
    assert ctx.artifacts["selection_text_sha256"] == hashlib.sha256(
        b"Selected browser text"
    ).hexdigest()
    assert [cap.name for cap in ctx.capabilities] == ["read_selection"]


def test_uia_context_rejects_foreground_identity_mismatch(monkeypatch) -> None:
    monkeypatch.setattr(
        uia_module,
        "_run_uia_selection_probe",
        lambda hwnd: UiaProbeResult(True, {
            "ok": True,
            "hwnd": 1234,
            "process_id": 9999,
            "root_hwnd": 1234,
            "text": "Wrong process",
        }),
    )
    ctx = UiaTextSelectionAdapter().read_context(_browser_window())
    assert ctx.content is None
    assert ctx.error == "UI Automation selection identity did not match the foreground window."


def test_uia_context_fails_closed_when_no_selection_is_exposed(monkeypatch) -> None:
    monkeypatch.setattr(
        uia_module,
        "_run_uia_selection_probe",
        lambda hwnd: UiaProbeResult(
            False,
            {
                "ok": False,
                "hwnd": 1234,
                "root_hwnd": 1234,
                "process_id": 5678,
                "elapsed_ms": 20,
            },
            "No non-empty UI Automation text selection was exposed.",
        ),
    )
    ctx = UiaTextSelectionAdapter().read_context(_browser_window())
    assert ctx.content is None
    assert ctx.error is None


def test_uia_context_rejects_root_window_mismatch(monkeypatch) -> None:
    monkeypatch.setattr(
        uia_module,
        "_run_uia_selection_probe",
        lambda hwnd: UiaProbeResult(True, {
            "ok": True,
            "hwnd": 1234,
            "root_hwnd": 4321,
            "process_id": 5678,
            "text": "Wrong browser window",
        }),
    )
    ctx = UiaTextSelectionAdapter().read_context(_browser_window())
    assert ctx.content is None
    assert ctx.error == "UI Automation selection identity did not match the foreground window."


def test_chromium_pdf_uses_verified_visible_text_and_context(monkeypatch) -> None:
    monkeypatch.setattr(
        uia_module,
        "_run_uia_selection_probe",
        lambda hwnd: UiaProbeResult(True, {
            "ok": True,
            "hwnd": 1234,
            "process_id": 5678,
            "root_hwnd": 1234,
            "text": "multi-task learning framework for carotid p",
            "truncated": False,
            "range_count": 1,
            "rectangle_count_total": 2,
            "rectangles_truncated": False,
            "rectangles": [[322, 528, 1133, 74], [237, 602, 35, 75]],
            "elapsed_ms": 1308,
        }),
    )
    monkeypatch.setattr(
        uia_module,
        "recover_local_pdf_selection",
        lambda data: PdfSelectionRecovery(
            True,
            text="A multi-task learning framework for carotid",
            context=(
                "A multi-task learning framework for carotid\n"
                "plaque segmentation and classification from\n"
                "ultrasound images"
            ),
            rectangles=((261.0, 528.0, 1192.0, 74.0),),
            document_path=r"D:\paper.pdf",
            page_number=1,
            uia_matching_core="multi-task learning framework for carotid",
            dropped_uia_rectangle_count=1,
        ),
    )

    ctx = UiaTextSelectionAdapter().read_context(_pdf_window())

    assert ctx.content == "A multi-task learning framework for carotid"
    assert ctx.method == "pdf:screen-highlight+local-text-layer"
    assert ctx.artifacts["selection_context"].endswith("ultrasound images")
    assert ctx.artifacts["selection_rectangles"] == [
        [261.0, 528.0, 1192.0, 74.0]
    ]
    assert ctx.artifacts["pdf_dropped_uia_rectangle_count"] == 1
    assert ctx.artifacts["uia_selection_text_chars"] == 43


def test_chromium_pdf_fails_closed_when_visible_text_cannot_be_verified(
    monkeypatch,
) -> None:
    monkeypatch.setattr(
        uia_module,
        "_run_uia_selection_probe",
        lambda hwnd: UiaProbeResult(True, {
            "ok": True,
            "hwnd": 1234,
            "process_id": 5678,
            "root_hwnd": 1234,
            "text": "possibly wrong text",
            "range_count": 1,
            "rectangle_count_total": 1,
            "rectangles": [[10, 20, 100, 30]],
        }),
    )
    monkeypatch.setattr(
        uia_module,
        "recover_local_pdf_selection",
        lambda data: PdfSelectionRecovery(
            False,
            document_path=r"D:\paper.pdf",
            page_number=1,
            error="visual mismatch",
        ),
    )

    ctx = UiaTextSelectionAdapter().read_context(_pdf_window())

    assert ctx.content is None
    assert ctx.method == "pdf:verified-visible-selection"
    assert ctx.error == (
        "The visible Chromium PDF selection could not be verified "
        "against the local document text layer."
    )
    assert ctx.artifacts["pdf_recovery_error"] == "visual mismatch"
