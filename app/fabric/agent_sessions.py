from __future__ import annotations

import ctypes
import json
import os
import unicodedata
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterable


_SESSION_METADATA_LINE_LIMIT = 64
_SESSION_METADATA_BYTE_LIMIT = 128_000
_SESSION_METADATA_PREFIX_BYTES = 96_000
_SESSION_METADATA_TAIL_BYTES = _SESSION_METADATA_BYTE_LIMIT - _SESSION_METADATA_PREFIX_BYTES
_SESSION_TITLE_MAX_CHARS = 80
_ERROR_SHARING_VIOLATION = 32
_ERROR_LOCK_VIOLATION = 33
_GENERIC_READ = 0x80000000
_OPEN_EXISTING = 3
_FILE_ATTRIBUTE_NORMAL = 0x80


def _normalized_path(value: Path | str) -> Path:
    return Path(value).expanduser().resolve()


def _same_path(left: Path | str, right: Path | str) -> bool:
    return os.path.normcase(str(_normalized_path(left))) == os.path.normcase(str(_normalized_path(right)))


def _is_below(path: Path | str, root: Path | str) -> bool:
    try:
        _normalized_path(path).relative_to(_normalized_path(root))
        return True
    except ValueError:
        return False


def _timestamp(value: object, fallback: float) -> str:
    text = str(value or "").strip()
    if text:
        try:
            parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            return parsed.astimezone(timezone.utc).isoformat(timespec="seconds")
        except ValueError:
            pass
    return datetime.fromtimestamp(fallback, timezone.utc).isoformat(timespec="seconds")


def _ordinary_readable(path: Path) -> bool:
    try:
        with path.open("rb") as handle:
            handle.read(0)
        return True
    except OSError:
        return False


def _win32_exclusive_read(
    path: Path,
    *,
    kernel32: Any | None = None,
    get_last_error: Callable[[], int] | None = None,
) -> tuple[bool, int]:
    native = kernel32 is None
    if native:
        if os.name != "nt":
            return False, 0
        from ctypes import wintypes

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.CreateFileW.argtypes = [
            wintypes.LPCWSTR,
            wintypes.DWORD,
            wintypes.DWORD,
            wintypes.LPVOID,
            wintypes.DWORD,
            wintypes.DWORD,
            wintypes.HANDLE,
        ]
        kernel32.CreateFileW.restype = wintypes.HANDLE
        kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel32.CloseHandle.restype = wintypes.BOOL
    error_reader = get_last_error or ctypes.get_last_error
    handle = kernel32.CreateFileW(
        str(path),
        _GENERIC_READ,
        0,
        None,
        _OPEN_EXISTING,
        _FILE_ATTRIBUTE_NORMAL,
        None,
    )
    handle_value = handle.value if hasattr(handle, "value") else handle
    if handle_value in {None, -1, ctypes.c_void_p(-1).value}:
        return False, int(error_reader())
    kernel32.CloseHandle(handle)
    return True, 0


def _windows_open_handle_evidence(
    path: Path,
    *,
    readable: Callable[[Path], bool] = _ordinary_readable,
    exclusive_open: Callable[[Path], tuple[bool, int]] = _win32_exclusive_read,
) -> str | None:
    if not readable(path):
        return None
    opened, error = exclusive_open(path)
    if opened:
        return None
    if error in {_ERROR_SHARING_VIOLATION, _ERROR_LOCK_VIOLATION}:
        return "open_handle"
    return None


def _default_liveness_probe(provider: str, path: Path) -> str | None:
    if os.name != "nt" or provider != "codex":
        return None
    return _windows_open_handle_evidence(path)


