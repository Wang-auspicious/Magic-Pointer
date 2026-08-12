"""Tests for the AnchorResolver degradation chain (harness gap review L3).

Covers the resolve() ladder exactly as reviewed:
app_identity (most stable) -> structural_path -> content_hash -> spatial
(last resort), with ambiguous/changed as first-class outcomes. All probes are
fake: nothing touches a real desktop, window, or UI automation API. Probe
call counters also pin down that degradation is lazy (later probes are only
invoked when earlier tiers fail).
"""

from app.anchor import (
    AppIdentity,
    ResolutionAmbiguous,
    ResolutionChanged,
    ResolutionExact,
    ResolutionGone,
    ResolutionMoved,
    SpatialHint,
    build_anchor,
    resolution_name,
)
from app.anchor.resolver import AnchorResolver, resolution_to_dict

EXPECTED_HASH = "sha256:expected-content"
ACTUAL_HASH = "sha256:different-content"

MINIMAL_ARGS = {
    "anchor_id": "anchor-1",
    "app_identity": AppIdentity(process_name="notepad.exe"),
    "captured_at_utc": "2026-08-12T09:00:00Z",
}

SPATIAL = SpatialHint(0.5, 0.25, 0, 12.0, -4.5)


def make_anchor(**overrides):
    args = dict(MINIMAL_ARGS)
    args.update(overrides)
    return build_anchor(**args)


class RecordingProbe:
    """Fake AnchorProbe: configurable outcomes plus per-method call counters."""

    def __init__(
        self,
        *,
        app_match: bool = True,
        app_evidence: str = "app:matched",
        candidates=(),
        content_hash=None,
        spatial_pos=None,
    ) -> None:
        self.app_match = app_match
        self.app_evidence = app_evidence
        self.candidates = tuple(candidates)
        self.content_hash = content_hash
        self.spatial_pos = spatial_pos
        self.calls = {
            "app_matches": 0,
            "structure_candidates": 0,
            "content_hash_at": 0,
            "spatial_position": 0,
        }
        self.content_hint_seen = None

    def app_matches(self, identity: AppIdentity) -> tuple[bool, str]:
        self.calls["app_matches"] += 1
        return self.app_match, self.app_evidence

    def structure_candidates(self, anchor) -> tuple:
        self.calls["structure_candidates"] += 1
        return self.candidates

    def content_hash_at(self, position_hint) -> str | None:
        self.calls["content_hash_at"] += 1
        self.content_hint_seen = position_hint
        return self.content_hash

    def spatial_position(self, anchor) -> tuple[float, float] | None:
        self.calls["spatial_position"] += 1
        return self.spatial_pos


class AppMismatchProbe:
    """App identity fails; any later probe call is a bug to be asserted."""

    def __init__(self) -> None:
        self.calls = {"app_matches": 0, "structure_candidates": 0,
                      "content_hash_at": 0, "spatial_position": 0}

    def app_matches(self, identity: AppIdentity) -> tuple[bool, str]:
        self.calls["app_matches"] += 1
        return False, "app:no-window"

    def structure_candidates(self, anchor) -> tuple:
        self.calls["structure_candidates"] += 1
        raise AssertionError("structure probe must not run after app mismatch")

    def content_hash_at(self, position_hint) -> str | None:
        self.calls["content_hash_at"] += 1
        raise AssertionError("content probe must not run after app mismatch")

    def spatial_position(self, anchor) -> tuple[float, float] | None:
        self.calls["spatial_position"] += 1
        raise AssertionError("spatial probe must not run after app mismatch")


class TestAppIdentityGate:
    def test_app_mismatch_is_gone_without_further_probes(self) -> None:
        probe = AppMismatchProbe()
        resolution = AnchorResolver(probe).resolve(make_anchor())
        assert isinstance(resolution, ResolutionGone)
        assert resolution.reason == "app_identity_mismatch"
        assert resolution_name(resolution) == "gone"
        assert probe.calls == {
            "app_matches": 1,
            "structure_candidates": 0,
            "content_hash_at": 0,
            "spatial_position": 0,
        }

    def test_app_evidence_recorded_in_outer_resolution(self) -> None:
        probe = RecordingProbe(
            app_evidence="uia:foreground=notepad.exe",
            candidates=(make_anchor(anchor_id="c", content_hash=EXPECTED_HASH),),
            content_hash=EXPECTED_HASH,
        )
        resolution = AnchorResolver(probe).resolve(
            make_anchor(content_hash=EXPECTED_HASH)
        )
        assert isinstance(resolution, ResolutionExact)
        assert "uia:foreground=notepad.exe" in resolution.evidence


