
from app.adapters.uia_text_adapter import (
    SELF_DRAWN_WINDOW_CLASSES,
    UIA_EXCLUDED_WINDOW_CLASSES,
    UIA_WINDOW_CLASSES,
    UiaTextSelectionAdapter,
    clipboard_fallback_forbidden,
)


def _window(class_name: str, title: str = "Untitled") -> dict[str, object]:
    return {"hwnd": 4321, "pid": 8765, "class_name": class_name, "title": title}


NEWLY_ADMITTED = (
    ("Notepad", "mp_probe.txt - Notepad"),
    ("CabinetWClass", "Downloads"),
    ("WeChatMainWndForPC", "WeChat"),
    ("ApplicationFrameWindow", "Mail"),
)

SELF_DRAWN = (
    ("Qt51514QWindowIcon", "微信"),
    ("Qt6QWindowIcon", "some Qt app"),
    ("MMUIRenderSubWindowHW", "WeChat"),
    ("SunAwtFrame", "IntelliJ IDEA"),
    ("GLFW30", "game window"),
)


def test_apps_outside_the_old_whitelist_are_now_admitted() -> None:
    adapter = UiaTextSelectionAdapter()
    for class_name, title in NEWLY_ADMITTED:
        assert class_name not in UIA_WINDOW_CLASSES
        assert adapter.match_window(_window(class_name, title)) is True, class_name


def test_self_drawn_windows_are_declined_before_the_probe_runs() -> None:
    adapter = UiaTextSelectionAdapter()
    for class_name, title in SELF_DRAWN:
        assert adapter.match_window(_window(class_name, title)) is False, class_name


def test_the_terminal_readers_are_not_among_the_declined() -> None:
    assert "CASCADIA_HOSTING_WINDOW_CLASS" not in SELF_DRAWN_WINDOW_CLASSES
    assert "ConsoleWindowClass" not in SELF_DRAWN_WINDOW_CLASSES
    adapter = UiaTextSelectionAdapter()
    assert adapter.match_window(_window("CASCADIA_HOSTING_WINDOW_CLASS", "Windows PowerShell")) is True
    assert adapter.match_window(_window("ConsoleWindowClass", "cmd.exe")) is True


def test_a_declined_class_is_still_probed_when_the_whitelist_asks_for_it() -> None:
    import pytest

    monkeypatch = pytest.MonkeyPatch()
    try:
        monkeypatch.setenv("MAGIC_POINTER_UIA_WINDOW_SCOPE", "whitelist")
        adapter = UiaTextSelectionAdapter()
        assert adapter.match_window(_window("Qt51514QWindowIcon", "微信")) is False
        assert adapter.match_window(_window("CASCADIA_HOSTING_WINDOW_CLASS", "t")) is True
    finally:
        monkeypatch.undo()


def test_surfaces_with_no_user_text_stay_excluded() -> None:
    adapter = UiaTextSelectionAdapter()
    for class_name in ("Progman", "Shell_TrayWnd", "#32768", "tooltips_class32"):
        assert class_name in UIA_EXCLUDED_WINDOW_CLASSES
        assert adapter.match_window(_window(class_name)) is False, class_name


def test_our_own_surfaces_are_still_refused() -> None:
    adapter = UiaTextSelectionAdapter()
    for title in ("Magic Pointer Overlay", "Magic Pointer Panel"):
        assert adapter.match_window(_window("Chrome_WidgetWin_1", title)) is False


def test_a_window_with_no_class_name_is_refused() -> None:
    adapter = UiaTextSelectionAdapter()
    assert adapter.match_window({"hwnd": 1, "pid": 2, "title": "x"}) is False
    assert adapter.match_window(_window("", "x")) is False


def test_whitelist_mode_restores_the_old_gate(monkeypatch) -> None:
    monkeypatch.setenv("MAGIC_POINTER_UIA_WINDOW_SCOPE", "whitelist")
    adapter = UiaTextSelectionAdapter()
    assert adapter.match_window(_window("Notepad", "x")) is False
    assert adapter.match_window(_window("Chrome_WidgetWin_1", "Edge")) is True


def test_scope_switch_is_read_per_call_not_cached_at_import(monkeypatch) -> None:
    adapter = UiaTextSelectionAdapter()
    assert adapter.match_window(_window("Notepad", "x")) is True
    monkeypatch.setenv("MAGIC_POINTER_UIA_WINDOW_SCOPE", "whitelist")
    assert adapter.match_window(_window("Notepad", "x")) is False
    monkeypatch.setenv("MAGIC_POINTER_UIA_WINDOW_SCOPE", "open")
    assert adapter.match_window(_window("Notepad", "x")) is True


def test_unrecognized_scope_values_fall_back_to_open(monkeypatch) -> None:
    monkeypatch.setenv("MAGIC_POINTER_UIA_WINDOW_SCOPE", "banana")
    assert UiaTextSelectionAdapter().match_window(_window("Notepad", "x")) is True


def test_terminals_forbid_a_synthesized_ctrl_c() -> None:
    for class_name in ("CASCADIA_HOSTING_WINDOW_CLASS", "ConsoleWindowClass"):
        forbidden, reason = clipboard_fallback_forbidden(_window(class_name, "PowerShell"))
        assert forbidden is True
        assert reason == "ctrl_c_is_sigint_in_terminals"

    by_title, _ = clipboard_fallback_forbidden(
        _window("Chrome_WidgetWin_1", "Windows Terminal")
    )
    assert by_title is True


def test_ordinary_apps_do_not_forbid_the_clipboard_fallback() -> None:
    forbidden, reason = clipboard_fallback_forbidden(_window("Notepad", "notes.txt"))
    assert forbidden is False
    assert reason == ""


def test_admission_does_not_bypass_the_probe_identity_checks() -> None:
    context = UiaTextSelectionAdapter().read_context(_window("Notepad", "x") | {"hwnd": 0})
    assert context.content in (None, "")
    assert context.error
