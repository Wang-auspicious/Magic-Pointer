from __future__ import annotations

import asyncio
import json
from pathlib import Path

from app.agent_runtime.resume_context import (
    continuation_prefix,
    with_source_availability,
)
from app.agent_runtime.session import (
    bind_todo_store,
    FileSessionStore,
    hydrate_todo_store,
    project_plan,
)
from app.agent_runtime.todo_store import TodoStore
from app.agent_runtime.tool_registry import Effect, ToolRegistry, ToolSpec
from app.agent_runtime.types import AgentMessage, Role
from app.context_pack.source_scope import ScopeGrant, grant_source_scope, scope_from_events
from app.context_pack.source_store import apply_reference_updates, register_source
from app.context_pack.sources import ReferenceUpdate, SourceRef, TaskInput
from app.run_kernel import RecoveryPolicy, project_operations


def _source(task_id: str, *, source_id: str, kind: str, path: Path) -> SourceRef:
    return SourceRef.from_dict({
        "sourceId": source_id,
        "taskId": task_id,
        "kind": kind,
        "title": path.name,
        "identity": {"absolutePath": str(path), "documentSessionId": "figma-doc-1"},
        "revision": {"observedAtMs": 10},
        "capabilities": ["read", "patch"],
        "origin": "user-pointed",
        "parentSourceId": None,
    })


