"""UIA tree and native actions behind the Kimi 13 tools.

The registry already has click/set_value. Production still returned an empty
tree and refused every UIA pattern. These tests pin the bridge that turns a
raw accessibility dump into indexed elements and honest pattern results.
"""

from __future__ import annotations

import json

from app.agent_runtime.tool_registry import ToolRegistry
from app.desktop_actions import DesktopActionSession, register_desktop_action_tools
from app.desktop_actions.uia import UiaBridge, normalize_elements


def _windows():
    return [{
        "hwnd": 42,
        "window_id": "w-42",
        "title": "记事本",
        "process_name": "notepad.exe",
        "pid": 1001,
        "rect": [100, 100, 500, 400],
    }]


def _raw_nodes():
    return [
        {
            "name": "记事本",
            "control_type": 50032,
            "rect": [100, 100, 500, 400],
            "patterns": [],
        },
        {
            "name": "正文",
            "control_type": 50004,
            "rect": [120, 160, 480, 360],
            "patterns": ["Value"],
            "runtime_id": [42, 1],
        },
        {
            "name": "保存",
            "control_type": 50000,
            "rect": [200, 370, 280, 394],
            "patterns": ["Invoke"],
            "runtime_id": [42, 2],
        },
        {
            "name": "",
            "control_type": 50033,
            "rect": [100, 100, 500, 400],
            "patterns": [],
        },
    ]


def test_normalize_elements_assigns_indexes_and_skips_silent_panes() -> None:
    elements = normalize_elements(_raw_nodes())
    assert [item["index"] for item in elements] == [1, 2, 3]
    assert elements[0]["role"] == "window"
    assert elements[1]["role"] == "edit"
    assert elements[1]["name"] == "正文"
    assert elements[1]["rect"] == [120, 160, 480, 360]
    assert elements[1]["patterns"] == ["Value"]
    assert elements[2]["role"] == "button"
    assert all(item["name"] != "" or item["patterns"] for item in elements)


def test_get_app_state_indexes_the_bridged_tree() -> None:
    bridge = UiaBridge(walker=lambda hwnd: _raw_nodes() if int(hwnd) == 42 else [])
    session = DesktopActionSession(
        driver=object(),
        windows_probe=_windows,
        elements_probe=bridge.list_elements,
        launcher=lambda app: {"ok": True, "app": app},
        uia_act=bridge.act,
        session_id="s1",
    )
    registry = ToolRegistry()
    register_desktop_action_tools(registry, session)
    observed = json.loads(registry.execute_tool(
        "get_app_state",
        {"window_id": "w-42", "mode": "ax"},
    ).value)
    assert {item["index"] for item in observed["elements"]} == {1, 2, 3}
    assert observed["elements"][1]["name"] == "正文"


def test_set_value_goes_through_the_bridge_actor_not_a_click() -> None:
    acted: list[tuple] = []

    def actor(action, element, value=None):
        acted.append((action, element["index"], value))
        return {"ok": True, "backend": "uia_value"}

    bridge = UiaBridge(walker=lambda hwnd: _raw_nodes(), actor=actor)
    driver_calls: list = []

    class Driver:
        def click(self, *args, **kwargs):
            driver_calls.append(("click", args, kwargs))

    session = DesktopActionSession(
        driver=Driver(),
        windows_probe=_windows,
        elements_probe=bridge.list_elements,
        launcher=lambda app: {"ok": True, "app": app},
        uia_act=bridge.act,
        session_id="s1",
    )
    registry = ToolRegistry()
    register_desktop_action_tools(registry, session)
    snapshot_id = json.loads(registry.execute_tool(
        "get_app_state",
        {"window_id": "w-42", "mode": "ax"},
    ).value)["snapshot_id"]
    result = json.loads(registry.execute_tool("set_value", {
        "snapshot_id": snapshot_id,
        "index": 2,
        "value": "hello",
    }).value)
    assert result["used_backend"] == "uia_value"
    assert acted == [("value", 2, "hello")]
    assert driver_calls == []


def test_missing_pattern_is_unsupported_not_a_fake_click() -> None:
    def actor(action, element, value=None):
        return {"ok": False, "backend": f"uia_{action}", "reason": "no_pattern"}

    bridge = UiaBridge(walker=lambda hwnd: _raw_nodes(), actor=actor)
    session = DesktopActionSession(
        driver=object(),
        windows_probe=_windows,
        elements_probe=bridge.list_elements,
        launcher=lambda app: {"ok": True, "app": app},
        uia_act=bridge.act,
        session_id="s1",
    )
    registry = ToolRegistry()
    register_desktop_action_tools(registry, session)
    snapshot_id = json.loads(registry.execute_tool(
        "get_app_state",
        {"window_id": "w-42", "mode": "ax"},
    ).value)["snapshot_id"]
    result = registry.execute_tool("set_value", {
        "snapshot_id": snapshot_id,
        "index": 2,
        "value": "hello",
    })
    assert result.is_error
    assert "unsupported" in (result.error_message or "").lower()


def test_live_elements_uses_the_module_walker(monkeypatch) -> None:
    from app.desktop_actions import uia as uia_mod
    from app.desktop_actions.session import _live_elements

    monkeypatch.setattr(uia_mod, "walk_window", lambda hwnd: _raw_nodes())
    items = _live_elements(42)
    assert [item["name"] for item in items] == ["记事本", "正文", "保存"]
    assert items[1]["index"] == 2


def test_walk_window_is_honest_when_there_is_no_tree() -> None:
    from app.desktop_actions.uia import walk_window

    assert walk_window(0) == []
