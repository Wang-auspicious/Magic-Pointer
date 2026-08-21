"""Desktop action surface: Kimi's 13 tools on the main loop.

The model may read the screen today, but it cannot act. These tests pin the
contracts borrowed from Kimi CU (snapshot_id, index XOR coords, input
ownership, used_backend + verification), UFO² (native semantic action first)
and Clicky (turn_ended releases the real-input lock). Drivers are fakes —
nothing touches the live desktop.
"""

from __future__ import annotations

import json

from app.agent_runtime.errors import FailureType
from app.agent_runtime.tool_registry import Effect, ToolRegistry
from app.desktop_actions import DesktopActionSession, register_desktop_action_tools


class _Driver:
    def __init__(self) -> None:
        self.calls: list[tuple] = []

    def click(self, point, *, button="left", count=1):
        self.calls.append(("click", point, button, count))

    def drag(self, start, end, *, duration_ms=0):
        self.calls.append(("drag", start, end, duration_ms))

    def scroll(self, point, *, delta):
        self.calls.append(("scroll", point, delta))

    def type_text(self, value):
        self.calls.append(("type", value))

    def key_down(self, key):
        self.calls.append(("down", key))

    def key_up(self, key):
        self.calls.append(("up", key))

    def activate(self, hwnd):
        self.calls.append(("activate", hwnd))


def _windows():
    return [
        {
            "hwnd": 42,
            "window_id": "w-42",
            "title": "记事本",
            "process_name": "notepad.exe",
            "pid": 1001,
            "rect": [100, 100, 500, 400],
        },
        {
            "hwnd": 7,
            "window_id": "w-7",
            "title": "飞书",
            "process_name": "Feishu.exe",
            "pid": 2002,
            "rect": [600, 100, 1200, 800],
        },
    ]


def _elements():
    return [
        {
            "index": 1,
            "role": "edit",
            "name": "正文",
            "rect": [120, 160, 480, 360],
            "patterns": ["Value"],
        },
        {
            "index": 2,
            "role": "button",
            "name": "保存",
            "rect": [200, 370, 280, 394],
            "patterns": ["Invoke"],
        },
    ]


def _session(**overrides) -> DesktopActionSession:
    launched: list[str] = []

    def launch(app: str) -> dict:
        launched.append(app)
        return {"ok": True, "app": app}

    def uia(action: str, element: dict, value: str | None = None) -> dict:
        return {"ok": True, "backend": f"uia_{action}", "value": value, "element": element}

    kwargs = dict(
        driver=_Driver(),
        windows_probe=_windows,
        elements_probe=lambda hwnd: _elements() if int(hwnd) == 42 else [],
        launcher=launch,
        uia_act=uia,
        session_id="s1",
    )
    kwargs.update(overrides)
    session = DesktopActionSession(**kwargs)
    session.launched = launched  # type: ignore[attr-defined]
    return session


def _registry(session: DesktopActionSession | None = None) -> tuple[ToolRegistry, DesktopActionSession]:
    session = session or _session()
    registry = ToolRegistry()
    register_desktop_action_tools(registry, session)
    return registry, session


def _exec(registry: ToolRegistry, name: str, args: dict | None = None):
    return registry.execute_tool(name, args or {})


def _payload(result) -> dict:
    return json.loads(result.value)


KIMI_WINDOWS_TOOLS = (
    "list_apps",
    "launch_app",
    "activate_window",
    "get_app_state",
    "click",
    "type_text",
    "press_key",
    "scroll",
    "set_value",
    "perform_secondary_action",
    "select_text",
    "drag",
    "turn_ended",
)


def test_all_thirteen_kimi_tools_are_registered() -> None:
    registry, _session = _registry()
    assert tuple(spec.name for spec in registry.list() if spec.name in KIMI_WINDOWS_TOOLS) == KIMI_WINDOWS_TOOLS
    assert registry.get("list_apps").effect is Effect.READ
    assert registry.get("click").effect is Effect.REVERSIBLE_WRITE
    assert registry.get("get_app_state").is_concurrency_safe is True
    assert registry.get("click").is_concurrency_safe is False


def test_get_app_state_issues_a_snapshot_that_click_must_present() -> None:
    registry, session = _registry()
    observed = _payload(_exec(registry, "get_app_state", {"window_id": "w-42", "mode": "ax"}))
    snapshot_id = observed["snapshot_id"]
    assert observed["windows"][0]["title"] == "记事本"
    assert {item["index"] for item in observed["elements"]} == {1, 2}

    missing = _exec(registry, "click", {"index": 2})
    assert missing.is_error
    assert missing.failure_type is FailureType.STALE_SNAPSHOT

    clicked = _payload(_exec(registry, "click", {
        "snapshot_id": snapshot_id,
        "index": 2,
    }))
    assert clicked["used_backend"] == "foreground_click"
    assert clicked["verification"]["matched"] is True
    assert session.driver.calls[0][0] == "click"
    assert session.driver.calls[0][1] == (240, 382)


