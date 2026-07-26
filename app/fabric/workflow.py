from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class WorkflowNode:
    id: str
    kind: str
    label: str
    state: str
    checkpoint: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "kind": self.kind,
            "label": self.label,
            "state": self.state,
            "checkpoint": self.checkpoint,
        }


def operation_graph(
    *,
    recipe_id: str,
    provider: str,
    permission: str,
    object_count: int,
) -> dict[str, Any]:
    nodes = [
        WorkflowNode("ground", "grounding", f"冻结 {object_count} 个来源对象", "complete", True),
        WorkflowNode("route", "routing", f"匹配 {recipe_id}", "complete", True),
    ]
    edges = [{"from": "ground", "to": "route"}]
    previous = "route"
    if permission == "confirm":
        nodes.append(WorkflowNode("approval", "human_gate", "等待用户确认真实副作用", "pending", True))
        edges.append({"from": previous, "to": "approval"})
        previous = "approval"
    nodes.extend([
        WorkflowNode(
            "execute",
            "provider",
            f"通过 {provider} 执行",
            "pending",
            provider == "agent.task",
        ),
        WorkflowNode("verify", "verification", "在目标表面回读并生成回执", "pending", True),
    ])
    edges.extend([
        {"from": previous, "to": "execute"},
        {"from": "execute", "to": "verify"},
    ])
    return {
        "schemaVersion": 1,
        "entry": "ground",
        "terminal": "verify",
        "nodes": [node.to_dict() for node in nodes],
        "edges": edges,
        "durable": provider == "agent.task",
        "humanInTheLoop": permission == "confirm",
    }