def _metadata_lines(
    path: Path,
    *,
    limit: int = _SESSION_METADATA_LINE_LIMIT,
    byte_limit: int = _SESSION_METADATA_BYTE_LIMIT,
    tail: bool = False,
) -> Iterable[dict[str, Any]]:
    """Parse complete JSONL records from one fixed-size prefix or tail read."""
    try:
        size = path.stat().st_size
        bounded = max(0, min(int(byte_limit), _SESSION_METADATA_BYTE_LIMIT))
        start = max(0, size - bounded) if tail else 0
        with path.open("rb") as handle:
            if start:
                handle.seek(start)
            data = handle.read(bounded)
    except OSError:
        return
    if not data:
        return
    lines = data.splitlines()
    if not tail and size > len(data) and not data.endswith((b"\n", b"\r")):
        # Never parse a prefix record whose remainder is outside the byte budget.
        lines = lines[:-1]
    for raw_line in lines[: max(0, int(limit))]:
        try:
            value = json.loads(raw_line.decode("utf-8", errors="replace"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            continue
        if isinstance(value, dict):
            yield value


def _session_records(path: Path) -> list[dict[str, Any]]:
    """Read at most 128 KB and 64 complete records per session file."""
    try:
        size = path.stat().st_size
    except OSError:
        return []
    if size <= _SESSION_METADATA_BYTE_LIMIT:
        return list(_metadata_lines(path))
    prefix = list(_metadata_lines(
        path,
        limit=48,
        byte_limit=_SESSION_METADATA_PREFIX_BYTES,
    ))
    return prefix + list(_metadata_lines(
        path,
        limit=16,
        byte_limit=_SESSION_METADATA_TAIL_BYTES,
        tail=True,
    ))


def _string(value: object) -> str:
    return value if isinstance(value, str) else ""


def _message_text(value: object) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        return _message_text(value.get("content"))
    if isinstance(value, list):
        return " ".join(
            text
            for item in value
            if isinstance(item, dict)
            for text in [_string(item.get("text"))]
            if text
        )
    return ""


def _first_user_text(records: Iterable[dict[str, Any]], provider: str) -> str:
    items = list(records)
    if provider == "codex":
        for item in items:
            payload = item.get("payload")
            if not isinstance(payload, dict):
                continue
            if item.get("type") == "event_msg" and payload.get("type") == "user_message":
                text = _message_text(payload.get("message"))
                if text:
                    return text
        for item in items:
            payload = item.get("payload")
            if not isinstance(payload, dict):
                continue
            if (
                item.get("type") == "response_item"
                and payload.get("type") == "message"
                and payload.get("role") == "user"
            ):
                text = _message_text(payload.get("content"))
                if text:
                    return text
        return ""
    if provider == "claude":
        for item in items:
            if item.get("type") != "user":
                continue
            text = _message_text(item.get("message"))
            if text:
                return text
        return ""
    if provider == "gemini":
        for item in items:
            if item.get("type") != "user":
                continue
            text = _message_text(item.get("content"))
            if text:
                return text
        return ""
    if provider == "pi":
        for item in items:
            message = item.get("message")
            if item.get("type") != "message" or not isinstance(message, dict) or message.get("role") != "user":
                continue
            text = _message_text(message.get("content"))
            if text:
                return text
    return ""


def _metadata_title(records: Iterable[dict[str, Any]], provider: str) -> str:
    title = ""
    for item in records:
        if provider == "claude" and item.get("type") in {"ai-title", "custom-title"}:
            candidate = _string(item.get("customTitle") or item.get("aiTitle") or item.get("title"))
        elif provider == "gemini":
            update = item.get("$set")
            candidate = _string(item.get("summary"))
            if isinstance(update, dict):
                candidate = _string(update.get("summary")) or candidate
        elif provider == "pi" and item.get("type") == "session_info":
            candidate = _string(item.get("name"))
        else:
            candidate = ""
        if candidate:
            title = candidate
    return title


def _clean_title(value: object) -> str:
    text = _string(value)
    if not text:
        return ""
    without_controls = "".join(
        " " if unicodedata.category(character).startswith("C") else character
        for character in text
    )
    normalized = " ".join(without_controls.split())
    if len(normalized) <= _SESSION_TITLE_MAX_CHARS:
        return normalized
    return normalized[: _SESSION_TITLE_MAX_CHARS - 1].rstrip() + "…"


def _fallback_title(provider: str, cwd: str, session_id: str) -> str:
    provider_name = _clean_title(provider.capitalize()) or "Agent"
    workspace = _clean_title(Path(cwd).name) or "workspace"
    short_id = _clean_title(session_id)[:8] or "session"
    return _clean_title(f"{provider_name} · {workspace} · {short_id}")


def _session_title(provider: str, cwd: str, session_id: str, candidate: object = None) -> str:
    return _clean_title(candidate) or _fallback_title(provider, cwd, session_id)


@dataclass(frozen=True)
class AgentSession:
    provider: str
    session_id: str
    cwd: str
    last_active_at: str
    state: str
    transport: str
    source: str
    resume_token: str | None = None
    cwd_match: str = "none"
    title: str | None = None
    live: bool = False
    live_evidence: str | None = None

    def to_dict(self) -> dict[str, Any]:
        value: dict[str, Any] = {
            "provider": self.provider,
            "sessionId": self.session_id,
            "title": _session_title(self.provider, self.cwd, self.session_id, self.title),
            "cwd": self.cwd,
            "lastActiveAt": self.last_active_at,
            "state": self.state,
            "transport": self.transport,
            "source": self.source,
            "resumeToken": self.resume_token or self.session_id,
            "cwdMatch": self.cwd_match,
        }
        if self.live and self.live_evidence:
            value["live"] = True
            value["liveEvidence"] = self.live_evidence
        return value


class AgentSessionRegistry:
    """Discover verifiable saved sessions without reading or returning prompts."""

    def __init__(
        self,
        *,
        codex_root: Path | str | None = None,
        claude_root: Path | str | None = None,
        gemini_root: Path | str | None = None,
        pi_root: Path | str | None = None,
        liveness_probe: Callable[[str, Path], str | None] | None = None,
    ) -> None:
        home = Path.home()
        self.codex_root = Path(codex_root) if codex_root is not None else home / ".codex" / "sessions"
        self.claude_root = Path(claude_root) if claude_root is not None else home / ".claude" / "projects"
        self.gemini_root = Path(gemini_root) if gemini_root is not None else home / ".gemini" / "tmp"
        self.pi_root = Path(pi_root) if pi_root is not None else home / ".pi" / "agent" / "sessions"
        self.liveness_probe = liveness_probe if liveness_probe is not None else _default_liveness_probe

    @staticmethod
    def _match(session_cwd: str, requested_cwd: Path | str | None, mode: str) -> str:
        if requested_cwd is None:
            return "unscoped"
        if _same_path(session_cwd, requested_cwd):
            return "strict"
        if mode == "subtree" and _is_below(session_cwd, requested_cwd):
            return "subtree"
        if mode == "confirm":
            return "confirmation_required"
        return "none"

    @staticmethod
    def _state(path: Path) -> str:
        age_seconds = max(0.0, datetime.now(timezone.utc).timestamp() - path.stat().st_mtime)
        return "recent" if age_seconds <= 15 * 60 else "resumable"

    def _live_evidence(self, provider: str, path: Path, active_only: bool) -> str | None:
        if not active_only:
            return None
        try:
            evidence = self.liveness_probe(provider, path)
        except Exception:
            return None
        return evidence.strip() if isinstance(evidence, str) and evidence.strip() else None

    def _codex(self, *, active_only: bool = False) -> list[AgentSession]:
        sessions: list[AgentSession] = []
        if not self.codex_root.is_dir():
            return sessions
        titles: dict[str, str] = {}
        for item in _metadata_lines(
            self.codex_root.parent / "session_index.jsonl",
            limit=2000,
            byte_limit=_SESSION_METADATA_BYTE_LIMIT,
            tail=True,
        ):
            session_id = _string(item.get("id")).strip()
            title = _string(item.get("thread_name"))
            if session_id and title:
                titles[session_id] = title
        for path in self.codex_root.rglob("*.jsonl"):
            records = _session_records(path)
            first = records[0] if records else None
            payload = dict(first.get("payload") or {}) if isinstance(first, dict) else {}
            if first is None or first.get("type") != "session_meta":
                continue
            source = payload.get("source")
            if isinstance(source, dict) and isinstance(source.get("subagent"), dict):
                # Codex v2 deliberately rejects direct turn/start on child agents.
                # Excluding them here prevents the UI from offering an unusable binding.
                continue
            session_id = str(payload.get("id") or "").strip()
            cwd = str(payload.get("cwd") or "").strip()
            if not session_id or not cwd:
                continue
            live_evidence = self._live_evidence("codex", path, active_only)
            if active_only and live_evidence is None:
                continue
            title = titles.get(session_id) or _first_user_text(records, "codex")
            sessions.append(AgentSession(
                provider="codex", session_id=session_id, cwd=str(_normalized_path(cwd)),
                last_active_at=_timestamp(path.stat().st_mtime, path.stat().st_mtime),
                state=self._state(path), transport="exec-resume-jsonl", source="codex_session_meta",
                title=_session_title("codex", cwd, session_id, title),
                live=live_evidence is not None, live_evidence=live_evidence,
            ))
        return sessions

    def _claude(self, *, active_only: bool = False) -> list[AgentSession]:
        sessions: list[AgentSession] = []
        if not self.claude_root.is_dir():
            return sessions
        for path in self.claude_root.rglob("*.jsonl"):
            if "subagents" in {part.casefold() for part in path.parts}:
                continue
            records = _session_records(path)
            metadata = next((item for item in records if item.get("sessionId") and item.get("cwd")), None)
            if metadata is None:
                continue
            session_id = str(metadata.get("sessionId") or path.stem).strip()
            cwd = str(metadata.get("cwd") or "").strip()
            if not session_id or not cwd:
                continue
            live_evidence = self._live_evidence("claude", path, active_only)
            if active_only and live_evidence is None:
                continue
            title = _metadata_title(records, "claude") or _first_user_text(records, "claude")
            sessions.append(AgentSession(
                provider="claude", session_id=session_id, cwd=str(_normalized_path(cwd)),
                last_active_at=_timestamp(None, path.stat().st_mtime),
                state=self._state(path), transport="print-resume-stream-json", source="claude_session_meta",
                title=_session_title("claude", cwd, session_id, title),
                live=live_evidence is not None, live_evidence=live_evidence,
            ))
        return sessions

    def _gemini(self, *, active_only: bool = False) -> list[AgentSession]:
        sessions: list[AgentSession] = []
        if not self.gemini_root.is_dir():
            return sessions
        for project in self.gemini_root.iterdir():
            if not project.is_dir():
                continue
            project_root = project / ".project_root"
            try:
                cwd = project_root.read_text(encoding="utf-8").strip()
            except OSError:
                continue
            paths = sorted(
                [
                    *list((project / "chats").glob("session-*.jsonl")),
                    *list((project / "chats").glob("session-*.json")),
                ],
                key=lambda item: item.stat().st_mtime,
                reverse=True,
            )
            for index, path in enumerate(paths, 1):
                records = _session_records(path)
                metadata: dict[str, Any] = {}
                for item in records:
                    update = item.get("$set")
                    if isinstance(update, dict):
                        metadata.update(update)
                    if item.get("sessionId"):
                        metadata.update(item)
                if not metadata or str(metadata.get("kind") or "main") != "main":
                    continue
                session_id = str(metadata.get("sessionId") or "").strip()
                if not session_id:
                    continue
                live_evidence = self._live_evidence("gemini", path, active_only)
                if active_only and live_evidence is None:
                    continue
                title = _metadata_title(records, "gemini") or _first_user_text(records, "gemini")
                sessions.append(AgentSession(
                    provider="gemini", session_id=session_id, cwd=str(_normalized_path(cwd)),
                    last_active_at=_timestamp(None, path.stat().st_mtime),
                    state=self._state(path), transport="print-resume-json", source="gemini_session_meta",
                    resume_token=str(index),
                    title=_session_title("gemini", cwd, session_id, title),
                    live=live_evidence is not None, live_evidence=live_evidence,
                ))
        return sessions

    def _pi(self, *, active_only: bool = False) -> list[AgentSession]:
        sessions: list[AgentSession] = []
        if not self.pi_root.is_dir():
            return sessions
        for path in self.pi_root.rglob("*.jsonl"):
            records = _session_records(path)
            metadata = next((
                item for item in records
                if (item.get("sessionId") or item.get("session_id") or item.get("id")) and item.get("cwd")
            ), None)
            if metadata is None:
                continue
            session_id = str(metadata.get("sessionId") or metadata.get("session_id") or metadata.get("id") or "").strip()
            cwd = str(metadata.get("cwd") or "").strip()
            if not session_id or not cwd:
                continue
            live_evidence = self._live_evidence("pi", path, active_only)
            if active_only and live_evidence is None:
                continue
            title = _metadata_title(records, "pi") or _first_user_text(records, "pi")
            sessions.append(AgentSession(
                provider="pi", session_id=session_id, cwd=str(_normalized_path(cwd)),
                last_active_at=_timestamp(None, path.stat().st_mtime),
                state=self._state(path), transport="pi-session-json", source="pi_session_meta",
                title=_session_title("pi", cwd, session_id, title),
                live=live_evidence is not None, live_evidence=live_evidence,
            ))
        return sessions

    def discover(
        self,
        *,
        provider: str | None = None,
        cwd: Path | str | None = None,
        cwd_match: str = "strict",
        include_mismatch: bool = False,
        limit: int = 200,
        active_only: bool = False,
    ) -> list[AgentSession]:
        requested = str(provider or "").strip().casefold()
        builders = {"codex": self._codex, "pi": self._pi, "claude": self._claude, "gemini": self._gemini}
        names = [requested] if requested in builders else list(builders)
        found: list[AgentSession] = []
        for name in names:
            for item in builders[name](active_only=active_only):
                match = self._match(item.cwd, cwd, cwd_match)
                if match == "none" and not include_mismatch:
                    continue
                found.append(AgentSession(**{**item.__dict__, "cwd_match": match}))
        found.sort(key=lambda item: item.last_active_at, reverse=True)
        deduplicated: list[AgentSession] = []
        seen: set[tuple[str, str]] = set()
        for item in found:
            identity = (item.provider, item.session_id)
            if identity in seen:
                continue
            seen.add(identity)
            deduplicated.append(item)
        return deduplicated[: max(0, min(int(limit), 1000))]

    def resolve(
        self,
        provider: str,
        session_id: str,
        *,
        cwd: Path | str,
        cwd_match: str = "strict",
        confirmed: bool = False,
    ) -> AgentSession | None:
        for item in self.discover(provider=provider, cwd=cwd, cwd_match=cwd_match, include_mismatch=True, limit=1000):
            if item.session_id != str(session_id):
                continue
            if item.cwd_match in {"strict", "subtree"}:
                return item
            if item.cwd_match == "confirmation_required" and confirmed:
                return item
            return None
        return None

    def unique(self, provider: str, *, cwd: Path | str, cwd_match: str = "strict") -> AgentSession | None:
        matches = self.discover(provider=provider, cwd=cwd, cwd_match=cwd_match, limit=2)
        return matches[0] if len(matches) == 1 else None
