from __future__ import annotations

import json
from pathlib import Path

from app.agent_runtime.session import FileSessionStore
from app.context_pack.daily_wrap import ConversationEventCatalog


def test_daily_wrap_reads_only_real_turn_events_in_the_requested_range(tmp_path: Path) -> None:
    path = tmp_path / "history" / "conversations.json"
    path.parent.mkdir(parents=True)
    path.write_text(json.dumps([
        {
            "id": "c-in",
            "title": "核对报价",
            "object": {"app": "Weixin", "windowTitle": "项目群"},
            "turns": [{
                "id": "t-in",
                "at": 2000,
                "startedAt": 1500,
                "completedAt": 2000,
                "question": "核对两份报价",
                "answer": "差异是税率。",
                "outcome": "已完成",
                "events": [{"name": "Context.read", "isError": False}],
                "receipts": [{"toolName": "Context.read", "usedBackend": "pdf.native"}],
                "artifacts": [{"artifactId": "a-1", "revision": 2}],
            }],
        },
        {
            "id": "c-out",
            "title": "范围外",
            "object": {"app": "PowerPoint"},
            "turns": [{
                "id": "t-out", "at": 9000, "question": "晚些工作", "answer": "完成", "outcome": "已完成"
            }],
        },
    ], ensure_ascii=False), encoding="utf-8")

    result = ConversationEventCatalog(path).summaries(
        from_ms=1000,
        to_ms=3000,
        conversation_ids=["c-in"],
    )
    assert result["materialAvailable"] is True
    assert result["coverage"]["includedTurns"] == 1
    assert result["events"][0]["conversationId"] == "c-in"
    assert result["events"][0]["startedAt"] == 1500
    assert result["events"][0]["completedAt"] == 2000
    assert result["events"][0]["receipts"][0]["usedBackend"] == "pdf.native"
    assert "durationMs" not in result["events"][0], "不能从窗口停留推断工作时长"


def test_daily_wrap_empty_range_says_no_material_instead_of_inventing_a_day(tmp_path: Path) -> None:
    path = tmp_path / "history" / "conversations.json"
    path.parent.mkdir(parents=True)
    path.write_text("[]", encoding="utf-8")

    result = ConversationEventCatalog(path).summaries(from_ms=1000, to_ms=2000)
    assert result["materialAvailable"] is False
    assert result["events"] == []
    assert "没有纳入本次材料" in result["coverage"]["message"]


def test_daily_wrap_uses_event_session_as_the_current_artifact_authority(tmp_path: Path) -> None:
    session_root = tmp_path / "agent-sessions"
    session = FileSessionStore(session_root).create("agent-wrap-artifact")
    generated = session.record_artifact_generated("第一版")
    artifact_id = str(generated.data["artifactId"])
    session.record_artifact_patched(
        artifact_id,
        "用户编辑后的第二版",
        author="user",
        expected_revision=1,
    )

    path = tmp_path / "history" / "conversations.json"
    path.parent.mkdir(parents=True)
    path.write_text(json.dumps([{
        "id": "c-artifact",
        "title": "编辑总结",
        "agentSessionId": "agent-wrap-artifact",
        "turns": [{
            "id": "t-artifact",
            "at": 2000,
            "question": "写总结",
            "answer": "第一版",
            "outcome": "已完成",
            "artifacts": [{"artifactId": artifact_id, "revision": 1, "content": "第一版"}],
        }],
    }], ensure_ascii=False), encoding="utf-8")

    result = ConversationEventCatalog(path, session_root=session_root).summaries(
        from_ms=1000,
        to_ms=3000,
    )
    artifact = result["events"][0]["artifacts"][0]
    assert artifact["revision"] == 2
    assert artifact["content"] == "用户编辑后的第二版"
    assert artifact["authority"] == "event_session"