class TestStructureTier:
    def test_single_candidate_matching_hash_is_exact(self) -> None:
        candidate = make_anchor(
            anchor_id="candidate-1",
            structural_path="Window/3/Edit[1]",
            content_hash=EXPECTED_HASH,
        )
        probe = RecordingProbe(candidates=(candidate,), content_hash="never-read")
        resolution = AnchorResolver(probe).resolve(
            make_anchor(
                structural_path="Window/3/Edit[1]",
                content_hash=EXPECTED_HASH,
                spatial=SPATIAL,
            )
        )
        assert isinstance(resolution, ResolutionExact)
        assert resolution_name(resolution) == "exact"
        assert "structure:1-candidate" in resolution.evidence
        assert "content_hash:match" in resolution.evidence

    def test_single_candidate_mismatched_hash_is_changed(self) -> None:
        candidate = make_anchor(
            anchor_id="candidate-1",
            structural_path="Window/3/Edit[1]",
            content_hash=ACTUAL_HASH,
        )
        probe = RecordingProbe(candidates=(candidate,))
        resolution = AnchorResolver(probe).resolve(
            make_anchor(
                structural_path="Window/3/Edit[1]",
                content_hash=EXPECTED_HASH,
            )
        )
        assert isinstance(resolution, ResolutionChanged)
        assert resolution.expected_hash == EXPECTED_HASH
        assert resolution.actual_hash == ACTUAL_HASH
        assert "content_hash:mismatch" in resolution.evidence

    def test_two_candidates_is_ambiguous_order_preserved(self) -> None:
        first = make_anchor(anchor_id="candidate-1", content_hash=EXPECTED_HASH)
        second = make_anchor(anchor_id="candidate-2", content_hash=EXPECTED_HASH)
        probe = RecordingProbe(candidates=(first, second))
        resolution = AnchorResolver(probe).resolve(
            make_anchor(content_hash=EXPECTED_HASH)
        )
        assert isinstance(resolution, ResolutionAmbiguous)
        assert resolution_name(resolution) == "ambiguous"
        assert resolution.candidates == (first, second)
        assert "structure:2-candidates" in resolution.evidence

    def test_three_candidates_is_ambiguous(self) -> None:
        candidates = tuple(
            make_anchor(anchor_id=f"candidate-{i}", content_hash=EXPECTED_HASH)
            for i in range(3)
        )
        probe = RecordingProbe(candidates=candidates)
        resolution = AnchorResolver(probe).resolve(
            make_anchor(content_hash=EXPECTED_HASH)
        )
        assert isinstance(resolution, ResolutionAmbiguous)
        assert len(resolution.candidates) == 3

    def test_single_candidate_without_expected_hash_is_never_exact(self) -> None:
        candidate = make_anchor(anchor_id="candidate-1", content_hash=ACTUAL_HASH)
        probe = RecordingProbe(candidates=(candidate,))
        resolution = AnchorResolver(probe).resolve(
            make_anchor(structural_path="Window/3/Edit[1]", content_hash=None)
        )
        assert not isinstance(resolution, ResolutionExact)
        assert isinstance(resolution, ResolutionChanged)
        assert resolution.expected_hash is None
        assert resolution.actual_hash == ACTUAL_HASH


class TestContentTier:
    def test_content_match_is_moved_with_content_evidence(self) -> None:
        probe = RecordingProbe(candidates=(), content_hash=EXPECTED_HASH)
        anchor = make_anchor(content_hash=EXPECTED_HASH, spatial=SPATIAL)
        resolution = AnchorResolver(probe).resolve(anchor)
        assert isinstance(resolution, ResolutionMoved)
        assert resolution.new_position == (0.5, 0.25)
        assert "content_hash:match" in resolution.evidence
        assert "structure:0-candidates" in resolution.evidence
        assert probe.content_hint_seen is SPATIAL

    def test_content_mismatch_is_changed(self) -> None:
        probe = RecordingProbe(candidates=(), content_hash=ACTUAL_HASH, spatial_pos=(0.9, 0.1))
        resolution = AnchorResolver(probe).resolve(
            make_anchor(content_hash=EXPECTED_HASH, spatial=SPATIAL)
        )
        assert isinstance(resolution, ResolutionChanged)
        assert resolution.expected_hash == EXPECTED_HASH
        assert resolution.actual_hash == ACTUAL_HASH
        assert "content_hash:mismatch" in resolution.evidence
        assert probe.calls["spatial_position"] == 0

    def test_content_unreadable_falls_back_to_spatial(self) -> None:
        probe = RecordingProbe(candidates=(), content_hash=None, spatial_pos=(0.9, 0.2))
        resolution = AnchorResolver(probe).resolve(
            make_anchor(content_hash=EXPECTED_HASH, spatial=SPATIAL)
        )
        assert isinstance(resolution, ResolutionMoved)
        assert resolution.new_position == (0.9, 0.2)
        assert "spatial_fallback" in resolution.evidence
        assert "content_hash:unreadable" in resolution.evidence

    def test_nothing_survives_is_gone(self) -> None:
        probe = RecordingProbe(candidates=(), content_hash=None, spatial_pos=None)
        resolution = AnchorResolver(probe).resolve(
            make_anchor(content_hash=EXPECTED_HASH)
        )
        assert isinstance(resolution, ResolutionGone)
        assert resolution.reason == "no_surviving_evidence"


