"""Windows-native computer operator constrained by a :class:`SurfaceGrant`."""

from __future__ import annotations

import ctypes
import ctypes.wintypes
import hashlib
import os
import threading
import time
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Protocol

from app.capture import CaptureProvider, GdiFallbackCaptureProvider
from app.governance.cancellation import CancelledError

from .schema import (
    ComputerAction,
    ComputerActionKind,
    OperatorBackendResult,
    OperatorObservation,
    SurfaceGrant,
)


class WindowsInputDriver(Protocol):
    def window_at(self, point: tuple[int, int]) -> int: ...
    def foreground_window(self) -> int: ...
    def click(self, point: tuple[int, int], *, button: str, count: int) -> None: ...
    def move(self, point: tuple[int, int], *, duration_ms: int) -> None: ...
    def drag(
        self,
        start: tuple[int, int],
        end: tuple[int, int],
        *,
        duration_ms: int,
    ) -> None: ...
    def scroll(self, point: tuple[int, int], *, delta: int) -> None: ...
    def type_text(self, value: str) -> None: ...
    def key_down(self, key: str) -> None: ...
    def key_up(self, key: str) -> None: ...


class _MouseInput(ctypes.Structure):
    _fields_ = [
        ("dx", ctypes.wintypes.LONG),
        ("dy", ctypes.wintypes.LONG),
        ("mouseData", ctypes.wintypes.DWORD),
        ("dwFlags", ctypes.wintypes.DWORD),
        ("time", ctypes.wintypes.DWORD),
        ("dwExtraInfo", ctypes.c_size_t),
    ]


class _KeyboardInput(ctypes.Structure):
    _fields_ = [
        ("wVk", ctypes.wintypes.WORD),
        ("wScan", ctypes.wintypes.WORD),
        ("dwFlags", ctypes.wintypes.DWORD),
        ("time", ctypes.wintypes.DWORD),
        ("dwExtraInfo", ctypes.c_size_t),
    ]


class _HardwareInput(ctypes.Structure):
    _fields_ = [
        ("uMsg", ctypes.wintypes.DWORD),
        ("wParamL", ctypes.wintypes.WORD),
        ("wParamH", ctypes.wintypes.WORD),
    ]


class _InputValue(ctypes.Union):
    _fields_ = [("mi", _MouseInput), ("ki", _KeyboardInput), ("hi", _HardwareInput)]


class _Input(ctypes.Structure):
    _anonymous_ = ("value",)
    _fields_ = [("type", ctypes.wintypes.DWORD), ("value", _InputValue)]


_KEYS = {
    "backspace": 0x08,
    "tab": 0x09,
    "enter": 0x0D,
    "shift": 0x10,
    "ctrl": 0x11,
    "control": 0x11,
    "alt": 0x12,
    "escape": 0x1B,
    "esc": 0x1B,
    "space": 0x20,
    "pageup": 0x21,
    "pagedown": 0x22,
    "end": 0x23,
    "home": 0x24,
    "left": 0x25,
    "up": 0x26,
    "right": 0x27,
    "down": 0x28,
    "delete": 0x2E,
    "win": 0x5B,
    "meta": 0x5B,
}


