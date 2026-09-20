"""Behavior regressions from CU01–CU27; never operate a real desktop."""
from __future__ import annotations

import json
from types import SimpleNamespace

import pytest

from app.agent_runtime.errors import ActionFailure
from app.computer_operator.windows import Win32InputDriver
from app.desktop_actions.session import DesktopActionSession
from app.desktop_actions import uia


WINDOW = {"hwnd": 42, "pid": 7, "rect": [0, 0, 1000, 1000], "title": "Editor"}


class Driver:
    def __init__(self): self.calls = []
    def click(self, point, **kwargs): self.calls.append(("click", point))
    def scroll(self, point, **kwargs): self.calls.append(("scroll", point, kwargs))
    def type_text(self, value): self.calls.append(("type", value))
    def key_down(self, key):
        if key == "unsupported": raise ValueError("unsupported_key")
        self.calls.append(("down", key))
    def key_up(self, key): self.calls.append(("up", key))
    def drag(self, start, end, **kwargs): self.calls.append(("drag", start, end, kwargs))


def element(index=1, **kwargs):
    return {"index": index, "role": "edit", "name": "Body", "value": "prefix", "rect": [20, 30 + index, 500, 60 + index], "patterns": ["Value"], "runtime_id": [42, index], **kwargs}


def session(rows=None, **overrides):
    kwargs = dict(driver=Driver(), windows_probe=lambda: [dict(WINDOW)], elements_probe=lambda _: rows if rows is not None else [element()], launcher=lambda _: {}, uia_act=lambda *args: {"ok": False}, session_id="audit")
    kwargs.update(overrides)
    return DesktopActionSession(**kwargs)


def observe(s): return json.loads(s.get_app_state())["snapshot_id"]


def test_focus_missing_driver_capability_is_not_success():
    with pytest.raises(ActionFailure): session().activate_window("w-42")


def test_native_focus_restores_window_and_checks_actual_foreground():
    calls = []
    driver = Win32InputDriver.__new__(Win32InputDriver)
    driver._user32 = SimpleNamespace(IsIconic=lambda hwnd: True, ShowWindow=lambda *args: calls.append(("restore", *args)), SetForegroundWindow=lambda hwnd: calls.append(("focus", hwnd)))
    driver.foreground_window = lambda: 42
    driver.activate(42)
    assert calls == [("restore", 42, 9), ("focus", 42)]
    driver.foreground_window = lambda: 99
    with pytest.raises(RuntimeError, match="focus"): driver.activate(42)


def test_horizontal_scroll_reaches_native_wheel():
    s = session()
    s.scroll(observe(s), x=40, y=40, dx=3, dy=-2)
    assert s.driver.calls[-1] == ("scroll", (40, 40), {"delta": -2, "horizontal_delta": 3})
    driver = Win32InputDriver.__new__(Win32InputDriver)
    calls = []
    driver._position = lambda point: None
    driver._mouse = lambda flag, delta: calls.append((flag, delta))
    driver.scroll((40, 40), delta=-2, horizontal_delta=3)
    assert calls == [(0x0800, -240), (0x1000, 360)]


def test_multiline_and_tabs_are_one_paste_not_submit_keys(monkeypatch):
    driver = Win32InputDriver.__new__(Win32InputDriver)
    pasted, entries = [], []
    driver._send = lambda batch: entries.extend(batch)
    monkeypatch.setattr(driver, "_paste_text", lambda text: pasted.append(text), raising=False)
    driver.type_text("one\r\ntwo\tthree")
    assert pasted == ["one\r\ntwo\tthree"]
    assert not entries


def test_chord_releases_prefix_after_later_key_fails():
    s = session()
    with pytest.raises(ValueError): s._chord(["ctrl", "unsupported"])
    assert s.driver.calls == [("down", "ctrl"), ("up", "ctrl")]


def test_same_label_and_geometry_but_changed_runtime_id_is_stale():
    rows = [element()]
    s = session(rows)
    state = observe(s)
    rows[0] = element(runtime_id=[42, 99])
    with pytest.raises(ActionFailure, match="changed"): s.click(state, index=1)
    assert not s.driver.calls


def test_search_and_ref_can_address_raw_node_beyond_outline_caps():
    rows = [element(i, name=f"row {i}") for i in range(1, 151)]
    rows[-1]["name"] = "A" * 100 + " NEEDLE"
    s = session(rows)
    state = observe(s)
    result = json.loads(s.search_ui(state, text="NEEDLE"))
    assert result["total_matches"] == 1
    assert result["matches"][0]["ref"] == "@e150"
    assert "NEEDLE" in result["matches"][0]["name"]
    assert json.loads(s.inspect_ui(state, "@e150"))["target"]["index"] == 150


def test_uia_failure_is_not_confirmed_empty(monkeypatch):
    monkeypatch.setattr(uia.os, "name", "nt")
    monkeypatch.setattr(uia, "_com_walk", lambda hwnd: (_ for _ in ()).throw(RuntimeError("provider_failed")))
    with pytest.raises(RuntimeError, match="provider_failed"): uia.walk_window(42)


def test_observation_retention_is_bounded_and_expired_refs_fail():
    s = session()
    first = observe(s)
    for _ in range(200): latest = observe(s)
    assert len(s._snapshots) <= 32
    with pytest.raises(ActionFailure): s.read_text(first, "@e1")
    assert json.loads(s.read_text(latest, "@e1"))["text"] == "prefix"


def test_append_input_verifies_whole_field_delta():
    values = iter(["prefix", "prefixsuffix"])
    s = session(uia_act=lambda action, *args: {"ok": True, "value": next(values)})
    result = json.loads(s.type_text(observe(s), "suffix", index=1, clear=False, submit=True))
    assert result["verification"]["matched"] is True
    assert result["submitted"] is True


def test_text_pattern_document_read_uses_document_text():
    s = session([element(role="document", name="Title", value="", patterns=["Text"], text="Actual body")])
    assert json.loads(s.read_text(observe(s), "@e1"))["text"] == "Actual body"
