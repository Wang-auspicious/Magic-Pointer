"""Anchor model: a cross-time survivable target handle (harness gap review L3).

An :class:`Anchor` carries redundant identities (process/window, structural
path, content hash, normalized spatial hint) so a resolver can either return
the same object or say explicitly that it is gone. Resolution outcomes are a
discriminated union of five frozen dataclasses; ``ambiguous`` and ``changed``
are first-class results, never collapsed into ``exact``.

This module is pure Python and has no I/O or platform dependencies.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True, slots=True)
class AppIdentity:
    """Process + window identity; the most stable anchor facet."""

    process_name: str
    process_id: int | None = None
    window_class: str | None = None
    title_pattern: str | None = None


@dataclass(frozen=True, slots=True)
class SpatialHint:
    """Last-resort normalized spatial facet; coordinates are 0..1."""

    normalized_x: float
    normalized_y: float
    monitor_index: int
    anchor_offset_x: float
    anchor_offset_y: float

    def __post_init__(self) -> None:
        if not 0.0 <= self.normalized_x <= 1.0:
            raise ValueError(f"normalized_x must be within 0..1, got {self.normalized_x!r}")
        if not 0.0 <= self.normalized_y <= 1.0:
            raise ValueError(f"normalized_y must be within 0..1, got {self.normalized_y!r}")


@dataclass(frozen=True, slots=True)
class Anchor:
    """A cross-time target handle with redundant identity facets.

    Invariants enforced in ``__post_init__``:
    - ``anchor_id`` and ``captured_at_utc`` are non-empty.
    - ``dpi_scale`` is strictly positive.
    """

    anchor_id: str
    app_identity: AppIdentity
    structural_path: str | None = None
    content_hash: str | None = None
    spatial: SpatialHint | None = None
    captured_at_utc: str = ""
    dpi_scale: float = 1.0

    def __post_init__(self) -> None:
        if not self.anchor_id.strip():
            raise ValueError("anchor_id must be non-empty")
        if not self.captured_at_utc.strip():
            raise ValueError("captured_at_utc must be non-empty")
        if self.dpi_scale <= 0:
            raise ValueError(f"dpi_scale must be > 0, got {self.dpi_scale!r}")


def build_anchor(**fields: Any) -> Anchor:
    """Build an :class:`Anchor`, rejecting missing/empty identity fields."""
    anchor_id = fields.get("anchor_id")
    if not anchor_id or not str(anchor_id).strip():
        raise ValueError("anchor_id is required and must be non-empty")
    captured_at = fields.get("captured_at_utc")
    if not captured_at or not str(captured_at).strip():
        raise ValueError("captured_at_utc is required and must be non-empty")
    return Anchor(**fields)


@dataclass(frozen=True, slots=True)
class AnchorResolution:
    """Base of the five-way resolution discriminant union."""

    anchor: Anchor


@dataclass(frozen=True, slots=True)
class ResolutionExact(AnchorResolution):
    """The target is the same object at the same place."""

    evidence: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class ResolutionMoved(AnchorResolution):
    """The same target is now at a (normalized) new position, or unknown."""

    new_position: tuple[float, float] | None
    evidence: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class ResolutionChanged(AnchorResolution):
    """The target's content no longer matches the expected hash."""

    expected_hash: str | None
    actual_hash: str | None
    evidence: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class ResolutionGone(AnchorResolution):
    """The target no longer exists; ``reason`` says why."""

    reason: str


@dataclass(frozen=True, slots=True)
class ResolutionAmbiguous(AnchorResolution):
    """Multiple candidates match; never treated as exact."""

    candidates: tuple[Anchor, ...]
    evidence: tuple[str, ...]

    def __post_init__(self) -> None:
        if len(self.candidates) < 2:
            raise ValueError(
                f"ambiguous resolution requires >= 2 candidates, got {len(self.candidates)}"
            )


