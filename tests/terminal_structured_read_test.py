"""Terminal structured-read regression tests (real-machine fix 2026-08-13).

Real-machine findings that these tests pin:
- ``uia_text_adapter`` used ``time.monotonic`` without importing ``time``
  -> every resident-host probe crashed with NameError and every read fell
  back to OCR (pixel) silently.
- Windows Terminal's ``DocumentRange.GetText`` throws or returns
  whitespace for a healthy buffer -> the probe's terminal path must fall
  back to the RangeFromPoint line-window read (C# side, covered by the
  real-machine scenario; here the Python mapping is pinned).
- terminal_buffer results must survive the adapter mapping into a
  non-empty AdapterReadContext instead of degrading to identity_only.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def test_resident_probe_path_does_not_raise_name_error() -> None:
    """The resident-host funnel must never crash on a missing import
    (real bug: time.monotonic NameError killed the whole UIA path)."""
    import app.adapters.uia_text_adapter as module

    # The module must import time for the spawn cooldown logic.
    assert hasattr(module, "time"), "uia_text_adapter must import time"


def test_terminal_buffer_probe_maps_to_non_empty_context(monkeypatch) -> None:
    """A healthy terminal_buffer probe result becomes a readable context."""
    from app.adapters.uia_text_adapter import UiaProbeResult, UiaTextSelectionAdapter

    data = {
        "ok": True,
        "result_kind": "terminal_buffer",
        "hwnd": 123,
        "root_hwnd": 123,
        "process_id": 456,
        "text": (
            "\n\n  1. T1 预算掐死循环\n  2. T2 证据前置注入矛盾\n"
            "  3. T3 全量确认侵蚀承诺\n\n"
        ),
        "terminal_anchor_text": "2. T2 证据前置注入矛盾",
        "element_rect": [10, 200, 1200, 800],
        "rectangles": [[10, 260, 600, 20]],
        "rectangle_count_total": 1,
        "element_name": "Windows PowerShell",
        "class_name": "TermControl",
        "control_type": "ControlType.Text",
        "elapsed_ms": 42,
    }
    monkeypatch.setattr(
        "app.adapters.uia_text_adapter._run_uia_selection_probe",
        lambda *args, **kwargs: UiaProbeResult(True, data),
    )
    context = UiaTextSelectionAdapter().read_context(
        {
            "hwnd": 123,
            "title": "Windows PowerShell",
            "class_name": "CASCADIA_HOSTING_WINDOW_CLASS",
            "process_name": "WindowsTerminal.exe",
            "pid": 456,
        },
        target_point={"x": 300, "y": 300},
    )
    assert context is not None
    assert context.content and context.content.strip(), "terminal content must not be empty"
    assert "T2" in context.content
    artifacts = context.artifacts or {}
    assert int(artifacts.get("terminal_buffer_chars") or 0) > 0
    assert artifacts.get("perception_result_kind") == "terminal_buffer"


def test_terminal_buffer_evidence_extractor_handles_blank_anchor() -> None:
    """Blank anchor line must not zero out the window text (real scenario)."""
    from app.grounding.terminal_evidence import TerminalEvidenceExtractor

    raw = (
        "  1. 第一条内容\n  2. 第二条内容\n  3. 第三条内容\n"
        "\n  结束行\n"
    )
    evidence = TerminalEvidenceExtractor().extract(
        raw, method="uia:terminal-text-pattern", anchor_text=""
    )
    window_text = str((evidence.get("window") or {}).get("text") or "")
    assert window_text.strip(), "window text must survive a blank anchor"
