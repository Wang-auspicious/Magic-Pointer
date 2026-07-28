from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path

from app.fabric.target_lease import TargetLease, reconfirm_target_lease, validate_target_lease


def _screen_object(tmp_path: Path) -> dict:
    capture = tmp_path / "capture.png"
    capture.write_bytes(b"first-capture")
    return {
        "id": "screen-1",
        "kind": "screen_region",
        "label": "THIS",
        "content": "Save button overlaps the card",
        "bbox": [10, 20, 300, 240],
        "source": {
            "app": "code.exe",
            "title": "Magic Pointer - Visual Studio Code",
            "hwnd": 42,
            "processId": 314,
            "path": str(capture),
            "screenshotPath": str(capture),
        },
    }


def test_lease_fingerprint_is_stable_under_mapping_order(tmp_path: Path) -> None:
    obj = _screen_object(tmp_path)
    reordered = {
        "source": dict(reversed(list(obj["source"].items()))),
        "bbox": obj["bbox"],
        "content": obj["content"],
        "label": obj["label"],
        "kind": obj["kind"],
        "id": obj["id"],
    }
    now = datetime(2026, 7, 26, 8, 0, tzinfo=timezone.utc)

    first = TargetLease.create([obj], selection_session_id="session-1", now=now)
    second = TargetLease.create([reordered], selection_session_id="session-1", now=now)

    assert first.object_fingerprint == second.object_fingerprint
    assert first.capture_fingerprint == second.capture_fingerprint
    assert first.window == {
        "hwnd": 42,
        "processId": 314,
        "app": "code.exe",
        "title": "Magic Pointer - Visual Studio Code",
    }
    assert first.requires_live_validation is True


def test_lease_fingerprint_changes_with_object_or_capture(tmp_path: Path) -> None:
    now = datetime(2026, 7, 26, 8, 0, tzinfo=timezone.utc)
    obj = _screen_object(tmp_path)
    original = TargetLease.create([obj], now=now)

    changed_object = {**obj, "content": "Different selected content"}
    changed = TargetLease.create([changed_object], now=now)
    assert changed.object_fingerprint != original.object_fingerprint

    Path(obj["source"]["path"]).write_bytes(b"second-capture")
    changed_capture = TargetLease.create([obj], now=now)
    assert changed_capture.capture_fingerprint != original.capture_fingerprint


def test_live_window_identity_must_match_hwnd_and_process(tmp_path: Path) -> None:
    now = datetime(2026, 7, 26, 8, 0, tzinfo=timezone.utc)
    lease = TargetLease.create([_screen_object(tmp_path)], now=now).to_dict()

    valid = validate_target_lease(
        lease,
        live_windows=[{"hwnd": 42, "pid": 314, "title": "Magic Pointer - Visual Studio Code"}],
        now=now + timedelta(seconds=30),
    )
    wrong_process = validate_target_lease(
        lease,
        live_windows=[{"hwnd": 42, "pid": 999}],
        now=now + timedelta(seconds=30),
    )
    missing = validate_target_lease(
        lease,
        live_windows=[],
        now=now + timedelta(seconds=30),
    )

    assert valid.valid is True
    assert valid.reason == "live_target_match"
    assert wrong_process.valid is False
    assert wrong_process.reason == "stale_target_window"
    assert missing.valid is False
    assert missing.reason == "stale_target_window"


def test_title_or_desktop_change_pauses_the_same_hwnd_and_process(tmp_path: Path) -> None:
    now = datetime(2026, 7, 26, 8, 0, tzinfo=timezone.utc)
    obj = _screen_object(tmp_path)
    obj["source"]["desktopId"] = "desktop-1"
    lease = TargetLease.create([obj], now=now).to_dict()

    renamed = validate_target_lease(
        lease,
        live_windows=[{
            "hwnd": 42,
            "pid": 314,
            "title": "Different document",
            "desktopId": "desktop-1",
        }],
        now=now + timedelta(seconds=30),
    )
    moved = validate_target_lease(
        lease,
        live_windows=[{
            "hwnd": 42,
            "pid": 314,
            "title": "Magic Pointer - Visual Studio Code",
            "desktopId": "desktop-2",
        }],
        now=now + timedelta(seconds=30),
    )

    assert renamed.to_dict() == {"valid": False, "reason": "target_window_title_changed"}
    assert moved.to_dict() == {"valid": False, "reason": "target_desktop_changed"}


