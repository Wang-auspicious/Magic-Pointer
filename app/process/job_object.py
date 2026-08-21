"""Windows JobObject with KILL_ON_JOB_CLOSE.

Everywhere Watchdog's idea, written here: MCP/OCR children join a job so
the OS reaps them when this process dies. The C# is BSL 1.1; this module
is original ctypes.
"""

from __future__ import annotations

import ctypes
import os
from ctypes import wintypes
from typing import Any

JobObjectExtendedLimitInformation = 9
JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000
_PROCESS_TERMINATE = 0x0001
_PROCESS_SET_QUOTA = 0x0100
_PROCESS_ACCESS = _PROCESS_TERMINATE | _PROCESS_SET_QUOTA

__all__ = ["KillOnCloseJob", "attach_kill_on_close"]


class _IoCounters(ctypes.Structure):
    _fields_ = [
        ("ReadOperationCount", ctypes.c_uint64),
        ("WriteOperationCount", ctypes.c_uint64),
        ("OtherOperationCount", ctypes.c_uint64),
        ("ReadTransferCount", ctypes.c_uint64),
        ("WriteTransferCount", ctypes.c_uint64),
        ("OtherTransferCount", ctypes.c_uint64),
    ]


class _BasicLimitInformation(ctypes.Structure):
    _fields_ = [
        ("PerProcessUserTimeLimit", ctypes.c_int64),
        ("PerJobUserTimeLimit", ctypes.c_int64),
        ("LimitFlags", wintypes.DWORD),
        ("MinimumWorkingSetSize", ctypes.c_size_t),
        ("MaximumWorkingSetSize", ctypes.c_size_t),
        ("ActiveProcessLimit", wintypes.DWORD),
        ("Affinity", ctypes.c_size_t),
        ("PriorityClass", wintypes.DWORD),
        ("SchedulingClass", wintypes.DWORD),
    ]


class _ExtendedLimitInformation(ctypes.Structure):
    _fields_ = [
        ("BasicLimitInformation", _BasicLimitInformation),
        ("IoInfo", _IoCounters),
        ("ProcessMemoryLimit", ctypes.c_size_t),
        ("JobMemoryLimit", ctypes.c_size_t),
        ("PeakProcessMemoryUsed", ctypes.c_size_t),
        ("PeakJobMemoryUsed", ctypes.c_size_t),
    ]


def _kernel32() -> Any:
    dll = ctypes.WinDLL("kernel32", use_last_error=True)
    dll.CreateJobObjectW.argtypes = [wintypes.LPVOID, wintypes.LPCWSTR]
    dll.CreateJobObjectW.restype = wintypes.HANDLE
    dll.SetInformationJobObject.argtypes = [
        wintypes.HANDLE,
        ctypes.c_int,
        wintypes.LPVOID,
        wintypes.DWORD,
    ]
    dll.SetInformationJobObject.restype = wintypes.BOOL
    dll.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    dll.AssignProcessToJobObject.restype = wintypes.BOOL
    dll.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    dll.OpenProcess.restype = wintypes.HANDLE
    dll.CloseHandle.argtypes = [wintypes.HANDLE]
    dll.CloseHandle.restype = wintypes.BOOL
    return dll


class KillOnCloseJob:
    """One job whose members die when this handle is closed."""

    def __init__(self) -> None:
        if os.name != "nt":
            raise RuntimeError("job_object_unavailable")
        self._dll = _kernel32()
        handle = self._dll.CreateJobObjectW(None, None)
        if not handle:
            raise OSError("CreateJobObjectW failed")
        info = _ExtendedLimitInformation()
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not self._dll.SetInformationJobObject(
            handle,
            JobObjectExtendedLimitInformation,
            ctypes.byref(info),
            ctypes.sizeof(info),
        ):
            self._dll.CloseHandle(handle)
            raise OSError("SetInformationJobObject failed")
        self._handle = handle

    def assign(self, process: object) -> bool:
        if not self._handle:
            return False
        handle, owned = _process_handle(self._dll, process)
        if not handle:
            return False
        try:
            return bool(self._dll.AssignProcessToJobObject(self._handle, handle))
        finally:
            if owned:
                self._dll.CloseHandle(handle)

    def close(self) -> None:
        handle = self._handle
        self._handle = None
        if handle:
            self._dll.CloseHandle(handle)

    def __del__(self) -> None:  # pragma: no cover - interpreter teardown
        try:
            self.close()
        except Exception:
            return


_PROCESS_JOB: KillOnCloseJob | None = None


def attach_kill_on_close(process: object) -> bool:
    """Assign ``process`` to the process-wide kill-on-close job.

    Returns False when JobObjects are unavailable or assignment fails.
    Never raises: a spawn must not die because the watchdog could not attach.
    """
    if os.name != "nt" or process is None:
        return False
    global _PROCESS_JOB
    try:
        if _PROCESS_JOB is None:
            _PROCESS_JOB = KillOnCloseJob()
        return _PROCESS_JOB.assign(process)
    except Exception:
        return False


def _process_handle(dll: Any, process: object) -> tuple[int, bool]:
    popen_handle = getattr(process, "_handle", None)
    if popen_handle:
        return int(popen_handle), False
    pid = process if isinstance(process, int) else getattr(process, "pid", None)
    if not pid:
        return 0, False
    handle = dll.OpenProcess(_PROCESS_ACCESS, False, int(pid))
    return int(handle or 0), True
