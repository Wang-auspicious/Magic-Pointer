from __future__ import annotations

import ctypes
from contextlib import suppress
from ctypes import wintypes


def get_foreground_window_handle() -> int:
    """Return the exact foreground top-level window handle on Windows."""

    try:
        return int(ctypes.windll.user32.GetForegroundWindow() or 0)
    except Exception:
        return 0


def enable_dpi_awareness() -> None:
    """Make screen coordinates match physical pixels as much as possible."""

    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
    except Exception:
        with suppress(Exception):
            ctypes.windll.user32.SetProcessDPIAware()

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
            if result != 0 and not user32.GetWindowRect(hwnd, ctypes.byref(rect)):
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
                    "hwnd": int(hwnd),
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
