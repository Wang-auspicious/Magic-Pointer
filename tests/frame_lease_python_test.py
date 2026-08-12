from __future__ import annotations

import json
from pathlib import Path

import pytest

from scripts.frame_lease import FrameLeaseError, normalize_frame_lease


def test_python_accepts_the_shared_v1_fixture() -> None:
    fixture = Path("tests/fixtures/frame-lease-v1.json")
    lease = normalize_frame_lease(json.loads(fixture.read_text(encoding="utf-8")))
    assert lease["frameLeaseId"] == "frame-1"
    assert lease["surfaceBoundsPx"] == [0, 0, 1920, 1080]


def test_python_rejects_a_missing_artifact() -> None:
    with pytest.raises(FrameLeaseError, match="localArtifact"):
        normalize_frame_lease({"schemaVersion": 1, "frameLeaseId": "x"})


def test_python_rejects_wrong_schema_version() -> None:
    with pytest.raises(FrameLeaseError, match="schemaVersion"):
        normalize_frame_lease({})


def test_python_rejects_non_positive_geometry() -> None:
    lease = json.loads(Path("tests/fixtures/frame-lease-v1.json").read_text(encoding="utf-8"))
    lease["surfaceBoundsPx"] = [0, 0, 0, 1080]
    with pytest.raises(FrameLeaseError, match="surfaceBoundsPx"):
        normalize_frame_lease(lease)


def test_python_rejects_unknown_source() -> None:
    lease = json.loads(Path("tests/fixtures/frame-lease-v1.json").read_text(encoding="utf-8"))
    lease["source"] = "grab-all"
    with pytest.raises(FrameLeaseError, match="source"):
        normalize_frame_lease(lease)


def test_python_never_mutates_the_input() -> None:
    lease = json.loads(Path("tests/fixtures/frame-lease-v1.json").read_text(encoding="utf-8"))
    snapshot = json.dumps(lease, sort_keys=True)
    normalize_frame_lease(lease)
    assert json.dumps(lease, sort_keys=True) == snapshot
