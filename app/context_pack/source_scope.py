"""Task-bound source authorization projected from the EventSession log."""

from __future__ import annotations

import os
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Mapping

from .source_store import reference_revision, task_sources
from .sources import SourceRef

ACCESS_ACTIONS = frozenset({"read", "patch", "send", "delete", "run"})


def _texts(values: Iterable[Any], name: str) -> tuple[str, ...]:
    result = tuple(str(value or "").strip() for value in values)
    if any(not value for value in result):
        raise ValueError(f"{name} must contain non-empty strings")
    if len(result) != len(set(result)):
        raise ValueError(f"{name} must not contain duplicates")
    return result


@dataclass(frozen=True, slots=True)
class AccessRequest:
    action: str
    source_ids: tuple[str, ...] = ()
    paths: tuple[str, ...] = ()
    window_ids: tuple[str, ...] = ()
    recipients: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        action = str(self.action or "").strip()
        if action not in ACCESS_ACTIONS:
            raise ValueError(f"unsupported access action: {action}")
        object.__setattr__(self, "action", action)
        for field_name in ("source_ids", "paths", "window_ids", "recipients"):
            object.__setattr__(
                self,
                field_name,
                _texts(getattr(self, field_name), f"AccessRequest.{field_name}"),
            )

    @property
    def empty(self) -> bool:
        return not (self.source_ids or self.paths or self.window_ids or self.recipients)


@dataclass(frozen=True, slots=True)
class ScopeGrant:
    grant_id: str
    task_id: str
    source_ids: tuple[str, ...]
    folder_roots: tuple[str, ...]
    window_ids: tuple[str, ...]
    recipients: tuple[str, ...]
    actions: tuple[str, ...]
    expires_at_ms: int | None

    def __post_init__(self) -> None:
        for field_name in ("grant_id", "task_id"):
            value = str(getattr(self, field_name) or "").strip()
            if not value:
                raise ValueError(f"ScopeGrant.{field_name} must be non-empty")
            object.__setattr__(self, field_name, value)
        for field_name in ("source_ids", "folder_roots", "window_ids", "recipients"):
            object.__setattr__(
                self,
                field_name,
                _texts(getattr(self, field_name), f"ScopeGrant.{field_name}"),
            )
        actions = _texts(self.actions, "ScopeGrant.actions")
        unsupported = sorted(set(actions) - ACCESS_ACTIONS)
        if unsupported:
            raise ValueError(f"unsupported scope action(s): {unsupported}")
        if not actions:
            raise ValueError("ScopeGrant.actions must not be empty")
        object.__setattr__(self, "actions", actions)
        if self.expires_at_ms is not None and (
            isinstance(self.expires_at_ms, bool)
            or not isinstance(self.expires_at_ms, int)
            or self.expires_at_ms < 0
        ):
            raise ValueError("ScopeGrant.expires_at_ms must be a non-negative integer or None")

    @classmethod
    def from_dict(cls, value: Mapping[str, Any]) -> "ScopeGrant":
        required = {
            "grantId", "taskId", "sourceIds", "folderRoots", "windowIds",
            "recipients", "actions", "expiresAtMs",
        }
        unknown = sorted(set(value) - required)
        missing = sorted(required - set(value))
        if unknown or missing:
            raise ValueError(f"invalid ScopeGrant fields missing={missing} unknown={unknown}")
        arrays = ("sourceIds", "folderRoots", "windowIds", "recipients", "actions")
        if any(not isinstance(value[name], list) for name in arrays):
            raise ValueError("ScopeGrant collection fields must be arrays")
        return cls(
            grant_id=str(value["grantId"]),
            task_id=str(value["taskId"]),
            source_ids=tuple(value["sourceIds"]),
            folder_roots=tuple(value["folderRoots"]),
            window_ids=tuple(value["windowIds"]),
            recipients=tuple(value["recipients"]),
            actions=tuple(value["actions"]),
            expires_at_ms=value["expiresAtMs"],
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "grantId": self.grant_id,
            "taskId": self.task_id,
            "sourceIds": list(self.source_ids),
            "folderRoots": list(self.folder_roots),
            "windowIds": list(self.window_ids),
            "recipients": list(self.recipients),
            "actions": list(self.actions),
            "expiresAtMs": self.expires_at_ms,
        }


@dataclass(frozen=True, slots=True)
class TaskSourceScope:
    task_id: str
    sources: tuple[SourceRef, ...]
    grants: tuple[ScopeGrant, ...]


@dataclass(frozen=True, slots=True)
class AccessDecision:
    allowed: bool
    reason: str = ""


def _event_parts(event: Any) -> tuple[str, dict[str, Any]]:
    if isinstance(event, Mapping):
        return str(event.get("type") or ""), dict(event.get("data") or {})
    return str(getattr(event, "type", "") or ""), dict(getattr(event, "data", {}) or {})


