"""Tests for the Anchor model (harness gap review L3).

Covers: build_anchor construction and validation, the five-way
AnchorResolution discriminant union with resolution_name, the >=2 candidates
invariant of ResolutionAmbiguous, strict to_dict/from_dict serialization, and
immutability of the Anchor dataclass.
"""

import dataclasses

import pytest

from app.anchor import (
    AppIdentity,
    ResolutionAmbiguous,
    ResolutionChanged,
    ResolutionExact,
    ResolutionGone,
    ResolutionMoved,
    SpatialHint,
    build_anchor,
    from_dict,
    resolution_name,
    to_dict,
)

FULL_IDENTITY = AppIdentity(
    process_name="notepad.exe",
    process_id=1234,
    window_class="Notepad",
    title_pattern=r"* - 记事本",
)
FULL_SPATIAL = SpatialHint(
    normalized_x=0.5,
    normalized_y=0.25,
    monitor_index=0,
    anchor_offset_x=12.0,
    anchor_offset_y=-4.5,
)

MINIMAL_ARGS = {
    "anchor_id": "anchor-1",
    "app_identity": AppIdentity(process_name="notepad.exe"),
    "captured_at_utc": "2026-08-12T09:00:00Z",
}


def make_anchor(**overrides):
    args = dict(MINIMAL_ARGS)
    args.update(overrides)
    return build_anchor(**args)


class TestBuildAnchor:
    def test_full_fields(self) -> None:
        anchor = build_anchor(
            anchor_id="anchor-9",
            app_identity=FULL_IDENTITY,
            structural_path="Window/3/Edit[1]",
            content_hash="a1b2c3d4",
            spatial=FULL_SPATIAL,
            captured_at_utc="2026-08-12T09:00:00Z",
            dpi_scale=1.5,
        )
        assert anchor.anchor_id == "anchor-9"
        assert anchor.app_identity is FULL_IDENTITY
        assert anchor.structural_path == "Window/3/Edit[1]"
        assert anchor.content_hash == "a1b2c3d4"
        assert anchor.spatial is FULL_SPATIAL
        assert anchor.captured_at_utc == "2026-08-12T09:00:00Z"
        assert anchor.dpi_scale == 1.5

    def test_minimal_fields(self) -> None:
        anchor = make_anchor()
        assert anchor.anchor_id == "anchor-1"
        assert anchor.app_identity == AppIdentity(process_name="notepad.exe")
        assert anchor.structural_path is None
        assert anchor.content_hash is None
        assert anchor.spatial is None
        assert anchor.captured_at_utc == "2026-08-12T09:00:00Z"
        assert anchor.dpi_scale == 1.0

    def test_missing_anchor_id_rejected(self) -> None:
        args = dict(MINIMAL_ARGS)
        del args["anchor_id"]
        with pytest.raises(ValueError):
            build_anchor(**args)

    def test_empty_anchor_id_rejected(self) -> None:
        with pytest.raises(ValueError):
            make_anchor(anchor_id="")
        with pytest.raises(ValueError):
            make_anchor(anchor_id="   ")

    def test_missing_captured_at_rejected(self) -> None:
        args = dict(MINIMAL_ARGS)
        del args["captured_at_utc"]
        with pytest.raises(ValueError):
            build_anchor(**args)

    def test_empty_captured_at_rejected(self) -> None:
        with pytest.raises(ValueError):
            make_anchor(captured_at_utc="")

    def test_normalized_x_out_of_range_rejected(self) -> None:
        with pytest.raises(ValueError):
            build_anchor(
                anchor_id="a",
                app_identity=AppIdentity(process_name="x"),
                captured_at_utc="t",
                spatial=SpatialHint(-0.1, 0.5, 0, 0.0, 0.0),
            )

    def test_normalized_y_out_of_range_rejected(self) -> None:
        with pytest.raises(ValueError):
            build_anchor(
                anchor_id="a",
                app_identity=AppIdentity(process_name="x"),
                captured_at_utc="t",
                spatial=SpatialHint(0.5, 1.5, 0, 0.0, 0.0),
            )

    def test_spatial_hint_boundaries_accepted(self) -> None:
        SpatialHint(0.0, 1.0, 0, 0.0, 0.0)
        SpatialHint(1.0, 0.0, 0, 0.0, 0.0)

    def test_dpi_scale_zero_rejected(self) -> None:
        with pytest.raises(ValueError):
            make_anchor(dpi_scale=0.0)

    def test_dpi_scale_negative_rejected(self) -> None:
        with pytest.raises(ValueError):
            make_anchor(dpi_scale=-1.0)


