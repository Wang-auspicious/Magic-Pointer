
from types import SimpleNamespace

import pytest

import app.agent_runtime.wait_tool as wait_module
from app.agent_runtime.wait_tool import WaitTool


def _clock(monkeypatch):
    clock = SimpleNamespace(now=100.0)

    def advance(seconds):
        clock.now += seconds

    monkeypatch.setattr(
        wait_module, "time", SimpleNamespace(monotonic=lambda: clock.now, sleep=advance)
    )
    return clock


def test_satisfied_wait_reports_probe_duration_instead_of_timeout(monkeypatch):
    clock = _clock(monkeypatch)

    def windows():
        clock.now += 0.125
        return [{"hwnd": 1, "title": "Report ready"}]

    result = WaitTool(windows_probe=windows, elements_probe=lambda _: []).wait(
        window_title="Report", timeout_s=20
    )
    assert result["satisfied"] is True
    assert result["elapsed_s"] == pytest.approx(0.125)


def test_timeout_reports_actual_time_spent_in_slow_probe(monkeypatch):
    clock = _clock(monkeypatch)

    def windows():
        clock.now += 0.4
        return []

    result = WaitTool(windows_probe=windows, elements_probe=lambda _: []).wait(
        window_title="Report", timeout_s=0.2
    )
    assert result["satisfied"] is False
    assert result["elapsed_s"] == pytest.approx(0.4)


def test_element_timeout_identifies_condition_not_window_filter(monkeypatch):
    _clock(monkeypatch)
    result = WaitTool(
        windows_probe=lambda: [{"hwnd": 1, "title": "Report"}],
        elements_probe=lambda _: [],
    ).wait(window_title="Report", element_text="Saved", timeout_s=0.1)
    assert result["satisfied"] is False
    assert result["condition"] == "element_text"