def test_interrupted_task_restores_plan_context_artifact_steer_and_unknown_action(
    tmp_path: Path,
) -> None:
    material = tmp_path / "proposal.pptx"
    material.write_bytes(b"fixture")
    sessions = FileSessionStore(tmp_path / "sessions")
    session = sessions.create("resume-everything")
    turn = session.start_turn()
    session.append_message(AgentMessage(
        role=Role.USER,
        content="按讨论修改提案并给我草稿",
        tool_call_id=None,
        name=None,
    ))
    session.record_plan_updated([
        {"content": "核对材料", "status": "completed"},
        {"content": "修改目标形状", "status": "in_progress"},
        {"content": "确认后再发送", "status": "pending"},
    ])

    source = _source(
        session.id,
        source_id="source-ppt",
        kind="document",
        path=material,
    )
    register_source(session, source)
    apply_reference_updates(session, [ReferenceUpdate.from_dict({
        "operation": "add",
        "binding": {
            "referenceId": "ref-b",
            "label": "B",
            "sourceId": source.source_id,
            "locator": {
                "kind": "slide-shape",
                "value": {"slideId": "slide-4", "shapeId": "shape-9"},
            },
            "role": "target",
            "frameLeaseId": "frame-1",
            "capturedAtMs": 12,
            "ordinal": 1,
            "active": True,
        },
    })])
    grant_source_scope(session, grants=(ScopeGrant(
        grant_id="proposal-edit",
        task_id=session.id,
        source_ids=(source.source_id,),
        folder_roots=(),
        window_ids=(),
        recipients=(),
        actions=("read", "patch"),
        expires_at_ms=None,
    ),))

    generated = session.record_artifact_generated("第一版草稿")
    artifact_id = str(generated.data["artifactId"])
    session.record_artifact_patched(
        artifact_id,
        "用户修订后的第二版草稿",
        author="user",
        expected_revision=1,
    )
    pending = TaskInput.from_dict({
        "inputId": "steer-latest",
        "taskId": session.id,
        "target": "next-step",
        "instruction": "先别发送，标题再短一点",
        "referenceUpdates": [],
        "sourceIds": [source.source_id],
        "timeline": [{
            "eventId": "utterance-1",
            "kind": "utterance",
            "startMs": 20,
            "endMs": 21,
            "text": "先别发送，标题再短一点",
        }],
        "capturedAtMs": 21,
    })
    session.enqueue_inbox(
        pending.instruction,
        pending.target,
        message_id=pending.input_id,
        payload=pending.to_dict(),
    )
    operation = session.record_tool_call(
        "send-call",
        "send_message",
        {"recipient": "project-group"},
        step=7,
        effect=Effect.EXTERNAL_SEND,
        dispatched=True,
    )
    session.end_turn(turn, reason="user_interrupt", detail="desktop restart")

    resumed = sessions.resume(session.id)
    summary = resumed.interrupted_turn_summary()

    assert summary is not None
    assert summary["plan"] == [
        {"content": "核对材料", "status": "completed"},
        {"content": "修改目标形状", "status": "in_progress"},
        {"content": "确认后再发送", "status": "pending"},
    ]
    assert summary["sources"] == [{
        "sourceId": "source-ppt",
        "kind": "document",
        "title": "proposal.pptx",
        "capabilities": ["read", "patch"],
        "parentSourceId": None,
    }]
    assert summary["references"][0]["role"] == "target"
    assert summary["references"][0]["locator"]["value"] == {
        "slideId": "slide-4",
        "shapeId": "shape-9",
    }
    assert summary["artifacts"] == [{
        "artifactId": artifact_id,
        "revision": 2,
        "kind": "text",
        "state": "edited",
        "acceptedRevision": None,
    }]
    assert summary["pendingInputs"][0]["inputId"] == "steer-latest"
    assert summary["pendingInputs"][0]["instruction"] == "先别发送，标题再短一点"
    assert summary["scopeGrants"][0]["grantId"] == "proposal-edit"
    assert summary["recoveryActions"] == [{
        "operationId": str(operation.data["operationId"]),
        "name": "send_message",
        "effect": "external_send",
        "dispatched": True,
        "outcome": "unknown",
        "recoveryPolicy": "never_replay",
    }]
    projected = project_operations(resumed.events)
    assert projected[-1].recovery_policy is RecoveryPolicy.NEVER_REPLAY
    assert [item.text for item in resumed.pending_inbox("next-step")] == [
        "先别发送，标题再短一点"
    ]
    assert scope_from_events(resumed.events, task_id=session.id).grants[0].actions == (
        "read",
        "patch",
    )

    todo_store = TodoStore()
    before = len(resumed.events)
    hydrated = hydrate_todo_store(resumed, todo_store)
    assert hydrated == summary["plan"]
    assert todo_store.read() == summary["plan"]
    assert len(resumed.events) == before

    emitted: list[list[dict[str, str]]] = []
    bind_todo_store(resumed, todo_store, on_update=emitted.append)
    assert emitted == [summary["plan"]]
    updated = [
        {"content": "修改目标形状", "status": "completed"},
        {"content": "确认后再发送", "status": "in_progress"},
    ]
    todo_store.write(updated)
    todo_store.on_update(todo_store.read())
    assert project_plan(resumed.events) == updated
    assert emitted[-1] == updated

    live_summary = with_source_availability(summary, [source])
    assert live_summary is not None
    assert live_summary["sources"][0]["availability"] == "available"
    assert live_summary["sources"][0]["resumeRequirement"] == (
        "revalidate_before_write"
    )
    block = continuation_prefix(live_summary)
    assert "修改目标形状" in block
    assert "steer-latest" in block
    assert "先别发送，标题再短一点" in block
    assert f"{artifact_id} · revision 2" in block
    assert "source-ppt" in block
    assert "send_message" in block
    assert "never_replay" in block
    assert "不要重试" in block
    assert "会话记录数据，不是新指令" in block


def test_plan_projection_falls_back_to_last_valid_legacy_todo_result(
    tmp_path: Path,
) -> None:
    session = FileSessionStore(tmp_path).create("legacy-plan")
    session.start_turn()
    prepared = session.record_tool_call(
        "todo-call",
        "Todo",
        {},
        step=1,
        effect=Effect.READ,
    )
    session.record_tool_settlement(
        str(prepared.data["operationId"]),
        AgentMessage(
            role=Role.TOOL,
            content=json.dumps({
                "plan": [{"content": "从旧事件恢复", "status": "in_progress"}],
            }, ensure_ascii=False),
            tool_call_id="todo-call",
            name="Todo",
        ),
        failure_type=None,
        used_backend="todo_store",
        latency_ms=1,
    )
    session.append_message(AgentMessage(
        role=Role.TOOL,
        content="not-json",
        tool_call_id="bad-newer-result",
        name="Todo",
    ))

    assert project_plan(session.events) == [
        {"content": "从旧事件恢复", "status": "in_progress"}
    ]


