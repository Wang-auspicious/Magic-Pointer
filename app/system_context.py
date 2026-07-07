from __future__ import annotations

import ctypes
from ctypes import wintypes


def get_foreground_window_title() -> str:
    """Return the foreground window title on Windows.

    Fails softly because this is metadata only.
    """

    try:
        user32 = ctypes.windll.user32
        hwnd = user32.GetForegroundWindow()
        if not hwnd:
            return ""
        length = user32.GetWindowTextLengthW(hwnd)
        if length <= 0:
            return ""
        buffer = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, buffer, length + 1)
        return buffer.value
    except Exception:
        return ""


def get_virtual_screen_bbox() -> tuple[int, int, int, int]:
    """Return the virtual desktop rectangle covering all monitors."""

    user32 = ctypes.windll.user32
    sm_xvirtualscreen = 76
    sm_yvirtualscreen = 77
    sm_cxvirtualscreen = 78
    sm_cyvirtualscreen = 79
    x = int(user32.GetSystemMetrics(sm_xvirtualscreen))
    y = int(user32.GetSystemMetrics(sm_yvirtualscreen))
    w = int(user32.GetSystemMetrics(sm_cxvirtualscreen))
    h = int(user32.GetSystemMetrics(sm_cyvirtualscreen))
    return (x, y, x + w, y + h)


def is_hotkey_down() -> bool:
    """Ctrl + Alt + M global hotkey state.

    Implemented with GetAsyncKeyState to avoid third-party keyboard hooks in
    MVP0. Later versions should use RegisterHotKey or a native tray app.
    """

    user32 = ctypes.windll.user32
    vk_control = 0x11
    vk_menu = 0x12  # Alt
    vk_m = 0x4D

    def down(vk: int) -> bool:
        return bool(user32.GetAsyncKeyState(vk) & 0x8000)

    return down(vk_control) and down(vk_menu) and down(vk_m)


def enable_dpi_awareness() -> None:
    """Make screen coordinates match physical pixels as much as possible."""

    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
    except Exception:
        try:
            ctypes.windll.user32.SetProcessDPIAware()
        except Exception:
            pass



def get_cursor_position() -> tuple[int, int]:
    """Return current cursor position in physical screen coordinates."""

    class POINT(ctypes.Structure):
        _fields_ = [("x", wintypes.LONG), ("y", wintypes.LONG)]

    point = POINT()
    ctypes.windll.user32.GetCursorPos(ctypes.byref(point))
    return int(point.x), int(point.y)


_MUTEX_HANDLE = None

def acquire_single_instance(name: str = "Global\\MagicPointerOpenMVP") -> bool:
    """Return False if another Magic Pointer process is already running."""

    global _MUTEX_HANDLE
    try:
        kernel32 = ctypes.windll.kernel32
        handle = kernel32.CreateMutexW(None, True, name)
        last_error = kernel32.GetLastError()
        if last_error == 183:  # ERROR_ALREADY_EXISTS
            return False
        _MUTEX_HANDLE = handle
        return True
    except Exception:
        return True



def _intersects(a: tuple[int, int, int, int], b: tuple[int, int, int, int]) -> bool:
    return max(a[0], b[0]) < min(a[2], b[2]) and max(a[1], b[1]) < min(a[3], b[3])


