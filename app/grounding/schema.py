"""Reusable, platform-neutral schemas for pointer grounding.

This module intentionally contains only pure Python data structures and JSON
helpers. It does not call UI automation, Electron, or OS-specific APIs.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Iterable


Point = tuple[int, int]
Size = tuple[int, int]
BoundingBox = tuple[int, int, int, int]
JsonDict = dict[str, Any]


def _int_tuple(value: Iterable[Any] | None, length: int, field_name: str) -> tuple[int, ...] | None:
    if value is None:
        return None
    parsed = tuple(int(item) for item in value)
    if len(parsed) != length:
        raise ValueError(f"{field_name} must contain exactly {length} integers")
    return parsed


def point_to_json(point: Point | None) -> list[int] | None:
    return None if point is None else [point[0], point[1]]


def point_from_json(value: Iterable[Any] | None) -> Point | None:
    parsed = _int_tuple(value, 2, "point")
    return None if parsed is None else (parsed[0], parsed[1])


def size_to_json(size: Size | None) -> list[int] | None:
    return None if size is None else [size[0], size[1]]


def size_from_json(value: Iterable[Any] | None) -> Size | None:
    parsed = _int_tuple(value, 2, "size")
    return None if parsed is None else (parsed[0], parsed[1])


def bbox_to_json(bbox: BoundingBox | None) -> list[int] | None:
    return None if bbox is None else [bbox[0], bbox[1], bbox[2], bbox[3]]


def bbox_from_json(value: Iterable[Any] | None) -> BoundingBox | None:
    parsed = _int_tuple(value, 4, "bbox")
    return None if parsed is None else (parsed[0], parsed[1], parsed[2], parsed[3])


@dataclass(frozen=True)
class PointerSelection:
    """A raw user pointer selection before it is resolved to an object."""

    id: str
    point: Point
    bbox: BoundingBox | None = None
    screen_size: Size | None = None
    selected_at: str | None = None
    source: str = "pointer"
    modifiers: tuple[str, ...] = ()
    metadata: JsonDict = field(default_factory=dict)

    def to_dict(self) -> JsonDict:
        return {
            "id": self.id,
            "point": point_to_json(self.point),
            "bbox": bbox_to_json(self.bbox),
            "screen_size": size_to_json(self.screen_size),
            "selected_at": self.selected_at,
            "source": self.source,
            "modifiers": list(self.modifiers),
            "metadata": dict(self.metadata),
        }

    @classmethod
    def from_dict(cls, data: JsonDict) -> "PointerSelection":
        point = point_from_json(data["point"])
        if point is None:
            raise ValueError("point is required for PointerSelection")
        return cls(
            id=str(data["id"]),
            point=point,
            bbox=bbox_from_json(data.get("bbox")),
            screen_size=size_from_json(data.get("screen_size")),
            selected_at=data.get("selected_at"),
            source=str(data.get("source", "pointer")),
            modifiers=tuple(str(item) for item in data.get("modifiers", ())),
            metadata=dict(data.get("metadata") or {}),
        )


@dataclass(frozen=True)
class GroundedObject:
    """A screen object grounded from a pointer selection or detector result."""

    id: str
    kind: str
    bbox: BoundingBox
    label: str | None = None
    confidence: float = 1.0
    source_selection_id: str | None = None
    text: str | None = None
    app_title: str | None = None
    image_path: str | None = None
    metadata: JsonDict = field(default_factory=dict)

    @classmethod
    def from_selection(
        cls,
        *,
        id: str,
        kind: str,
        selection: PointerSelection,
        bbox: BoundingBox | None = None,
        label: str | None = None,
        confidence: float = 1.0,
        text: str | None = None,
        app_title: str | None = None,
        image_path: str | None = None,
        metadata: JsonDict | None = None,
    ) -> "GroundedObject":
        object_bbox = bbox or selection.bbox
        if object_bbox is None:
            x, y = selection.point
            object_bbox = (x, y, x, y)
        return cls(
            id=id,
            kind=kind,
            bbox=object_bbox,
            label=label,
            confidence=confidence,
            source_selection_id=selection.id,
            text=text,
            app_title=app_title,
            image_path=image_path,
            metadata=dict(metadata or {}),
        )

    def to_dict(self) -> JsonDict:
        return {
            "id": self.id,
            "kind": self.kind,
            "bbox": bbox_to_json(self.bbox),
            "label": self.label,
            "confidence": self.confidence,
            "source_selection_id": self.source_selection_id,
            "text": self.text,
            "app_title": self.app_title,
            "image_path": self.image_path,
            "metadata": dict(self.metadata),
        }

    @classmethod
    def from_dict(cls, data: JsonDict) -> "GroundedObject":
        bbox = bbox_from_json(data["bbox"])
        if bbox is None:
            raise ValueError("bbox is required for GroundedObject")
        return cls(
            id=str(data["id"]),
            kind=str(data["kind"]),
            bbox=bbox,
            label=data.get("label"),
            confidence=float(data.get("confidence", 1.0)),
            source_selection_id=data.get("source_selection_id"),
            text=data.get("text"),
            app_title=data.get("app_title"),
            image_path=data.get("image_path"),
            metadata=dict(data.get("metadata") or {}),
        )


