
from __future__ import annotations

import json

import pytest

from app.agent_runtime.tool_registry import ToolRegistry
from app.desktop_actions import DesktopActionSession, register_desktop_action_tools


class _Driver:
    def __init__(self) -> None:
        self.calls: list[tuple] = []

    def click(self, point, *, button="left", count=1):
        self.calls.append(("click", point, button, count))

    def type_text(self, value):
        self.calls.append(("type", value))

    def key_down(self, key):
        self.calls.append(("down", key))

    def key_up(self, key):
        self.calls.append(("up", key))

    def scroll(self, point, *, delta):
        self.calls.append(("scroll", point, delta))

    def drag(self, start, end, *, duration_ms=0):
        self.calls.append(("drag", start, end, duration_ms))


def _windows() -> list[dict]:
    return [
        {"hwnd": 42, "window_id": "w-42", "title": "Notepad", "process_name": "notepad.exe", "pid": 1001, "rect": [0, 0, 500, 400]},
        {"hwnd": 7, "window_id": "w-7", "title": "Mail", "process_name": "mail.exe", "pid": 2002, "rect": [600, 0, 1200, 800]},
    ]


def _elements() -> list[dict]:
    return [
        {"index": 1, "role": "window", "name": "Notepad", "rect": [0, 0, 500, 400], "patterns": []},
        {"index": 2, "role": "edit", "name": "Body", "value": "old", "rect": [20, 50, 480, 350], "patterns": ["Value"]},
        {"index": 3, "role": "button", "name": "Save", "rect": [20, 360, 90, 390], "patterns": ["Invoke"]},
    ]


def _registry(*, elements_probe=None, windows_probe=None):
    driver = _Driver()
    def default_elements(hwnd):
        rows = _elements() if int(hwnd) == 42 else []
        if any(call[:2] == ("type", "hello") for call in driver.calls):
            rows[1] = {**rows[1], "value": "hello"}
        return rows
    session = DesktopActionSession(
        driver=driver,
        windows_probe=windows_probe or _windows,
        elements_probe=elements_probe or default_elements,
        launcher=lambda app: {"ok": True, "app": app},
        uia_act=lambda action, element, value=None: {"ok": True, "backend": f"uia_{action}", "value": value},
        session_id="parity",
    )
    registry = ToolRegistry()
    register_desktop_action_tools(registry, session)
    return registry, session, driver


def _payload(result):
    assert not result.is_error, result.error_message
    return json.loads(str(result.value))


def test_pi_state_scoped_root_search_and_inspection_tools_exist() -> None:
    registry, _session, _driver = _registry()
    roots = _payload(registry.execute_tool("find_roots", {"text": "Notepad"}))
    assert roots["roots"][0]["root_ref"] == "@r1"
    observed = _payload(registry.execute_tool("observe_ui", {"root": "@r1"}))
    assert observed["state_id"]
    assert observed["outline"][0]["ref"] == "@e1"
    matches = _payload(registry.execute_tool("search_ui", {"state_id": observed["state_id"], "text": "Save"}))
    assert matches["matches"][0]["ref"] == "@e3"
    inspected = _payload(registry.execute_tool("inspect_ui", {"state_id": observed["state_id"], "ref": "@e3"}))
    assert inspected["target"]["name"] == "Save"
    text = _payload(registry.execute_tool("read_text", {"state_id": observed["state_id"], "ref": "@e2"}))
    assert text["text"] == "old"


def test_pi_act_is_one_state_bound_transaction_and_returns_successor_diff() -> None:
    registry, _session, driver = _registry()
    observed = _payload(registry.execute_tool("observe_ui", {"root": "@r1"}))
    result = _payload(registry.execute_tool("act_ui", {
        "state_id": observed["state_id"],
        "actions": [
            {"action": "click", "ref": "@e2"},
            {"action": "typeText", "text": "hello"},
        ],
        "expect": {"text": "hello", "timeout_ms": 100},
    }))
    assert result["state_id"] != observed["state_id"]
    assert result["base_state_id"] == observed["state_id"]
    assert result["view"] in {"diff", "full"}
    assert result["verification"]["found"] is True
    assert [call[0] for call in driver.calls] == ["click", "type"]


def test_pi_wait_for_is_bounded_and_reports_found_without_polling_capture() -> None:
    calls = {"n": 0}

    def elements(_hwnd):
        calls["n"] += 1
        rows = _elements()
        if calls["n"] >= 2:
            rows[2] = {**rows[2], "name": "Saved"}
        return rows

    registry, _session, _driver = _registry(elements_probe=elements)
    observed = _payload(registry.execute_tool("observe_ui", {"root": "@r1"}))
    result = _payload(registry.execute_tool("wait_for", {
        "state_id": observed["state_id"],
        "text": "Saved",
        "timeout_ms": 300,
    }))
    assert result["found"] is True
    assert result["state_id"]
    assert calls["n"] >= 2


@pytest.mark.parametrize("field", ["name", "value"])
def test_read_text_preserves_full_snapshot_text_beyond_the_outline(field) -> None:
    full_text = "x" * 100 + "完整尾部"
    rows = _elements()
    rows[1] = {**rows[1], "value": "", field: full_text}
    registry, _session, _driver = _registry(elements_probe=lambda _hwnd: rows)
    observed = _payload(registry.execute_tool("observe_ui", {"root": "@r1"}))
    assert len(observed["outline"][1][field]) < len(full_text)
    rows[1][field] = "changed after observation"

    result = _payload(registry.execute_tool("read_text", {
        "state_id": observed["state_id"], "ref": "@e2",
    }))

    assert result["text"] == full_text
    assert result["used_backend"] == "uia.snapshot"


@pytest.mark.parametrize("condition", [{"text": "完整尾部"}, {"value": "x" * 100 + "完整尾部"}])
def test_wait_for_matches_full_text_beyond_the_outline(condition) -> None:
    calls = []

    def elements(_hwnd):
        calls.append(True)
        rows = _elements()
        if len(calls) >= 2:
            rows[1]["value"] = "x" * 100 + "完整尾部"
        return rows

    registry, _session, _driver = _registry(elements_probe=elements)
    observed = _payload(registry.execute_tool("observe_ui", {"root": "@r1"}))

    result = _payload(registry.execute_tool("wait_for", {
        "state_id": observed["state_id"], "timeout_ms": 100, **condition,
    }))

    assert result["found"] is True
    assert result["timed_out"] is False
    assert len(calls) == 2
