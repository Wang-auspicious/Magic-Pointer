from __future__ import annotations

from app.system_context import process_name_for_pid


def test_process_name_for_pid_returns_only_executable_name() -> None:
    assert process_name_for_pid(
        77,
        query_path=lambda pid: rf"C:\Windows\System32\demo-{pid}.EXE",
    ) == "demo-77.EXE"


def test_process_name_for_pid_fails_closed_for_invalid_or_unreadable_process() -> None:
    assert process_name_for_pid(0, query_path=lambda _pid: "ignored.exe") == ""
    assert process_name_for_pid(
        77,
        query_path=lambda _pid: (_ for _ in ()).throw(OSError("denied")),
    ) == ""
