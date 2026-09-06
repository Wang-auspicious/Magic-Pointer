"""Durable task-source, fragment, coverage and reference value objects.

The wire format is camelCase and deliberately strict: these objects cross the
Electron/Python boundary and are persisted in EventSession, so silently
discarding a misspelled field would lose the only route back to source material.
"""

from __future__ import annotations

import copy
from dataclasses import dataclass
from typing import Any, Mapping, Protocol, runtime_checkable

from app.evidence.contract import EvidenceStatus

SOURCE_KINDS = frozenset({"file", "document", "chat", "web", "figma", "capture"})
SOURCE_ORIGINS = frozenset({"user-attached", "user-pointed", "task-discovered"})
SOURCE_CAPABILITIES = frozenset({"read", "search", "follow", "patch"})
LOCATOR_KINDS = frozenset({
    "message",
    "text",
    "table",
    "cell-range",
    "slide-shape",
    "pdf-region",
    "dom-node",
    "figma-node",
    "visual-region",
})
COVERAGE_EXTENTS = frozenset({"selection", "neighborhood", "page", "document", "query-results"})
REFERENCE_ROLES = frozenset({"target", "source", "reference", "exclude", "unresolved"})
REFERENCE_OPERATIONS = frozenset({"add", "correct", "remove"})
TASK_INPUT_TARGETS = frozenset({"next-step", "next-turn"})
TIMELINE_KINDS = frozenset({"utterance", "point"})


def _record(value: Any, name: str) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        raise ValueError(f"{name} must be an object")
    return dict(value)


def _strict(
    value: Any,
    name: str,
    *,
    required: set[str],
    optional: set[str] | None = None,
) -> dict[str, Any]:
    data = _record(value, name)
    allowed = required | (optional or set())
    unknown = sorted(set(data) - allowed)
    if unknown:
        raise ValueError(f"unknown field(s) for {name}: {unknown}")
    missing = sorted(required - set(data))
    if missing:
        raise ValueError(f"missing field(s) for {name}: {missing}")
    return data


def _text(value: Any, name: str, *, allow_empty: bool = False) -> str:
    if not isinstance(value, str):
        raise ValueError(f"{name} must be a string")
    result = value.strip()
    if not result and not allow_empty:
        raise ValueError(f"{name} must be non-empty")
    return result


def _integer(value: Any, name: str, *, minimum: int = 0) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        raise ValueError(f"{name} must be an integer >= {minimum}")
    return value


def _string_list(value: Any, name: str) -> tuple[str, ...]:
    if not isinstance(value, list):
        raise ValueError(f"{name} must be an array")
    result = tuple(_text(item, f"{name} item") for item in value)
    if len(result) != len(set(result)):
        raise ValueError(f"{name} must not contain duplicates")
    return result


@dataclass(frozen=True, slots=True)
class FragmentLocator:
    kind: str
    value: dict[str, Any]

    @classmethod
    def from_dict(cls, value: Mapping[str, Any]) -> "FragmentLocator":
        data = _strict(value, cls.__name__, required={"kind", "value"})
        kind = _text(data["kind"], "FragmentLocator.kind")
        if kind not in LOCATOR_KINDS:
            raise ValueError(f"unsupported FragmentLocator.kind: {kind}")
        return cls(kind=kind, value=copy.deepcopy(_record(data["value"], "FragmentLocator.value")))

    def to_dict(self) -> dict[str, Any]:
        return {"kind": self.kind, "value": copy.deepcopy(self.value)}


