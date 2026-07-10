from __future__ import annotations

import json
import uuid
from dataclasses import dataclass, field, replace
from datetime import datetime
from pathlib import Path
from typing import Any

from app.actions.schema import ActionProposal, ActionTarget, SafetyLevel

JsonDict = dict[str, Any]

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_HISTORY_PATH = ROOT / "data" / "runtime" / "action_history.jsonl"


def now_iso() -> str:
    return datetime.now().isoformat(timespec="seconds")


def new_history_id() -> str:
    return f"hist-{uuid.uuid4().hex[:16]}"


def excerpt(value: str | None, limit: int = 700) -> str:
    text = "" if value is None else str(value)
    if len(text) <= limit:
        return text
    return text[:limit] + "..."


@dataclass(frozen=True)
class ActionHistoryRecord:
    """Audit record for one confirmed local write action.

    For precise delayed undo we keep before/after text locally. This is a local
    desktop action ledger, not prompt context: callers should surface excerpts in
    UI and avoid sending full history back to models unless the user asks.
    """

    id: str
    action_type: str
    app: str
    proposal_id: str
    document: str | None = None
    target_label: str | None = None
    before_sha256: str | None = None
    after_sha256: str | None = None
    before_excerpt: str | None = None
    after_excerpt: str | None = None
    before_text: str | None = None
    after_text: str | None = None
    selection_start: int | None = None
    selection_end: int | None = None
    after_selection_end: int | None = None
    selection_session_id: str | None = None
    selection_snapshot_id: str | None = None
    source_window_hwnd: int | None = None
    source_window_title: str | None = None
    left_anchor_sha256: str | None = None
    left_anchor_chars: int | None = None
    right_anchor_sha256: str | None = None
    right_anchor_chars: int | None = None
    status: str = "succeeded"
    confirmed: bool = True
    created_at: str = field(default_factory=now_iso)
    undone_at: str | None = None
    metadata: JsonDict = field(default_factory=dict)

    @property
    def is_undoable(self) -> bool:
        return (
            self.confirmed
            and self.status == "succeeded"
            and self.undone_at is None
            and self.action_type == "office_replace_selection"
            and self.app == "word"
            and self.before_text is not None
            and self.after_text is not None
        )

    def to_dict(self) -> JsonDict:
        return {
            "id": self.id,
            "action_type": self.action_type,
            "app": self.app,
            "proposal_id": self.proposal_id,
            "document": self.document,
            "target_label": self.target_label,
            "before_sha256": self.before_sha256,
            "after_sha256": self.after_sha256,
            "before_excerpt": self.before_excerpt,
            "after_excerpt": self.after_excerpt,
            "before_text": self.before_text,
            "after_text": self.after_text,
            "selection_start": self.selection_start,
            "selection_end": self.selection_end,
            "after_selection_end": self.after_selection_end,
            "selection_session_id": self.selection_session_id,
            "selection_snapshot_id": self.selection_snapshot_id,
            "source_window_hwnd": self.source_window_hwnd,
            "source_window_title": self.source_window_title,
            "left_anchor_sha256": self.left_anchor_sha256,
            "left_anchor_chars": self.left_anchor_chars,
            "right_anchor_sha256": self.right_anchor_sha256,
            "right_anchor_chars": self.right_anchor_chars,
            "status": self.status,
            "confirmed": self.confirmed,
            "created_at": self.created_at,
            "undone_at": self.undone_at,
            "metadata": dict(self.metadata),
        }

    @classmethod
    def from_dict(cls, data: JsonDict) -> "ActionHistoryRecord":
        return cls(
            id=str(data["id"]),
            action_type=str(data["action_type"]),
            app=str(data.get("app") or ""),
            proposal_id=str(data.get("proposal_id") or ""),
            document=data.get("document"),
            target_label=data.get("target_label"),
            before_sha256=data.get("before_sha256"),
            after_sha256=data.get("after_sha256"),
            before_excerpt=data.get("before_excerpt"),
            after_excerpt=data.get("after_excerpt"),
            before_text=data.get("before_text"),
            after_text=data.get("after_text"),
            selection_start=_optional_int(data.get("selection_start")),
            selection_end=_optional_int(data.get("selection_end")),
            after_selection_end=_optional_int(data.get("after_selection_end")),
            selection_session_id=data.get("selection_session_id"),
            selection_snapshot_id=data.get("selection_snapshot_id"),
            source_window_hwnd=_optional_int(data.get("source_window_hwnd")),
            source_window_title=data.get("source_window_title"),
            left_anchor_sha256=data.get("left_anchor_sha256"),
            left_anchor_chars=_optional_int(data.get("left_anchor_chars")),
            right_anchor_sha256=data.get("right_anchor_sha256"),
            right_anchor_chars=_optional_int(data.get("right_anchor_chars")),
            status=str(data.get("status") or "succeeded"),
            confirmed=bool(data.get("confirmed", True)),
            created_at=str(data.get("created_at") or now_iso()),
            undone_at=data.get("undone_at"),
            metadata=dict(data.get("metadata") or {}),
        )


