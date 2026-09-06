"""EventSession-backed projection for task sources and persistent references."""

from __future__ import annotations

from dataclasses import replace
from typing import Any, Iterable, Mapping, Protocol

from .sources import ReferenceBinding, ReferenceUpdate, SourceRef


class _AppendSession(Protocol):
    id: str
    events: tuple[Any, ...]

    def append(self, event_type: str, data: Mapping[str, Any], **kwargs: Any) -> Any: ...


def _event_parts(event: Any) -> tuple[str, Mapping[str, Any]]:
    if isinstance(event, Mapping):
        return str(event.get("type") or ""), dict(event.get("data") or {})
    return str(getattr(event, "type", "") or ""), dict(getattr(event, "data", {}) or {})


def _context_events(events: Iterable[Any]):
    for event in events:
        event_type, data = _event_parts(event)
        if event_type == "context/updated":
            yield data
        elif event_type == "inbox/consumed" and isinstance(data.get("contextUpdate"), Mapping):
            # Claiming TaskInput is one durable event: its model-surface data
            # messages and reference projection become visible together.
            yield dict(data["contextUpdate"])


def task_sources(events: Iterable[Any]) -> tuple[SourceRef, ...]:
    ordered: dict[str, SourceRef] = {}
    task_id: str | None = None
    for data in _context_events(events):
        event_task = str(data.get("taskId") or "")
        if task_id is None:
            task_id = event_task
        elif event_task != task_id:
            raise ValueError("context events contain more than one taskId")
        for raw in data.get("sources") or []:
            source = SourceRef.from_dict(raw)
            if source.task_id != event_task:
                raise ValueError("source taskId differs from context taskId")
            ordered[source.source_id] = source
    return tuple(ordered.values())


def _apply_update(
    projected: dict[str, ReferenceBinding],
    update: ReferenceUpdate,
) -> None:
    binding = update.binding
    current = projected.get(binding.reference_id)
    if update.operation == "add":
        if current is not None:
            raise ValueError(f"reference already exists: {binding.reference_id}")
        if any(item.label == binding.label for item in projected.values()):
            raise ValueError(f"reference label already used: {binding.label}")
        if any(item.ordinal == binding.ordinal for item in projected.values()):
            raise ValueError(f"reference ordinal already used: {binding.ordinal}")
        projected[binding.reference_id] = binding
        return
    if current is None:
        raise ValueError(f"unknown reference: {binding.reference_id}")
    if binding.label != current.label or binding.ordinal != current.ordinal:
        raise ValueError("reference correction/removal cannot renumber an existing binding")
    if update.operation == "remove":
        if binding.source_id != current.source_id:
            raise ValueError("reference removal cannot change sourceId")
        projected[binding.reference_id] = replace(current, active=False)
        return
    projected[binding.reference_id] = replace(
        binding,
        frame_lease_id=binding.frame_lease_id or current.frame_lease_id,
    )


def task_references(events: Iterable[Any]) -> tuple[ReferenceBinding, ...]:
    projected: dict[str, ReferenceBinding] = {}
    for data in _context_events(events):
        for raw in data.get("referenceUpdates") or []:
            _apply_update(projected, ReferenceUpdate.from_dict(raw))
    return tuple(projected.values())


def reference_revision(events: Iterable[Any]) -> int:
    revision = 0
    for data in _context_events(events):
        candidate = data.get("referenceRevision")
        if isinstance(candidate, bool) or not isinstance(candidate, int) or candidate < revision:
            raise ValueError("context referenceRevision must be monotonic")
        revision = candidate
    return revision


def resolve_source(events: Iterable[Any], source_id: str) -> SourceRef:
    for source in task_sources(events):
        if source.source_id == source_id:
            return source
    raise KeyError(f"unknown task source: {source_id}")


def validate_context_update(
    data: Mapping[str, Any],
    *,
    session_id: str,
    events: Iterable[Any],
) -> None:
    required = {"taskId", "sources", "referenceUpdates", "referenceRevision"}
    allowed = required | {"scopeGrants", "scopeRevocations"}
    unknown = sorted(set(data) - allowed)
    if unknown:
        raise ValueError(f"unknown field(s) for context/updated: {unknown}")
    missing = sorted(required - set(data))
    if missing:
        raise ValueError(f"context/updated missing field(s): {missing}")
    if str(data.get("taskId") or "") != session_id:
        raise ValueError("context/updated taskId must match EventSession")
    raw_sources = data.get("sources")
    raw_updates = data.get("referenceUpdates")
    if not isinstance(raw_sources, list) or not isinstance(raw_updates, list):
        raise ValueError("context/updated sources and referenceUpdates must be arrays")
    raw_grants = data.get("scopeGrants", [])
    raw_revocations = data.get("scopeRevocations", [])
    if not isinstance(raw_grants, list) or not isinstance(raw_revocations, list):
        raise ValueError("context scopeGrants and scopeRevocations must be arrays")
    from .source_scope import ScopeGrant

    grants = [ScopeGrant.from_dict(raw) for raw in raw_grants]
    if any(grant.task_id != session_id for grant in grants):
        raise ValueError("context scope grant belongs to another task")
    if any(not isinstance(item, str) or not item.strip() for item in raw_revocations):
        raise ValueError("context scope revocations must be non-empty strings")
    sources = [SourceRef.from_dict(raw) for raw in raw_sources]
    if any(source.task_id != session_id for source in sources):
        raise ValueError("context source belongs to another task")

    current_revision = reference_revision(events)
    proposed_revision = data.get("referenceRevision")
    expected_revision = current_revision + (1 if raw_updates else 0)
    if proposed_revision != expected_revision:
        raise ValueError(
            f"context reference revision must advance from {current_revision} to {expected_revision}"
        )

    known_sources = {source.source_id for source in task_sources(events)}
    known_sources.update(source.source_id for source in sources)
    projected = {item.reference_id: item for item in task_references(events)}
    for raw in raw_updates:
        update = ReferenceUpdate.from_dict(raw)
        if update.binding.source_id not in known_sources:
            raise ValueError(f"reference source is not registered for task: {update.binding.source_id}")
        _apply_update(projected, update)


def register_source(session: _AppendSession, source: SourceRef) -> Any:
    if source.task_id != session.id:
        raise ValueError("source taskId must match target task")
    revision = reference_revision(session.events)
    return session.append(
        "context/updated",
        {
            "taskId": session.id,
            "sources": [source.to_dict()],
            "referenceUpdates": [],
            "referenceRevision": revision,
        },
    )


def apply_reference_updates(
    session: _AppendSession,
    updates: Iterable[ReferenceUpdate],
    *,
    expected_revision: int | None = None,
) -> Any | None:
    current = reference_revision(session.events)
    if expected_revision is not None and expected_revision != current:
        raise ValueError(f"reference revision mismatch: expected {expected_revision}, current {current}")
    materialized = tuple(updates)
    if not materialized:
        return None
    return session.append(
        "context/updated",
        {
            "taskId": session.id,
            "sources": [],
            "referenceUpdates": [item.to_dict() for item in materialized],
            "referenceRevision": current + 1,
        },
    )


__all__ = [
    "apply_reference_updates",
    "reference_revision",
    "register_source",
    "resolve_source",
    "task_references",
    "task_sources",
    "validate_context_update",
]
