"""Model-facing tools for task-scoped source discovery and reading."""

from __future__ import annotations

import json
import time
from typing import Any, Iterable

from app.agent_runtime.errors import ActionFailure, FailureType
from app.agent_runtime.tool_registry import Effect, ToolRegistry, ToolSpec
from app.artifacts.document_patch import DocumentPatch

from .source_scope import AccessRequest
from .source_store import (
    apply_reference_updates,
    reference_revision,
    register_source,
    resolve_source,
    task_references,
    task_sources,
)
from .sources import (
    FragmentLocator,
    ReferenceBinding,
    ReferenceUpdate,
    SourceReaderRegistry,
)


def _object_schema(
    properties: dict[str, dict[str, Any]],
    required: Iterable[str],
) -> dict[str, Any]:
    return {"type": "object", "properties": properties, "required": list(required)}


def _locator_key(source_id: str, locator: FragmentLocator) -> str:
    return f"{source_id}:{json.dumps(locator.to_dict(), ensure_ascii=False, sort_keys=True)}"


def _tool_failure(message: str) -> ActionFailure:
    return ActionFailure(FailureType.PERMISSION_DENIED, message)


def register_context_tools(
    registry: ToolRegistry,
    *,
    session: Any = None,
    session_getter: Any = None,
    readers: SourceReaderRegistry,
    knowledge_catalog: Any = None,
    daily_wrap_catalog: Any = None,
) -> None:
    if knowledge_catalog is None:
        from .knowledge import KnowledgeCatalog

        knowledge_catalog = KnowledgeCatalog()
    if daily_wrap_catalog is None:
        from .daily_wrap import ConversationEventCatalog

        daily_wrap_catalog = ConversationEventCatalog()
    observed: set[str] = set()

    def current_session() -> Any:
        value = session_getter() if callable(session_getter) else session
        if value is None:
            raise RuntimeError("task source session is not ready")
        return value

    def sources_by_id() -> dict[str, Any]:
        active = current_session()
        return {source.source_id: source for source in task_sources(active.events)}

    def requested_source_ids(args: dict[str, object]) -> tuple[str, ...]:
        raw = args.get("source_ids")
        if isinstance(raw, list) and raw:
            return tuple(str(item) for item in raw)
        return tuple(sources_by_id())

    def list_execute(scope: object = None) -> dict[str, Any]:
        active = current_session()
        return {
            "taskId": active.id,
            "sources": [source.to_model_dict() for source in task_sources(active.events)],
            "references": [
                binding.to_model_dict() for binding in task_references(active.events)
                if binding.active
            ],
            "referenceRevision": reference_revision(active.events),
        }

    def read_execute(
        source_id: str,
        locator: dict[str, Any] | None = None,
        cursor: str | None = None,
        limit: int = 8,
        scope: object = None,
    ) -> dict[str, Any]:
        active = current_session()
        source = resolve_source(active.events, str(source_id))
        parsed_locator = FragmentLocator.from_dict(locator) if locator else None
        result = readers.for_source(source).read(
            source,
            parsed_locator,
            str(cursor) if cursor else None,
            max(1, min(int(limit), 100)),
        )
        if result.source_id != source.source_id:
            raise ValueError("reader returned a result for another source")
        for fragment in result.fragments:
            observed.add(_locator_key(source.source_id, fragment.locator))
        return result.to_dict()

    def search_execute(
        query: str,
        source_ids: list[str] | None = None,
        cursor: str | None = None,
        limit: int = 8,
        scope: object = None,
    ) -> dict[str, Any]:
        active = current_session()
        ids = tuple(source_ids or sources_by_id())
        results: list[dict[str, Any]] = []
        for source_id in ids:
            source = resolve_source(active.events, str(source_id))
            result = readers.for_source(source).search(
                source,
                str(query),
                str(cursor) if cursor else None,
                max(1, min(int(limit), 100)),
            )
            if result.source_id != source.source_id:
                raise ValueError("reader returned a result for another source")
            for fragment in result.fragments:
                observed.add(_locator_key(source.source_id, fragment.locator))
            results.append(result.to_dict())
        return {"query": str(query), "results": results}

    def follow_execute(
        source_id: str,
        fragment_id: str,
        scope: object = None,
    ) -> dict[str, Any]:
        active = current_session()
        source = resolve_source(active.events, str(source_id))
        discovered = readers.for_source(source).follow(source, str(fragment_id))
        known = sources_by_id()
        accepted = []
        for child in discovered:
            if child.task_id != active.id or child.parent_source_id != source.source_id:
                raise ValueError("followed source must be a child of the requested task source")
            current = known.get(child.source_id)
            if current is None:
                register_source(active, child)
                known[child.source_id] = child
            elif current != child:
                raise ValueError("followed source identity changed")
            accepted.append(child.to_model_dict())
        return {"sourceId": source.source_id, "sources": accepted}

    def bind_execute(
        reference_id: str,
        role: str,
        source_id: str,
        locator: dict[str, Any],
        reason: str,
        scope: object = None,
    ) -> dict[str, Any]:
        active = current_session()
        source = resolve_source(active.events, str(source_id))
        parsed_locator = FragmentLocator.from_dict(locator)
        if _locator_key(source.source_id, parsed_locator) not in observed:
            raise _tool_failure(
                "Context.bind may only use a source locator returned by Context.read/search"
            )
        current = {
            binding.reference_id: binding for binding in task_references(active.events)
        }.get(str(reference_id))
        ordinal = current.ordinal if current else max(
            (binding.ordinal for binding in task_references(active.events)),
            default=0,
        ) + 1
        binding = ReferenceBinding(
            reference_id=str(reference_id),
            label=current.label if current else chr(ord("A") + min(ordinal - 1, 25)),
            source_id=source.source_id,
            locator=parsed_locator,
            role=str(role),
            frame_lease_id=current.frame_lease_id if current else None,
            captured_at_ms=current.captured_at_ms if current else int(time.time() * 1000),
            ordinal=ordinal,
            active=True,
        )
        update = ReferenceUpdate("correct" if current else "add", binding)
        apply_reference_updates(active, (update,))
        return {
            "reference": binding.to_model_dict(),
            "reason": str(reason),
            "referenceRevision": reference_revision(active.events),
        }

    def propose_patch_execute(
        patch_id: str,
        summary: str,
        references: list[dict[str, Any]],
        operations: list[dict[str, Any]],
        scope: object = None,
    ) -> dict[str, Any]:
        active = current_session()
        known_sources = sources_by_id()
        active_references = {
            item.reference_id: item
            for item in task_references(active.events)
            if item.active
        }
        candidate = DocumentPatch.from_dict({
            "patchId": str(patch_id),
            "artifactId": "pending-artifact",
            "artifactRevision": 1,
            "references": references,
            "operations": operations,
        })
        for reference in candidate.references:
            current = active_references.get(reference.reference_id)
            if current is None:
                raise ValueError(
                    f"document patch reference is not active: {reference.reference_id}"
                )
            if (
                current.source_id != reference.source_id
                or current.locator != reference.locator
                or current.role != reference.role
            ):
                raise ValueError(
                    f"document patch reference differs from current task binding: {reference.reference_id}"
                )
            source = known_sources.get(reference.source_id)
            if source is None or "patch" not in source.capabilities:
                raise ValueError(
                    f"document source does not advertise patch capability: {reference.source_id}"
                )
        event = active.record_artifact_generated(
            str(summary),
            kind="document_patch",
            patch_payload={
                "patchId": candidate.patch_id,
                "references": [item.to_dict() for item in candidate.references],
                "operations": [item.to_dict() for item in candidate.operations],
            },
        )
        patch = DocumentPatch.from_dict(event.data["patchPayload"])
        return {
            "artifactId": str(event.data["artifactId"]),
            "revision": int(event.data["revision"]),
            "kind": "document_patch",
            "preview": patch.preview(),
            "requiresUserAcceptance": True,
        }

    def patch_source_ids(args: dict[str, object]) -> tuple[str, ...]:
        raw = args.get("references")
        if not isinstance(raw, list):
            return ()
        return tuple(dict.fromkeys(
            str(item.get("sourceId") or "")
            for item in raw
            if isinstance(item, dict) and str(item.get("sourceId") or "").strip()
        ))

    def knowledge_search_execute(
        query: str = "",
        category: str | None = None,
        limit: int = 20,
        scope: object = None,
    ) -> dict[str, Any]:
        entries = knowledge_catalog.search(
            str(query or ""),
            category=str(category) if category else None,
            limit=max(1, min(int(limit), 100)),
        )
        return {
            "query": str(query or ""),
            "entries": [entry.to_dict() for entry in entries],
            "count": len(entries),
            "usedBackend": "stash.index.linear",
        }

    def knowledge_add_execute(
        entry_id: str,
        scope: object = None,
    ) -> dict[str, Any]:
        active = current_session()
        resolution = knowledge_catalog.resolve(str(entry_id), task_id=active.id)
        if not resolution.available:
            raise ActionFailure(
                FailureType.TOOL_ERROR,
                f"knowledge source unavailable: {resolution.unavailable_reason}",
            )
        known = sources_by_id().get(resolution.source.source_id)
        if known is None:
            register_source(active, resolution.source)
        elif known != resolution.source:
            raise ActionFailure(
                FailureType.CONTENT_CHANGED,
                "knowledge source identity changed; locate it again",
            )
        return resolution.to_dict()

    def daily_wrap_execute(
        from_ms: int,
        to_ms: int,
        conversation_ids: list[str] | None = None,
        limit: int = 200,
        scope: object = None,
    ) -> dict[str, Any]:
        return daily_wrap_catalog.summaries(
            from_ms=int(from_ms),
            to_ms=int(to_ms),
            conversation_ids=conversation_ids,
            limit=max(1, min(int(limit), 500)),
        )

    registry.register(ToolSpec(
        name="Context.list",
        description="列出当前任务已经加入的材料、引用角色和可继续读取的 sourceId。",
        input_schema=_object_schema({}, ()),
        execute=list_execute,
        effect=Effect.READ,
        is_concurrency_safe=True,
        used_backend="event_session.context",
    ))
    registry.register(ToolSpec(
        name="Context.read",
        description="按 sourceId 和可选局部 locator 读取当前任务材料；聊天来源从目标消息读取语义邻域，结果保留 locator、coverage 与 backend。",
        input_schema=_object_schema({
            "source_id": {"type": "string"},
            "locator": {"type": "object"},
            "cursor": {"type": "string"},
            "limit": {"type": "integer", "minimum": 1, "maximum": 100},
        }, ("source_id",)),
        execute=read_execute,
        effect=Effect.READ,
        is_concurrency_safe=True,
        used_backend="task_source.reader",
        access_for=lambda args: AccessRequest(
            action="read", source_ids=(str(args.get("source_id") or ""),),
        ),
    ))
    registry.register(ToolSpec(
        name="Context.search",
        description="在当前任务材料中搜索；聊天来源检索已绑定会话历史，每项结果返回 sourceId、locator、coverage 和引用信息。",
        input_schema=_object_schema({
            "query": {"type": "string"},
            "source_ids": {"type": "array", "items": {"type": "string"}},
            "cursor": {"type": "string"},
            "limit": {"type": "integer", "minimum": 1, "maximum": 100},
        }, ("query",)),
        execute=search_execute,
        effect=Effect.READ,
        is_concurrency_safe=True,
        used_backend="task_source.search",
        access_for=lambda args: AccessRequest(
            action="read", source_ids=requested_source_ids(args),
        ),
    ))
    registry.register(ToolSpec(
        name="Context.follow",
        description="沿消息回复、聊天附件或文档关系发现派生材料；附件版本保留独立身份，新来源必须追溯到已有 sourceId。",
        input_schema=_object_schema({
            "source_id": {"type": "string"},
            "fragment_id": {"type": "string"},
        }, ("source_id", "fragment_id")),
        execute=follow_execute,
        effect=Effect.READ,
        used_backend="task_source.follow",
        deferred=True,
        access_for=lambda args: AccessRequest(
            action="read", source_ids=(str(args.get("source_id") or ""),),
        ),
    ))
    registry.register(ToolSpec(
        name="Context.bind",
        description="把已读取的 source/locator 绑定为任务引用角色；不能加入新来源或扩大授权。",
        input_schema=_object_schema({
            "reference_id": {"type": "string"},
            "role": {
                "type": "string",
                "enum": ["target", "source", "reference", "exclude", "unresolved"],
            },
            "source_id": {"type": "string"},
            "locator": {"type": "object"},
            "reason": {"type": "string"},
        }, ("reference_id", "role", "source_id", "locator", "reason")),
        execute=bind_execute,
        effect=Effect.READ,
        used_backend="event_session.context",
        deferred=True,
        access_for=lambda args: AccessRequest(
            action="read", source_ids=(str(args.get("source_id") or ""),),
        ),
    ))
    registry.register(ToolSpec(
        name="Knowledge.search",
        description=(
            "仅当用户要求使用其显式收藏时，按关键词和可选分类搜索本地材料索引。"
            "结果只给摘要与来源入口；要读原文先用 Knowledge.add_to_task 加入当前任务。"
        ),
        input_schema=_object_schema({
            "query": {"type": "string"},
            "category": {"type": "string"},
            "limit": {"type": "integer", "minimum": 1, "maximum": 100},
        }, ("query",)),
        execute=knowledge_search_execute,
        effect=Effect.READ,
        is_concurrency_safe=True,
        used_backend="stash.index.linear",
    ))
    registry.register(ToolSpec(
        name="Knowledge.add_to_task",
        description=(
            "把用户从显式收藏搜索结果中选定的一项加入当前任务材料，返回 sourceId 和原始 locator。"
            "删除或丢失的收藏会明确失败，不能继续使用旧摘要。"
        ),
        input_schema=_object_schema({
            "entry_id": {"type": "string"},
        }, ("entry_id",)),
        execute=knowledge_add_execute,
        effect=Effect.READ,
        used_backend="stash.index.linear",
    ))
    registry.register(ToolSpec(
        name="DailyWrap.read",
        description=(
            "读取用户明确选择的时间范围和任务集合内真实记录的问答、工具事件、回执与产物。"
            "空范围会返回没有材料；不得据此补造全天工作或窗口停留时长。"
        ),
        input_schema=_object_schema({
            "from_ms": {"type": "integer", "minimum": 0},
            "to_ms": {"type": "integer", "minimum": 0},
            "conversation_ids": {"type": "array", "items": {"type": "string"}},
            "limit": {"type": "integer", "minimum": 1, "maximum": 500},
        }, ("from_ms", "to_ms")),
        execute=daily_wrap_execute,
        effect=Effect.READ,
        is_concurrency_safe=True,
        used_backend="conversation_store.events",
    ))
    registry.register(ToolSpec(
        name="Document.propose_patch",
        description=(
            "为当前任务中已经绑定的 target 引用创建可编辑的结构化文档修改草稿。"
            "只生成预览，不写文件；每个 operation 必须带明确 sourceId、locator、before、after，"
            "用户接受同一 revision 后才可应用。"
        ),
        input_schema=_object_schema({
            "patch_id": {"type": "string"},
            "summary": {"type": "string"},
            "references": {"type": "array", "items": {"type": "object"}},
            "operations": {"type": "array", "items": {"type": "object"}},
        }, ("patch_id", "summary", "references", "operations")),
        execute=propose_patch_execute,
        effect=Effect.READ,
        used_backend="event_session.document_patch",
        resource_keys=("draft-artifacts",),
        access_for=lambda args: AccessRequest(
            action="read", source_ids=patch_source_ids(args),
        ),
    ))


__all__ = ["register_context_tools"]
