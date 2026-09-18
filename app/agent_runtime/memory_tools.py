"""Cross-session memory recall (Hermes session_search discovery shape).

The agent's own past sessions are durable memory — search them (bounded) so
"上次我们怎么修的" is one tool call instead of amnesia.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from app.agent_runtime.tool_registry import Effect, ToolRegistry, ToolSpec

__all__ = ["register_history_search"]


def register_history_search(registry: ToolRegistry, *, sessions_root: Path | str) -> None:
    # 旧名别名（一个版本）：历史授权/旧调用仍路由到规范工具；别名不进 schema。
    registry.register_alias("search_history", "Recall")
    root = Path(sessions_root).resolve()

    def events(path):
        with path.open(encoding="utf-8") as stream:
            for line_number, line in enumerate(stream, 1):
                try:
                    event = json.loads(line)
                except ValueError:
                    continue  # An interrupted append may leave an unfinished tail.
                if not isinstance(event, dict):
                    continue
                body = json.dumps(event.get("data", event), ensure_ascii=False, separators=(",", ":"))
                yield event.get("seq", line_number), str(event.get("type", "event")), body

    def search_history(query: str = "", max_results: int = 8, session_id: str | None = None,
                       event_seq: int | None = None, offset: int = 0, max_chars: int = 4_000,
                       **_: Any) -> Any:
        if session_id is not None:
            path = (root / f"{session_id}.jsonl").resolve()
            if path.parent != root:
                raise ValueError("session_id must name a session in the history directory")
            for seq, kind, body in events(path):
                if seq != event_seq:
                    continue
                start = max(0, int(offset))
                end = start + max(1, min(8_000, int(max_chars)))
                return {"sessionId": session_id, "eventSeq": seq, "type": kind,
                        "content": body[start:end], "offset": start,
                        "nextOffset": end if end < len(body) else None, "totalChars": len(body)}
            raise ValueError("event_seq was not found in this session")
        text = str(query or "").strip()
        if not text:
            raise ValueError("query is required")
        bounded = max(1, min(int(max_results or 8), 30))
        kept: list[str] = []
        for path in sorted(root.glob("*.jsonl"), key=lambda p: p.stat().st_mtime_ns, reverse=True):
            count = 0
            for seq, kind, body in events(path):
                position = body.casefold().find(text.casefold())
                if position < 0 or kind == "model/request":
                    continue
                start = max(0, position - 200)
                excerpt = body[start:start + 700]
                kept.append(f"{path.name}:{seq}: [{kind}] {'…' if start else ''}{excerpt}")
                count += 1
                if count >= 3 or len(kept) >= bounded:
                    break
            if len(kept) >= bounded:
                break
        return (
            "历史会话匹配（每会话最多 3 条，显示命中附近的摘录；格式 文件:事件序号。"
            "用 Recall(session_id=不含.jsonl的文件名, event_seq=事件序号) 读取原文，"
            "按返回的 nextOffset 续读）：\n" + "\n".join(kept)
        )

    registry.register(ToolSpec(
        name="Recall",
        description=(
            "搜索自己过去会话的记录（跨会话记忆）：找之前修过的问题、"
            "用过的命令、做过的决定，包括压缩前的原始记录。query 为具体关键词；"
            "用 session_id 和 event_seq 可分页读取命中事件，无需工作区文件工具。"
        ),
        input_schema={
            "type": "object",
            "properties": {
                "query": {"type": "string"},
                "max_results": {"type": "integer", "description": "默认 8"},
                "session_id": {"type": "string"},
                "event_seq": {"type": "integer"},
                "offset": {"type": "integer", "minimum": 0},
                "max_chars": {"type": "integer", "minimum": 1, "maximum": 8000},
            },
            "required": [],
        },
        execute=search_history,
        effect=Effect.READ,
        is_concurrency_safe=True,
        used_backend="workspace_fs",
        timeout_ms=30_000,
        deferred=True,  # 跨会话记忆召回是低频动作
    ))
