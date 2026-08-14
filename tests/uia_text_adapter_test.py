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


def _terminal_window() -> dict[str, object]:
    return {
        "hwnd": 1234,
        "pid": 5678,
        "class_name": "CASCADIA_HOSTING_WINDOW_CLASS",
        "title": "Administrator: PowerShell",
    }


def _notepad_window() -> dict[str, object]:
    return {
        "hwnd": 1234,
        "pid": 5678,
        "class_name": "Notepad",
        "title": "some-file.txt - Notepad",
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
    # Word is admitted now. match_window used to gate on UIA_WINDOW_CLASSES, so
    # OpusApp was refused along with Notepad, Explorer and WeChat. Admission is
    # not routing: OfficeAdapter has perception_priority 10 against this
    # adapter's 30, so Word still reads through Office COM first and UIA is only
    # a fallback behind it.
    assert adapter.match_window({"class_name": "OpusApp", "title": "Document - Word"}) is True
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
    assert UiaTextSelectionAdapter().match_window(_terminal_window()) is True
    assert uia_app_from_window(_terminal_window()) == "terminal"


def test_uia_terminal_buffer_becomes_bounded_structural_evidence(monkeypatch) -> None:
    def probe(hwnd, *, target_region=None):
        assert target_region == {"x": 560, "y": 468, "width": 160, "height": 24}
        return UiaProbeResult(True, {
            "ok": True,
            "result_kind": "terminal_buffer",
            "hwnd": 1234,
            "process_id": 5678,
            "root_hwnd": 1234,
            "text": (
                "PS D:\\repo> python verify.py --token secret\n"
                "working\nError: broken\nProcess exited with code 7\nPS D:\\repo>"
            ),
            "terminal_anchor_text": "Error: broken",
            "element_name": "Terminal",
            "control_type": "ControlType.Document",
            "element_rect": [0, 0, 1280, 720],
            "rectangles": [[552, 466, 176, 28]],
            "elapsed_ms": 12,
        })

    monkeypatch.setattr(uia_module, "_run_uia_selection_probe", probe)
    ctx = UiaTextSelectionAdapter().read_context(
        _terminal_window(),
        target_region={"x": 560, "y": 468, "width": 160, "height": 24},
    )

    evidence = ctx.artifacts["terminal_evidence"]
    assert ctx.app == "terminal"
    assert ctx.method == "uia:terminal-text-pattern"
    assert ctx.content == "Error: broken"
    assert ctx.artifacts["selection_rectangles"] == [[552, 466, 176, 28]]
    assert evidence["command"] == "python verify.py --token [redacted]"
    assert evidence["exitCode"] == 7
    assert evidence["anchor"]["text"] == "Error: broken"
    assert "secret" not in str(ctx.to_dict())


def test_uia_document_text_fallback_becomes_structured_content(monkeypatch) -> None:
    """Review R2: an editor without an active selection now yields the whole
    document via the probe's document_text fallback (Notepad incident:
    34,660-char file, zero selection -> previously an empty structured layer
    and a pixel-only object)."""
    monkeypatch.setattr(
        uia_module,
        "_run_uia_selection_probe",
        lambda hwnd: UiaProbeResult(True, {
            "ok": True,
            "result_kind": "document_text",
            "hwnd": 1234,
            "process_id": 5678,
            "root_hwnd": 1234,
            "text": "整篇文档的第一行\n整篇文档的第二行",
            "truncated": False,
            "element_name": "Document",
            "control_type": "ControlType.Document",
            "class_name": "Notepad",
            "element_rect": [100, 200, 800, 600],
            "rectangles": [],
            "elapsed_ms": 15,
        }),
    )
    ctx = UiaTextSelectionAdapter().read_context(_notepad_window())
    assert ctx.app == "application"
    assert ctx.method == "uia:document-text"
    assert ctx.content == "整篇文档的第一行\n整篇文档的第二行"
    assert ctx.artifacts["perception_result_kind"] == "document_text"
    assert ctx.artifacts["selection_rectangles"] == [[100, 200, 800, 600]]
    assert ctx.artifacts["selection_rectangles_coordinate_space"] == "physical_screen_pixels"


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
    assert ctx.artifacts["selection_rectangles_format"] == "xywh"
    assert ctx.artifacts["selection_rectangle_count_total"] == 1
    assert ctx.artifacts["selection_rectangles_truncated"] is False
    assert ctx.artifacts["selection_text_sha256"] == hashlib.sha256(
        b"Selected browser text"
    ).hexdigest()
    assert [cap.name for cap in ctx.capabilities] == ["read_selection"]


def test_uia_context_reads_meaningful_element_under_pointer_before_pixels(monkeypatch) -> None:
    calls = []

    def probe(hwnd, *, target_point=None):
        calls.append((hwnd, target_point))
        return UiaProbeResult(True, {
            "ok": True,
            "result_kind": "point_element",
            "hwnd": 1234,
            "process_id": 5678,
            "root_hwnd": 1234,
            "text": "Save",
            "element_name": "Save",
            "element_value": "",
            "automation_id": "save-button",
            "control_type": "ControlType.Button",
            "localized_control_type": "button",
            "class_name": "Button",
            "element_rect": [100, 200, 84, 32],
            "elapsed_ms": 9,
        })

    monkeypatch.setattr(uia_module, "_run_uia_selection_probe", probe)
    ctx = UiaTextSelectionAdapter().read_context(
        _browser_window(),
        target_point={"x": 120, "y": 216},
    )

    assert calls == [(1234, {"x": 120, "y": 216})]
    assert ctx.content == "Save"
    assert ctx.method == "uia:element-from-point"
    assert ctx.artifacts["element_name"] == "Save"
    assert ctx.artifacts["automation_id"] == "save-button"
    assert ctx.artifacts["selection_rectangles"] == [[100, 200, 84, 32]]
    assert ctx.artifacts["perception_result_kind"] == "point_element"


def test_uia_context_reads_all_bounded_elements_in_an_enclosed_region(monkeypatch) -> None:
    calls = []

    def probe(hwnd, *, target_region=None):
        calls.append((hwnd, target_region))
        return UiaProbeResult(True, {
            "ok": True,
            "result_kind": "region_elements",
            "hwnd": 1234,
            "process_id": 5678,
            "root_hwnd": 1234,
            "text": "当前版本\nMagic Pointer 1.0.0",
            "rectangles": [[100, 200, 120, 28], [100, 236, 190, 28]],
            "rectangle_count_total": 2,
            "region_elements": [
                {"text": "当前版本", "control_type": "ControlType.Text", "rect": [100, 200, 120, 28]},
                {"text": "Magic Pointer 1.0.0", "control_type": "ControlType.Text", "rect": [100, 236, 190, 28]},
            ],
            "elapsed_ms": 12,
        })

    monkeypatch.setattr(uia_module, "_run_uia_selection_probe", probe)
    region = {"x": 80, "y": 180, "width": 240, "height": 110}
    ctx = UiaTextSelectionAdapter().read_context(_browser_window(), target_region=region)

    assert calls == [(1234, region)]
    assert ctx.content == "当前版本\nMagic Pointer 1.0.0"
    assert ctx.method == "uia:region-elements"
    assert ctx.artifacts["perception_result_kind"] == "region_elements"
    assert [item["text"] for item in ctx.artifacts["region_elements"]] == [
        "当前版本", "Magic Pointer 1.0.0",
    ]


def test_uia_probe_source_supports_bounded_element_from_point() -> None:
    source = uia_module.UIA_PROBE_SOURCE.read_text(encoding="utf-8")
    assert "AutomationElement.FromPoint" in source
    assert 'result.ResultKind = "point_element"' in source
    assert "result_kind" in source
    assert "TryTerminalBufferAtPoint" in source
    assert "RegionCenter(targetRegion.Value)" in source
    assert 'result.ResultKind = "terminal_buffer"' in source
    assert "DocumentRange.GetText(MaxTextChars)" in source
    assert "RangeFromPoint(point)" in source
    assert "anchor.GetBoundingRectangles()" in source
    assert "TryRegionElements" in source
    assert 'result.ResultKind = "region_elements"' in source


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