@dataclass(frozen=True, slots=True)
class SourceRef:
    source_id: str
    task_id: str
    kind: str
    title: str
    identity: dict[str, Any]
    revision: dict[str, Any]
    capabilities: tuple[str, ...]
    origin: str
    parent_source_id: str | None

    @classmethod
    def from_dict(cls, value: Mapping[str, Any]) -> "SourceRef":
        data = _strict(
            value,
            cls.__name__,
            required={
                "sourceId", "taskId", "kind", "title", "identity", "revision",
                "capabilities", "origin", "parentSourceId",
            },
        )
        kind = _text(data["kind"], "SourceRef.kind")
        if kind not in SOURCE_KINDS:
            raise ValueError(f"unsupported SourceRef.kind: {kind}")
        origin = _text(data["origin"], "SourceRef.origin")
        if origin not in SOURCE_ORIGINS:
            raise ValueError(f"unsupported SourceRef.origin: {origin}")
        capabilities = _string_list(data["capabilities"], "SourceRef.capabilities")
        unsupported = sorted(set(capabilities) - SOURCE_CAPABILITIES)
        if unsupported:
            raise ValueError(f"unsupported SourceRef.capabilities: {unsupported}")
        parent = data["parentSourceId"]
        if parent is not None:
            parent = _text(parent, "SourceRef.parentSourceId")
        return cls(
            source_id=_text(data["sourceId"], "SourceRef.sourceId"),
            task_id=_text(data["taskId"], "SourceRef.taskId"),
            kind=kind,
            title=_text(data["title"], "SourceRef.title"),
            identity=copy.deepcopy(_record(data["identity"], "SourceRef.identity")),
            revision=copy.deepcopy(_record(data["revision"], "SourceRef.revision")),
            capabilities=capabilities,
            origin=origin,
            parent_source_id=parent,
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "sourceId": self.source_id,
            "taskId": self.task_id,
            "kind": self.kind,
            "title": self.title,
            "identity": copy.deepcopy(self.identity),
            "revision": copy.deepcopy(self.revision),
            "capabilities": list(self.capabilities),
            "origin": self.origin,
            "parentSourceId": self.parent_source_id,
        }

    def to_model_dict(self) -> dict[str, Any]:
        return {
            "sourceId": self.source_id,
            "kind": self.kind,
            "title": self.title,
            "capabilities": list(self.capabilities),
            "parentSourceId": self.parent_source_id,
        }


@dataclass(frozen=True, slots=True)
class Coverage:
    extent: str
    read_ranges: tuple[dict[str, Any], ...]
    total_units: int | None
    complete: bool
    next_cursor: str | None
    missing_reason: str | None

    @classmethod
    def from_dict(cls, value: Mapping[str, Any]) -> "Coverage":
        data = _strict(
            value,
            cls.__name__,
            required={"extent", "readRanges", "totalUnits", "complete", "nextCursor", "missingReason"},
        )
        extent = _text(data["extent"], "Coverage.extent")
        if extent not in COVERAGE_EXTENTS:
            raise ValueError(f"unsupported Coverage.extent: {extent}")
        ranges = data["readRanges"]
        if not isinstance(ranges, list):
            raise ValueError("Coverage.readRanges must be an array")
        total = data["totalUnits"]
        if total is not None:
            total = _integer(total, "Coverage.totalUnits")
        if not isinstance(data["complete"], bool):
            raise ValueError("Coverage.complete must be boolean")
        cursor = data["nextCursor"]
        if cursor is not None:
            cursor = _text(cursor, "Coverage.nextCursor")
        reason = data["missingReason"]
        if reason is not None:
            reason = _text(reason, "Coverage.missingReason")
        return cls(
            extent=extent,
            read_ranges=tuple(copy.deepcopy(_record(item, "Coverage.readRanges item")) for item in ranges),
            total_units=total,
            complete=data["complete"],
            next_cursor=cursor,
            missing_reason=reason,
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "extent": self.extent,
            "readRanges": [copy.deepcopy(item) for item in self.read_ranges],
            "totalUnits": self.total_units,
            "complete": self.complete,
            "nextCursor": self.next_cursor,
            "missingReason": self.missing_reason,
        }