class TestLazyDegradation:
    def test_exact_chain_call_counts(self) -> None:
        candidate = make_anchor(anchor_id="c", content_hash=EXPECTED_HASH)
        probe = RecordingProbe(candidates=(candidate,), content_hash=EXPECTED_HASH)
        AnchorResolver(probe).resolve(make_anchor(content_hash=EXPECTED_HASH))
        assert probe.calls == {
            "app_matches": 1,
            "structure_candidates": 1,
            "content_hash_at": 0,
            "spatial_position": 0,
        }

    def test_content_tier_runs_when_structure_finds_nothing(self) -> None:
        probe = RecordingProbe(candidates=(), content_hash=EXPECTED_HASH)
        AnchorResolver(probe).resolve(
            make_anchor(content_hash=EXPECTED_HASH, spatial=SPATIAL)
        )
        assert probe.calls == {
            "app_matches": 1,
            "structure_candidates": 1,
            "content_hash_at": 1,
            "spatial_position": 0,
        }

    def test_ambiguous_skips_content_and_spatial_probes(self) -> None:
        probe = RecordingProbe(
            candidates=(make_anchor(anchor_id="a"), make_anchor(anchor_id="b"))
        )
        AnchorResolver(probe).resolve(make_anchor(content_hash=EXPECTED_HASH))
        assert probe.calls["app_matches"] == 1
        assert probe.calls["structure_candidates"] == 1
        assert probe.calls["content_hash_at"] == 0
        assert probe.calls["spatial_position"] == 0

    def test_spatial_fallback_runs_full_ladder(self) -> None:
        probe = RecordingProbe(candidates=(), content_hash=None, spatial_pos=(0.4, 0.6))
        AnchorResolver(probe).resolve(make_anchor(content_hash=EXPECTED_HASH))
        assert probe.calls == {
            "app_matches": 1,
            "structure_candidates": 1,
            "content_hash_at": 1,
            "spatial_position": 1,
        }

    def test_gone_runs_full_ladder_once(self) -> None:
        probe = RecordingProbe(candidates=(), content_hash=None, spatial_pos=None)
        AnchorResolver(probe).resolve(make_anchor(content_hash=EXPECTED_HASH))
        assert probe.calls == {
            "app_matches": 1,
            "structure_candidates": 1,
            "content_hash_at": 1,
            "spatial_position": 1,
        }


class TestResolutionToDict:
    def test_exact_kind_and_evidence(self) -> None:
        anchor = make_anchor(content_hash=EXPECTED_HASH)
        data = resolution_to_dict(ResolutionExact(anchor, ("app:matched", "content_hash:match")))
        assert data["kind"] == "exact"
        assert data["anchor"]["anchor_id"] == "anchor-1"
        assert data["evidence"] == ["app:matched", "content_hash:match"]

    def test_moved_kind_positions(self) -> None:
        anchor = make_anchor()
        with_pos = resolution_to_dict(ResolutionMoved(anchor, (0.9, 0.2), ("spatial_fallback",)))
        assert with_pos["kind"] == "moved"
        assert with_pos["new_position"] == [0.9, 0.2]
        without_pos = resolution_to_dict(ResolutionMoved(anchor, None, ("content_hash:match",)))
        assert without_pos["new_position"] is None

    def test_changed_kind_hashes(self) -> None:
        anchor = make_anchor(content_hash=EXPECTED_HASH)
        data = resolution_to_dict(ResolutionChanged(anchor, EXPECTED_HASH, ACTUAL_HASH, ("content_hash:mismatch",)))
        assert data["kind"] == "changed"
        assert data["expected_hash"] == EXPECTED_HASH
        assert data["actual_hash"] == ACTUAL_HASH

    def test_gone_kind_reason(self) -> None:
        data = resolution_to_dict(ResolutionGone(make_anchor(), "app_identity_mismatch"))
        assert data["kind"] == "gone"
        assert data["reason"] == "app_identity_mismatch"

    def test_ambiguous_kind_candidates(self) -> None:
        anchor = make_anchor()
        first = make_anchor(anchor_id="a")
        second = make_anchor(anchor_id="b")
        data = resolution_to_dict(ResolutionAmbiguous(anchor, (first, second), ("structure:2-candidates",)))
        assert data["kind"] == "ambiguous"
        assert [c["anchor_id"] for c in data["candidates"]] == ["a", "b"]
        assert data["evidence"] == ["structure:2-candidates"]