def test_a_replaced_element_at_the_same_index_invalidates_the_snapshot() -> None:
    elements = _elements()

    def probe(_hwnd):
        return elements

    registry, _owned = _registry(session=_session(elements_probe=probe))
    snapshot_id = _payload(_exec(registry, "get_app_state", {
        "window_id": "w-42",
        "mode": "ax",
    }))["snapshot_id"]
    elements[1] = {**elements[1], "name": "取消"}
    stale = _exec(registry, "click", {"snapshot_id": snapshot_id, "index": 2})
    assert stale.is_error
    assert stale.failure_type is FailureType.STALE_SNAPSHOT


def test_a_moved_window_invalidates_the_snapshot() -> None:
    windows = _windows()

    def probe():
        return windows

    registry, _owned = _registry(session=_session(windows_probe=probe))
    snapshot_id = _payload(_exec(registry, "get_app_state", {
        "window_id": "w-42",
        "mode": "ax",
    }))["snapshot_id"]
    windows[0] = {**windows[0], "rect": [800, 100, 1200, 400]}
    stale = _exec(registry, "click", {"snapshot_id": snapshot_id, "index": 2})
    assert stale.is_error
    assert stale.failure_type is FailureType.STALE_SNAPSHOT


def test_index_and_coordinates_must_not_be_mixed() -> None:
    registry, _session = _registry()
    snapshot_id = _payload(_exec(registry, "get_app_state", {
        "window_id": "w-42",
        "mode": "ax",
    }))["snapshot_id"]
    mixed = _exec(registry, "click", {
        "snapshot_id": snapshot_id,
        "index": 2,
        "x": 10,
        "y": 10,
    })
    assert mixed.is_error
    assert "index" in (mixed.error_message or "")


def test_real_input_is_busy_but_reads_still_work() -> None:
    registry, session = _registry()
    snapshot_id = _payload(_exec(registry, "get_app_state", {
        "window_id": "w-42",
        "mode": "ax",
    }))["snapshot_id"]
    assert session.ownership.acquire("other-session", "click") is True
    busy = _exec(registry, "click", {"snapshot_id": snapshot_id, "index": 2})
    assert busy.is_error
    assert busy.failure_type is FailureType.COMPUTER_USE_BUSY
    listed = _payload(_exec(registry, "list_apps", {}))
    assert any(item["title"] == "记事本" for item in listed["apps"])


def test_turn_ended_releases_the_input_lock() -> None:
    registry, session = _registry()
    snapshot_id = _payload(_exec(registry, "get_app_state", {
        "window_id": "w-42",
        "mode": "ax",
    }))["snapshot_id"]
    _exec(registry, "click", {"snapshot_id": snapshot_id, "index": 2})
    assert session.ownership.holder == "s1"
    _exec(registry, "turn_ended", {})
    assert session.ownership.holder is None


def test_unknown_app_name_does_not_open_explorer() -> None:
    registry, session = _registry()
    unknown = _exec(registry, "launch_app", {"app": "definitely-not-installed-xyz"})
    assert unknown.is_error
    assert "unknown" in (unknown.error_message or "").lower()
    assert session.launched == []


def test_known_process_name_may_launch() -> None:
    registry, session = _registry()
    result = _payload(_exec(registry, "launch_app", {"app": "notepad.exe"}))
    assert result["ok"] is True
    assert session.launched == ["notepad.exe"]


def test_win_key_chords_are_rejected() -> None:
    registry, _session = _registry()
    snapshot_id = _payload(_exec(registry, "get_app_state", {
        "window_id": "w-42",
        "mode": "ax",
    }))["snapshot_id"]
    blocked = _exec(registry, "press_key", {
        "snapshot_id": snapshot_id,
        "keys": "Win+r",
    })
    assert blocked.is_error
    assert "Win" in (blocked.error_message or "")


def test_set_value_uses_native_uia_before_clicking() -> None:
    registry, session = _registry()
    snapshot_id = _payload(_exec(registry, "get_app_state", {
        "window_id": "w-42",
        "mode": "ax",
    }))["snapshot_id"]
    result = _payload(_exec(registry, "set_value", {
        "snapshot_id": snapshot_id,
        "index": 1,
        "value": "hello",
    }))
    assert result["used_backend"] == "uia_value"
    assert result["verification"]["matched"] is True
    assert session.driver.calls == []


