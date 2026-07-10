from __future__ import annotations

import io
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import scripts.action_bridge as action_bridge
import scripts.electron_bridge as electron_bridge
import scripts.selection_bridge as selection_bridge
from scripts.selection_bridge import _context_from_snapshot, _read_target_context, _wants_undo


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
