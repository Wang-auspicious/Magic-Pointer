from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.actions.policy import LocalPermissionPolicy
from app.actions.schema import ActionProposal, SafetyLevel
from app.adapters import default_adapter_registry, format_adapter_context
from app.adapters.office_adapter import OfficeAdapter, OfficeProbeResult, office_app_from_window
import app.adapters.office_adapter as office_module


def test_office_window_matching() -> None:
    assert office_app_from_window({"class_name": "XLMAIN", "title": "Book1 - Excel"}) == "excel"
    assert office_app_from_window({"class_name": "OpusApp", "title": "Document1 - Word"}) == "word"
    assert office_app_from_window({"class_name": "CabinetWClass", "title": "Desktop - File Explorer"}) is None


def test_registry_skips_overlay_and_reads_first_office_context() -> None:
    windows = [
        {"title": "Magic Pointer Overlay", "class_name": "Chrome_WidgetWin_1"},
        {"title": "Book1 - Excel", "class_name": "XLMAIN", "hwnd": 100},
    ]
    registry = default_adapter_registry()
    assert registry.matching_adapter(windows[0]) is None
    assert registry.matching_adapter(windows[1]) is not None


def test_excel_context_formatting_with_fake_com_probe() -> None:
    original = office_module._run_powershell_json
    try:
        office_module._run_powershell_json = lambda script: OfficeProbeResult(True, {
            "method": "com:excel.selection",
            "hwnd": 123,
            "workbook": r"C:\demo\book.xlsx",
            "worksheet": "Sheet1",
            "address": "A1:B2",
            "row_count": 2,
            "col_count": 2,
            "rows": [
                [{"text": "Name", "value": "Name", "formula": "Name"}, {"text": "Score", "value": "Score", "formula": "Score"}],
                [{"text": "Alice", "value": "Alice", "formula": "Alice"}, {"text": "42", "value": 42, "formula": "42"}],
            ],
            "messages": [],
        })
        ctx = OfficeAdapter().read_context({"class_name": "XLMAIN", "title": "Book1 - Excel", "hwnd": 123})
        assert ctx.app == "excel"
        assert "Alice\t42" in (ctx.content or "")
        rendered = format_adapter_context(ctx)
        assert "Native app adapter context v1" in rendered
        assert "write_selection" in rendered
    finally:
        office_module._run_powershell_json = original


def test_permission_policy_blocks_and_confirms() -> None:
    policy = LocalPermissionPolicy()
    assert policy.decide(ActionProposal(id="r", action_type="read_selection", safety_level=SafetyLevel.READ_ONLY)).requires_confirmation is False
    write = policy.decide(ActionProposal(id="w", action_type="office_write_selection", safety_level=SafetyLevel.LOW))
    assert write.allowed is True
    assert write.requires_confirmation is True
    blocked = policy.decide(ActionProposal(id="d", action_type="delete_file", safety_level=SafetyLevel.DESTRUCTIVE))
    assert blocked.allowed is False


def main() -> None:
    test_office_window_matching()
    test_registry_skips_overlay_and_reads_first_office_context()
    test_excel_context_formatting_with_fake_com_probe()
    test_permission_policy_blocks_and_confirms()
    print("adapter harness test ok")


if __name__ == "__main__":
    main()