def scope_from_events(
    events: Iterable[Any],
    *,
    task_id: str,
    grants: Iterable[ScopeGrant] = (),
) -> TaskSourceScope:
    materialized = tuple(events)
    projected = {grant.grant_id: grant for grant in grants}
    for event in materialized:
        event_type, data = _event_parts(event)
        if event_type != "context/updated":
            continue
        for raw in data.get("scopeGrants") or []:
            grant = ScopeGrant.from_dict(raw)
            if grant.task_id != task_id:
                raise ValueError("scope grant belongs to another task")
            projected[grant.grant_id] = grant
        for grant_id in data.get("scopeRevocations") or []:
            projected.pop(str(grant_id), None)
    return TaskSourceScope(
        task_id=str(task_id),
        sources=task_sources(materialized),
        grants=tuple(projected.values()),
    )


def grant_source_scope(
    session: Any,
    *,
    grants: Iterable[ScopeGrant] = (),
    revocations: Iterable[str] = (),
) -> Any:
    additions = tuple(grants)
    removed = _texts(revocations, "scope revocations")
    if not additions and not removed:
        raise ValueError("scope update requires a grant or revocation")
    if any(grant.task_id != session.id for grant in additions):
        raise ValueError("scope grant taskId must match target task")
    return session.append("context/updated", {
        "taskId": session.id,
        "sources": [],
        "referenceUpdates": [],
        "referenceRevision": reference_revision(session.events),
        "scopeGrants": [grant.to_dict() for grant in additions],
        "scopeRevocations": list(removed),
    })


def ensure_folder_read_scope(
    session: Any,
    folder_root: str | Path,
    *,
    grant_id: str = "workspace-materials",
) -> Any | None:
    """Persist the trusted folder-picker's read scope without duplicate events."""
    normalized = str(Path(folder_root).expanduser().resolve(strict=False))
    desired = ScopeGrant(
        grant_id=grant_id,
        task_id=session.id,
        source_ids=(),
        folder_roots=(normalized,),
        window_ids=(),
        recipients=(),
        actions=("read",),
        expires_at_ms=None,
    )
    current = scope_from_events(session.events, task_id=session.id)
    if any(grant == desired for grant in current.grants):
        return None
    return grant_source_scope(session, grants=(desired,))


def resolve_access(spec: Any, arguments: Mapping[str, Any]) -> AccessRequest:
    resolver = getattr(spec, "access_for", None)
    if resolver is None:
        return AccessRequest(action="read")
    resolved = resolver(dict(arguments))
    if not isinstance(resolved, AccessRequest):
        raise TypeError("ToolSpec.access_for must return AccessRequest")
    if resolved.empty:
        raise ValueError("resource tool access_for returned no access requirement")
    return resolved


def _source_allowed(scope: TaskSourceScope, source_id: str, action: str, now_ms: int) -> bool:
    sources = {source.source_id: source for source in scope.sources}
    source = sources.get(source_id)
    if source is None:
        return False
    if action == "read":
        seen: set[str] = set()
        current: SourceRef | None = source
        while current is not None and current.source_id not in seen:
            seen.add(current.source_id)
            if current.origin in {"user-attached", "user-pointed"}:
                return True
            current = sources.get(current.parent_source_id or "")
    return any(
        action in grant.actions
        and source_id in grant.source_ids
        and (grant.expires_at_ms is None or now_ms <= grant.expires_at_ms)
        for grant in scope.grants
    )


def _inside(path: str, root: str) -> bool:
    candidate = os.path.normcase(str(Path(path).resolve(strict=False)))
    parent = os.path.normcase(str(Path(root).resolve(strict=False)))
    try:
        return os.path.commonpath((candidate, parent)) == parent
    except ValueError:
        return False


def authorize_access(
    scope: TaskSourceScope,
    request: AccessRequest,
    *,
    now_ms: int | None = None,
) -> AccessDecision:
    if now_ms is None:
        now_ms = int(time.time() * 1000)
    active = tuple(
        grant for grant in scope.grants
        if request.action in grant.actions
        and (grant.expires_at_ms is None or now_ms <= grant.expires_at_ms)
    )
    for source_id in request.source_ids:
        if not _source_allowed(scope, source_id, request.action, now_ms):
            return AccessDecision(False, f"source_not_granted:{source_id}")
    for path in request.paths:
        if not any(_inside(path, root) for grant in active for root in grant.folder_roots):
            return AccessDecision(False, f"path_not_granted:{path}")
    for window_id in request.window_ids:
        if not any(window_id in grant.window_ids for grant in active):
            return AccessDecision(False, f"window_not_granted:{window_id}")
    for recipient in request.recipients:
        if not any(recipient in grant.recipients for grant in active):
            return AccessDecision(False, f"recipient_not_granted:{recipient}")
    return AccessDecision(True)


__all__ = [
    "ACCESS_ACTIONS",
    "AccessDecision",
    "AccessRequest",
    "ScopeGrant",
    "TaskSourceScope",
    "authorize_access",
    "ensure_folder_read_scope",
    "grant_source_scope",
    "resolve_access",
    "scope_from_events",
]
