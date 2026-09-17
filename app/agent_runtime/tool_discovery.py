"""Compact, registry-owned tool directory and exact schema discovery."""
from __future__ import annotations

import json
import re
from collections.abc import Iterable

from app.agent_runtime.errors import ActionFailure, FailureType
from app.agent_runtime.tool_registry import FIND_CAPABILITY_TOOL, ToolRegistry, ToolSpec


def tool_directory(specs: Iterable[ToolSpec]) -> str:
    """Names and first sentences only; full parameters belong in API schemas."""
    rows = []
    for spec in specs:
        summary = re.split(r"[\n。]|(?<=\.)\s", spec.description.strip(), maxsplit=1)[0]
        rows.append(f"{spec.name}: {summary[:120]}")
    if not rows:
        return ""
    return "\n按需工具目录（先用 names 批量加载，再按完整参数调用）：\n" + "\n".join(rows)


def register_find_capability(registry: ToolRegistry, *, limit: int = 8) -> ToolSpec:
    """Discover exact batches or search when the tool name is unknown."""
    def execute(keyword: str = "", names: list[str] | None = None, scope: object = None) -> str:
        if names:
            matches = []
            missing = []
            for name in dict.fromkeys(names):
                try:
                    matches.append(registry.get(name))
                except KeyError:
                    missing.append(name)
            if missing:
                raise ActionFailure(FailureType.TOOL_ERROR, "Unknown tools: " + ", ".join(missing))
        elif keyword.strip():
            matches = registry.search(keyword, limit=limit)
        else:
            raise ActionFailure(FailureType.TOOL_ERROR, "Provide names or a search keyword.")
        return json.dumps({
            "tools": [{"name": spec.name} for spec in matches],
            "note": "完整参数将在下一轮工具列表提供；按 schema 调用，无需重复加载。",
        }, ensure_ascii=False)

    return registry.register(ToolSpec(
        name=FIND_CAPABILITY_TOOL,
        description=(
            "加载目录中的工具：优先用 names 一次选择本任务需要的多个精确名称，"
            "不知道名称时用 keyword 搜索。下一轮提供完整参数，不猜参数。"
        ),
        input_schema={
            "type": "object",
            "properties": {
                "names": {"type": "array", "items": {"type": "string"}, "minItems": 1, "maxItems": 16,
                          "description": "要加载的精确工具名，可一次加载同一工作流所需工具。"},
                "keyword": {"type": "string", "description": "不知道工具名时使用的搜索词。"},
            },
            "required": [],
        },
        execute=execute,
        is_concurrency_safe=True,
        used_backend="tool_registry_search",
        timeout_ms=5000,
        discovers_tools=True,
    ))
