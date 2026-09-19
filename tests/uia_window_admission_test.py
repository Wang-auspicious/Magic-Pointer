"""UIA admission is open by default, so an unlisted app is not silently unreadable.

match_window used to gate on UIA_WINDOW_CLASSES, six class names covering
browsers, Acrobat and terminals. Everything else -- Notepad, Explorer, WeChat,
every ordinary Win32 input box -- was refused before the probe ran, and the
selection fell through to OCR. The probe itself was never the limit: it has
FocusedElement, ElementFromPoint, RangeFromPoint and FindAll available.

These tests pin the inversion: admit by default, exclude only surfaces known to
hold no user text, and keep the escape hatch working.
"""

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

# 自绘窗口不探：树里永远没有可读文字，探针只会白跑一趟。
# 2026-09-19 本机实测（详见 uia_text_adapter.SELF_DRAWN_WINDOW_CLASSES）：
#   微信 Qt51514QWindowIcon  探针 415ms，documents=0，无文字
#   向日葵 FLUTTER_RUNNER_WIN32_WINDOW  documents=0，无文字
# 用户对 Qt 的裁决：「QT 就明确不要 uia 了」。
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
    """自绘窗口不探——探针在它们身上只会花掉一次往返再空手而归。

    实测过的代价（2026-09-19 本机）：微信 415ms、向日葵 415ms 起，而且探针返回的
    「没有文字」还可能被下游当成一次成功的结构读取，把像素兜底关掉。
    """
    adapter = UiaTextSelectionAdapter()
    for class_name, title in SELF_DRAWN:
        assert adapter.match_window(_window(class_name, title)) is False, class_name


def test_the_terminal_readers_are_not_among_the_declined() -> None:
    """终端**不能**跟着一起跳：它的缓冲区是真读得出来的。

    这张表是从 COLD_TREE_DENY_CLASSES 里减出来的，减掉的就是这两个——
    tests/terminal_structured_read_test.py 钉着它们的读取器。
    """
    assert "CASCADIA_HOSTING_WINDOW_CLASS" not in SELF_DRAWN_WINDOW_CLASSES
    assert "ConsoleWindowClass" not in SELF_DRAWN_WINDOW_CLASSES
    adapter = UiaTextSelectionAdapter()
    assert adapter.match_window(_window("CASCADIA_HOSTING_WINDOW_CLASS", "Windows PowerShell")) is True
    assert adapter.match_window(_window("ConsoleWindowClass", "cmd.exe")) is True


def test_a_declined_class_is_still_probed_when_the_whitelist_asks_for_it() -> None:
    """逃生口还在：白名单模式是明确的「我就要探这几个」。"""
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
    # Reading our own capsule would feed the overlay's text back in as context.
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
    # It is a stop-the-bleeding switch; needing a restart would defeat it.
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
    # In a terminal Ctrl+C is SIGINT, not copy. Nothing sends keys today, but
    # opening admission makes a keyboard fallback tempting for windows UIA cannot
    # read, and that fallback would kill whatever the user is running.
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
    # Admitting a window only means we ask. read_context still refuses without a
    # usable handle, so opening the gate cannot skip the identity guarantees.
    context = UiaTextSelectionAdapter().read_context(_window("Notepad", "x") | {"hwnd": 0})
    assert context.content in (None, "")
    assert context.error
