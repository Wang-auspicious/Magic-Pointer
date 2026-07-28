from __future__ import annotations

import json
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable


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


def _metadata_lines(path: Path, *, limit: int = 32, byte_limit: int = 128_000) -> Iterable[dict[str, Any]]:
    """Read only a bounded metadata prefix; transcript bodies never leave this module."""
    consumed = 0
    try:
        with path.open("r", encoding="utf-8", errors="replace") as handle:
            for _ in range(limit):
                line = handle.readline()
                if not line:
                    break
                consumed += len(line.encode("utf-8", errors="ignore"))
                if consumed > byte_limit:
                    break
                try:
                    value = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(value, dict):
                    yield value
    except OSError:
        return


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

    def to_dict(self) -> dict[str, Any]:
        return {
            "provider": self.provider,
            "sessionId": self.session_id,
            "cwd": self.cwd,
            "lastActiveAt": self.last_active_at,
            "state": self.state,
            "transport": self.transport,
            "source": self.source,
            "resumeToken": self.resume_token or self.session_id,
            "cwdMatch": self.cwd_match,
        }


class AgentSessionRegistry:
    """Discover verifiable saved sessions without reading or returning prompts."""

    def __init__(
        self,
        *,
        codex_root: Path | str | None = None,
        claude_root: Path | str | None = None,
        gemini_root: Path | str | None = None,
        pi_root: Path | str | None = None,
    ) -> None:
        home = Path.home()
        self.codex_root = Path(codex_root) if codex_root is not None else home / ".codex" / "sessions"
        self.claude_root = Path(claude_root) if claude_root is not None else home / ".claude" / "projects"
        self.gemini_root = Path(gemini_root) if gemini_root is not None else home / ".gemini" / "tmp"
        self.pi_root = Path(pi_root) if pi_root is not None else home / ".pi" / "agent" / "sessions"

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

    def _codex(self) -> list[AgentSession]:
        sessions: list[AgentSession] = []
        if not self.codex_root.is_dir():
            return sessions
        for path in self.codex_root.rglob("*.jsonl"):
            first = next(iter(_metadata_lines(path, limit=2)), None)
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
            sessions.append(AgentSession(
                provider="codex", session_id=session_id, cwd=str(_normalized_path(cwd)),
                last_active_at=_timestamp(path.stat().st_mtime, path.stat().st_mtime),
                state=self._state(path), transport="exec-resume-jsonl", source="codex_session_meta",
            ))
        return sessions

    def _claude(self) -> list[AgentSession]:
        sessions: list[AgentSession] = []
        if not self.claude_root.is_dir():
            return sessions
        for path in self.claude_root.rglob("*.jsonl"):
            if "subagents" in {part.casefold() for part in path.parts}:
                continue
            metadata = next((item for item in _metadata_lines(path) if item.get("sessionId") and item.get("cwd")), None)
            if metadata is None:
                continue
            session_id = str(metadata.get("sessionId") or path.stem).strip()
            cwd = str(metadata.get("cwd") or "").strip()
            if not session_id or not cwd:
                continue
            sessions.append(AgentSession(
                provider="claude", session_id=session_id, cwd=str(_normalized_path(cwd)),
                last_active_at=_timestamp(None, path.stat().st_mtime),
                state=self._state(path), transport="print-resume-stream-json", source="claude_session_meta",
            ))
        return sessions

    def _gemini(self) -> list[AgentSession]:
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
            paths = sorted((project / "chats").glob("session-*.jsonl"), key=lambda item: item.stat().st_mtime, reverse=True)
            for index, path in enumerate(paths, 1):
                metadata = next(iter(_metadata_lines(path, limit=2)), None)
                if metadata is None or str(metadata.get("kind") or "main") != "main":
                    continue
                session_id = str(metadata.get("sessionId") or "").strip()
                if not session_id:
                    continue
                sessions.append(AgentSession(
                    provider="gemini", session_id=session_id, cwd=str(_normalized_path(cwd)),
                    last_active_at=_timestamp(None, path.stat().st_mtime),
                    state=self._state(path), transport="print-resume-json", source="gemini_session_meta",
                    resume_token=str(index),
                ))
        return sessions

    def _pi(self) -> list[AgentSession]:
        sessions: list[AgentSession] = []
        if not self.pi_root.is_dir():
            return sessions
        for path in self.pi_root.rglob("*.jsonl"):
            metadata = next((item for item in _metadata_lines(path) if (item.get("sessionId") or item.get("session_id")) and item.get("cwd")), None)
            if metadata is None:
                continue
            session_id = str(metadata.get("sessionId") or metadata.get("session_id") or "").strip()
            cwd = str(metadata.get("cwd") or "").strip()
            if not session_id or not cwd:
                continue
            sessions.append(AgentSession(
                provider="pi", session_id=session_id, cwd=str(_normalized_path(cwd)),
                last_active_at=_timestamp(None, path.stat().st_mtime),
                state=self._state(path), transport="pi-session-json", source="pi_session_meta",
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
    ) -> list[AgentSession]:
        requested = str(provider or "").strip().casefold()
        builders = {"codex": self._codex, "pi": self._pi, "claude": self._claude, "gemini": self._gemini}
        names = [requested] if requested in builders else list(builders)
        found: list[AgentSession] = []
        for name in names:
            for item in builders[name]():
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