def resolution_name(resolution: AnchorResolution) -> str:
    """Return the discriminant name of a resolution: exact/moved/changed/gone/ambiguous."""
    if isinstance(resolution, ResolutionExact):
        return "exact"
    if isinstance(resolution, ResolutionMoved):
        return "moved"
    if isinstance(resolution, ResolutionChanged):
        return "changed"
    if isinstance(resolution, ResolutionGone):
        return "gone"
    if isinstance(resolution, ResolutionAmbiguous):
        return "ambiguous"
    raise TypeError(f"unknown resolution type: {type(resolution).__name__}")


def _identity_to_dict(identity: AppIdentity) -> dict[str, Any]:
    return {
        "process_name": identity.process_name,
        "process_id": identity.process_id,
        "window_class": identity.window_class,
        "title_pattern": identity.title_pattern,
    }


def _spatial_to_dict(spatial: SpatialHint) -> dict[str, Any]:
    return {
        "normalized_x": spatial.normalized_x,
        "normalized_y": spatial.normalized_y,
        "monitor_index": spatial.monitor_index,
        "anchor_offset_x": spatial.anchor_offset_x,
        "anchor_offset_y": spatial.anchor_offset_y,
    }


_ANCHOR_FIELDS = frozenset(
    {
        "anchor_id",
        "app_identity",
        "structural_path",
        "content_hash",
        "spatial",
        "captured_at_utc",
        "dpi_scale",
    }
)
_IDENTITY_FIELDS = frozenset(
    {"process_name", "process_id", "window_class", "title_pattern"}
)
_SPATIAL_FIELDS = frozenset(
    {
        "normalized_x",
        "normalized_y",
        "monitor_index",
        "anchor_offset_x",
        "anchor_offset_y",
    }
)


def to_dict(anchor: Anchor) -> dict[str, Any]:
    """Serialize an anchor to a plain dict (None fields are preserved)."""
    return {
        "anchor_id": anchor.anchor_id,
        "app_identity": _identity_to_dict(anchor.app_identity),
        "structural_path": anchor.structural_path,
        "content_hash": anchor.content_hash,
        "spatial": None if anchor.spatial is None else _spatial_to_dict(anchor.spatial),
        "captured_at_utc": anchor.captured_at_utc,
        "dpi_scale": anchor.dpi_scale,
    }


def _check_strict(
    data: Mapping[str, Any], allowed: frozenset[str], what: str
) -> None:
    unknown = set(data) - allowed
    if unknown:
        raise ValueError(f"unknown {what} fields: {sorted(unknown)}")
    missing = allowed - set(data)
    if missing:
        raise ValueError(f"missing {what} fields: {sorted(missing)}")


def from_dict(data: Mapping[str, Any]) -> Anchor:
    """Deserialize an anchor strictly; unknown or missing fields are rejected."""
    _check_strict(data, _ANCHOR_FIELDS, "anchor")

    identity_raw = data["app_identity"]
    if not isinstance(identity_raw, Mapping):
        raise ValueError("app_identity must be a mapping")
    _check_strict(identity_raw, _IDENTITY_FIELDS, "app_identity")
    identity = AppIdentity(
        process_name=identity_raw["process_name"],
        process_id=identity_raw["process_id"],
        window_class=identity_raw["window_class"],
        title_pattern=identity_raw["title_pattern"],
    )

    spatial: SpatialHint | None = None
    if data["spatial"] is not None:
        spatial_raw = data["spatial"]
        if not isinstance(spatial_raw, Mapping):
            raise ValueError("spatial must be a mapping or None")
        _check_strict(spatial_raw, _SPATIAL_FIELDS, "spatial")
        spatial = SpatialHint(
            normalized_x=spatial_raw["normalized_x"],
            normalized_y=spatial_raw["normalized_y"],
            monitor_index=spatial_raw["monitor_index"],
            anchor_offset_x=spatial_raw["anchor_offset_x"],
            anchor_offset_y=spatial_raw["anchor_offset_y"],
        )

    return Anchor(
        anchor_id=data["anchor_id"],
        app_identity=identity,
        structural_path=data["structural_path"],
        content_hash=data["content_hash"],
        spatial=spatial,
        captured_at_utc=data["captured_at_utc"],
        dpi_scale=data["dpi_scale"],
    )
