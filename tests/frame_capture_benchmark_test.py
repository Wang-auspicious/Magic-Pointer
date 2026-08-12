from __future__ import annotations

from scripts.benchmark_frame_capture import build_report, format_human_summary


def test_report_includes_every_required_field() -> None:
    report = build_report(
        rounds=10,
        success_count=8,
        errors=[{"round": 3, "error": "no_frame_buffered", "message": "no frame"}],
        latencies_ms=[12.0, 20.5, 31.0, 18.0, 42.0, 25.0, 17.0, 60.0],
        backend="gdi-fallback",
        frame_dimensions=(1920, 1080),
        process_reuse_count=1,
        display_bbox=[0, 0, 1920, 1080],
    )
    assert report["rounds"] == 10
    assert report["successes"] == 8
    assert report["errors"] == 1
    assert report["cold_start_ms"] == 12.0
    assert report["warm_p50_ms"] == 25.0
    assert report["p50_ms"] is not None
    assert report["p95_ms"] is not None
    assert report["max_ms"] == 60.0
    assert report["backend"] == "gdi-fallback"
    assert report["frame"] == {"width": 1920, "height": 1080}
    assert report["process_reuse_count"] == 1
    assert report["success_rate"] == 0.8

    summary = format_human_summary(report)
    for token in (
        "rounds",
        "successes",
        "errors",
        "p50",
        "p95",
        "max",
        "backend",
        "process",
    ):
        assert token in summary, f"human summary must mention {token}"


def test_failed_round_stays_in_the_denominator() -> None:
    report = build_report(
        rounds=3,
        success_count=2,
        errors=[{"round": 2, "error": "no_frame_buffered", "message": "no frame"}],
        latencies_ms=[10.0, 20.0],
        backend="test",
        frame_dimensions=(320, 200),
        process_reuse_count=1,
        display_bbox=[0, 0, 320, 200],
    )
    assert report["rounds"] == 3
    assert report["successes"] == 2
    assert report["errors"] == 1
    assert report["success_rate"] == 2 / 3
    assert len(report["failed_rounds"]) == 1
    assert report["failed_rounds"][0]["round"] == 2


def test_empty_latencies_report_nulls_without_crashing() -> None:
    report = build_report(
        rounds=2,
        success_count=0,
        errors=[{"round": 1, "error": "epoch_not_armed", "message": "x"}],
        latencies_ms=[],
        backend="test",
        frame_dimensions=None,
        process_reuse_count=1,
        display_bbox=[0, 0, 320, 200],
    )
    assert report["p50_ms"] is None
    assert report["p95_ms"] is None
    assert report["max_ms"] is None
    assert report["cold_start_ms"] is None
    assert report["success_rate"] == 0.0
    assert format_human_summary(report)