def test_desktop_tool_descriptions_are_chinese_handbooks() -> None:
    registry, _session = _registry()
    for name in KIMI_WINDOWS_TOOLS:
        description = registry.get(name).description
        assert any("\u4e00" <= char <= "\u9fff" for char in description), name
        assert "when to" not in description.casefold()
    live = registry.get("get_app_state").description
    assert "实时" in live
    assert "冻结" in live


def test_type_text_confirms_by_reading_current_value_not_setting() -> None:
    actions: list[tuple] = []

    def uia(action, element, value=None):
        actions.append((action, value))
        if action == "read_value":
            return {"ok": True, "backend": "uia_value", "value": "hello"}
        return {"ok": True, "backend": "uia_value"}

    registry, session = _registry(session=_session(uia_act=uia))
    snapshot_id = _payload(_exec(registry, "get_app_state", {
        "window_id": "w-42",
        "mode": "ax",
    }))["snapshot_id"]
    result = _payload(_exec(registry, "type_text", {
        "snapshot_id": snapshot_id,
        "index": 1,
        "text": "hello",
    }))
    assert [item[0] for item in actions] == ["read_value"]
    assert result["verification"]["matched"] is True
    assert any(call[0] == "type" for call in session.driver.calls)


def test_type_text_mismatch_on_readback_is_not_matched() -> None:
    def uia(action, element, value=None):
        if action == "read_value":
            return {"ok": True, "backend": "uia_value", "value": "other"}
        return {"ok": True, "backend": "uia_value"}

    registry, _sess = _registry(session=_session(uia_act=uia))
    snapshot_id = _payload(_exec(registry, "get_app_state", {
        "window_id": "w-42",
        "mode": "ax",
    }))["snapshot_id"]
    result = _payload(_exec(registry, "type_text", {
        "snapshot_id": snapshot_id,
        "index": 1,
        "text": "hello",
    }))
    assert result["verification"]["matched"] is False


def test_type_text_reports_unavailable_when_uia_cannot_confirm() -> None:
    def uia(action, element, value=None):
        return {"ok": False, "backend": "uia_value", "reason": "no_value_pattern"}

    registry, session = _registry(session=_session(uia_act=uia))
    snapshot_id = _payload(_exec(registry, "get_app_state", {
        "window_id": "w-42",
        "mode": "ax",
    }))["snapshot_id"]
    result = _payload(_exec(registry, "type_text", {
        "snapshot_id": snapshot_id,
        "index": 1,
        "text": "hello",
    }))
    assert result["used_backend"] == "foreground_clipboard_paste"
    assert result["verification"]["matched"] is False
    assert result["verification"]["status"] == "unavailable"
    assert any(call[0] == "type" for call in session.driver.calls)


def test_press_key_accepts_common_aliases() -> None:
    """真机 turn-3 事故：模型按 Return 被拒（只认 Enter）——别名在生产驱动
    的键表里解析（Win32InputDriver._KEYS），会话层必须放行不报
    unsupported_key。"""
    registry, session = _registry()
    snapshot_id = _payload(_exec(registry, "get_app_state", {
        "window_id": "w-42",
        "mode": "ax",
    }))["snapshot_id"]
    result = _exec(registry, "press_key", {
        "snapshot_id": snapshot_id,
        "keys": "Return",
    })
    assert not result.is_error, result.value
    downs = [call for call in session.driver.calls if call[0] in {"down", "key_down"}]
    assert downs, session.driver.calls
    # 生产驱动的键表确实认识这个别名（防回归钉住）。
    from app.computer_operator.windows import _KEYS

    assert _KEYS["return"] == _KEYS["enter"]


def test_get_app_state_finds_window_by_class_when_process_name_empty() -> None:
    """真机 turn-3 事故：Win11 记事本 process_name 为空，app=Notepad /
    app=Notepad.exe 全部 window not found——app 匹配必须回退到 class 与标题。"""
    windows = [
        {"hwnd": 11, "pid": 1, "title": "mp-doc.txt - Notepad", "class_name": "Notepad",
         "process_name": "", "rect": [0, 0, 400, 300]},
    ]
    registry, _ = _registry(session=_session(windows_probe=lambda: windows))
    result = _exec(registry, "get_app_state", {"app": "Notepad", "mode": "ax"})
    assert not result.is_error, result.value
    payload = json.loads(result.value)
    assert payload["windows"][0]["hwnd"] == 11

    result_exe = _exec(registry, "get_app_state", {"app": "notepad.exe", "mode": "ax"})
    assert not result_exe.is_error
