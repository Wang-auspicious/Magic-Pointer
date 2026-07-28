from __future__ import annotations

import ctypes
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
from ctypes import wintypes
from pathlib import Path
from typing import Any, Callable, Iterable
from urllib.parse import urlsplit


_SECRET_ARGUMENT = re.compile(
    r"(?i)(--?(?:api[-_]?key|token|secret|password|passwd|authorization|credential))(?:(=)|\s+)(\"[^\"]*\"|'[^']*'|\S+)"
)
_SECRET_ASSIGNMENT = re.compile(
    r"(?i)\b([A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL))=([^\s]+)"
)


def _resolved_directory(value: object) -> str:
    text = str(value or "").strip().strip('"')
    if not text:
        return ""
    try:
        path = Path(text).expanduser().resolve()
    except OSError:
        return ""
    return str(path) if path.is_dir() else ""


def _git_root(cwd: str) -> str:
    if not cwd:
        return ""
    try:
        completed = subprocess.run(
            ["git", "-C", cwd, "rev-parse", "--show-toplevel"],
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=2.5,
            shell=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return ""
    if completed.returncode != 0:
        return ""
    return _resolved_directory(completed.stdout.strip())


def redact_launch_command(value: object) -> str:
    text = str(value or "").replace("\r", " ").replace("\n", " ").strip()
    text = re.sub(r"\s+", " ", text)
    text = _SECRET_ARGUMENT.sub(lambda match: f"{match.group(1)}{'=' if match.group(2) else ' '}[redacted]", text)
    text = _SECRET_ASSIGNMENT.sub(lambda match: f"{match.group(1)}=[redacted]", text)
    text = re.sub(r"(?i)(https?://[^\s/:]+):[^\s/@]+@", r"\1:[redacted]@", text)
    return text[:2000]


def _command_path_candidates(command_line: str) -> list[str]:
    candidates: list[str] = []
    try:
        tokens = shlex.split(command_line, posix=False)
    except ValueError:
        tokens = command_line.split()
    for index, raw in enumerate(tokens[:128]):
        token = raw.strip().strip('"')
        if token in {"-C", "--cwd", "--cd", "--directory"} and index + 1 < len(tokens):
            directory = _resolved_directory(tokens[index + 1])
            if directory and directory not in candidates:
                candidates.append(directory)
            continue
        if "=" in token and token.split("=", 1)[0] in {"--cwd", "--cd", "--directory"}:
            directory = _resolved_directory(token.split("=", 1)[1])
            if directory and directory not in candidates:
                candidates.append(directory)
            continue
        try:
            path = Path(token).expanduser()
        except (OSError, ValueError):
            continue
        if path.is_absolute() and path.exists():
            directory = str((path if path.is_dir() else path.parent).resolve())
            if directory not in candidates:
                candidates.append(directory)
    return candidates


def _windows_current_directory(pid: int) -> str:
    """Best-effort x64 PEB read; returns empty for inaccessible/WOW64 processes."""
    if os.name != "nt" or ctypes.sizeof(ctypes.c_void_p) != 8:
        return ""
    process = None
    kernel32 = None
    try:
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        ntdll = ctypes.WinDLL("ntdll")
        kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel32.OpenProcess.restype = wintypes.HANDLE
        kernel32.ReadProcessMemory.argtypes = [wintypes.HANDLE, wintypes.LPCVOID, wintypes.LPVOID, ctypes.c_size_t, ctypes.POINTER(ctypes.c_size_t)]
        kernel32.ReadProcessMemory.restype = wintypes.BOOL
        kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel32.IsWow64Process.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.BOOL)]
        process = kernel32.OpenProcess(0x0410, False, int(pid))
        if not process:
            return ""
        wow64 = wintypes.BOOL()
        if kernel32.IsWow64Process(process, ctypes.byref(wow64)) and wow64.value:
            return ""

        class PROCESS_BASIC_INFORMATION(ctypes.Structure):
            _fields_ = [
                ("Reserved1", ctypes.c_void_p),
                ("PebBaseAddress", ctypes.c_void_p),
                ("Reserved2", ctypes.c_void_p * 2),
                ("UniqueProcessId", ctypes.c_void_p),
                ("Reserved3", ctypes.c_void_p),
            ]

        pbi = PROCESS_BASIC_INFORMATION()
        returned = wintypes.ULONG()
        if ntdll.NtQueryInformationProcess(process, 0, ctypes.byref(pbi), ctypes.sizeof(pbi), ctypes.byref(returned)) != 0:
            return ""

        def read(address: int, size: int) -> bytes | None:
            buffer = ctypes.create_string_buffer(size)
            count = ctypes.c_size_t()
            if not kernel32.ReadProcessMemory(process, ctypes.c_void_p(address), buffer, size, ctypes.byref(count)):
                return None
            return buffer.raw[:count.value]

        peb = int(pbi.PebBaseAddress or 0)
        raw_parameters = read(peb + 0x20, 8) if peb else None
        if not raw_parameters or len(raw_parameters) < 8:
            return ""
        parameters = int.from_bytes(raw_parameters[:8], "little")
        raw_string = read(parameters + 0x38, 16) if parameters else None
        if not raw_string or len(raw_string) < 16:
            return ""
        length = int.from_bytes(raw_string[0:2], "little")
        buffer_address = int.from_bytes(raw_string[8:16], "little")
        if length <= 0 or length > 32768 or not buffer_address:
            return ""
        raw_value = read(buffer_address, length)
        if not raw_value:
            return ""
        return _resolved_directory(raw_value.decode("utf-16-le", errors="replace"))
    except (AttributeError, OSError, ValueError):
        return ""
    finally:
        if process:
            try:
                if kernel32 is not None:
                    kernel32.CloseHandle(process)
            except Exception:
                pass


