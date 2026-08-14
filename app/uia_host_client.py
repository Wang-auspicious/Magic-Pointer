"""Resident UIA host client (Phase C; review priority #1).

The per-request probe pays a ~570ms process cold start + COM rebuild per
read. The resident host (`uia_resident_host.exe`, compiled from the same
probe source with ``RESIDENT_HOST`` defined) serves the identical result
contract over a named pipe. This client is the funnel:

- line protocol: ``id|ping`` or ``id|hwnd[|x|y|region|x|y|w|h]``;
- circuit breaker: N consecutive transport failures open the circuit for
  a cooldown (callers then fall back to the per-request probe process);
- every method is pure-connect logic; the OS pipe I/O is injected so
  tests run against a fake transport, no named pipe required.

Pure Python, stdlib + ctypes only.
"""

from __future__ import annotations

import ctypes
import json
import os
import time
from typing import Any, Callable

__all__ = [
    "UiaHostClient",
    "build_request_line",
    "parse_response",
]

_GENERIC_READ = 0x80000000
_GENERIC_WRITE = 0x40000000
_OPEN_EXISTING = 3
_INVALID_HANDLE_VALUE = -1


def _open_pipe_handle(name: str, timeout_s: float) -> int:
    """Open the ``\\\\.\\pipe\\<name>`` path with a wall-clock wait; -1 on failure."""
    kernel32 = ctypes.windll.kernel32
    path = "\\\\.\\pipe\\" + name
    deadline = time.monotonic() + timeout_s
    while True:
        handle = kernel32.CreateFileW(
            path,
            _GENERIC_READ | _GENERIC_WRITE,
            0,  # no sharing: exclusive client
            None,
            _OPEN_EXISTING,
            0,
            None,
        )
        if handle not in (-1, _INVALID_HANDLE_VALUE):
            return handle
        if time.monotonic() >= deadline:
            return -1
        time.sleep(0.02)


def _write_pipe(handle: int, line: str) -> bool:
    kernel32 = ctypes.windll.kernel32
    payload = (line + "\n").encode("utf-8")
    written = ctypes.c_uint32(0)
    result = kernel32.WriteFile(
        handle,
        payload,
        len(payload),
        ctypes.byref(written),
        None,
    )
    return bool(result) and written.value == len(payload)


def _read_pipe(handle: int, timeout_s: float) -> str | None:
    """Read one line; None on timeout/EOF/error."""
    kernel32 = ctypes.windll.kernel32
    deadline = time.monotonic() + timeout_s
    buffer = bytearray()
    while True:
        available = ctypes.c_uint32(0)
        kernel32.PeekNamedPipe(
            handle, None, 0, None, ctypes.byref(available), None
        )
        if available.value > 0:
            chunk = (ctypes.c_char * min(available.value, 65536))()
            read = ctypes.c_uint32(0)
            ok = kernel32.ReadFile(
                handle, chunk, len(chunk), ctypes.byref(read), None
            )
            if not ok or read.value == 0:
                return None
            buffer.extend(chunk.raw[: read.value])
            if b"\n" in buffer:
                break
        elif time.monotonic() >= deadline:
            return None
        else:
            time.sleep(0.005)
    first, _, _rest = bytes(buffer).partition(b"\n")
    return first.decode("utf-8", errors="replace")


def build_request_line(
    hwnd: int,
    *,
    target_point: dict[str, int] | None = None,
    target_region: dict[str, int] | None = None,
) -> str:
    """The host's one-line request protocol."""
    parts = [str(int(hwnd))]
    if isinstance(target_region, dict):
        try:
            parts.extend([
                "region",
                str(int(target_region.get("x"))),
                str(int(target_region.get("y"))),
                str(int(target_region.get("width"))),
                str(int(target_region.get("height"))),
            ])
        except (TypeError, ValueError):
            parts = [str(int(hwnd))]
    elif isinstance(target_point, dict):
        try:
            parts.extend([
                str(int(target_point.get("x"))),
                str(int(target_point.get("y"))),
            ])
        except (TypeError, ValueError):
            parts = [str(int(hwnd))]
    return "|".join(parts)


def parse_response(line: str) -> dict[str, Any] | None:
    """Parse a host response line into the probe-shaped dict; None if junk."""
    if not line or not line.strip().startswith("{"):
        return None
    try:
        data = json.loads(line)
    except ValueError:
        return None
    if not isinstance(data, dict):
        return None
    if "id" in data:
        data = {key: value for key, value in data.items() if key != "id"}
    return data


class UiaHostClient:
    """Circuit-breakered named-pipe client for the resident UIA host."""

    def __init__(
        self,
        *,
        pipe_name: str | None = None,
        connect_timeout_s: float = 1.0,
        response_timeout_s: float = 5.0,
        cooldown_s: float = 30.0,
        max_failures: int = 3,
    ) -> None:
        self.pipe_name = pipe_name or os.environ.get(
            "MAGIC_POINTER_UIA_HOST_PIPE", "MagicPointerUIAHost"
        )
        self.connect_timeout_s = max(0.05, float(connect_timeout_s))
        self.response_timeout_s = max(0.1, float(response_timeout_s))
        self.cooldown_s = max(0.0, float(cooldown_s))
        self.max_failures = max(1, int(max_failures))
        self._consecutive_failures = 0
        self._open_until = 0.0
        self._next_id = 1

    # -- circuit -----------------------------------------------------------

    def available(self) -> bool:
        return time.monotonic() >= self._open_until

    def _record_failure(self) -> None:
        self._consecutive_failures += 1
        if self._consecutive_failures >= self.max_failures:
            self._open_until = time.monotonic() + self.cooldown_s
            self._consecutive_failures = 0

    def _record_success(self) -> None:
        self._consecutive_failures = 0

    # -- requests ----------------------------------------------------------

    def ping(self) -> bool:
        """One transport round trip; True means the host is alive."""
        if not self.available():
            return False
        request_id = self._next_id
        self._next_id += 1
        raw = self._exchange(f"{request_id}|ping")
        if raw is None:
            self._record_failure()
            return False
        data = parse_response(raw)
        if not data or data.get("ok") is not True:
            self._record_failure()
            return False
        self._record_success()
        return True

    def probe(
        self,
        hwnd: int,
        *,
        target_point: dict[str, int] | None = None,
        target_region: dict[str, int] | None = None,
    ) -> dict[str, Any] | None:
        """One probe over the resident host; None = transport-level failure
        (the caller falls back to the per-request probe process)."""
        if not self.available():
            return None
        request_id = self._next_id
        self._next_id += 1
        line = f"{request_id}|{build_request_line(hwnd, target_point=target_point, target_region=target_region)}"
        raw = self._exchange(line)
        if raw is None:
            self._record_failure()
            return None
        data = parse_response(raw)
        if data is None or "ok" not in data:
            self._record_failure()
            return None
        self._record_success()
        return data

    # -- transport (injectable) --------------------------------------------

    def _exchange(self, line: str) -> str | None:
        handle = _open_pipe_handle(self.pipe_name, self.connect_timeout_s)
        if handle == -1:
            return None
        try:
            if not _write_pipe(handle, line):
                return None
            return _read_pipe(handle, self.response_timeout_s)
        finally:
            try:
                ctypes.windll.kernel32.CloseHandle(handle)
            except Exception:  # noqa: BLE001
                pass
