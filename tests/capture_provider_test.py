"""CaptureProvider contract tests (Phase B): selection, honesty, benchmark."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.capture import (  # noqa: E402
    GdiFallbackCaptureProvider,
    WgcWindowCaptureProvider,
    benchmark_provider,
    provider_for,
)


def test_provider_for_defaults_to_gdi(monkeypatch) -> None:
    monkeypatch.delenv("MAGIC_POINTER_CAPTURE_BACKEND", raising=False)
    provider = provider_for(None)
    assert provider.source == "gdi-fallback"
    assert provider.available() is True


def test_provider_for_env_selects_wgc(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("MAGIC_POINTER_CAPTURE_BACKEND", "wgc-window")
    provider = provider_for(None)
    assert provider.source == "wgc-window"


def test_wgc_provider_is_honest_when_tool_missing(tmp_path) -> None:
    provider = WgcWindowCaptureProvider(tool_path=tmp_path / "missing.exe")
    assert provider.available() is False
    assert "wgc_tool_missing" in provider.unavailable_reason
    result = benchmark_provider(provider, (0, 0, 100, 100), samples=3)
    assert result.samples == 0
    assert "wgc_tool_missing" in result.unavailable_reason


def test_benchmark_measures_a_real_backend(tmp_path, monkeypatch) -> None:
    from PIL import Image

    class FakeGdi:
        source = "gdi-fallback"

        def __init__(self) -> None:
            self._unavailable_reason = ""

        def available(self) -> bool:
            return True

        @property
        def unavailable_reason(self) -> str:
            return self._unavailable_reason

        def capture(self, bbox_ltrb):
            return Image.new("RGB", (50, 50), "black")

    result = benchmark_provider(FakeGdi(), (0, 0, 50, 50), samples=5)
    assert result.samples == 5
    assert result.p50_ms >= 0
    assert result.p95_ms >= result.p50_ms
    assert result.p99_ms >= result.p95_ms
    assert result.unavailable_reason == ""


def test_gdi_provider_is_available_on_this_machine() -> None:
    provider = GdiFallbackCaptureProvider()
    assert provider.available() is True
    assert provider.unavailable_reason == ""