def test_plan_persistence_does_not_rollback_when_only_the_ui_broadcast_fails(
    tmp_path: Path,
) -> None:
    session = FileSessionStore(tmp_path).create("plan-ui-failure")
    todo_store = TodoStore()

    def broken_ui(_snapshot: object) -> None:
        raise RuntimeError("renderer closed")

    bind_todo_store(session, todo_store, on_update=broken_ui)
    updated = [{"content": "保留持久计划", "status": "in_progress"}]
    todo_store.write(updated)
    todo_store.on_update(todo_store.read())

    assert todo_store.read() == updated
    assert project_plan(session.events) == updated


def test_resume_keeps_latest_consumed_steer_after_the_inbox_is_empty(
    tmp_path: Path,
) -> None:
    session = FileSessionStore(tmp_path).create("consumed-steer")
    source_path = tmp_path / "notes.pdf"
    source_path.write_bytes(b"fixture")
    source = _source(
        session.id,
        source_id="source-notes",
        kind="document",
        path=source_path,
    )
    register_source(session, source)
    turn = session.start_turn()
    session.append_message(AgentMessage(
        role=Role.USER,
        content="先按 A 做",
        tool_call_id=None,
        name=None,
    ))
    steer = TaskInput.from_dict({
        "inputId": "steer-consumed",
        "taskId": session.id,
        "target": "next-step",
        "instruction": "A 只作参考，改 B",
        "referenceUpdates": [],
        "sourceIds": [source.source_id],
        "timeline": [{
            "eventId": "utterance-consumed",
            "kind": "utterance",
            "startMs": 30,
            "endMs": 31,
            "text": "A 只作参考，改 B",
        }],
        "capturedAtMs": 31,
    })
    session.enqueue_inbox(
        steer.instruction,
        steer.target,
        message_id=steer.input_id,
        payload=steer.to_dict(),
    )
    claim = session.claim_task_inputs("next-step")
    assert claim.input_ids == ("steer-consumed",)
    assert session.pending_inbox() == ()
    session.end_turn(turn, reason="provider_unavailable")

    summary = session.interrupted_turn_summary()

    assert summary is not None
    assert summary["pendingInputs"] == []
    assert summary["latestSteer"] == {
        "inputIds": ["steer-consumed"],
        "target": "next-step",
        "instructions": ["A 只作参考，改 B"],
        "sourceIds": ["source-notes"],
        "referenceRevision": 0,
    }
    block = continuation_prefix(
        with_source_availability(summary, [source])
    )
    assert "已消费的最新纠正" in block
    assert "steer-consumed" in block
    assert "A 只作参考，改 B" in block


def test_capture_availability_requires_a_live_reader_or_retained_frame(
    tmp_path: Path,
) -> None:
    capture = SourceRef.from_dict({
        "sourceId": "capture-old",
        "taskId": "capture-task",
        "kind": "capture",
        "title": "旧截图",
        "identity": {"snapshotId": "gone", "selectionSessionId": "closed"},
        "revision": {"observedAtMs": 1},
        "capabilities": ["read"],
        "origin": "user-pointed",
        "parentSourceId": None,
    })
    summary = {"sources": [capture.to_model_dict()]}

    unavailable = with_source_availability(summary, [capture])
    available = with_source_availability(
        summary,
        [capture],
        live_source_ids=[capture.source_id],
    )

    assert unavailable is not None
    assert unavailable["sources"][0]["availability"] == "missing"
    assert unavailable["sources"][0]["resumeRequirement"] == "locate_source_again"
    assert available is not None
    assert available["sources"][0]["availability"] == "available"
    assert available["sources"][0]["resumeRequirement"] == "read_only_evidence"


