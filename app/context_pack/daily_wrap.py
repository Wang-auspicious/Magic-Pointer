"""Read factual task events for a user-requested DailyWrap.

This is a normal Runtime source, not an activity tracker. It exposes only
turns Magic Pointer actually recorded and never fabricates an app timeline or
fills gaps in the selected time range.
"""

from __future__ import annotations

import json
import os
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

from app.agent_runtime.session import FileSessionStore
from app.artifacts.projection import project_artifacts


def default_conversation_history() -> Path:
    root = Path(
        os.environ.get("MAGIC_POINTER_USER_DATA_DIR")
        or Path(__file__).resolve().parents[2] / "data" / "runtime"
    )
    return root / "history" / "conversations.json"


def _bounded_text(value: Any, limit: int) -> str:
    return str(value or "").strip()[:limit]


def _bounded_records(value: Any, limit: int) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    return [dict(item) for item in value[:limit] if isinstance(item, Mapping)]


class ConversationEventCatalog:
    def __init__(
        self,
        path: Path | str | None = None,
        *,
        session_root: Path | str | None = None,
    ) -> None:
        self.path = Path(path) if path is not None else default_conversation_history()
        self.session_root = (
            Path(session_root)
            if session_root is not None
            else self.path.parent.parent / "agent-sessions"
        )

    def _load(self) -> list[dict[str, Any]]:
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError, TypeError):
            return []
        return [dict(item) for item in raw if isinstance(item, Mapping)] if isinstance(raw, list) else []

    def summaries(
        self,
        *,
        from_ms: int,
        to_ms: int,
        conversation_ids: Sequence[str] | None = None,
        limit: int = 200,
    ) -> dict[str, Any]:
        start = int(from_ms)
        end = int(to_ms)
        if start < 0 or end < start:
            raise ValueError("DailyWrap time range must satisfy 0 <= from_ms <= to_ms")
        selected = {str(value) for value in conversation_ids or () if str(value).strip()}
        bounded_limit = max(0, min(int(limit), 500))
        events: list[dict[str, Any]] = []
        included_conversations: set[str] = set()

        def authoritative_artifacts(conversation: Mapping[str, Any]) -> dict[str, dict[str, Any]]:
            session_id = _bounded_text(conversation.get("agentSessionId"), 200)
            if not session_id:
                return {}
            try:
                session = FileSessionStore(self.session_root).resume(session_id, repair=False)
                artifacts = project_artifacts(session.events)
            except (OSError, RuntimeError, ValueError):
                return {}
            return {
                artifact.artifact_id: {
                    "artifactId": artifact.artifact_id,
                    "revision": artifact.revision,
                    "content": artifact.content,
                    "state": artifact.state.value,
                    "kind": artifact.kind,
                    "acceptedRevision": artifact.accepted_revision,
                    "patchPayload": artifact.patch_payload,
                    "authority": "event_session",
                }
                for artifact in artifacts
            }

        for conversation in self._load():
            conversation_id = _bounded_text(conversation.get("id"), 200)
            if selected and conversation_id not in selected:
                continue
            current_artifacts = authoritative_artifacts(conversation)
            for raw_turn in conversation.get("turns") or []:
                if not isinstance(raw_turn, Mapping):
                    continue
                try:
                    started_at = int(raw_turn.get("startedAt") or raw_turn.get("at") or 0)
                except (TypeError, ValueError):
                    continue
                raw_completed = raw_turn.get("completedAt")
                try:
                    completed_at = int(raw_completed) if raw_completed is not None else None
                except (TypeError, ValueError):
                    completed_at = None
                observed_at = completed_at if completed_at is not None else started_at
                if observed_at < start or observed_at > end:
                    continue
                included_conversations.add(conversation_id)
                recorded_artifacts = _bounded_records(raw_turn.get("artifacts"), 24)
                resolved_artifacts = [
                    current_artifacts.get(str(item.get("artifactId") or ""), item)
                    for item in recorded_artifacts
                ]
                events.append({
                    "conversationId": conversation_id,
                    "conversationTitle": _bounded_text(conversation.get("title"), 300),
                    "turnId": _bounded_text(raw_turn.get("id"), 200),
                    "startedAt": started_at,
                    "completedAt": completed_at,
                    "question": _bounded_text(raw_turn.get("question"), 4000),
                    "answer": _bounded_text(raw_turn.get("answer"), 12000),
                    "outcome": _bounded_text(raw_turn.get("outcome"), 100),
                    "source": dict(conversation.get("object") or {})
                    if isinstance(conversation.get("object"), Mapping)
                    else {},
                    "events": _bounded_records(raw_turn.get("events"), 48),
                    "receipts": _bounded_records(raw_turn.get("receipts"), 48),
                    "artifacts": resolved_artifacts,
                    "evidence": dict(raw_turn.get("evidence") or {})
                    if isinstance(raw_turn.get("evidence"), Mapping)
                    else None,
                })

        events.sort(
            key=lambda item: int(item["completedAt"] or item["startedAt"]),
            reverse=True,
        )
        events = events[:bounded_limit]
        material_available = bool(events)
        return {
            "fromMs": start,
            "toMs": end,
            "conversationIds": sorted(selected),
            "materialAvailable": material_available,
            "events": events,
            "coverage": {
                "includedConversations": len(included_conversations),
                "includedTurns": len(events),
                "complete": len(events) < bounded_limit if bounded_limit else not events,
                "message": (
                    f"已纳入 {len(events)} 条真实任务记录。"
                    if material_available
                    else "所选时间和任务范围没有纳入本次材料；不要补造全天活动。"
                ),
            },
        }


__all__ = ["ConversationEventCatalog", "default_conversation_history"]
