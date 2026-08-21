"""DraftArtifact is a versioned editable product, not a chat bubble.

The session log is the store. These tests pin the domain rules before any
loop wiring: generation, user/agent patches, approve-binds-hash, and the
ban on empty drafts.
"""

from __future__ import annotations

import asyncio
import hashlib
from pathlib import Path

import pytest

from app.agent_runtime.loop import LoopParams, LoopStopped, run_agent_loop
from app.agent_runtime.model_client import LoopModelClient, ToolCallArrived, TurnDone
from app.agent_runtime.session import FileSessionStore
from app.agent_runtime.tool_registry import ToolRegistry, ToolSpec
from app.agent_runtime.types import ToolCall
from app.artifacts.projection import project_artifacts
from app.artifacts.schema import DraftState


def _hash(content: str) -> str:
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def test_generated_draft_is_revision_one_with_a_stable_hash(tmp_path: Path) -> None:
    session = FileSessionStore(tmp_path).create("draft-gen")
    event = session.record_artifact_generated("把这三行改成会议纪要。")

    artifacts = project_artifacts(session.events)
    assert len(artifacts) == 1
    draft = artifacts[0]
    assert draft.artifact_id == event.data["artifactId"]
    assert draft.revision == 1
    assert draft.content == "把这三行改成会议纪要。"
    assert draft.content_hash == _hash("把这三行改成会议纪要。")
    assert draft.state is DraftState.GENERATED
    assert draft.accepted_revision is None


def test_a_user_patch_bumps_revision_and_is_not_model_visible(tmp_path: Path) -> None:
    session = FileSessionStore(tmp_path).create("draft-patch")
    generated = session.record_artifact_generated("初稿")
    artifact_id = str(generated.data["artifactId"])
    session.record_artifact_patched(artifact_id, "用户改过的稿", author="user")

    draft = project_artifacts(session.events)[0]
    assert draft.revision == 2
    assert draft.content == "用户改过的稿"
    assert draft.state is DraftState.EDITED
    assert [patch.author for patch in draft.history] == ["model", "user"]
    assert all(event.surface_op is None for event in session.events if event.type.startswith("artifact/"))
    assert session.derive_messages() == []


def test_accept_binds_the_current_hash_and_a_later_edit_voids_it(tmp_path: Path) -> None:
    session = FileSessionStore(tmp_path).create("draft-accept")
    artifact_id = str(session.record_artifact_generated("可批准的稿").data["artifactId"])
    current_hash = _hash("可批准的稿")
    session.record_artifact_accepted(artifact_id, revision=1, content_hash=current_hash)

    approved = project_artifacts(session.events)[0]
    assert approved.state is DraftState.APPROVED
    assert approved.accepted_revision == 1

    session.record_artifact_patched(artifact_id, "批准后又改了", author="user")
    edited = project_artifacts(session.events)[0]
    assert edited.state is DraftState.EDITED
    assert edited.accepted_revision is None
    assert edited.revision == 2


def test_accepting_a_stale_hash_is_rejected(tmp_path: Path) -> None:
    session = FileSessionStore(tmp_path).create("draft-stale")
    artifact_id = str(session.record_artifact_generated("现稿").data["artifactId"])
    with pytest.raises(ValueError, match="contentHash"):
        session.record_artifact_accepted(
            artifact_id,
            revision=1,
            content_hash=_hash("另一份已经不在的稿"),
        )
    assert project_artifacts(session.events)[0].state is DraftState.GENERATED


def test_empty_content_is_not_a_draft(tmp_path: Path) -> None:
    session = FileSessionStore(tmp_path).create("draft-empty")
    with pytest.raises(ValueError, match="empty"):
        session.record_artifact_generated("   ")
    assert project_artifacts(session.events) == ()


def test_a_completed_loop_answer_becomes_a_generated_draft(tmp_path: Path) -> None:
    session = FileSessionStore(tmp_path).create("draft-loop")
    registry = ToolRegistry()
    registry.register(ToolSpec(
        name="unused",
        description="unused",
        input_schema={"type": "object", "properties": {}, "required": []},
        execute=lambda scope=None: "no",
    ))

    class Backend:
        def generate(self, messages, tools, budget_ms=None, cancel_scope=None):
            yield TurnDone(usage={"input_tokens": 4, "output_tokens": 6}, raw_text="这是终稿。")

    async def collect():
        return [
            event
            async for event in run_agent_loop(LoopParams(
                user_input="写一段",
                registry=registry,
                client=LoopModelClient(Backend()),
                session=session,
                request_header={"systemPrompt": "system"},
            ))
        ]

    events = asyncio.run(collect())
    assert isinstance(events[-1], LoopStopped)
    drafts = project_artifacts(session.events)
    assert len(drafts) == 1
    assert drafts[0].content == "这是终稿。"
    assert drafts[0].state is DraftState.GENERATED
    assert drafts[0].revision == 1


def test_a_follow_up_answer_is_a_new_draft_not_a_patch(tmp_path: Path) -> None:
    store = FileSessionStore(tmp_path)
    session = store.create("draft-followup")
    registry = ToolRegistry()

    class Backend:
        def __init__(self, answer: str) -> None:
            self.answer = answer

        def generate(self, messages, tools, budget_ms=None, cancel_scope=None):
            yield TurnDone(usage=None, raw_text=self.answer)

    async def run(handle, prompt, answer):
        return [
            event
            async for event in run_agent_loop(LoopParams(
                user_input=prompt,
                registry=registry,
                client=LoopModelClient(Backend(answer)),
                session=handle,
                request_header={"systemPrompt": "system"},
            ))
        ]

    asyncio.run(run(session, "第一问", "第一稿"))
    resumed = store.resume("draft-followup", repair=True)
    asyncio.run(run(resumed, "第二问", "第二稿"))
    drafts = project_artifacts(resumed.events)
    assert [draft.content for draft in drafts] == ["第一稿", "第二稿"]
    assert all(draft.revision == 1 for draft in drafts)
    assert drafts[0].artifact_id != drafts[1].artifact_id


def test_a_clarification_does_not_become_a_draft(tmp_path: Path) -> None:
    session = FileSessionStore(tmp_path).create("draft-ask")
    registry = ToolRegistry()
    registry.register(ToolSpec(
        name="ask_user_question",
        description="ask",
        input_schema={
            "type": "object",
            "properties": {
                "question": {"type": "string"},
                "options": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["question", "options"],
        },
        execute=lambda question, options, scope=None: __import__("json").dumps({
            "asked": True,
            "awaitingUserInput": True,
            "question": question,
            "options": options,
        }, ensure_ascii=False),
        suspends_for_user_input=True,
    ))

    class Backend:
        def generate(self, messages, tools, budget_ms=None, cancel_scope=None):
            yield ToolCallArrived(call=ToolCall(
                id="ask-1",
                name="ask_user_question",
                arguments={"question": "选 A 还是 B？", "options": ["A", "B"]},
            ))
            yield TurnDone(usage=None, raw_text=None)

    async def collect():
        return [
            event
            async for event in run_agent_loop(LoopParams(
                user_input="帮我处理",
                registry=registry,
                client=LoopModelClient(Backend()),
                session=session,
                request_header={"systemPrompt": "system"},
            ))
        ]

    asyncio.run(collect())
    assert project_artifacts(session.events) == ()