@dataclass(frozen=True, slots=True)
class ReferenceBinding:
    reference_id: str
    label: str
    source_id: str
    locator: FragmentLocator
    role: str
    frame_lease_id: str | None
    captured_at_ms: int
    ordinal: int
    active: bool

    @classmethod
    def from_dict(cls, value: Mapping[str, Any]) -> "ReferenceBinding":
        data = _strict(
            value,
            cls.__name__,
            required={
                "referenceId", "label", "sourceId", "locator", "role",
                "frameLeaseId", "capturedAtMs", "ordinal", "active",
            },
        )
        role = _text(data["role"], "ReferenceBinding.role")
        if role not in REFERENCE_ROLES:
            raise ValueError(f"unsupported ReferenceBinding.role: {role}")
        frame = data["frameLeaseId"]
        if frame is not None:
            frame = _text(frame, "ReferenceBinding.frameLeaseId")
        if not isinstance(data["active"], bool):
            raise ValueError("ReferenceBinding.active must be boolean")
        return cls(
            reference_id=_text(data["referenceId"], "ReferenceBinding.referenceId"),
            label=_text(data["label"], "ReferenceBinding.label"),
            source_id=_text(data["sourceId"], "ReferenceBinding.sourceId"),
            locator=FragmentLocator.from_dict(data["locator"]),
            role=role,
            frame_lease_id=frame,
            captured_at_ms=_integer(data["capturedAtMs"], "ReferenceBinding.capturedAtMs"),
            ordinal=_integer(data["ordinal"], "ReferenceBinding.ordinal", minimum=1),
            active=data["active"],
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "referenceId": self.reference_id,
            "label": self.label,
            "sourceId": self.source_id,
            "locator": self.locator.to_dict(),
            "role": self.role,
            "frameLeaseId": self.frame_lease_id,
            "capturedAtMs": self.captured_at_ms,
            "ordinal": self.ordinal,
            "active": self.active,
        }

    def to_model_dict(self) -> dict[str, Any]:
        return {
            "referenceId": self.reference_id,
            "label": self.label,
            "sourceId": self.source_id,
            "locator": self.locator.to_dict(),
            "role": self.role,
            "active": self.active,
        }


@dataclass(frozen=True, slots=True)
class ReferenceUpdate:
    operation: str
    binding: ReferenceBinding

    @classmethod
    def from_dict(cls, value: Mapping[str, Any]) -> "ReferenceUpdate":
        data = _strict(value, cls.__name__, required={"operation", "binding"})
        operation = _text(data["operation"], "ReferenceUpdate.operation")
        if operation not in REFERENCE_OPERATIONS:
            raise ValueError(f"unsupported ReferenceUpdate.operation: {operation}")
        binding = ReferenceBinding.from_dict(data["binding"])
        if operation == "remove" and binding.active:
            raise ValueError("remove reference update requires active=false")
        if operation in {"add", "correct"} and not binding.active:
            raise ValueError(f"{operation} reference update requires active=true")
        return cls(operation=operation, binding=binding)

    def to_dict(self) -> dict[str, Any]:
        return {"operation": self.operation, "binding": self.binding.to_dict()}


@dataclass(frozen=True, slots=True)
class TimelineEvent:
    event_id: str
    kind: str
    start_ms: int
    end_ms: int
    text: str | None = None
    reference_id: str | None = None

    @classmethod
    def from_dict(cls, value: Mapping[str, Any]) -> "TimelineEvent":
        data = _strict(
            value,
            cls.__name__,
            required={"eventId", "kind", "startMs", "endMs"},
            optional={"text", "referenceId"},
        )
        kind = _text(data["kind"], "TimelineEvent.kind")
        if kind not in TIMELINE_KINDS:
            raise ValueError(f"unsupported TimelineEvent.kind: {kind}")
        start = _integer(data["startMs"], "TimelineEvent.startMs")
        end = _integer(data["endMs"], "TimelineEvent.endMs")
        if end < start:
            raise ValueError("TimelineEvent.endMs must be >= startMs")
        text = data.get("text")
        if text is not None:
            text = _text(text, "TimelineEvent.text", allow_empty=False)
        reference = data.get("referenceId")
        if reference is not None:
            reference = _text(reference, "TimelineEvent.referenceId")
        if kind == "utterance" and text is None:
            raise ValueError("utterance timeline event requires text")
        if kind == "point" and reference is None:
            raise ValueError("point timeline event requires referenceId")
        return cls(
            event_id=_text(data["eventId"], "TimelineEvent.eventId"),
            kind=kind,
            start_ms=start,
            end_ms=end,
            text=text,
            reference_id=reference,
        )

    def to_dict(self) -> dict[str, Any]:
        result: dict[str, Any] = {
            "eventId": self.event_id,
            "kind": self.kind,
            "startMs": self.start_ms,
            "endMs": self.end_ms,
        }
        if self.text is not None:
            result["text"] = self.text
        if self.reference_id is not None:
            result["referenceId"] = self.reference_id
        return result


