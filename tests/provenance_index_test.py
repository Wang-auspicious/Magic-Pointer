from __future__ import annotations

from pathlib import Path

import pytest

from app.fabric.agents import AgentInvocation, AgentRequest
from app.fabric.provenance import ProvenanceError, ProvenanceIndex
from app.fabric.schema import OperationPlan, RiskLevel
from app.fabric.task_store import AgentTaskStore


def _plan(workspace: Path) -> OperationPlan:
    return OperationPlan(
        id="plan-n15",
        recipe_id="agent.handoff",
        command="fix the pointed button",
        risk=RiskLevel.EXTERNAL_SEND,
        provider="agent.task",
        object_ids=("object-a",),
        parameters={
            "cwd": str(workspace),
            "objects": [{
                "id": "object-a",
                "referenceLabel": "A",
                "kind": "button",
                "label": "Save",
                "bbox": [10, 20, 80, 50],
                "source": {"app": "code.exe", "title": "Settings"},
            }],
        },
        preview={"title": "Agent handoff"},
        requires_confirmation=True,
        idempotency_key="idem-n15",
        integrity_token="signed",
    )


def test_object_trace_joins_plan_task_patch_page_and_artifact(tmp_path: Path) -> None:
    runtime = tmp_path / "runtime"
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    patch = workspace / "button-fix.patch"
    page = workspace / "preview.html"
    patch.write_text("diff --git a/ui b/ui\n", encoding="utf-8")
    page.write_text("<button>Save</button>\n", encoding="utf-8")
    tasks = AgentTaskStore(
        runtime / "agent-tasks",
        spawn_worker=lambda _path: 991,
        process_alive=lambda _pid: True,
    )
    task = tasks.start(
        AgentRequest(provider="codex", prompt="fix", cwd=str(workspace)),
        AgentInvocation(argv=("codex",), stdin="fix", cwd=str(workspace), protocol="jsonl"),
    )
    tasks.link_provenance(
        task["taskId"],
        plan_id="plan-n15",
        receipt_id="receipt-n15",
        recipe_id="agent.handoff",
        source_object_ids=("object-a",),
        retention_days=30,
    )
    tasks.complete(
        task["taskId"],
        exit_code=0,
        summary="done",
        output={"artifacts": [str(patch), str(page)]},
    )
    index = ProvenanceIndex(runtime)
    index.record_execution(
        _plan(workspace),
        {"id": "receipt-n15", "status": "accepted", "output": {"taskId": task["taskId"]}},
    )

    trace = index.trace("object-a")

    assert trace["object"]["label"] == "Save"
    assert trace["object"]["bbox"] == [10, 20, 80, 50]
    assert trace["plans"][0]["planId"] == "plan-n15"
    assert trace["tasks"][0]["taskId"] == task["taskId"]
    assert trace["tasks"][0]["status"] == "succeeded"
    assert {item["linkKind"] for item in trace["artifacts"]} == {"diff", "page"}
    assert all(item["sourceObjectIds"] == ["object-a"] for item in trace["artifacts"])


def test_objects_are_deduplicated_and_unknown_object_fails_closed(tmp_path: Path) -> None:
    index = ProvenanceIndex(tmp_path)
    plan = _plan(tmp_path)
    index.record_execution(plan, {"id": "r1", "status": "succeeded", "output": {}})
    index.record_execution(plan, {"id": "r2", "status": "succeeded", "output": {}})

    assert [item["objectId"] for item in index.objects()] == ["object-a"]
    with pytest.raises(ProvenanceError, match="object provenance not found"):
        index.trace("missing")
