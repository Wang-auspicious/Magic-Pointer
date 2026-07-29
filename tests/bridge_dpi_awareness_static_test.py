from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_capture_bridges_enable_dpi_awareness_before_windows_queries() -> None:
    for relative in ("scripts/selection_snapshot_bridge.py", "scripts/electron_bridge.py"):
        source = (ROOT / relative).read_text(encoding="utf-8")
        assert "enable_dpi_awareness()" in source, relative
        assert source.index("enable_dpi_awareness()") < source.index("def "), relative