@dataclass(frozen=True, slots=True)
class TaskInput:
    input_id: str
    task_id: str
    target: str
    instruction: str
    reference_updates: tuple[ReferenceUpdate, ...]
    source_ids: tuple[str, ...]
    timeline: tuple[TimelineEvent, ...]
    captured_at_ms: int

    @classmethod
    def from_dict(cls, value: Mapping[str, Any]) -> "TaskInput":
        data = _strict(
            value,
            cls.__name__,
            required={
                "inputId", "taskId", "target", "instruction", "referenceUpdates",
                "sourceIds", "timeline", "capturedAtMs",
            },
        )
        target = _text(data["target"], "TaskInput.target")
        if target not in TASK_INPUT_TARGETS:
            raise ValueError(f"unsupported TaskInput.target: {target}")
        instruction = _text(data["instruction"], "TaskInput.instruction", allow_empty=True)
        raw_updates = data["referenceUpdates"]
        raw_timeline = data["timeline"]
        if not isinstance(raw_updates, list) or not isinstance(raw_timeline, list):
            raise ValueError("TaskInput referenceUpdates and timeline must be arrays")
        updates = tuple(ReferenceUpdate.from_dict(item) for item in raw_updates)
        source_ids = _string_list(data["sourceIds"], "TaskInput.sourceIds")
        if not instruction and not updates and not source_ids:
            raise ValueError("TaskInput requires instruction, referenceUpdates, or sourceIds")
        return cls(
            input_id=_text(data["inputId"], "TaskInput.inputId"),
            task_id=_text(data["taskId"], "TaskInput.taskId"),
            target=target,
            instruction=instruction,
            reference_updates=updates,
            source_ids=source_ids,
            timeline=tuple(TimelineEvent.from_dict(item) for item in raw_timeline),
            captured_at_ms=_integer(data["capturedAtMs"], "TaskInput.capturedAtMs"),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "inputId": self.input_id,
            "taskId": self.task_id,
            "target": self.target,
            "instruction": self.instruction,
            "referenceUpdates": [item.to_dict() for item in self.reference_updates],
            "sourceIds": list(self.source_ids),
            "timeline": [item.to_dict() for item in self.timeline],
            "capturedAtMs": self.captured_at_ms,
        }


@dataclass(frozen=True, slots=True)
class ReadFragment:
    fragment_id: str
    locator: FragmentLocator
    text: str
    metadata: dict[str, Any]
    citations: tuple[dict[str, Any], ...]

    @classmethod
    def from_dict(cls, value: Mapping[str, Any]) -> "ReadFragment":
        data = _strict(
            value,
            cls.__name__,
            required={"fragmentId", "locator", "text", "metadata", "citations"},
        )
        citations = data["citations"]
        if not isinstance(citations, list):
            raise ValueError("ReadFragment.citations must be an array")
        return cls(
            fragment_id=_text(data["fragmentId"], "ReadFragment.fragmentId"),
            locator=FragmentLocator.from_dict(data["locator"]),
            text=_text(data["text"], "ReadFragment.text", allow_empty=True),
            metadata=copy.deepcopy(_record(data["metadata"], "ReadFragment.metadata")),
            citations=tuple(copy.deepcopy(_record(item, "ReadFragment.citations item")) for item in citations),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "fragmentId": self.fragment_id,
            "locator": self.locator.to_dict(),
            "text": self.text,
            "metadata": copy.deepcopy(self.metadata),
            "citations": [copy.deepcopy(item) for item in self.citations],
        }