class Win32InputDriver:
    """Small SendInput wrapper; no clipboard and no generated code."""

    def __init__(self) -> None:
        if os.name != "nt":
            raise RuntimeError("windows_input_unavailable")
        self._user32 = ctypes.windll.user32
        self._user32.SendInput.argtypes = [
            ctypes.wintypes.UINT,
            ctypes.POINTER(_Input),
            ctypes.c_int,
        ]
        self._user32.SendInput.restype = ctypes.wintypes.UINT
        self._user32.WindowFromPoint.argtypes = [ctypes.wintypes.POINT]
        self._user32.WindowFromPoint.restype = ctypes.wintypes.HWND
        self._user32.GetAncestor.argtypes = [ctypes.wintypes.HWND, ctypes.wintypes.UINT]
        self._user32.GetAncestor.restype = ctypes.wintypes.HWND
        self._user32.GetForegroundWindow.restype = ctypes.wintypes.HWND
        self._user32.SetCursorPos.argtypes = [ctypes.c_int, ctypes.c_int]
        self._user32.SetCursorPos.restype = ctypes.wintypes.BOOL
        self._user32.VkKeyScanW.argtypes = [ctypes.wintypes.WCHAR]
        self._user32.VkKeyScanW.restype = ctypes.c_short

    def _send(self, entries: list[_Input]) -> None:
        if not entries:
            return
        batch = (_Input * len(entries))(*entries)
        sent = int(self._user32.SendInput(len(batch), batch, ctypes.sizeof(_Input)) or 0)
        if sent != len(batch):
            raise RuntimeError(f"send_input_incomplete:{sent}/{len(batch)}")

    def _mouse(self, flag: int, data: int = 0) -> None:
        self._send([_Input(type=0, mi=_MouseInput(0, 0, data & 0xFFFFFFFF, flag, 0, 0))])

    def _vk(self, key: str) -> int:
        clean = str(key or "").strip().casefold()
        if clean in _KEYS:
            return _KEYS[clean]
        if len(clean) == 1:
            resolved = int(self._user32.VkKeyScanW(clean))
            if resolved != -1:
                return resolved & 0xFF
        if clean.startswith("f") and clean[1:].isdigit() and 1 <= int(clean[1:]) <= 24:
            return 0x6F + int(clean[1:])
        raise ValueError(f"unsupported_key:{key}")

    def window_at(self, point: tuple[int, int]) -> int:
        value = self._user32.WindowFromPoint(ctypes.wintypes.POINT(*point))
        return int(self._user32.GetAncestor(value, 2) or value or 0)

    def foreground_window(self) -> int:
        value = self._user32.GetForegroundWindow()
        return int(self._user32.GetAncestor(value, 2) or value or 0)

    def _position(self, point: tuple[int, int]) -> None:
        if not self._user32.SetCursorPos(int(point[0]), int(point[1])):
            raise RuntimeError("set_cursor_position_failed")

    def click(self, point: tuple[int, int], *, button: str, count: int) -> None:
        self._position(point)
        down, up = (0x0008, 0x0010) if button == "right" else (0x0002, 0x0004)
        for _ in range(max(1, int(count))):
            self._mouse(down)
            self._mouse(up)

    def move(self, point: tuple[int, int], *, duration_ms: int) -> None:
        del duration_ms
        self._position(point)

    def drag(
        self,
        start: tuple[int, int],
        end: tuple[int, int],
        *,
        duration_ms: int,
    ) -> None:
        self._position(start)
        self._mouse(0x0002)
        try:
            steps = max(1, min(60, int(duration_ms) // 16 if duration_ms else 1))
            delay = max(0.0, float(duration_ms) / 1000.0 / steps)
            for index in range(1, steps + 1):
                fraction = index / steps
                self._position((
                    round(start[0] + (end[0] - start[0]) * fraction),
                    round(start[1] + (end[1] - start[1]) * fraction),
                ))
                if delay:
                    time.sleep(delay)
        finally:
            self._mouse(0x0004)

    def scroll(self, point: tuple[int, int], *, delta: int) -> None:
        self._position(point)
        self._mouse(0x0800, int(delta) * 120)

    def type_text(self, value: str) -> None:
        entries: list[_Input] = []
        text = str(value)
        index = 0
        while index < len(text):
            char = text[index]
            if char == "\r" and index + 1 < len(text) and text[index + 1] == "\n":
                index += 1
            if char in {"\r", "\n", "\t"}:
                virtual_key = 0x09 if char == "\t" else 0x0D
                entries.extend([
                    _Input(type=1, ki=_KeyboardInput(virtual_key, 0, 0, 0, 0)),
                    _Input(type=1, ki=_KeyboardInput(virtual_key, 0, 0x0002, 0, 0)),
                ])
            else:
                raw = char.encode("utf-16-le", errors="strict")
                for offset in range(0, len(raw), 2):
                    unit = int.from_bytes(raw[offset:offset + 2], "little")
                    entries.extend([
                        _Input(type=1, ki=_KeyboardInput(0, unit, 0x0004, 0, 0)),
                        _Input(type=1, ki=_KeyboardInput(0, unit, 0x0006, 0, 0)),
                    ])
            index += 1
        self._send(entries)

    def key_down(self, key: str) -> None:
        self._send([_Input(type=1, ki=_KeyboardInput(self._vk(key), 0, 0, 0, 0))])

    def key_up(self, key: str) -> None:
        self._send([_Input(type=1, ki=_KeyboardInput(self._vk(key), 0, 0x0002, 0, 0))])


class WindowsComputerOperatorBackend:
    backend_name = "windows-native"

    def __init__(
        self,
        *,
        output_root: Path | str,
        capture_provider: CaptureProvider | None = None,
        driver: WindowsInputDriver | None = None,
    ) -> None:
        self.output_root = Path(output_root)
        self.capture_provider = capture_provider or GdiFallbackCaptureProvider()
        self.driver = driver or Win32InputDriver()
        self._held_by_operation: dict[str, set[str]] = {}
        self._input_lock = threading.RLock()

    @staticmethod
    def _check_cancel(scope: Any) -> None:
        checker = getattr(scope, "raise_if_cancelled", None)
        if callable(checker):
            checker()

    @staticmethod
    def _expected_hwnds(grant: SurfaceGrant) -> set[int]:
        lease = grant.target_lease
        raw = lease.get("windows")
        windows = raw if isinstance(raw, list) and raw else [lease.get("window")]
        return {
            int(item.get("hwnd") or 0)
            for item in windows
            if isinstance(item, dict) and int(item.get("hwnd") or 0) > 0
        }

    @staticmethod
    def _screen_point(
        point: tuple[float, float] | None,
        grant: SurfaceGrant,
    ) -> tuple[int, int]:
        if point is None:
            raise ValueError("action_coordinate_missing")
        left, top, right, bottom = grant.bounds_ltrb
        return (
            left + round(float(point[0]) * max(0, right - left - 1)),
            top + round(float(point[1]) * max(0, bottom - top - 1)),
        )

    def _pointer_target(
        self,
        point: tuple[float, float] | None,
        grant: SurfaceGrant,
    ) -> tuple[int, int]:
        screen = self._screen_point(point, grant)
        expected = self._expected_hwnds(grant)
        if not expected or int(self.driver.window_at(screen)) not in expected:
            raise PermissionError("pointer_target_outside_surface")
        return screen

    def _require_foreground(self, grant: SurfaceGrant) -> None:
        expected = self._expected_hwnds(grant)
        if not expected or int(self.driver.foreground_window()) not in expected:
            raise PermissionError("foreground_target_outside_surface")

    def observe(self, grant: SurfaceGrant, *, scope: Any = None) -> OperatorObservation:
        self._check_cancel(scope)
        if not self.capture_provider.available():
            raise RuntimeError(self.capture_provider.unavailable_reason or "capture_unavailable")
        image = self.capture_provider.capture(grant.bounds_ltrb)
        self._check_cancel(scope)
        self.output_root.mkdir(parents=True, exist_ok=True)
        observation_id = str(uuid.uuid4())
        path = self.output_root / f"{observation_id}.png"
        temp = self.output_root / f".{observation_id}.tmp"
        image.save(temp, format="PNG")
        os.replace(temp, path)
        payload = path.read_bytes()
        width, height = image.size
        return OperatorObservation(
            observation_id=observation_id,
            surface_id=grant.surface_id,
            image_ref=str(path),
            image_sha256=hashlib.sha256(payload).hexdigest(),
            width=int(width),
            height=int(height),
            captured_at=datetime.now(UTC).isoformat(),
            used_backend=f"{self.backend_name}:{self.capture_provider.source}",
        )

    def execute(
        self,
        action: ComputerAction,
        grant: SurfaceGrant,
        *,
        scope: Any = None,
    ) -> OperatorBackendResult:
        try:
            with self._input_lock:
                self._check_cancel(scope)
                data = self._execute_locked(action, grant, scope=scope)
                self._check_cancel(scope)
            return OperatorBackendResult(executed=True, data=data)
        except CancelledError:
            raise
        except PermissionError as exc:
            return OperatorBackendResult(executed=False, error=str(exc))
        except Exception as exc:
            return OperatorBackendResult(
                executed=False,
                error=f"windows_input_failed:{type(exc).__name__}:{exc}",
            )

    def _execute_locked(
        self,
        action: ComputerAction,
        grant: SurfaceGrant,
        *,
        scope: Any,
    ) -> dict[str, Any]:
        kind = action.kind
        if kind in {
            ComputerActionKind.CLICK,
            ComputerActionKind.DOUBLE_CLICK,
            ComputerActionKind.RIGHT_CLICK,
        }:
            point = self._pointer_target(action.start, grant)
            self.driver.click(
                point,
                button="right" if kind is ComputerActionKind.RIGHT_CLICK else "left",
                count=2 if kind is ComputerActionKind.DOUBLE_CLICK else 1,
            )
            return {"screenPoint": list(point)}
        if kind is ComputerActionKind.HOVER:
            point = self._pointer_target(action.start, grant)
            self.driver.move(point, duration_ms=action.duration_ms)
            return {"screenPoint": list(point)}
        if kind is ComputerActionKind.DRAG:
            start = self._pointer_target(action.start, grant)
            end = self._pointer_target(action.end, grant)
            self.driver.drag(start, end, duration_ms=action.duration_ms)
            return {"startPoint": list(start), "endPoint": list(end)}
        if kind is ComputerActionKind.SCROLL:
            point = self._pointer_target(action.start, grant)
            self.driver.scroll(point, delta=action.scroll_delta)
            return {"screenPoint": list(point), "delta": action.scroll_delta}
        if kind is ComputerActionKind.TYPE_TEXT:
            self._require_foreground(grant)
            self.driver.type_text(str(action.text))
            return {"characters": len(str(action.text))}
        if kind is ComputerActionKind.HOTKEY:
            self._require_foreground(grant)
            pressed: list[str] = []
            action_error: Exception | None = None
            try:
                for key in action.keys:
                    self._check_cancel(scope)
                    self.driver.key_down(key)
                    pressed.append(key)
            except Exception as exc:
                action_error = exc
            release_error: Exception | None = None
            for key in reversed(pressed):
                try:
                    self.driver.key_up(key)
                except Exception as exc:
                    release_error = release_error or exc
            if action_error is not None:
                raise action_error
            if release_error is not None:
                raise release_error
            return {"keys": list(action.keys)}
        if kind is ComputerActionKind.KEY_DOWN:
            self._require_foreground(grant)
            held = self._held_by_operation.setdefault(action.action_id, set())
            pressed: list[str] = []
            try:
                for key in action.keys:
                    self.driver.key_down(key)
                    held.add(key)
                    pressed.append(key)
            except Exception:
                for key in reversed(pressed):
                    try:
                        self.driver.key_up(key)
                    except Exception:
                        continue
                    held.discard(key)
                if not held:
                    self._held_by_operation.pop(action.action_id, None)
                raise
            return {"keys": list(action.keys)}
        if kind is ComputerActionKind.KEY_UP:
            self._require_foreground(grant)
            release_error: Exception | None = None
            for key in action.keys:
                try:
                    self.driver.key_up(key)
                except Exception as exc:
                    release_error = release_error or exc
                    continue
                for held in self._held_by_operation.values():
                    held.discard(key)
            if release_error is not None:
                raise release_error
            return {"keys": list(action.keys)}
        if kind is ComputerActionKind.WAIT:
            deadline = time.monotonic() + action.duration_ms / 1000.0
            while time.monotonic() < deadline:
                self._check_cancel(scope)
                time.sleep(min(0.05, max(0.0, deadline - time.monotonic())))
            return {"waitedMs": action.duration_ms}
        raise ValueError(f"unsupported_action:{kind.value}")

    def abort(self, operation_id: str) -> bool:
        with self._input_lock:
            held = self._held_by_operation.pop(str(operation_id), set())
            released = False
            for key in reversed(tuple(held)):
                try:
                    self.driver.key_up(key)
                    released = True
                except Exception:
                    pass
            return released
