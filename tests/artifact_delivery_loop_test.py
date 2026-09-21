"""Explicit deliverables through the real harness, loop and durable session."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from app.agent_runtime.loop import LoopParams, run_agent_loop
from app.agent_runtime.model_client import LoopModelClient, ToolCallArrived, TurnDone
from app.agent_runtime.session import FileSessionStore
from app.agent_runtime.types import ToolCall, TransitionReason
from app.artifacts.projection import project_artifacts
from app.harness.builtin_bundle import boot_loop_context
from app.receipts.projection import project_receipts
from scripts.conversation_bridge import _latest_turn_artifact_summaries
from scripts.artifact_bridge import _wire_artifact


class Scripted:
    def __init__(self, *rounds):
        self.rounds = list(rounds)

    def generate(self, messages, tools, budget_ms=None, cancel_scope=None):
        yield from self.rounds.pop(0)


def call(name, arguments, identity="call-1"):
    return [ToolCallArrived(call=ToolCall(id=identity, name=name, arguments=arguments)),
            TurnDone(usage=None, raw_text=None)]


def run(session, root, *rounds):
    report = boot_loop_context({"source_session_getter": lambda: session}, root=root)
    try:
        async def collect():
            return [event async for event in run_agent_loop(LoopParams(
                user_input="按用户要求处理当前交付物",
                registry=report.ctx.get("tools"),
                client=LoopModelClient(Scripted(*rounds)),
                session=session,
                request_header={"systemPrompt": "system"},
            ))]
        return asyncio.run(collect())[-1].terminal
    finally:
        report.ctx.unload()


def test_explicit_create_update_read_and_chat_keep_one_durable_deliverable(tmp_path: Path):
    store = FileSessionStore(tmp_path / "sessions")
    session = store.create("deliverable")
    terminal = run(session, tmp_path,
        call("Artifact.create", {"title": "团队会议纪要", "kind": "markdown", "content": "# 纪要\n初稿"}),
        [TurnDone(usage=None, raw_text="会议纪要已放在草稿里。")],
    )
    assert terminal.reason is TransitionReason.COMPLETED
    assert terminal.results[0].is_error is False
    drafts = project_artifacts(session.events)
    assert len(drafts) == 1
    draft = drafts[0]
    assert draft.content == "# 纪要\n初稿"
    assert draft.title == "团队会议纪要"
    assert _wire_artifact(session, draft)["title"] == draft.title
    assert _latest_turn_artifact_summaries(session)[0]["name"] == draft.title
    assert project_receipts(session.events)[-1].artifact_ids == (draft.artifact_id,)

    # A user edit is real durable state, not a model-visible message.
    session.record_artifact_patched(draft.artifact_id, "# 纪要\n用户补充", author="user", expected_revision=1)
    session = store.resume("deliverable", repair=True)
    terminal = run(session, tmp_path,
        call("Artifact.read", {"artifact_id": draft.artifact_id}, "read-current"),
        call("Artifact.update", {"artifact_id": draft.artifact_id, "expected_revision": 2,
                                 "content": "# 纪要\n用户补充\n行动项"}, "revise"),
        [TurnDone(usage=None, raw_text="行动项已补入原稿。")],
    )
    assert all(not result.is_error for result in terminal.results)
    readback = json.loads(terminal.results[0].value)
    assert readback["content"] == "# 纪要\n用户补充"
    assert readback["revision"] == 2
    drafts = project_artifacts(session.events)
    assert len(drafts) == 1
    assert drafts[0].artifact_id == draft.artifact_id
    assert drafts[0].revision == 3
    assert drafts[0].title == draft.title
    summary = _latest_turn_artifact_summaries(session)
    assert len(summary) == 1
    assert summary[0]["revision"] == 3
    assert summary[0]["state"] == "edited"
    assert project_receipts(session.events)[-1].artifact_ids == (draft.artifact_id,)

    terminal = run(session, tmp_path,
        call("Artifact.read", {"artifact_id": draft.artifact_id}, "read-only"),
        [TurnDone(usage=None, raw_text="稿件已经包含行动项。")],
    )
    assert terminal.reason is TransitionReason.COMPLETED
    assert len(project_artifacts(session.events)) == 1
    assert _latest_turn_artifact_summaries(session) == []
    assert project_receipts(session.events)[-1].artifact_ids == ()


def test_stale_model_update_does_not_overwrite_user_revision(tmp_path: Path):
    session = FileSessionStore(tmp_path / "sessions").create("stale-draft")
    draft_id = session.record_artifact_generated("初稿").data["artifactId"]
    session.record_artifact_patched(draft_id, "用户现稿", author="user", expected_revision=1)
    terminal = run(session, tmp_path,
        call("Artifact.update", {"artifact_id": draft_id, "expected_revision": 1, "content": "旧稿覆盖"}),
        [TurnDone(usage=None, raw_text="草稿已经变化，需要读当前稿。")],
    )
    assert terminal.results[0].is_error
    assert "current revision 2" in terminal.results[0].value
    assert project_artifacts(session.events)[0].content == "用户现稿"
    assert _latest_turn_artifact_summaries(session) == []


@pytest.mark.parametrize("kind", [None, "permission"])
def test_waiting_for_user_does_not_create_artifacts(tmp_path: Path, kind):
    session = FileSessionStore(tmp_path / "sessions").create("ask")
    args = {"question": "请确认下一步", "options": ["继续", "停止"]}
    if kind:
        args.update(kind=kind, tool="Bash")
    terminal = run(session, tmp_path, call("AskUser", args))
    assert terminal.reason is TransitionReason.AWAITING_USER
    assert project_artifacts(session.events) == ()


def test_plan_progress_and_completion_stay_out_of_artifacts(tmp_path: Path):
    session = FileSessionStore(tmp_path / "sessions").create("plan")
    terminal = run(session, tmp_path,
        call("Todo", {"todos": [{"content": "检查范围", "status": "completed"}]}),
        [TurnDone(usage=None, raw_text="范围已经确认。")],
    )
    assert terminal.reason is TransitionReason.COMPLETED
    assert not terminal.results[0].is_error
    assert project_artifacts(session.events) == ()