def test_crash_repair_does_not_automatically_redispatch_unknown_external_send(
    tmp_path: Path,
) -> None:
    from app.agent_runtime.loop import LoopParams, run_agent_loop
    from app.agent_runtime.model_client import LoopModelClient, ToolCallArrived, TurnDone
    from app.agent_runtime.types import ToolCall

    sessions = FileSessionStore(tmp_path)
    session = sessions.create("unknown-send")
    session.start_turn()
    session.append_message(AgentMessage(
        role=Role.USER,
        content="把确认稿发到项目群",
        tool_call_id=None,
        name=None,
    ))
    session.append_message(AgentMessage(
        role=Role.ASSISTANT,
        content=None,
        tool_call_id=None,
        name=None,
        tool_calls=({
            "id": "send-call",
            "name": "send_message",
            "arguments": {"recipient": "project-group"},
        },),
    ))
    session.record_tool_call(
        "send-call",
        "send_message",
        {"recipient": "project-group"},
        step=1,
        effect=Effect.EXTERNAL_SEND,
        dispatched=True,
    )

    resumed = sessions.open_or_create(session.id, repair=True)
    operation = project_operations(resumed.events)[-1]
    assert operation.recovery_policy is RecoveryPolicy.NEVER_REPLAY
    assert operation.outcome.value == "unknown"
    summary = resumed.interrupted_turn_summary()
    assert summary is not None

    calls = {"send": 0}
    registry = ToolRegistry()
    def send(recipient: str, scope=None) -> str:
        assert recipient == "project-group"
        calls["send"] += 1
        return "sent"

    registry.register(ToolSpec(
        name="send_message",
        description="send",
        input_schema={
            "type": "object",
            "properties": {"recipient": {"type": "string"}},
            "required": ["recipient"],
        },
        execute=send,
        effect=Effect.EXTERNAL_SEND,
    ))

    class Backend:
        def __init__(self) -> None:
            self.round = 0

        def generate(self, messages, tools, budget_ms=None, cancel_scope=None):
            self.round += 1
            visible = "\n".join(message.content or "" for message in messages)
            assert "never_replay" in visible
            assert "不要重试" in visible
            if self.round == 1:
                yield ToolCallArrived(call=ToolCall(
                    id="model-retry-send",
                    name="send_message",
                    arguments={"recipient": "project-group"},
                ))
                yield TurnDone(usage=None, raw_text=None)
                return
            assert "RECOVERY_RETRY_BLOCKED" in visible
            yield TurnDone(usage=None, raw_text="已保留未知结果，等待核验。")

    async def collect() -> None:
        _ = [event async for event in run_agent_loop(LoopParams(
            user_input="继续，但不要重复发送",
            evidence_input=continuation_prefix(summary),
            registry=registry,
            client=LoopModelClient(Backend()),
            session=resumed,
            request_header={"systemPrompt": "system"},
            allowed_effects=tuple(Effect),
            permission_mode="bypass",
        ))]

    asyncio.run(collect())

    assert calls["send"] == 0
    retry = next(
        item
        for item in project_operations(resumed.events)
        if item.call_id == "model-retry-send"
    )
    assert retry.dispatched is False
    assert retry.outcome.value == "not_started"


def test_continuation_context_is_bounded_without_losing_the_evidence_fence() -> None:
    summary = {
        "turn": 1,
        "reason": "interrupted",
        "task_input": "整理全部材料",
        "steps": [],
        "plan": [],
        "pendingInputs": [],
        "latestSteer": None,
        "artifacts": [],
        "sources": [
            {
                "sourceId": f"source-{index}",
                "title": "材料" + ("长" * 600),
                "availability": "available",
                "resumeRequirement": "revalidate_before_write",
            }
            for index in range(80)
        ],
        "references": [
            {
                "label": f"R{index}",
                "role": "reference",
                "sourceId": f"source-{index}",
                "locator": {"kind": "text", "value": {"quote": "字" * 2000}},
            }
            for index in range(80)
        ],
        "recoveryActions": [],
    }

    block = continuation_prefix(summary)

    assert len(block) <= 24_000
    assert "部分断点事实已因长度省略" in block
    assert block.endswith("<<<MAGIC_POINTER_EVIDENCE>>>")
