
from __future__ import annotations

from typing import Any, Protocol, runtime_checkable

from .anchor import (
    Anchor,
    AnchorResolution,
    AppIdentity,
    ResolutionAmbiguous,
    ResolutionChanged,
    ResolutionExact,
    ResolutionGone,
    ResolutionMoved,
    SpatialHint,
    resolution_name,
    to_dict,
)


@runtime_checkable
class AnchorProbe(Protocol):

    def app_matches(self, identity: AppIdentity) -> tuple[bool, str]:
        ...

    def structure_candidates(self, anchor: Anchor) -> tuple[Anchor, ...]:
        ...

    def content_hash_at(self, position_hint: SpatialHint | None) -> str | None:
        ...

    def spatial_position(self, anchor: Anchor) -> tuple[float, float] | None:
        ...


class AnchorResolver:

    def __init__(self, probe: AnchorProbe) -> None:
        self._probe = probe

    def resolve(self, anchor: Anchor) -> AnchorResolution:
        matched, app_evidence = self._probe.app_matches(anchor.app_identity)
        if not matched:
            return ResolutionGone(anchor=anchor, reason="app_identity_mismatch")

        candidates = self._probe.structure_candidates(anchor)
        if candidates:
            return self._resolve_structure(anchor, app_evidence, candidates)

        base_evidence = (app_evidence, "structure:0-candidates")
        hint = anchor.spatial
        actual = self._probe.content_hash_at(hint)
        if actual is not None:
            expected = anchor.content_hash
            if expected is not None and actual == expected:
                new_position = (
                    (hint.normalized_x, hint.normalized_y) if hint is not None else None
                )
                return ResolutionMoved(
                    anchor=anchor,
                    new_position=new_position,
                    evidence=base_evidence + ("content_hash:match",),
                )
            if expected is not None:
                return ResolutionChanged(
                    anchor=anchor,
                    expected_hash=expected,
                    actual_hash=actual,
                    evidence=base_evidence + ("content_hash:mismatch",),
                )
            base_evidence += ("content_hash:unverifiable",)
            return ResolutionChanged(
                anchor=anchor,
                expected_hash=None,
                actual_hash=actual,
                evidence=base_evidence,
            )
        return self._resolve_spatial(anchor, base_evidence + ("content_hash:unreadable",))

    def _resolve_structure(
        self,
        anchor: Anchor,
        app_evidence: str,
        candidates: tuple[Anchor, ...],
    ) -> AnchorResolution:
        if len(candidates) >= 2:
            return ResolutionAmbiguous(
                anchor=anchor,
                candidates=candidates,
                evidence=(app_evidence, f"structure:{len(candidates)}-candidates"),
            )
        candidate = candidates[0]
        structure_evidence = (app_evidence, "structure:1-candidate")
        expected = anchor.content_hash
        if expected is not None and candidate.content_hash == expected:
            return ResolutionExact(
                anchor=anchor,
                evidence=structure_evidence + ("content_hash:match",),
            )
        return ResolutionChanged(
            anchor=anchor,
            expected_hash=expected,
            actual_hash=candidate.content_hash,
            evidence=structure_evidence + ("content_hash:mismatch",),
        )

    def _resolve_spatial(
        self,
        anchor: Anchor,
        base_evidence: tuple[str, ...],
    ) -> AnchorResolution:
        position = self._probe.spatial_position(anchor)
        if position is not None:
            return ResolutionMoved(
                anchor=anchor,
                new_position=position,
                evidence=base_evidence + ("spatial_fallback",),
            )
        return ResolutionGone(anchor=anchor, reason="no_surviving_evidence")


def resolution_to_dict(resolution: AnchorResolution) -> dict[str, Any]:
    base: dict[str, Any] = {
        "kind": resolution_name(resolution),
        "anchor": to_dict(resolution.anchor),
    }
    if isinstance(resolution, ResolutionExact):
        base["evidence"] = list(resolution.evidence)
    elif isinstance(resolution, ResolutionMoved):
        base["new_position"] = (
            list(resolution.new_position) if resolution.new_position is not None else None
        )
        base["evidence"] = list(resolution.evidence)
    elif isinstance(resolution, ResolutionChanged):
        base["expected_hash"] = resolution.expected_hash
        base["actual_hash"] = resolution.actual_hash
        base["evidence"] = list(resolution.evidence)
    elif isinstance(resolution, ResolutionGone):
        base["reason"] = resolution.reason
    elif isinstance(resolution, ResolutionAmbiguous):
        base["candidates"] = [to_dict(candidate) for candidate in resolution.candidates]
        base["evidence"] = list(resolution.evidence)
    else:
        raise TypeError(f"unknown resolution type: {type(resolution).__name__}")
    return base
