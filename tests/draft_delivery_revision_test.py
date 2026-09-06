from __future__ import annotations

from app.actions.draft_delivery import make_draft_delivery_proposal
from app.actions.executor import SafeActionExecutor
from app.actions.schema import ExecutionStatus


def _proposal():
    return make_draft_delivery_proposal(
        "approved draft",
        target_window={
            "hwnd": 901,
            "process_id": 44,
            "process_name": "WeChat.exe",
            "title": "Project chat",
        },
        target_point=[300, 700],
        target_point_space="physical_screen_pixels",
        artifact_id="artifact-1",
        artifact_revision=2,
        source_id="chat-1",
        locator={"kind": "message", "value": {"nativeMessageId": "m-22"}},
    )


def test_draft_delivery_proposal_binds_revision_source_and_locator() -> None:
    proposal = _proposal()

    assert proposal.parameters["artifact_id"] == "artifact-1"
    assert proposal.parameters["artifact_revision"] == 2
    assert proposal.parameters["source_id"] == "chat-1"
    assert proposal.parameters["locator"] == {
        "kind": "message",
        "value": {"nativeMessageId": "m-22"},
    }
    assert proposal.parameters["action_lease"] == {
        "artifactId": "artifact-1",
        "artifactRevision": 2,
        "sourceId": "chat-1",
        "locator": {
            "kind": "message",
            "value": {"nativeMessageId": "m-22"},
        },
        "targetHwnd": 901,
        "targetProcessId": 44,
    }


def test_stale_draft_revision_is_rejected_before_the_writer_runs() -> None:
    writes: list[dict] = []
    executor = SafeActionExecutor(
        draft_writer=lambda parameters: writes.append(parameters) or {"ok": True},
        artifact_revision_probe=lambda _artifact_id: {
            "revision": 3,
            "acceptedRevision": None,
            "contentHash": "changed",
        },
    )

    result = executor.execute(_proposal(), confirmed=True)

    assert result.status is ExecutionStatus.FAILED
    assert result.error == "draft artifact revision changed before execution"
    assert writes == []


def test_current_accepted_draft_is_written_and_readback_verified() -> None:
    proposal = _proposal()
    writes: list[dict] = []

    def writer(parameters):
        writes.append(parameters)
        return {
            "ok": True,
            "submit_sent": False,
            "target_hwnd": 901,
            "target_title": "Project chat",
            "delivery_mode": "full_prompt",
            "written_chars": len("approved draft"),
            "verified": True,
        }

    executor = SafeActionExecutor(
        draft_writer=writer,
        artifact_revision_probe=lambda _artifact_id: {
            "revision": 2,
            "acceptedRevision": 2,
            "contentHash": proposal.parameters["text_sha256"],
        },
    )

    result = executor.execute(proposal, confirmed=True)

    assert result.status is ExecutionStatus.SUCCEEDED
    assert result.output["verified"] is True
    assert len(writes) == 1