def test_capture_mutation_invalidates_long_running_lease(tmp_path: Path) -> None:
    now = datetime(2026, 7, 26, 8, 0, tzinfo=timezone.utc)
    obj = _screen_object(tmp_path)
    lease = TargetLease.create([obj], now=now).to_dict()
    Path(obj["source"]["path"]).write_bytes(b"replaced-after-plan")

    result = validate_target_lease(
        lease,
        live_windows=[{
            "hwnd": 42,
            "pid": 314,
            "title": "Magic Pointer - Visual Studio Code",
        }],
        now=now + timedelta(seconds=30),
    )

    assert result.to_dict() == {"valid": False, "reason": "target_capture_changed"}


def test_explicit_reconfirmation_renews_paused_lease_without_changing_object_identity(tmp_path: Path) -> None:
    now = datetime(2026, 7, 26, 8, 0, tzinfo=timezone.utc)
    obj = _screen_object(tmp_path)
    obj["source"]["desktopId"] = "desktop-1"
    original = TargetLease.create([obj], now=now).to_dict()

    renewed = reconfirm_target_lease(
        original,
        confirmed_windows=[{
            "hwnd": 84,
            "pid": 628,
            "app": "code.exe",
            "title": "Magic Pointer - Visual Studio Code",
            "desktopId": "desktop-2",
        }],
        now=now + timedelta(minutes=2),
    )

    assert renewed["leaseId"] != original["leaseId"]
    assert renewed["previousLeaseId"] == original["leaseId"]
    assert renewed["revision"] == 2
    assert renewed["objectFingerprint"] == original["objectFingerprint"]
    assert renewed["captureFingerprint"] == original["captureFingerprint"]
    assert renewed["window"]["hwnd"] == 84
    assert validate_target_lease(
        renewed,
        live_windows=[{
            "hwnd": 84,
            "pid": 628,
            "title": "Magic Pointer - Visual Studio Code",
            "desktopId": "desktop-2",
        }],
        now=now + timedelta(minutes=2, seconds=5),
    ).valid is True


def test_expired_lease_is_rejected_before_window_probe(tmp_path: Path) -> None:
    now = datetime(2026, 7, 26, 8, 0, tzinfo=timezone.utc)
    lease = TargetLease.create([_screen_object(tmp_path)], ttl_seconds=5, now=now).to_dict()
    result = validate_target_lease(
        lease,
        live_windows=[{"hwnd": 42, "pid": 314}],
        now=now + timedelta(seconds=6),
    )
    assert result.valid is False
    assert result.reason == "target_lease_expired"


def test_non_window_object_has_a_valid_non_live_lease(tmp_path: Path) -> None:
    now = datetime(2026, 7, 26, 8, 0, tzinfo=timezone.utc)
    lease = TargetLease.create(
        [{
            "id": "file-1",
            "kind": "file",
            "content": "report",
            "source": {"path": str(tmp_path / "report.md")},
        }],
        now=now,
    ).to_dict()
    result = validate_target_lease(lease, live_windows=None, now=now)
    assert lease["requiresLiveValidation"] is False
    assert result.valid is True
    assert result.reason == "lease_does_not_require_live_window"


def test_multi_object_lease_requires_every_distinct_source_window_to_remain_live(tmp_path: Path) -> None:
    now = datetime(2026, 7, 26, 8, 0, tzinfo=timezone.utc)
    first = _screen_object(tmp_path)
    first["referenceLabel"] = "A"
    second = {
        **first,
        "id": "screen-2",
        "referenceLabel": "B",
        "source": {**first["source"], "hwnd": 84, "processId": 628, "title": "Preview"},
    }
    third = {**second, "id": "screen-3", "referenceLabel": "C"}
    lease = TargetLease.create([first, second, third], now=now).to_dict()

    assert lease["windows"] == [
        {"hwnd": 42, "processId": 314, "app": "code.exe", "title": "Magic Pointer - Visual Studio Code"},
        {"hwnd": 84, "processId": 628, "app": "code.exe", "title": "Preview"},
    ]
    all_live = validate_target_lease(
        lease,
        live_windows=[{"hwnd": 42, "pid": 314}, {"hwnd": 84, "pid": 628}],
        now=now + timedelta(seconds=30),
    )
    one_missing = validate_target_lease(
        lease,
        live_windows=[{"hwnd": 42, "pid": 314}],
        now=now + timedelta(seconds=30),
    )
    assert all_live.valid is True
    assert one_missing.valid is False
    assert one_missing.reason == "stale_target_window"

    relabeled = TargetLease.create([{**first, "referenceLabel": "Z"}, second, third], now=now)
    assert relabeled.object_fingerprint != lease["objectFingerprint"]