@dataclass(frozen=True, slots=True)
class ReadResult:
    source_id: str
    fragments: tuple[ReadFragment, ...]
    coverage: Coverage
    evidence_status: str
    used_backend: str
    latency_ms: float

    @classmethod
    def from_dict(cls, value: Mapping[str, Any]) -> "ReadResult":
        data = _strict(
            value,
            cls.__name__,
            required={"sourceId", "fragments", "coverage", "evidenceStatus", "usedBackend", "latencyMs"},
        )
        fragments = data["fragments"]
        if not isinstance(fragments, list):
            raise ValueError("ReadResult.fragments must be an array")
        status = _text(data["evidenceStatus"], "ReadResult.evidenceStatus")
        if status not in {item.value for item in EvidenceStatus}:
            raise ValueError(f"unsupported ReadResult.evidenceStatus: {status}")
        latency = data["latencyMs"]
        if isinstance(latency, bool) or not isinstance(latency, (int, float)) or latency < 0:
            raise ValueError("ReadResult.latencyMs must be a non-negative number")
        return cls(
            source_id=_text(data["sourceId"], "ReadResult.sourceId"),
            fragments=tuple(ReadFragment.from_dict(item) for item in fragments),
            coverage=Coverage.from_dict(data["coverage"]),
            evidence_status=status,
            used_backend=_text(data["usedBackend"], "ReadResult.usedBackend"),
            latency_ms=float(latency),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "sourceId": self.source_id,
            "fragments": [item.to_dict() for item in self.fragments],
            "coverage": self.coverage.to_dict(),
            "evidenceStatus": self.evidence_status,
            "usedBackend": self.used_backend,
            "latencyMs": self.latency_ms,
        }


@runtime_checkable
class SourceReader(Protocol):
    def describe(self, source: SourceRef) -> ReadResult: ...

    def read(
        self,
        source: SourceRef,
        locator: FragmentLocator | None,
        cursor: str | None,
        limit: int,
    ) -> ReadResult: ...

    def search(
        self,
        source: SourceRef,
        query: str,
        cursor: str | None,
        limit: int,
    ) -> ReadResult: ...

    def follow(self, source: SourceRef, fragment_id: str) -> tuple[SourceRef, ...]: ...


class SourceReaderRegistry:
    def __init__(self) -> None:
        self._readers: dict[str, SourceReader] = {}
        self._source_readers: dict[str, SourceReader] = {}

    def register(self, kind: str, reader: SourceReader) -> None:
        if kind not in SOURCE_KINDS:
            raise ValueError(f"unsupported source kind: {kind}")
        if kind in self._readers:
            raise ValueError(f"source reader already registered for {kind}")
        self._readers[kind] = reader

    def register_source(self, source_id: str, reader: SourceReader) -> None:
        normalized = str(source_id).strip()
        if not normalized:
            raise ValueError("source_id must be non-empty")
        if normalized in self._source_readers:
            raise ValueError(f"source reader already registered for {normalized}")
        self._source_readers[normalized] = reader

    def for_source(self, source: SourceRef) -> SourceReader:
        live = self._source_readers.get(source.source_id)
        if live is not None:
            return live
        try:
            return self._readers[source.kind]
        except KeyError as exc:
            raise KeyError(f"no source reader registered for {source.kind}") from exc


__all__ = [
    "COVERAGE_EXTENTS",
    "Coverage",
    "FragmentLocator",
    "LOCATOR_KINDS",
    "ReadFragment",
    "ReadResult",
    "REFERENCE_OPERATIONS",
    "REFERENCE_ROLES",
    "ReferenceBinding",
    "ReferenceUpdate",
    "SOURCE_KINDS",
    "SourceReader",
    "SourceReaderRegistry",
    "SourceRef",
    "TASK_INPUT_TARGETS",
    "TaskInput",
    "TimelineEvent",
]
