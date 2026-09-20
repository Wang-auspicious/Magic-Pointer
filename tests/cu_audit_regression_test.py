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


def test_coordinate_action_rejects_changed_content_in_same_window():
    rows = [element()]
    s = session(rows)
    state = observe(s)
    rows[0] = element(value="another conversation")
    with pytest.raises(ActionFailure, match="changed"): s.click(state, x=50, y=50)
    assert not s.driver.calls


def test_candidate_pool_exposes_all_full_nodes_as_copies():
    s = session([element(i, name="x" * 200) for i in range(1, 151)])
    state = observe(s)
    pool = s.candidate_pool(state)
    assert len(pool) == 150 and len(pool[-1]["name"]) == 200
    pool[-1]["name"] = "mutated"
    assert s.candidate_pool(state)[-1]["name"] != "mutated"


def test_act_ui_failure_keeps_executed_prefix_receipt():
    s = session()
    with pytest.raises(ActionFailure) as failure:
        s.act_ui(observe(s), [{"action": "typeText", "text": "already written"}, {"action": "keypress", "keys": ["unsupported"]}])
    partial = failure.value.partial_result
    assert partial["failed_index"] == 1
    assert partial["executed"][0]["receipt"]["used_backend"] == "foreground_text_input"
    assert s.driver.calls == [("type", "already written")]


def test_act_ui_preserves_entire_drag_path():
    s = session()
    paths = []
    s.driver.drag_path = lambda points, **kwargs: paths.append(points)
    s.act_ui(observe(s), [{"action": "drag", "path": [{"x": 20, "y": 30}, {"x": 300, "y": 400}, {"x": 500, "y": 600}]}])
    assert paths == [[(20, 30), (300, 400), (500, 600)]]


def test_default_sessions_get_distinct_input_owners(monkeypatch):
    from app.desktop_actions import session as module
    monkeypatch.setattr(module, "_live_driver", Driver)
    assert module.default_session().session_id != module.default_session().session_id


def test_real_input_ownership_excludes_another_process():
    import os
    import subprocess
    import sys
    import uuid
    if os.name != "nt": pytest.skip("Windows named mutex")
    from app.desktop_actions.session import InputOwnershipLock
    name = "Local\\MP-CU-test-" + uuid.uuid4().hex
    lock = InputOwnershipLock(mutex_name=name)
    assert lock.acquire("first")
    code = "from app.desktop_actions.session import InputOwnershipLock; lock=InputOwnershipLock(mutex_name=" + repr(name) + "); print(lock.acquire('second')); lock.release()"
    try:
        assert subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, check=True).stdout.strip() == "False"
    finally:
        lock.release("first")
    assert subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, check=True).stdout.strip() == "True"


def test_send_delete_and_batch_effects_use_resolved_targets():
    from app.agent_runtime.tool_registry import Effect, ToolRegistry, spec_effect
    from app.desktop_actions.session import register_desktop_action_tools
    s = session([element(1, name="发送", role="button"), element(2, name="删除", role="button"), element(3, name="Name", role="edit")])
    state = observe(s)
    registry = ToolRegistry()
    register_desktop_action_tools(registry, s)
    cases = [("Click", {"index": 1}, Effect.EXTERNAL_SEND), ("Act", {"index": 2, "action": "invoke"}, Effect.DESTRUCTIVE), ("Type", {"text": "hello", "submit": True}, Effect.EXTERNAL_SEND), ("Key", {"keys": "enter"}, Effect.EXTERNAL_SEND), ("Click", {"index": 3}, Effect.REVERSIBLE_WRITE), ("act_ui", {"actions": [{"action": "click", "ref": "@e1"}]}, Effect.EXTERNAL_SEND)]
    for name, arguments, effect in cases:
        spec = registry.get(name)
        args = {"snapshot_id": state, "state_id": state, **arguments}
        assert spec_effect(spec, args) == effect
        access = spec.access_for(args)
        assert access.window_ids == ("w-42",)
        assert access.action == ("send" if effect == Effect.EXTERNAL_SEND else "delete" if effect == Effect.DESTRUCTIVE else "patch")


def test_opaque_coordinate_rechecks_local_pixels_and_ax_stays_pixel_free():
    from PIL import Image
    pixels = Image.new("RGB", (1000, 1000), "white")
    captures = []
    def capture(window): captures.append(window); return pixels.copy()
    s = session([], surface_probe=capture)
    state = observe(s)
    assert not captures
    with pytest.raises(ActionFailure, match="full"): s.click(state, x=50, y=50)
    state = json.loads(s.get_app_state(mode="full"))["snapshot_id"]
    pixels.putpixel((50, 50), (0, 0, 0))
    with pytest.raises(ActionFailure, match="changed"): s.click(state, x=50, y=50)


def test_search_calls_jev_only_for_no_literal_matches(monkeypatch):
    from app.desktop_actions import jev
    calls = []
    def suggest(text, candidates, **kwargs):
        calls.append((text, candidates, kwargs))
        return {"ref": "@e1", "confidence": 0.9}
    monkeypatch.setattr(jev, "suggest_target", suggest, raising=False)
    s = session()
    state = observe(s)
    assert json.loads(s.search_ui(state, text="Body"))["total_matches"] == 1
    assert not calls
    result = json.loads(s.search_ui(state, text="message composer"))
    assert result["total_matches"] == 0 and result["matches"] == []
    assert result["suggested_target"]["ref"] == "@e1"
    assert calls[0][2]["state_id"] == state


def test_successful_actions_keep_receipts_when_post_observation_fails():
    s = session()
    state = observe(s)
    s.elements_probe = lambda _: (_ for _ in ()).throw(RuntimeError("provider hung"))
    with pytest.raises(ActionFailure) as failure:
        s.act_ui(state, [{"action": "typeText", "text": "written"}])
    assert failure.value.partial_result["executed"][0]["receipt"]["used_backend"] == "foreground_text_input"
    assert failure.value.partial_result["failed_index"] is None


def test_image_only_observation_can_use_unchanged_coordinates():
    from PIL import Image
    s = session(surface_probe=lambda _: Image.new("RGB", (1000, 1000), "white"))
    state = json.loads(s.get_app_state(mode="image"))["snapshot_id"]
    s.click(state, x=50, y=50)
    assert s.driver.calls == [("click", (50, 50))]


def test_key_effect_is_case_insensitive_like_native_driver():
    from app.agent_runtime.tool_registry import Effect
    s = session()
    assert s.action_effect("Key", {"keys": "CTRL+ENTER"}) == Effect.EXTERNAL_SEND
    assert s.action_effect("Key", {"keys": "DELETE"}) == Effect.DESTRUCTIVE