def _optional_int(value: Any) -> int | None:
    if value is None or value == "":
        return None
    try:
        return int(value)
    except Exception:
        return None


class ActionHistoryStore:
    """Append-only JSONL history for local desktop write actions."""

    def __init__(self, path: Path | str | None = None) -> None:
        self.path = Path(path) if path is not None else DEFAULT_HISTORY_PATH

    def append(self, record: ActionHistoryRecord) -> ActionHistoryRecord:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(record.to_dict(), ensure_ascii=False, separators=(",", ":")) + "\n")
        return record

    def records(self) -> list[ActionHistoryRecord]:
        if not self.path.exists():
            return []
        out: list[ActionHistoryRecord] = []
        for line in self.path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            try:
                data = json.loads(line)
                if isinstance(data, dict):
                    out.append(ActionHistoryRecord.from_dict(data))
            except Exception:
                continue
        return out

    def get(self, history_id: str) -> ActionHistoryRecord | None:
        for record in self.records():
            if record.id == history_id:
                return record
        return None

    def recent_undoable(self, *, app: str | None = None) -> ActionHistoryRecord | None:
        for record in reversed(self.records()):
            if app is not None and record.app != app:
                continue
            if record.is_undoable:
                return record
        return None

    def recent_undoable_for_session(
        self,
        selection_session_id: str,
        *,
        app: str | None = None,
    ) -> ActionHistoryRecord | None:
        for record in reversed(self.records()):
            if record.selection_session_id != selection_session_id:
                continue
            if app is not None and record.app != app:
                continue
            if record.is_undoable:
                return record
        return None

    def mark_undone(self, history_id: str, *, undone_at: str | None = None) -> ActionHistoryRecord | None:
        records = self.records()
        updated: list[ActionHistoryRecord] = []
        matched: ActionHistoryRecord | None = None
        stamp = undone_at or now_iso()
        for record in records:
            if record.id == history_id:
                record = replace(record, undone_at=stamp, before_text=None, after_text=None)
                matched = record
            updated.append(record)
        if matched is None:
            return None
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp_path = self.path.with_suffix(self.path.suffix + ".tmp")
        tmp_path.write_text(
            "".join(json.dumps(record.to_dict(), ensure_ascii=False, separators=(",", ":")) + "\n" for record in updated),
            encoding="utf-8",
        )
        tmp_path.replace(self.path)
        return matched


def make_word_undo_proposal(record: ActionHistoryRecord) -> ActionProposal:
    return ActionProposal(
        id=f"undo-{record.id}",
        action_type="office_undo_last_action",
        target=ActionTarget(
            selection_id=record.selection_snapshot_id,
            description=record.target_label or "Word selection",
            metadata={
                "app": "word",
                "document": record.document,
                "history_id": record.id,
                "selection_session_id": record.selection_session_id,
                "selection_snapshot_id": record.selection_snapshot_id,
            },
        ),
        parameters={
            "app": "word",
            "history_id": record.id,
            "document": record.document,
            "target_label": record.target_label,
            "selection_session_id": record.selection_session_id,
            "selection_snapshot_id": record.selection_snapshot_id,
        },
        safety_level=SafetyLevel.HIGH,
        confirmation_required=True,
        rationale="Precisely restore the text changed by this Magic Pointer Word write without using global Ctrl+Z.",
        created_at=now_iso(),
        metadata={
            "history_id": record.id,
            "source_proposal_id": record.proposal_id,
            "selection_session_id": record.selection_session_id,
            "selection_snapshot_id": record.selection_snapshot_id,
        },
    )
