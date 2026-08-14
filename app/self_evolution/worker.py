"""Background review worker: session snapshot -> pending candidates only."""

from __future__ import annotations

import json
import os
import re
import time
import uuid
from contextlib import suppress
from pathlib import Path
from typing import Any

from app.agent_runtime.session import FileSessionStore
from app.self_evolution.candidates import LearningCandidateStore
from app.self_evolution.review import SessionLearningReviewer

__all__ = [
    "build_review_context",
    "parse_candidate_response",
    "run_review",
]

_REVIEW_PROMPT = """You are Magic Pointer's isolated background learning reviewer.
Review the completed Agent session and propose only durable improvements.

Learn when the user corrected style/workflow, a reusable technique emerged, or
an existing user skill/plugin missed a stable step. Do not learn one-off task
narratives, transient setup failures, temporary provider errors, or blanket
negative claims that a tool never works.

Return JSON only: an array of at most 3 objects with keys:
- kind: memory | skill | plugin
- target: learning/MEMORY.md, skills/<name>/SKILL.md (or support file), or
  plugins/<name>/<file>
- proposedContent: the complete new UTF-8 file content
- rationale: one concise durable reason

You cannot edit files. Your output becomes a pending candidate that a user must
inspect and approve. Never target app/, scripts/, electron/, tests/, docs/, or
any path outside the three user-owned roots above. Return [] when no durable
learning exists."""

_AUTH_HEADER = re.compile(
    r"(?i)(\bauthorization\s*:\s*bearer\s+)[A-Za-z0-9._~+/=-]+"
)
_SECRET_ASSIGNMENT = re.compile(
    r"(?i)(\b[A-Za-z0-9_.-]*(?:api[_-]?key|token|secret|password|passwd)"
    r"[A-Za-z0-9_.-]*\b\s*[:=]\s*)"
    r"(?:\"[^\"\r\n]*\"|'[^'\r\n]*'|[^\s,;]+)"
)
_SECRET_TOKEN = re.compile(
    r"(?<![A-Za-z0-9])(?:sk-[A-Za-z0-9_-]{8,}|gh[opusr]_[A-Za-z0-9_]{8,})"
)
_PRIVATE_KEY = re.compile(
    r"-----BEGIN [^-\r\n]*PRIVATE KEY-----.*?"
    r"-----END [^-\r\n]*PRIVATE KEY-----",
    re.DOTALL,
)
_SESSION_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


def _redact_review_text(value: str) -> str:
    """Remove common credentials before any background model handoff."""
    text = _PRIVATE_KEY.sub("[REDACTED PRIVATE KEY]", str(value or ""))
    text = _AUTH_HEADER.sub(r"\1[REDACTED]", text)
    text = _SECRET_ASSIGNMENT.sub(r"\1[REDACTED]", text)
    return _SECRET_TOKEN.sub("[REDACTED]", text)


def parse_candidate_response(text: str) -> list[dict[str, Any]]:
    raw = str(text or "").strip()
    fence = re.fullmatch(r"```(?:json)?\s*(.*?)\s*```", raw, re.DOTALL | re.IGNORECASE)
    if fence:
        raw = fence.group(1).strip()
    try:
        payload = json.loads(raw)
    except (TypeError, json.JSONDecodeError):
        return []
    if isinstance(payload, dict):
        payload = payload.get("candidates")
    if not isinstance(payload, list):
        return []
    return [item for item in payload if isinstance(item, dict)]


def build_review_context(
    user_root: Path | str,
    digest: dict[str, Any],
    *,
    max_chars: int = 60_000,
) -> str:
    """Bounded session + current user-learning state for full-file proposals."""
    root = Path(user_root).resolve()
    limit = max(256, int(max_chars))
    sections = [
        "[SESSION DIGEST]\n"
        + _redact_review_text(
            json.dumps(digest, ensure_ascii=False, sort_keys=True)
        )[: max(128, limit // 2)]
    ]
    paths: list[Path] = []
    memory = root / "learning" / "MEMORY.md"
    if memory.is_file():
        paths.append(memory)
    for base, pattern in (
        (root / "skills", "**/*"),
        (root / "plugins", "**/*"),
    ):
        if base.is_dir():
            paths.extend(
                path
                for path in sorted(base.glob(pattern))
                if path.is_file() and not path.is_symlink()
            )
    for path in paths[:32]:
        relative = path.relative_to(root).as_posix()
        try:
            content = path.read_text(encoding="utf-8")
        except (OSError, UnicodeError):
            continue
        sections.append(
            f"\n[USER FILE {relative}]\n{_redact_review_text(content)[:1200]}"
        )
    joined = "".join(sections)
    return joined[:limit]


def run_review(
    *,
    user_root: Path,
    session_root: Path,
    session_id: str,
    terminal_reason: str,
) -> dict[str, Any]:
    session = FileSessionStore(session_root).resume(session_id, repair=False)
    store = LearningCandidateStore(user_root)

    def review_model(digest: dict[str, Any]) -> list[dict[str, Any]]:
        from app.ai_client import ask_text_model  # noqa: PLC0415 -- worker-only load

        response = ask_text_model(
            _REVIEW_PROMPT,
            context_text=build_review_context(user_root, digest),
            timeout_s=30.0,
            attempts=1,
        )
        return parse_candidate_response(response)

    reviewer = SessionLearningReviewer(store, review_model)
    candidates, warnings = reviewer.review_session(
        session,
        terminal_reason=terminal_reason,
    )
    return {
        "ok": True,
        "sessionId": session_id,
        "candidateIds": [candidate.id for candidate in candidates],
        "warnings": warnings,
        "completedAt": int(time.time() * 1000),
    }


def write_review_result(user_root: Path, session_id: str, result: dict[str, Any]) -> Path:
    safe_session_id = str(session_id or "")
    if not _SESSION_ID.fullmatch(safe_session_id):
        raise ValueError(
            "session id must match [A-Za-z0-9][A-Za-z0-9._-]{0,127}"
        )
    target = user_root / "self-evolution" / "reviews" / f"{safe_session_id}.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    temp = target.parent / f".{target.name}.{uuid.uuid4().hex}.tmp"
    try:
        with temp.open("x", encoding="utf-8", newline="\n") as handle:
            json.dump(result, handle, ensure_ascii=False, sort_keys=True)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp, target)
    finally:
        with suppress(OSError):
            temp.unlink(missing_ok=True)
    return target