class TestResolutionUnion:
    def test_exact(self) -> None:
        anchor = make_anchor()
        res = ResolutionExact(anchor=anchor, evidence=("uia:ok", "hash-match"))
        assert res.anchor is anchor
        assert res.evidence == ("uia:ok", "hash-match")

    def test_moved(self) -> None:
        anchor = make_anchor()
        with_pos = ResolutionMoved(
            anchor=anchor,
            new_position=(0.3, 0.7),
            evidence=("uia:recreated",),
        )
        assert with_pos.new_position == (0.3, 0.7)
        without_pos = ResolutionMoved(anchor=anchor, new_position=None, evidence=())
        assert without_pos.new_position is None

    def test_changed(self) -> None:
        anchor = make_anchor(content_hash="expected123")
        res = ResolutionChanged(
            anchor=anchor,
            expected_hash="expected123",
            actual_hash="different456",
            evidence=("ocr:text-changed",),
        )
        assert res.expected_hash == "expected123"
        assert res.actual_hash == "different456"

    def test_gone(self) -> None:
        anchor = make_anchor()
        res = ResolutionGone(anchor=anchor, reason="window closed")
        assert res.anchor is anchor
        assert res.reason == "window closed"

    def test_ambiguous_with_two_candidates(self) -> None:
        anchor = make_anchor(anchor_id="a-1")
        candidate_a = make_anchor(anchor_id="a-2")
        candidate_b = make_anchor(anchor_id="a-3")
        res = ResolutionAmbiguous(
            anchor=anchor,
            candidates=(candidate_a, candidate_b),
            evidence=("uia:two-matches",),
        )
        assert res.candidates == (candidate_a, candidate_b)

    def test_ambiguous_with_one_candidate_rejected(self) -> None:
        anchor = make_anchor()
        with pytest.raises(ValueError):
            ResolutionAmbiguous(
                anchor=anchor,
                candidates=(anchor,),
                evidence=("uia:one-match",),
            )

    def test_resolution_name_mapping(self) -> None:
        anchor = make_anchor()
        assert resolution_name(ResolutionExact(anchor, ())) == "exact"
        assert resolution_name(ResolutionMoved(anchor, None, ())) == "moved"
        assert resolution_name(ResolutionChanged(anchor, None, None, ())) == "changed"
        assert resolution_name(ResolutionGone(anchor, "gone")) == "gone"
        ambiguous = ResolutionAmbiguous(anchor, (make_anchor(anchor_id="b"), make_anchor(anchor_id="c")), ())
        assert resolution_name(ambiguous) == "ambiguous"


class TestSerialization:
    def test_roundtrip_full(self) -> None:
        anchor = build_anchor(
            anchor_id="anchor-7",
            app_identity=FULL_IDENTITY,
            structural_path="Window/3/Edit[1]",
            content_hash="a1b2c3d4",
            spatial=FULL_SPATIAL,
            captured_at_utc="2026-08-12T09:00:00Z",
            dpi_scale=1.5,
        )
        assert from_dict(to_dict(anchor)) == anchor

    def test_roundtrip_minimal_preserves_none_fields(self) -> None:
        anchor = make_anchor()
        data = to_dict(anchor)
        assert data["structural_path"] is None
        assert data["content_hash"] is None
        assert data["spatial"] is None
        assert from_dict(data) == anchor

    def test_to_dict_structure(self) -> None:
        data = to_dict(make_anchor())
        assert data["app_identity"]["process_name"] == "notepad.exe"
        assert data["app_identity"]["process_id"] is None
        assert data["dpi_scale"] == 1.0

    def test_from_dict_rejects_unknown_top_level_field(self) -> None:
        data = to_dict(make_anchor())
        data["bogus"] = 1
        with pytest.raises(ValueError):
            from_dict(data)

    def test_from_dict_rejects_unknown_nested_field(self) -> None:
        data = to_dict(make_anchor())
        data["app_identity"]["bogus"] = 1
        with pytest.raises(ValueError):
            from_dict(data)

    def test_from_dict_rejects_missing_field(self) -> None:
        data = to_dict(make_anchor())
        del data["structural_path"]
        with pytest.raises(ValueError):
            from_dict(data)


class TestImmutability:
    def test_anchor_is_frozen(self) -> None:
        anchor = make_anchor()
        with pytest.raises(dataclasses.FrozenInstanceError):
            anchor.anchor_id = "other"
        with pytest.raises(dataclasses.FrozenInstanceError):
            anchor.captured_at_utc = "later"

    def test_nested_models_are_frozen(self) -> None:
        with pytest.raises(dataclasses.FrozenInstanceError):
            AppIdentity(process_name="x").process_name = "y"
        with pytest.raises(dataclasses.FrozenInstanceError):
            SpatialHint(0.5, 0.5, 0, 0.0, 0.0).normalized_x = 0.1