def list_visible_windows() -> list[dict[str, object]]:
    """Return visible top-level windows with titles, class names, pids and rects.

    EnumWindows normally returns windows in top-to-bottom z-order. We keep that
    order because it is useful for estimating occlusion and for future target
    disambiguation. This is still a cheap desktop metadata layer, not a full
    accessibility tree.
    """

    windows: list[dict[str, object]] = []
    user32 = ctypes.windll.user32
    kernel32 = ctypes.windll.kernel32

    class RECT(ctypes.Structure):
        _fields_ = [
            ("left", wintypes.LONG),
            ("top", wintypes.LONG),
            ("right", wintypes.LONG),
            ("bottom", wintypes.LONG),
        ]

    def is_cloaked(hwnd) -> bool:
        try:
            cloaked = ctypes.c_int(0)
            # DWMWA_CLOAKED = 14
            result = ctypes.windll.dwmapi.DwmGetWindowAttribute(hwnd, 14, ctypes.byref(cloaked), ctypes.sizeof(cloaked))
            return result == 0 and cloaked.value != 0
        except Exception:
            return False

    def get_rect(hwnd) -> tuple[int, int, int, int] | None:
        rect = RECT()
        try:
            # DWMWA_EXTENDED_FRAME_BOUNDS = 9, more accurate for modern windows.
            result = ctypes.windll.dwmapi.DwmGetWindowAttribute(hwnd, 9, ctypes.byref(rect), ctypes.sizeof(rect))
            if result != 0:
                if not user32.GetWindowRect(hwnd, ctypes.byref(rect)):
                    return None
        except Exception:
            if not user32.GetWindowRect(hwnd, ctypes.byref(rect)):
                return None
        return (int(rect.left), int(rect.top), int(rect.right), int(rect.bottom))

    def get_class_name(hwnd) -> str:
        try:
            buf = ctypes.create_unicode_buffer(256)
            user32.GetClassNameW(hwnd, buf, 256)
            return buf.value
        except Exception:
            return ""

    def get_pid(hwnd) -> int:
        try:
            pid = wintypes.DWORD()
            user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
            return int(pid.value)
        except Exception:
            return 0

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def enum_proc(hwnd, _lparam):
        try:
            if not user32.IsWindowVisible(hwnd) or is_cloaked(hwnd):
                return True
            length = user32.GetWindowTextLengthW(hwnd)
            if length <= 0:
                return True
            title_buf = ctypes.create_unicode_buffer(length + 1)
            user32.GetWindowTextW(hwnd, title_buf, length + 1)
            title = title_buf.value.strip()
            if not title:
                return True
            rect = get_rect(hwnd)
            if rect is None:
                return True
            w = int(rect[2] - rect[0])
            h = int(rect[3] - rect[1])
            if w < 30 or h < 30:
                return True
            lower = title.lower()
            if lower in {"program manager", "windows input experience"}:
                return True
            windows.append(
                {
                    "z_order": len(windows) + 1,
                    "title": title,
                    "class_name": get_class_name(hwnd),
                    "pid": get_pid(hwnd),
                    "bbox": rect,
                    "size": (w, h),
                }
            )
        except Exception:
            pass
        return True

    try:
        user32.EnumWindows(enum_proc, 0)
    except Exception:
        return []
    return windows


def visible_windows_intersecting(bbox: tuple[int, int, int, int]) -> list[dict[str, object]]:
    results = []
    for win in list_visible_windows():
        wb = win.get("bbox")
        if isinstance(wb, tuple) and len(wb) == 4 and _intersects(bbox, wb):
            results.append(win)
    return results[:12]


def apply_modern_window_backdrop(tk_window) -> None:
    """Best-effort Windows 11 Mica/Acrylic + rounded corners for a Tk window."""

    try:
        tk_window.update_idletasks()
        hwnd = wintypes.HWND(tk_window.winfo_id())
        dwmapi = ctypes.windll.dwmapi

        # DWMWA_WINDOW_CORNER_PREFERENCE = 33; 2 = round.
        corner_pref = ctypes.c_int(2)
        dwmapi.DwmSetWindowAttribute(hwnd, 33, ctypes.byref(corner_pref), ctypes.sizeof(corner_pref))

        # DWMWA_SYSTEMBACKDROP_TYPE = 38; 2 = Mica, 3 = Acrylic, 4 = Tabbed.
        # Acrylic is closer to a frosted dynamic blur; unsupported systems ignore it.
        backdrop = ctypes.c_int(3)
        result = dwmapi.DwmSetWindowAttribute(hwnd, 38, ctypes.byref(backdrop), ctypes.sizeof(backdrop))
        if result != 0:
            backdrop = ctypes.c_int(2)
            dwmapi.DwmSetWindowAttribute(hwnd, 38, ctypes.byref(backdrop), ctypes.sizeof(backdrop))
    except Exception:
        try:
            tk_window.attributes("-alpha", 0.985)
        except Exception:
            pass



def trigger_windows_dictation() -> bool:
    """Open Windows dictation (Win+H) for the focused text field.

    This keeps voice input dependency-free. It returns whether the key sequence
    was sent; Windows may still decide not to open dictation depending on user
    settings, microphone permission, or OS edition.
    """

    try:
        user32 = ctypes.windll.user32
        vk_lwin = 0x5B
        vk_h = 0x48
        keyeventf_keyup = 0x0002
        user32.keybd_event(vk_lwin, 0, 0, 0)
        user32.keybd_event(vk_h, 0, 0, 0)
        user32.keybd_event(vk_h, 0, keyeventf_keyup, 0)
        user32.keybd_event(vk_lwin, 0, keyeventf_keyup, 0)
        return True
    except Exception:
        return False
