"""Capability tools: capabilities as real, self-describing tools (model-as-router).

Review answer Q2/Q5 (2026-08-13): the higher-leverage move over deferred
loading is **merging** same-verb recipe variants into a small set of
orthogonal tools with enum parameters ("少量正交工具 + 丰富参数"), and
**killing the dual-track schema**: the argument schema is a behaviour
contract and lives here in code as the single source of truth; the recipe
manifest keeps only data-shaped metadata (titles, keywords, risk) used for
display, search and the propose/plan path.

The old ``recipe_tool_schemas`` offered every recipe with a fake single
``{"instruction": "string"}`` parameter and let a keyword table decide which
recipe ran. This module replaces that with the Claude Code pattern: each
tool has its own real input schema, an honest description of what it does,
and a READ effect — calling it only **proposes** a plan through the normal
plan/confirm/receipt path. Nothing here classifies intents.

In-loop reversible execution (review Q1): when the caller passes
``execute_plan`` and flips ``inloop_reversible`` on, recipes whose manifest
risk is ``local_write`` are registered with ``REVERSIBLE_WRITE`` effect plus the guard
preconditions (exact / focused / content unchanged), and their ``execute``
runs plan+execute and returns the receipt. Irreversible recipes
(external_send / destructive / purchase) always stay propose-only. When
``execute_plan`` is missing the tool degrades to propose — fail-safe, never
execute. The production default keeps ``inloop_reversible`` off until the
guard chain passes real-machine verification.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any

from app.action_guard.preconditions import (
    ContentUnchanged,
    ResolvedExact,
    TargetFocused,
)
from app.agent_runtime.tool_registry import (
    FIND_CAPABILITY_TOOL,
    Effect,
    ToolRegistry,
    ToolSpec,
)
from app.fabric.catalog import get_recipe
from app.fabric.intent_router import is_non_destination_recipe
from app.fabric.receipt_verification import verify_action_receipt

__all__ = [
    "CAPABILITY_TOOLS",
    "register_capability_tools",
    "register_find_capability",
    "recipe_ids_for_tool",
]

ProposeFn = Callable[[str, dict[str, Any]], dict[str, Any]]
ExecutePlanFn = Callable[[str, dict[str, Any]], dict[str, Any]]

_EMPTY_SCHEMA: dict[str, Any] = {"type": "object", "properties": {}, "required": []}


def _enum(choices: list[str], description: str) -> dict[str, Any]:
    return {"type": "string", "enum": choices, "description": description}


def _text(description: str) -> dict[str, Any]:
    return {"type": "string", "description": description}


def _object_schema(
    required: list[str],
    properties: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    return {"type": "object", "properties": properties, "required": required}

# ---------------------------------------------------------------------------
# Single source of truth: tool -> schema + dispatch (recipe id per operation).
# The manifest (data/recipes/builtin.recipes.json) supplies titles,
# descriptions and risk; this table supplies the behaviour contract.
# ---------------------------------------------------------------------------

CAPABILITY_TOOLS: list[dict[str, Any]] = [
    {
        "name": "text_transform",
        "description": (
            "对圈选文本做加工并生成执行方案（等待确认后执行）：翻译、改写、"
            "总结、压缩、扩写、转公式、清理 OCR 噪声；coverage=screen 时翻译整屏。"
        ),
        "schema": _object_schema(
            required=["operation"],
            properties={
                "operation": _enum(
                    ["translate", "rewrite", "summarize", "condense", "expand",
                     "latex", "clean"],
                    "加工类型",
                ),
                "language": _text("目标语言，如 英文/中文（translate 用）"),
                "style": _text("改写风格，如 更正式/更简洁（rewrite 用）"),
                "length": _text("目标长度说明，如 一半/两倍/100字（condense/expand 用）"),
                "destination": _text("总结写入哪里，如 邮件/笔记；留空则直接回答（summarize 用）"),
                "coverage": _enum(["selection", "screen"], "作用范围，默认 selection"),
            },
        ),
        "dispatch": {
            "translate": ("text.translate_in_place", ("language",)),
            "rewrite": ("text.rewrite_in_place", ("style",)),
            "summarize": ("text.summarize_route", ("destination",)),
            "condense": ("selection.condense", ("length",)),
            "expand": ("selection.expand", ("length",)),
            "latex": ("formula.to_latex", ()),
            "clean": ("text.ocr_clean", ()),
        },
        "scope_dispatch": {"screen": "screen.translate"},
    },
    {
        "name": "clipboard_text",
        "description": (
            "剪贴板能力：把圈选对象的结构化文本复制到剪贴板，或读取剪贴板历史。"
        ),
        "schema": _object_schema(
            required=["operation"],
            properties={
                "operation": _enum(["copy", "history"], "复制到剪贴板 / 读剪贴板历史"),
            },
        ),
        "dispatch": {
            "copy": ("text.ocr_copy", ()),
            "history": ("clipboard.history", ()),
        },
    },
    {
        "name": "data_export",
        "description": (
            "把圈选的表格或图表数据导出为文件（生成方案，等待确认后执行）："
            "表格可导出 xlsx/csv，图表提取为 csv 数据。"
        ),
        "schema": _object_schema(
            required=["source"],
            properties={
                "source": _enum(["table", "chart"], "数据来源：表格 / 图表"),
                "format": _enum(["xlsx", "csv"], "导出格式（table 用，默认 xlsx）"),
            },
        ),
        "dispatch": {
            "table": ("table.to_spreadsheet", ("format",)),
            "chart": ("chart.extract_data", ()),
        },
    },
    {
        "name": "image_ops",
        "description": (
            "对圈选图片做处理并生成方案（等待确认后执行）：编辑对象、多图合成、"
            "风格迁移、图片转提示词。"
        ),
        "schema": _object_schema(
            required=["operation"],
            properties={
                "operation": _enum(
                    ["edit_object", "compose", "style_transfer", "to_prompt"],
                    "图片操作类型",
                ),
                "instruction": _text("操作描述，如 移除背景中的杯子/加蓝天"),
            },
        ),
        "dispatch": {
            "edit_object": ("image.edit_object", ("instruction",)),
            "compose": ("image.compose", ("instruction",)),
            "style_transfer": ("image.style_transfer", ("instruction",)),
            "to_prompt": ("image.to_prompt", ()),
        },
    },
    {
        "name": "screen_help",
        "description": (
            "圈选相关的一键帮助：回忆屏幕内容（刚才看到什么）、操作指导、"
            "或读取记忆文件里的相关信息。只读，直接回答。"
        ),
        "schema": _object_schema(
            required=["operation"],
            properties={
                "operation": _enum(["recall", "coach", "memory"], "帮助类型"),
            },
        ),
        "dispatch": {
            "recall": ("screen.recall", ()),
            "coach": ("pointer.coach", ()),
            "memory": ("memory.recall", ()),
        },
    },
    {
        "name": "task_route",
        "description": (
            "把圈选内容变成外部任务（生成方案，等待确认后执行）：实体快捷操作、"
            "加入待办/任务系统、或交给后台 Agent 长任务。"
        ),
        "schema": _object_schema(
            required=["operation"],
            properties={
                "operation": _enum(
                    ["quick_action", "todo", "background_agent"], "任务去向"
                ),
                "instruction": _text("任务内容描述"),
            },
        ),
        "dispatch": {
            "quick_action": ("entity.quick_action", ("instruction",)),
            "todo": ("task.route", ("instruction",)),
            "background_agent": ("agent.background_task", ("instruction",)),
        },
    },
    {
        "name": "place_route",
        "description": (
            "把圈选内容投递到外部应用（生成方案，等待确认后执行）：地图路线、"
            "日历事件、视频点位操作。"
        ),
        "schema": _object_schema(
            required=["target"],
            properties={
                "target": _enum(["map", "calendar", "video"], "目标应用"),
                "text": _text("目的地 / 事件标题 / 操作描述"),
            },
        ),
        "dispatch": {
            "map": ("map.route", ("text",)),
            "calendar": ("calendar.create_from_screen", ("text",)),
            "video": ("video.place_action", ("text",)),
        },
    },
]

# Individual tools (distinct verbs; no merge candidates): recipe id only.
_INDIVIDUAL_RECIPES: dict[str, dict[str, Any]] = {
    "table_merge": {"recipe": "table.merge", "description": "合并多张表格为一个文件（生成方案，等待确认后执行）。"},
    "compare_objects": {
        "recipe": "objects.compare",
        "description": "对比多个圈选对象并生成方案（等待确认后执行）。",
        "schema": _object_schema([], {"aspect": _text("对比维度，如 价格/内容")}),
    },
    "research_card": {
        "recipe": "research.evidence_card",
        "description": "把圈选内容做成带来源的证据卡（生成方案，等待确认后执行）。",
    },
    "recipe_scale": {
        "recipe": "recipe.scale_and_route",
        "description": "把圈选内容按模板扩展成结构化列表并路由（生成方案，等待确认后执行）。",
    },
    "canvas_transform": {
        "recipe": "canvas.transform",
        "description": "对画布做变换操作（生成方案，等待确认后执行）。",
    },
    "vision_bridge": {
        "recipe": "vision.prompt_bridge",
        "description": "把圈选视觉上下文打包给视觉模型使用（生成方案，等待确认后执行）。",
    },
    "voice_command": {
        "recipe": "voice.short_command",
        "description": "把圈选内容转成语音短命令（只读，直接回答）。",
    },
    "mcp_integration": {
        "recipe": "integration.mcp",
        "description": "通过 MCP 集成外部能力（只读，直接回答）。",
    },
    "dashboard_govern": {
        "recipe": "governance.dashboard",
        "description": "圈选内容治理仪表盘设置（生成方案，等待确认后执行）。",
    },
    "element_pick": {
        "recipe": "element.pick",
        "description": "把圈选像素区域定位为可操作的界面元素（只读，直接回答）。",
    },
    "agent_handoff": {
        "recipe": "agent.handoff",
        "description": "把圈选任务编译成提示词交给外部 Agent（codex/claude/pi 等；生成方案，等待确认后执行）。",
        "schema": _object_schema([], {"agent": _text("交给哪个 Agent，如 codex/claude")}),
    },
}

_INLOOP_PRECONDITIONS = (ResolvedExact(), TargetFocused(), ContentUnchanged())


def recipe_ids_for_tool(tool_name: str) -> list[str]:
    """All recipe ids reachable through one tool (audit/ledger use)."""
    ids: list[str] = []
    for tool in CAPABILITY_TOOLS:
        if tool["name"] != tool_name:
            continue
        for recipe_id, _params in tool["dispatch"].values():
            ids.append(recipe_id)
        ids.extend(tool.get("scope_dispatch", {}).values())
    if tool_name in _INDIVIDUAL_RECIPES:
        ids.append(_INDIVIDUAL_RECIPES[tool_name]["recipe"])
    return ids


def _resolve_recipe(tool: dict[str, Any], args: dict[str, Any]) -> str | None:
    """Operation/enum values -> recipe id; None when the call is ambiguous."""
    coverage = str(args.get("coverage") or "selection")
    dispatch: dict[str, Any] = tool["dispatch"]
    scope_dispatch: dict[str, str] = tool.get("scope_dispatch", {})
    for key in ("operation", "source", "target"):
        value = args.get(key)
        if value in dispatch:
            if key == "operation" and value == "translate" and coverage == "screen":
                return scope_dispatch.get("screen")
            return dispatch[value][0]
    return None


def _map_args(tool: dict[str, Any], args: dict[str, Any]) -> dict[str, Any]:
    """Copy declared params (per the dispatch tuple) into the recipe args."""
    recipe_id = _resolve_recipe(tool, args)
    if recipe_id is None:
        return dict(args)
    keep: set[str] = set()
    for _name, params in tool["dispatch"].values():
        keep.update(params)
    keep.update({"coverage"})
    mapped = {key: value for key, value in args.items() if key in keep}
    return mapped


def _merged_tool_spec(
    tool: dict[str, Any],
    propose: ProposeFn,
    *,
    execute_plan: ExecutePlanFn | None,
    inloop_reversible: bool,
) -> ToolSpec:
    name = str(tool["name"])
    reachable = recipe_ids_for_tool(name)
    write_inloop = (
        inloop_reversible
        and execute_plan is not None
        and any(
            _recipe_risk_is_local_write(recipe_id) for recipe_id in reachable
        )
    )

    def execute(scope: object = None, **args: Any) -> str:
        recipe_id = _resolve_recipe(tool, dict(args))
        if recipe_id is None:
            return json.dumps({
                "ok": False,
                "error": "unknown_operation",
                "hint": "请检查 operation/source/target 参数的可选值",
            }, ensure_ascii=False)
        mapped = _map_args(tool, dict(args))
        if write_inloop and _recipe_risk_is_local_write(recipe_id):
            return json.dumps(
                execute_plan(recipe_id, mapped), ensure_ascii=False
            )
        return json.dumps(propose(recipe_id, mapped), ensure_ascii=False)

    return ToolSpec(
        name=name,
        description=str(tool["description"]),
        input_schema=dict(tool["schema"]),
        execute=execute,
        effect=Effect.REVERSIBLE_WRITE if write_inloop else Effect.READ,
        preconditions=_INLOOP_PRECONDITIONS if write_inloop else (),
        is_concurrency_safe=False if write_inloop else True,
        used_backend=(
            "fabric.plan_execute_inloop" if write_inloop else "fabric.plan_proposal"
        ),
        timeout_ms=30000,
        verify_result=verify_action_receipt if write_inloop else None,
    )


def _recipe_risk_is_local_write(recipe_id: str) -> bool:
    try:
        return get_recipe(recipe_id).risk.value == "local_write"
    except KeyError:
        return False


def _individual_tool_spec(
    tool_name: str,
    entry: dict[str, Any],
    propose: ProposeFn,
    *,
    execute_plan: ExecutePlanFn | None,
    inloop_reversible: bool,
) -> ToolSpec:
    recipe_id = str(entry["recipe"])
    schema = entry.get("schema", _EMPTY_SCHEMA)
    try:
        recipe = get_recipe(recipe_id)
        risk = recipe.risk.value
    except KeyError:
        risk = "read"
    write_inloop = (
        inloop_reversible
        and execute_plan is not None
        and risk == "local_write"
    )

    def execute(scope: object = None, **args: Any) -> str:
        if write_inloop:
            return json.dumps(
                execute_plan(recipe_id, dict(args)), ensure_ascii=False
            )
        return json.dumps(propose(recipe_id, dict(args)), ensure_ascii=False)

    return ToolSpec(
        name=tool_name,
        description=str(entry["description"]),
        input_schema=dict(schema),
        execute=execute,
        effect=Effect.REVERSIBLE_WRITE if write_inloop else Effect.READ,
        preconditions=_INLOOP_PRECONDITIONS if write_inloop else (),
        is_concurrency_safe=False if write_inloop else True,
        used_backend=(
            "fabric.plan_execute_inloop" if write_inloop else "fabric.plan_proposal"
        ),
        timeout_ms=30000,
        verify_result=verify_action_receipt if write_inloop else None,
    )


def _merged_effect(recipe_ids: list[str], *, inloop: bool) -> Effect:
    if not inloop:
        return Effect.READ
    for recipe_id in recipe_ids:
        try:
            if get_recipe(recipe_id).risk.value == "local_write":
                return Effect.REVERSIBLE_WRITE
        except KeyError:
            continue
    return Effect.READ


def register_capability_tools(
    registry: ToolRegistry,
    propose: ProposeFn,
    *,
    enabled_recipes: set[str] | None = None,
    execute_plan: ExecutePlanFn | None = None,
    inloop_reversible: bool = False,
) -> int:
    """Register the merged + individual capability tool set; returns the count.

    ``enabled_recipes`` filters recipes out of the dispatch tables (the
    tool disappears when every recipe it reaches is disabled). With
    ``execute_plan`` and ``inloop_reversible``, local-write capabilities
    execute in-loop under the guard preconditions; irreversible recipes
    always stay propose-only.
    """
    registered = 0
    for tool in CAPABILITY_TOOLS:
        reachable = recipe_ids_for_tool(str(tool["name"]))
        if enabled_recipes is not None and reachable and not any(
            recipe_id in enabled_recipes for recipe_id in reachable
        ):
            continue
        registry.register(
            _merged_tool_spec(
                tool,
                propose,
                execute_plan=execute_plan,
                inloop_reversible=inloop_reversible,
            )
        )
        registered += 1
    for tool_name, entry in _INDIVIDUAL_RECIPES.items():
        recipe_id = str(entry["recipe"])
        if enabled_recipes is not None and recipe_id not in enabled_recipes:
            continue
        try:
            recipe = get_recipe(recipe_id)
        except KeyError:
            continue
        if is_non_destination_recipe(recipe):
            continue
        registry.register(
            _individual_tool_spec(
                tool_name,
                entry,
                propose,
                execute_plan=execute_plan,
                inloop_reversible=inloop_reversible,
            )
        )
        registered += 1
    return registered


def register_find_capability(registry: ToolRegistry, *, limit: int = 8) -> ToolSpec:
    """Register the capability search tool (CC ToolSearch pattern).

    Tools beyond the loop's ``tool_limit`` are invisible to the model; this
    tool searches the full registry by keyword and the loop loads the
    discovered tools into the next round's schemas. Registered last so the
    search index sees every capability.
    """

    def execute(keyword: str, scope: object = None) -> str:
        matches = registry.search(keyword, limit=limit)
        return json.dumps({
            "keyword": keyword,
            "tools": [
                {
                    "name": spec.name,
                    "description": spec.description,
                    "parameters": spec.input_schema,
                }
                for spec in matches
            ],
            "note": (
                "发现的能力会在下一轮加入可用工具列表，之后可以直接调用。"
            ),
        }, ensure_ascii=False)

    return registry.register(ToolSpec(
        name=FIND_CAPABILITY_TOOL,
        description=(
            "在全部能力里按关键词搜索工具。默认没有加载的能力（翻译/表格/发送等）"
            "也能搜到；搜到的能力下一轮就可以直接调用。"
        ),
        input_schema={
            "type": "object",
            "properties": {
                "keyword": {
                    "type": "string",
                    "description": "搜索词，如 翻译/表格/发送/日历",
                },
            },
            "required": ["keyword"],
        },
        execute=execute,
        effect=Effect.READ,
        is_concurrency_safe=True,
        used_backend="tool_registry_search",
        timeout_ms=5000,
        discovers_tools=True,
    ))
