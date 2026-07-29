from pathlib import Path

from scripts.verify_browser_selection_alignment import (
    _dom_to_physical_mapping,
    validate_alignment_evidence,
)


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "verify_browser_selection_alignment.py"


def _valid_evidence() -> dict:
    return {
        "targetPointPhysical": {"x": 640, "y": 520},
        "domTargetRectPhysical": {"x": 610, "y": 500, "width": 80, "height": 24},
        "adapterTargetRectPhysical": {"x": 610, "y": 500, "width": 80, "height": 24},
        "stageTargetDip": {"x": 407, "y": 333, "width": 53, "height": 16},
        "projectedStageTargetPhysical": {"x": 610, "y": 500, "width": 80, "height": 24},
        "edgeErrorDip": {"left": 0.0, "top": 0.0, "right": 0.0, "bottom": 0.0},
        "coordinateTransforms": {"scaleFactor": 1.5},
        "screenshot": "evidence.png",
    }


def test_alignment_evidence_requires_complete_low_error_geometry() -> None:
    passed, errors = validate_alignment_evidence(_valid_evidence())
    assert passed is True
    assert errors == []


def test_alignment_evidence_rejects_missing_or_high_error_fields() -> None:
    missing = _valid_evidence()
    missing.pop("adapterTargetRectPhysical")
    passed, errors = validate_alignment_evidence(missing)
    assert passed is False
    assert "missing:adapterTargetRectPhysical" in errors

    drifted = _valid_evidence()
    drifted["edgeErrorDip"]["right"] = 2.01
    passed, errors = validate_alignment_evidence(drifted)
    assert passed is False
    assert "edge_error_exceeds_2_dip" in errors


def test_dom_mapping_uses_win32_client_origin_not_symmetric_outer_chrome() -> None:
    mapping = _dom_to_physical_mapping(
        {"hwnd": 1, "bbox": [251, 160, 2309, 1949]},
        {
            "outerWidth": 1040,
            "outerHeight": 900,
            "innerWidth": 1019,
            "innerHeight": 810,
            "devicePixelRatio": 2,
        },
        client_bounds={"x": 262, "y": 210, "width": 2038, "height": 1730},
    )
    assert mapping["contentOriginPhysical"] == {"x": 262, "y": 320}
    assert mapping["scaleX"] == 2
    assert mapping["scaleY"] == 2


def test_alignment_harness_foregrounds_exact_fixture_before_point_probe() -> None:
    source = SCRIPT.read_text(encoding="utf-8")
    assert "def _bring_to_foreground(" in source
    assert '_bring_to_foreground(int(window["hwnd"]), target_point)' in source
    assert "WindowFromPoint" in source
    assert "GetAncestor(point_window, 2)" in source