def _default_process_probe(pid: int) -> dict[str, Any] | None:
    if pid <= 0:
        return None
    if pid == os.getpid():
        return {
            "pid": pid,
            "parentPid": os.getppid(),
            "cwd": str(Path.cwd().resolve()),
            "executablePath": str(Path(sys.executable).resolve()),
            "commandLine": subprocess.list2cmdline([sys.executable, *sys.argv]),
        }
    cwd = _windows_current_directory(pid)
    if os.name != "nt":
        proc = Path("/proc") / str(pid)
        try:
            command = proc.joinpath("cmdline").read_bytes().replace(b"\0", b" ").decode(errors="replace").strip()
            executable = str(proc.joinpath("exe").resolve())
            cwd = str(proc.joinpath("cwd").resolve())
            status = proc.joinpath("status").read_text(encoding="utf-8", errors="replace")
            parent_match = re.search(r"(?m)^PPid:\s+(\d+)", status)
            return {"pid": pid, "parentPid": int(parent_match.group(1)) if parent_match else 0, "cwd": cwd, "executablePath": executable, "commandLine": command}
        except OSError:
            return None
    powershell = shutil.which("powershell.exe") or shutil.which("powershell")
    if not powershell:
        return {"pid": pid, "parentPid": 0, "cwd": cwd, "executablePath": "", "commandLine": ""} if cwd else None
    command = (
        f"$p=Get-CimInstance Win32_Process -Filter \"ProcessId={int(pid)}\";"
        "if($p){[pscustomobject]@{pid=[int]$p.ProcessId;parentPid=[int]$p.ParentProcessId;"
        "executablePath=[string]$p.ExecutablePath;commandLine=[string]$p.CommandLine}|ConvertTo-Json -Compress}"
    )
    try:
        completed = subprocess.run(
            [powershell, "-NoProfile", "-NonInteractive", "-Command", command],
            check=False, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            text=True, encoding="utf-8", errors="replace", timeout=3.5, shell=False,
        )
        value = json.loads(completed.stdout) if completed.returncode == 0 and completed.stdout.strip() else None
    except (OSError, subprocess.TimeoutExpired, json.JSONDecodeError):
        value = None
    if not isinstance(value, dict):
        return {"pid": pid, "parentPid": 0, "cwd": cwd, "executablePath": "", "commandLine": ""} if cwd else None
    value["cwd"] = cwd
    return value


