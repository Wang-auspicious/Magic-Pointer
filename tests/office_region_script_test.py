from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.adapters.office_adapter import (
    _EXCEL_REGION_SCRIPT,
    _EXCEL_SELECTION_SCRIPT,
    office_app_from_window,
)


def _inject_region(region: dict[str, int]) -> str:
    script = _EXCEL_REGION_SCRIPT
    for key, value in region.items():
        script = script.replace("{" + key + "}", str(value))
    return script


def test_excel_region_script_injects_coordinates() -> None:
    script = _inject_region({"region_x": 100, "region_y": 200, "region_w": 300, "region_h": 50})
    assert "{region" not in script
    assert "RangeFromPoint($x1, $y1)" in script
    assert "RangeFromPoint($x2, $y2)" in script
    assert "$excel.Range($r1, $r2)" in script
    assert "com:excel.region-from-point" in script


def test_excel_region_script_keeps_powershell_hashtable() -> None:
    script = _inject_region({"region_x": 1, "region_y": 2, "region_w": 3, "region_h": 4})
    assert "@{" in script
    assert "SetProcessDPIAware" in script


def test_excel_selection_script_is_untouched_fallback() -> None:
    assert "com:excel.selection" in _EXCEL_SELECTION_SCRIPT
    assert "RangeFromPoint" not in _EXCEL_SELECTION_SCRIPT
    assert "SetProcessDPIAware" not in _EXCEL_SELECTION_SCRIPT


def test_office_app_from_window_recognizes_excel() -> None:
    assert office_app_from_window({"class_name": "XLMAIN", "title": "Book1 - Excel"}) == "excel"


def test_excel_point_sampling_skips_com_probe() -> None:
    from app.adapters.office_adapter import OfficeAdapter

    adapter = OfficeAdapter()
    window = {"class_name": "XLMAIN", "title": "Book1 - Excel", "hwnd": 1, "pid": 2}
    context = adapter.read_context(window, target_point={"x": 100, "y": 100})
    assert context.app == "excel"
    assert context.error == "excel_com_skipped_for_point_sampling"
    assert context.content is None
