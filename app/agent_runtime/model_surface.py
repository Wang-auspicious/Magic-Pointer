"""ModelSurface: the bounded view the model actually sees.

Law IV (cognitive offloading) and law III (active forgetting) meet here: the
model never reads a transcript. Every surface is derived — from the sealed
context packet, the surprise deltas that escalated, and the top-k assertions —
under an explicit budget. Truncation is never silent: a ``pruning`` section
reports exactly what was dropped and why, and the estimate is honest.

Pure and deterministic; the caller supplies the pieces, this module only
composes and enforces the budget.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Mapping

DEFAULT_MAX_CHARS = 6000
DEFAULT_MAX_NODES = 16
CJK_WEIGHT = 1.0          # 1 CJK char ≈ 1 token（保守估计）
ASCII_WEIGHT = 0.25       # 4 ASCII chars ≈ 1 token


def estimate_tokens(text: str) -> int:
    """Cheap, honest token estimate: CJK chars cost ~1 token, ASCII ~0.25."""
    cjk = sum(1 for ch in text if "\u4e00" <= ch <= "\u9fff")
    ascii_count = len(text) - cjk
    return int(cjk * CJK_WEIGHT + ascii_count * ASCII_WEIGHT)


@dataclass(frozen=True)
class SurfaceBudget:
    max_chars: int = DEFAULT_MAX_CHARS
    max_nodes: int = DEFAULT_MAX_NODES


@dataclass(frozen=True)
class SurfaceNode:
    id: str
    role: str
    name: str
    bbox: tuple[int, int, int, int]
    state: str = "enabled"
    coverage: float = 1.0
    depth: int = 0

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "role": self.role,
            "name": self.name[:16],
            "bbox": list(self.bbox),
            "state": self.state,
            "coverage": round(self.coverage, 2),
            "depth": self.depth,
        }


@dataclass(frozen=True)
class ModelSurface:
    sections: tuple[tuple[str, str], ...] = ()   # (title, body) in order
    nodes: tuple[SurfaceNode, ...] = ()
    pruned: tuple[str, ...] = ()                 # honest pruning ledger
    total_chars: int = 0
    estimated_tokens: int = 0

    def render(self) -> str:
        parts: list[str] = []
        for title, body in self.sections:
            parts.append(f"## {title}\n{body}")
        if self.nodes:
            lines = ["## 空间对象"]
            for node in self.nodes:
                lines.append(
                    f"- [{node.id}] {node.role} \"{node.name}\" bbox={list(node.bbox)}"
                    f" state={node.state} coverage={node.coverage:.2f}"
                )
            parts.append("\n".join(lines))
        if self.pruned:
            parts.append("## 剪枝\n" + "\n".join(f"- {p}" for p in self.pruned))
        return "\n\n".join(parts)


def prune_nodes(nodes: list[SurfaceNode], max_nodes: int) -> tuple[list[SurfaceNode], list[str]]:
    """Deterministic pruning order (HCI review §1.3): deep containers →
    low coverage → disabled. Every drop is recorded — silent truncation is a
    bug, the model must know what it does not see."""
    kept = list(nodes)
    pruned: list[str] = []

    def drop(predicate, reason: str) -> None:
        nonlocal kept
        removable = [n for n in kept if predicate(n)]
        removable.sort(key=lambda n: (n.depth, -n.coverage), reverse=True)
        while len(kept) > max_nodes and removable:
            victim = removable.pop()
            kept.remove(victim)
            pruned.append(f"丢弃 {victim.id} ({victim.role})：{reason}")

    if len(kept) > max_nodes:
        drop(lambda n: n.depth > 2, "深层装饰容器")
    if len(kept) > max_nodes:
        drop(lambda n: n.coverage < 0.3, "覆盖率过低")
    if len(kept) > max_nodes:
        drop(lambda n: n.state == "disabled", "禁用状态")
    if len(kept) > max_nodes:
        for victim in kept[max_nodes:]:
            pruned.append(f"丢弃 {victim.id} ({victim.role})：超出节点预算")
        kept = kept[:max_nodes]
    return kept, pruned


def build_model_surface(
    *,
    instruction: str,
    context_sections: list[tuple[str, str]],
    nodes: list[SurfaceNode],
    surprise_deltas: list[dict[str, Any]] | None = None,
    assertions: str = "",
    budget: SurfaceBudget | None = None,
) -> ModelSurface:
    """Compose the bounded view. Budget applies first to nodes, then to text —
    a long instruction is truncated with an explicit note (never silently)."""
    budget = budget or SurfaceBudget()
    kept, pruned = prune_nodes(nodes, budget.max_nodes)

    sections: list[tuple[str, str, bool]] = [(t, b, False) for t, b in context_sections]
    if surprise_deltas:
        deltas = "\n".join(
            f"- [{d.get('grade')}] {d.get('reason')}：{'；'.join(map(str, d.get('details', [])))}"
            for d in surprise_deltas
        )
        # 惊奇增量是唤醒模型的唯一理由，必须受保护：先于大块证据被截断。
        sections.append(("惊奇（与预测不符的环境变化）", deltas, True))
    if assertions.strip():
        sections.append(("已验证的断言记忆", assertions.strip(), True))

    total = sum(len(t) + len(b) for t, b, _ in sections) + sum(30 + len(n.name) for n in nodes)
    if total > budget.max_chars:
        # 文本超预算：只截断/丢弃未受保护的上下文节，保护节永不静默丢失。
        kept_sections: list[tuple[str, str, bool]] = []
        room = budget.max_chars - (len(instruction) + sum(30 + len(n.name) for n in kept) + 200)
        for title, body, protected in sections:
            if protected:
                kept_sections.append((title, body, True))
                room -= len(title) + len(body)
                continue
            if room <= 0:
                pruned.append(f"丢弃节 {title}：超出字符预算")
                continue
            kept_sections.append((title, body[:room], False))
            room -= len(body[:room])
        sections = kept_sections
        pruned.append(f"已截断：总预算 {budget.max_chars} 字符，超出部分丢弃")

    if len(instruction) > budget.max_chars:
        instruction = instruction[:budget.max_chars] + "\n（指令过长，已截断）"
    sections.insert(0, ("用户指令", instruction, True))

    final: tuple[tuple[str, str], ...] = tuple((t, b) for t, b, _ in sections)
    total_chars = sum(len(t) + len(b) for t, b in final)
    return ModelSurface(
        sections=final,
        nodes=tuple(kept),
        pruned=tuple(pruned),
        total_chars=total_chars,
        estimated_tokens=estimate_tokens("\n".join(t + b for t, b in final)),
    )
