"""Isolated Hermes-style session review that can only create candidates."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from app.agent_runtime.session import EventSession
from app.self_evolution.candidates import LearningCandidate, LearningCandidateStore

__all__ = ["SessionLearningReviewer"]


class SessionLearningReviewer:
    """Translate a completed session digest into bounded pending changes.

    The callback is deliberately not an Agent tool loop. It receives plain
    JSON and can return only structured proposals. The store independently
    revalidates kind, target, current content, and size before recording any
    candidate; no proposal can write a file.
    """

    def __init__(
        self,
        store: LearningCandidateStore,
        review_model: Callable[[dict[str, Any]], list[dict[str, Any]]],
        *,
        max_candidates: int = 3,
        max_content_chars: int = 100_000,
    ) -> None:
        self.store = store
        self.review_model = review_model
        self.max_candidates = max(0, int(max_candidates))
        self.max_content_chars = max(1, int(max_content_chars))

    def review_session(
        self,
        session: EventSession,
        *,
        terminal_reason: str,
    ) -> tuple[list[LearningCandidate], list[str]]:
        messages = [message.to_dict() for message in session.derive_messages()]
        return self.review_digest(
            {
                "sessionId": session.id,
                "terminalReason": str(terminal_reason),
                "messages": messages,
                "eventCount": len(session.events),
                "lastEventHash": session.events[-1].hash if session.events else "",
            }
        )

    def review_digest(
        self, digest: dict[str, Any]
    ) -> tuple[list[LearningCandidate], list[str]]:
        session_id = str(digest.get("sessionId") or "")
        if not session_id:
            raise ValueError("learning review digest requires sessionId")
        raw = self.review_model(dict(digest))
        if not isinstance(raw, list):
            return [], ["review model returned a non-list candidate payload"]
        created: list[LearningCandidate] = []
        warnings: list[str] = []
        for index, item in enumerate(raw[: self.max_candidates]):
            if not isinstance(item, dict):
                warnings.append(f"candidate {index}: must be an object")
                continue
            content = item.get("proposedContent")
            if not isinstance(content, str) or not content:
                warnings.append(f"candidate {index}: proposedContent must be text")
                continue
            if len(content) > self.max_content_chars:
                warnings.append(f"candidate {index}: proposedContent is too large")
                continue
            try:
                created.append(
                    self.store.propose(
                        session_id=session_id,
                        kind=str(item.get("kind") or ""),
                        target=str(item.get("target") or ""),
                        proposed_content=content,
                        rationale=str(item.get("rationale") or ""),
                    )
                )
            except (ValueError, PermissionError, OSError) as exc:
                warnings.append(f"candidate {index}: {type(exc).__name__}: {exc}")
        return created, warnings
