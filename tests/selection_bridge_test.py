from __future__ import annotations

import io
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import scripts.action_bridge as action_bridge
import scripts.electron_bridge as electron_bridge
import scripts.selection_bridge as selection_bridge
from scripts.selection_bridge import (
    _context_from_snapshot,
    _interaction_episode_context,
    _read_target_context,
    _shopping_list_response,
    _wants_undo,
)


class _FakeAdapter:
    def read_context(self, window, **kwargs):
        return {"window": window, "command": kwargs.get("command")}


class _FakeRegistry:
    def __init__(self) -> None:
        self.seen = []

    def matching_adapter(self, window):
        self.seen.append(window)
        return _FakeAdapter() if window.get("supported") else None


def test_chinese_undo_commands() -> None:
    assert _wants_undo("撤回上次修改")
    assert _wants_undo("请还原刚才那一步")
    assert not _wants_undo("解释这段")


def test_target_context_never_scans_past_foreground(monkeypatch) -> None:
    registry = _FakeRegistry()
    monkeypatch.setattr("scripts.selection_bridge.default_adapter_registry", lambda: registry)
    foreground = {"title": "Browser", "supported": False}
    background_word = {"title": "Document - Word", "supported": True}
    target, context = _read_target_context([foreground, background_word], "解释这段")
    assert target == foreground
    assert context is None
    assert registry.seen == [foreground]


def test_snapshot_context_is_consumed_without_live_window_lookup(monkeypatch) -> None:
    monkeypatch.setattr(
        "scripts.selection_bridge._window_dicts",
        lambda: (_ for _ in ()).throw(AssertionError("must not scan live windows")),
    )
    expires_at = (datetime.now(timezone.utc) + timedelta(minutes=1)).isoformat()
    payload = {
        "selectionSnapshot": {
            "snapshot_id": "snapshot-1",
            "expires_at": expires_at,
            "source_window": {"title": "doc.docx - Word", "hwnd": 123},
            "context": {
                "adapter": "office",
                "app": "word",
                "window": {"title": "doc.docx - Word", "hwnd": 123},
                "content": "Selected text",
                "label": "doc.docx",
                "method": "com:word.selection",
                "capabilities": [],
                "artifacts": {"selection_start": 1, "selection_end": 14},
                "error": None,
            },
        }
    }
    window, context, snapshot, error = _context_from_snapshot(payload)
    assert error is None
    assert window["hwnd"] == 123
    assert context.content == "Selected text"
    assert snapshot["snapshot_id"] == "snapshot-1"


def test_expired_snapshot_fails_closed() -> None:
    expires_at = (datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat()
    _, context, _, error = _context_from_snapshot({
        "selectionSnapshot": {
            "snapshot_id": "expired",
            "expires_at": expires_at,
            "source_window": {"title": "doc.docx - Word"},
            "context": None,
        }
    })
    assert context is None
    assert error == "selection snapshot expired"


def test_interaction_episode_context_exposes_only_bound_slots() -> None:
    text = _interaction_episode_context({
        "version": 1,
        "episodeId": "episode-1",
        "slots": {
            "this": {"objectId": "selection:b", "label": "B", "content": "Beta"},
            "that": {"objectId": "selection:a", "label": "A", "content": "Alpha"},
            "these": [
                {"objectId": "selection:a", "label": "A", "content": "Alpha"},
                {"objectId": "selection:b", "label": "B", "content": "Beta"},
            ],
            "here": {"objectId": "selection:d", "label": "Draft", "app": "word"},
        },
    })
    assert "Interaction episode v1" in text
    assert "THIS" in text and "THAT" in text and "THESE[1]" in text and "HERE" in text
    assert "Alpha" in text and "Beta" in text
    assert "global history" in text


def test_shopping_list_response_is_local_typed_action() -> None:
    expires_at = (datetime.now(timezone.utc) + timedelta(minutes=1)).isoformat()
    payload = {
        "command": "Add this",
        "selectionSessionId": "session-1",
        "selectionSnapshot": {
            "snapshot_id": "snapshot-1",
            "expires_at": expires_at,
            "source_window": {"title": "Recipe.pdf - Microsoft Edge", "hwnd": 123},
            "context": {
                "adapter": "uia_text_selection",
                "app": "pdf",
                "window": {"title": "Recipe.pdf - Microsoft Edge", "hwnd": 123},
                "content": "1 lb Spaghetti",
                "label": "Recipe.pdf",
                "method": "uia:text-pattern.selection",
                "capabilities": [],
                "artifacts": {},
                "error": None,
            },
        },
    }
    target, app_ctx, snapshot, error = _context_from_snapshot(payload)
    assert error is None
    output = _shopping_list_response(payload, target, app_ctx, snapshot)
    assert output is not None
    assert output["ok"] is True
    assert output["intentKind"] == "shopping_list_add"
    assert output["answer"] == "正在加入购物清单…"
    assert output["autoExecuteProposalId"] == output["actionProposals"][0]["id"]
    assert output["actionProposals"][0]["action_type"] == "shopping_list_add"
    assert output["selectionSnapshotId"] == "snapshot-1"

    assert _shopping_list_response({**payload, "command": "Explain this"}, target, app_ctx, snapshot) is None


def test_selection_bridge_source_has_no_question_mark_corruption() -> None:
    source = (Path(__file__).resolve().parents[1] / "scripts" / "selection_bridge.py").read_text(encoding="utf-8")
    assert "????????" not in source


def test_bridges_accept_utf8_bom(monkeypatch) -> None:
    payload = '\ufeff{"command":"explain"}'
    monkeypatch.setattr(selection_bridge.sys, "stdin", io.StringIO(payload))
    assert selection_bridge.read_payload()["command"] == "explain"
    monkeypatch.setattr(action_bridge.sys, "stdin", io.StringIO(payload))
    assert action_bridge.read_payload()["command"] == "explain"
    monkeypatch.setattr(electron_bridge.sys, "stdin", io.StringIO(payload))
    assert electron_bridge._read_payload()["command"] == "explain"
