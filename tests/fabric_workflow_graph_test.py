from __future__ import annotations

from pathlib import Path

from app.fabric.engine import FabricEngine
from app.fabric.workflow import operation_graph


def test_confirmation_graph_has_ground_route_gate_execute_verify() -> None:
    graph = operation_graph(
        recipe_id="text.ocr_copy",
        provider="native.ocr",
        permission="confirm",
        object_count=1,
    )
    assert [node["id"] for node in graph["nodes"]] == [
        "ground",
        "route",
        "approval",
        "execute",
        "verify",
    ]
    assert graph["edges"][-1] == {"from": "execute", "to": "verify"}
    assert graph["humanInTheLoop"] is True
    assert graph["durable"] is False


def test_agent_plan_exposes_durable_signed_workflow_graph(tmp_path: Path) -> None:
    engine = FabricEngine(
        root=tmp_path,
        agent_availability={"pi": True},
        agent_starter=lambda _payload: {"taskId": "task", "status": "queued"},
    )
    planned = engine.plan(
        "让 Pi 在后台处理这个",
        objects=[{"id": "screen", "kind": "screen_region", "bbox": [0, 0, 20, 20]}],
        parameters={"cwd": str(tmp_path)},
    )
    graph = planned["plan"]["preview"]["workflowGraph"]
    assert graph["durable"] is True
    assert graph["nodes"][-1]["kind"] == "verification"
    assert planned["plan"]["integrityToken"]