def _default_listener_probe(port: int) -> int | None:
    if not (1 <= int(port) <= 65535):
        return None
    try:
        completed = subprocess.run(
            ["netstat", "-ano", "-p", "tcp"], check=False,
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            text=True, encoding="utf-8", errors="replace", timeout=3.0, shell=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    pattern = re.compile(rf"^\s*TCP\s+\S*:{int(port)}\s+\S+\s+(\S+)\s+(\d+)\s*$", re.IGNORECASE)
    established_pid: int | None = None
    for line in completed.stdout.splitlines():
        match = pattern.match(line)
        if match:
            state = match.group(1).casefold()
            pid = int(match.group(2))
            if state == "listening":
                return pid
            if state == "established" and established_pid is None:
                established_pid = pid
    return established_pid


class RuntimeWorkspaceResolver:
    def __init__(
        self,
        *,
        process_probe: Callable[[int], dict[str, Any] | None] = _default_process_probe,
        listener_probe: Callable[[int], int | None] = _default_listener_probe,
    ) -> None:
        self.process_probe = process_probe
        self.listener_probe = listener_probe

    @staticmethod
    def _source(objects: Iterable[dict[str, Any]]) -> tuple[int, str, list[str]]:
        target_pid = 0
        local_url = ""
        documents: list[str] = []
        for obj in objects:
            source = obj.get("source")
            source = dict(source) if isinstance(source, dict) else {}
            if not target_pid:
                try:
                    target_pid = int(source.get("processId") or source.get("process_id") or source.get("pid") or 0)
                except (TypeError, ValueError):
                    target_pid = 0
            url = str(source.get("url") or "").strip()
            if url and not local_url:
                try:
                    parsed = urlsplit(url)
                    host = (parsed.hostname or "").casefold()
                    if host == "localhost" or host == "::1" or host.startswith("127."):
                        local_url = f"{parsed.scheme}://{parsed.hostname}:{parsed.port or (443 if parsed.scheme == 'https' else 80)}"
                except ValueError:
                    pass
            for key in ("documentPath", "document_path", "path"):
                raw = str(source.get(key) or "").strip()
                if not raw:
                    continue
                try:
                    path = Path(raw).expanduser().resolve()
                except OSError:
                    continue
                if path.is_file() and path.suffix.casefold() not in {".png", ".jpg", ".jpeg", ".webp", ".bmp"}:
                    documents.append(str(path.parent))
        return target_pid, local_url, documents

    def resolve(self, objects: Iterable[dict[str, Any]], *, fallback_cwd: Path | str) -> dict[str, Any]:
        clean_objects = [dict(item) for item in objects if isinstance(item, dict)]
        target_pid, local_origin, document_dirs = self._source(clean_objects)
        candidates: list[tuple[int, str]] = []
        if local_origin:
            try:
                port = int(urlsplit(local_origin).port or 0)
            except ValueError:
                port = 0
            listener_pid = self.listener_probe(port) if port else None
            if listener_pid:
                candidates.append((int(listener_pid), "localhost_listener"))
        if target_pid and all(pid != target_pid for pid, _relation in candidates):
            candidates.append((target_pid, "window_process"))

        first_real_cwd: tuple[dict[str, Any], str, str] | None = None
        visited: set[int] = set()
        for root_pid, root_relation in candidates:
            pid = root_pid
            depth = 0
            while pid > 0 and pid not in visited and depth < 6:
                visited.add(pid)
                record = self.process_probe(pid)
                if not isinstance(record, dict):
                    break
                relation = root_relation if depth == 0 else f"{root_relation}_parent"
                cwd_candidates = []
                cwd = _resolved_directory(record.get("cwd"))
                if cwd:
                    cwd_candidates.append(cwd)
                cwd_candidates.extend(item for item in _command_path_candidates(str(record.get("commandLine") or "")) if item not in cwd_candidates)
                for candidate_cwd in cwd_candidates:
                    repo = _git_root(candidate_cwd)
                    if first_real_cwd is None:
                        first_real_cwd = (record, relation, candidate_cwd)
                    if repo:
                        return self._bound(record, relation, candidate_cwd, repo, target_pid, local_origin)
                try:
                    pid = int(record.get("parentPid") or 0)
                except (TypeError, ValueError):
                    pid = 0
                depth += 1

        for directory in document_dirs:
            repo = _git_root(directory)
            if repo:
                return {
                    "schemaVersion": 1, "state": "bound", "relation": "pointed_document",
                    "targetProcessId": target_pid or None, "workspaceProcessId": None,
                    "cwd": directory, "repoRoot": repo, "executablePath": "", "launchCommand": "",
                    "sourceOrigin": local_origin,
                }
        if first_real_cwd is not None:
            record, relation, candidate_cwd = first_real_cwd
            return self._bound(record, relation, candidate_cwd, "", target_pid, local_origin, state="bound_no_repo")
        fallback = _resolved_directory(fallback_cwd) or str(Path.cwd().resolve())
        return {
            "schemaVersion": 1,
            "state": "fallback_unverified",
            "relation": "explicit_cwd_fallback",
            "targetProcessId": target_pid or None,
            "workspaceProcessId": None,
            "cwd": fallback,
            "repoRoot": _git_root(fallback),
            "executablePath": "",
            "launchCommand": "",
            "sourceOrigin": local_origin,
        }

    @staticmethod
    def _bound(
        record: dict[str, Any], relation: str, cwd: str, repo: str,
        target_pid: int, local_origin: str, *, state: str = "bound",
    ) -> dict[str, Any]:
        try:
            workspace_pid = int(record.get("pid") or 0)
        except (TypeError, ValueError):
            workspace_pid = 0
        return {
            "schemaVersion": 1,
            "state": state,
            "relation": relation,
            "targetProcessId": target_pid or None,
            "workspaceProcessId": workspace_pid or None,
            "cwd": str(Path(cwd).resolve()),
            "repoRoot": repo,
            "executablePath": str(record.get("executablePath") or "")[:2000],
            "launchCommand": redact_launch_command(record.get("commandLine")),
            "sourceOrigin": local_origin,
        }
