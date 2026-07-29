from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SOURCE = (ROOT / "scripts" / "uia_selection_probe.cs").read_text(encoding="utf-8")


def test_native_text_selection_must_cover_the_supplied_pointer() -> None:
    assert "SelectionCoversTargetPoint" in SOURCE
    assert SOURCE.count("RejectSelectionOutsideTargetPoint") >= 3
    assert "selection_outside_target_point" in SOURCE


def test_rejected_stale_selection_falls_through_to_element_from_point() -> None:
    rejection = SOURCE.index("RejectSelectionOutsideTargetPoint")
    point_fallback = SOURCE.index("TryPointElement(root, targetPoint.Value, result)")
    assert rejection < point_fallback


def test_element_from_point_never_returns_a_catch_all_window_rectangle() -> None:
    assert "IsCatchAllPointElement" in SOURCE
    assert "SameElement(element, root)" in SOURCE
    assert "rootRectangle.Width * 0.90" in SOURCE


def test_element_from_point_accepts_chromium_renderer_descendants() -> None:
    point_block = SOURCE.split("private static void TryPointElement", 1)[1].split(
        "private static bool IsCatchAllPointElement", 1
    )[0]
    assert "BelongsToWindowTree(element, root)" in point_block
    assert "SafeProcessId(element) != result.ProcessId" not in point_block
    assert "SafeProcessId(focused) == result.ProcessId" not in SOURCE
    assert "GetAncestor(candidateHwnd, 2)" in SOURCE
    assert "IsChild(rootHwnd, candidateHwnd)" in SOURCE
