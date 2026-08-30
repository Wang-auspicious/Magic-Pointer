"""Cross-session memory recall (Hermes session_search discovery shape).

The agent's own past sessions are durable memory — search them (bounded) so
"上次我们怎么修的" is one tool call instead of amnesia.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from app.agent_runtime.tool_registry import Effect, ToolRegistry, ToolSpec

__all__ = ["register_history_search"]


def register_history_search(registry: ToolRegistry, *, sessions_root: Path | str) -> None:
    # 旧名别名（一个版本）：历史授权/旧调用仍路由到规范工具；别名不进 schema。
    registry.register_alias("search_history", "Recall")
    from app.agent_runtime.coding_tools import WorkspaceSpace

    space = WorkspaceSpace(Path(sessions_root))

    def search_history(query: str, max_results: int = 8, **_: Any) -> str:
        from app.agent_runtime.coding_tools import _do_grep

        text = str(query or "").strip()
        if not text:
            raise ValueError("query is required")
        bounded = max(1, min(int(max_results or 8), 30))
        hits = _do_grep(space.root, text, "*.jsonl", bounded * 3)
        # 同一会话的同一事件在 JSONL 里逐行重复，按文件聚合到前 3 条，
        # 把结果位让给不同的会话（Hermes session_search 的聚合意图）。
        per_file: dict[str, int] = {}
        kept: list[str] = []
        for line in hits.splitlines():
            if not line or line.startswith("[results truncated"):
                kept.append(line)
                continue
            file_key = line.split(":", 1)[0]
            if per_file.get(file_key, 0) >= 3:
                continue
            per_file[file_key] = per_file.get(file_key, 0) + 1
            kept.append(line)
        return (
            "历史会话匹配（每会话最多 3 条；session 文件为 JSONL，"
            "每行一个事件；用更具体的关键词缩小范围）：\n" + "\n".join(kept)
        )

    registry.register(ToolSpec(
        name="Recall",
        description=(
            "搜索自己过去会话的记录（跨会话记忆）：找之前修过的问题、"
            "用过的命令、做过的决定。关键词尽量具体（函数名、报错文本）。"
        ),
        input_schema={
            "type": "object",
            "properties": {
                "query": {"type": "string"},
                "max_results": {"type": "integer", "description": "默认 8"},
            },
            "required": ["query"],
        },
        execute=search_history,
        effect=Effect.READ,
        is_concurrency_safe=True,
        used_backend="workspace_fs",
        timeout_ms=30_000,
        deferred=True,  # 跨会话记忆召回是低频动作
    ))
