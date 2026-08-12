"""Tests for the per-app capability matrix and /doctor report (review L13/L14, task C1).

Covers: capability/status enum completeness; matrix upsert/get/status_for/apps;
JSON save/load roundtrip with corrupt-input errors; KNOWN_CAPABILITIES; doctor
verdict rules (unknown != failed); capability_summary expansion; factory
functions; concurrent access; report field completeness.
"""

from __future__ import annotations

import json
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest

from app.permissions import (
    KNOWN_CAPABILITIES,
    Capability,
    CapabilityEntry,
    CapabilityMatrix,
    CapabilityMatrixError,
    CapabilityStatus,
    entry_dict,
)
from app.telemetry import DoctorReport, HealthCheckResult, build_doctor_report


class TestEnums:
    def test_capability_enum_has_all_six(self) -> None:
        assert {c.value for c in Capability} == {
            "read_text",
            "read_structure",
            "write_back",
            "precise_location",
            "ocr",
            "vision",
        }

    def test_capability_status_enum_has_three(self) -> None:
        assert {s.value for s in CapabilityStatus} == {
            "available",
            "needs_unlock",
            "unsupported",
        }

    def test_capability_is_str_enum(self) -> None:
        assert Capability("read_text") is Capability.READ_TEXT
        assert Capability.READ_TEXT == "read_text"

    def test_capability_status_is_str_enum(self) -> None:
        assert CapabilityStatus("needs_unlock") is CapabilityStatus.NEEDS_UNLOCK
        assert CapabilityStatus.AVAILABLE == "available"


class TestMatrixOps:
    def test_set_get_roundtrip(self) -> None:
        matrix = CapabilityMatrix()
        matrix.set("chrome", Capability.READ_TEXT, CapabilityStatus.AVAILABLE)
        assert matrix.get("chrome", Capability.READ_TEXT) is CapabilityStatus.AVAILABLE

    def test_get_unknown_app_returns_none(self) -> None:
        matrix = CapabilityMatrix()
        matrix.set("chrome", Capability.OCR, CapabilityStatus.NEEDS_UNLOCK)
        assert matrix.get("wechat", Capability.OCR) is None

    def test_get_unknown_capability_returns_none(self) -> None:
        matrix = CapabilityMatrix()
        matrix.set("chrome", Capability.OCR, CapabilityStatus.AVAILABLE)
        assert matrix.get("chrome", Capability.VISION) is None

    def test_upsert_overwrites_status(self) -> None:
        matrix = CapabilityMatrix()
        matrix.set("chrome", Capability.WRITE_BACK, CapabilityStatus.UNSUPPORTED)
        matrix.set("chrome", Capability.WRITE_BACK, CapabilityStatus.AVAILABLE)
        assert matrix.get("chrome", Capability.WRITE_BACK) is CapabilityStatus.AVAILABLE

    def test_upsert_updates_notes(self) -> None:
        matrix = CapabilityMatrix()
        matrix.set("chrome", Capability.READ_TEXT, CapabilityStatus.NEEDS_UNLOCK)
        matrix.set(
            "chrome",
            Capability.READ_TEXT,
            CapabilityStatus.AVAILABLE,
            notes="debug port open",
        )
        entry = matrix._entries[("chrome", Capability.READ_TEXT)]
        assert entry.notes == "debug port open"

    def test_set_accepts_plain_value_strings(self) -> None:
        matrix = CapabilityMatrix()
        matrix.set("chrome", "read_text", "available")
        assert matrix.get("chrome", Capability.READ_TEXT) is CapabilityStatus.AVAILABLE

    def test_set_rejects_unknown_status(self) -> None:
        matrix = CapabilityMatrix()
        with pytest.raises(ValueError):
            matrix.set("chrome", Capability.READ_TEXT, "maybe")

    def test_status_for_returns_mapping(self) -> None:
        matrix = CapabilityMatrix()
        matrix.set("chrome", Capability.READ_TEXT, CapabilityStatus.AVAILABLE)
        matrix.set("chrome", Capability.WRITE_BACK, CapabilityStatus.UNSUPPORTED)
        assert matrix.status_for("chrome") == {
            Capability.READ_TEXT: CapabilityStatus.AVAILABLE,
            Capability.WRITE_BACK: CapabilityStatus.UNSUPPORTED,
        }

    def test_status_for_unknown_app_is_empty(self) -> None:
        assert CapabilityMatrix().status_for("nope") == {}

    def test_apps_returns_sorted_unique(self) -> None:
        matrix = CapabilityMatrix()
        matrix.set("wechat", Capability.READ_TEXT, CapabilityStatus.UNSUPPORTED)
        matrix.set("chrome", Capability.OCR, CapabilityStatus.AVAILABLE)
        matrix.set("wechat", Capability.VISION, CapabilityStatus.AVAILABLE)
        assert matrix.apps() == ["chrome", "wechat"]

    def test_entry_dict_shape(self) -> None:
        entry = CapabilityEntry(
            app="chrome",
            capability=Capability.READ_TEXT,
            status=CapabilityStatus.AVAILABLE,
            notes="ok",
        )
        assert entry_dict(entry) == {
            "app": "chrome",
            "capability": "read_text",
            "status": "available",
            "notes": "ok",
        }

    def test_entry_dict_without_notes(self) -> None:
        entry = CapabilityEntry(
            app="chrome",
            capability=Capability.OCR,
            status=CapabilityStatus.NEEDS_UNLOCK,
        )
        assert entry_dict(entry)["notes"] is None


class TestMatrixPersistence:
    def test_save_load_roundtrip(self, tmp_path) -> None:
        path = tmp_path / "matrix.json"
        matrix = CapabilityMatrix()
        matrix.set("chrome", Capability.READ_TEXT, CapabilityStatus.AVAILABLE, notes="ok")
        matrix.set("wechat", Capability.READ_TEXT, CapabilityStatus.UNSUPPORTED)
        matrix.save(path)
        loaded = CapabilityMatrix.load(path)
        assert loaded.apps() == matrix.apps()
        assert loaded.status_for("chrome") == matrix.status_for("chrome")
        assert loaded.get("wechat", Capability.READ_TEXT) is CapabilityStatus.UNSUPPORTED

    def test_load_bad_json_raises(self, tmp_path) -> None:
        path = tmp_path / "bad.json"
        path.write_text("not json {", encoding="utf-8")
        with pytest.raises(CapabilityMatrixError):
            CapabilityMatrix.load(path)

    def test_load_missing_top_level_entries_raises(self, tmp_path) -> None:
        path = tmp_path / "bad.json"
        path.write_text(json.dumps({"apps": []}), encoding="utf-8")
        with pytest.raises(CapabilityMatrixError):
            CapabilityMatrix.load(path)

    def test_load_missing_entry_field_raises(self, tmp_path) -> None:
        path = tmp_path / "bad.json"
        path.write_text(json.dumps({"entries": [{"app": "chrome"}]}), encoding="utf-8")
        with pytest.raises(CapabilityMatrixError):
            CapabilityMatrix.load(path)

    def test_load_unknown_capability_raises(self, tmp_path) -> None:
        path = tmp_path / "bad.json"
        path.write_text(
            json.dumps(
                {
                    "entries": [
                        {
                            "app": "chrome",
                            "capability": "mind_reading",
                            "status": "available",
                        }
                    ]
                }
            ),
            encoding="utf-8",
        )
        with pytest.raises(CapabilityMatrixError):
            CapabilityMatrix.load(path)

    def test_load_unknown_status_raises(self, tmp_path) -> None:
        path = tmp_path / "bad.json"
        path.write_text(
            json.dumps(
                {
                    "entries": [
                        {
                            "app": "chrome",
                            "capability": "read_text",
                            "status": "maybe",
                        }
                    ]
                }
            ),
            encoding="utf-8",
        )
        with pytest.raises(CapabilityMatrixError):
            CapabilityMatrix.load(path)

    def test_load_empty_entries_is_valid(self, tmp_path) -> None:
        path = tmp_path / "empty.json"
        path.write_text(json.dumps({"entries": []}), encoding="utf-8")
        assert CapabilityMatrix.load(path).apps() == []


class TestKnownCapabilities:
    def test_known_capabilities_match_enum(self) -> None:
        assert set(KNOWN_CAPABILITIES) == set(Capability)

    def test_known_capabilities_no_duplicates(self) -> None:
        assert len(KNOWN_CAPABILITIES) == len(set(KNOWN_CAPABILITIES))


class TestVerdict:
    def test_all_ok_is_healthy(self) -> None:
        checks = [
            HealthCheckResult.ok("uia_host", "resident"),
            HealthCheckResult.ok("model_endpoint"),
        ]
        report = build_doctor_report(CapabilityMatrix(), checks)
        assert report.verdict == "healthy"

    def test_any_failed_is_degraded(self) -> None:
        checks = [
            HealthCheckResult.ok("uia_host"),
            HealthCheckResult.fail("model_endpoint", "connection refused"),
        ]
        report = build_doctor_report(CapabilityMatrix(), checks)
        assert report.verdict == "degraded"

    def test_all_unknown_is_unknown(self) -> None:
        checks = [
            HealthCheckResult.unknown("ocr_warmup"),
            HealthCheckResult.unknown("uia_host"),
        ]
        report = build_doctor_report(CapabilityMatrix(), checks)
        assert report.verdict == "unknown"

    def test_mixed_ok_and_unknown_is_healthy(self) -> None:
        checks = [
            HealthCheckResult.ok("uia_host"),
            HealthCheckResult.unknown("ocr_warmup"),
        ]
        report = build_doctor_report(CapabilityMatrix(), checks)
        assert report.verdict == "healthy"

    def test_failed_dominates_unknown(self) -> None:
        checks = [
            HealthCheckResult.unknown("uia_host"),
            HealthCheckResult.fail("model_endpoint", "timeout"),
            HealthCheckResult.unknown("ocr_warmup"),
        ]
        report = build_doctor_report(CapabilityMatrix(), checks)
        assert report.verdict == "degraded"

    def test_empty_checks_is_unknown(self) -> None:
        assert build_doctor_report(CapabilityMatrix(), []).verdict == "unknown"


class TestCapabilitySummary:
    def test_summary_expands_matrix_by_app(self) -> None:
        matrix = CapabilityMatrix()
        matrix.set("chrome", Capability.READ_TEXT, CapabilityStatus.AVAILABLE)
        matrix.set("chrome", Capability.WRITE_BACK, CapabilityStatus.NEEDS_UNLOCK)
        matrix.set("wechat", Capability.READ_TEXT, CapabilityStatus.UNSUPPORTED)
        report = build_doctor_report(matrix, [HealthCheckResult.ok("uia_host")])
        assert report.capability_summary == {
            "chrome": {
                "read_text": "available",
                "write_back": "needs_unlock",
            },
            "wechat": {"read_text": "unsupported"},
        }

    def test_summary_empty_matrix_is_empty_dict(self) -> None:
        report = build_doctor_report(CapabilityMatrix(), [])
        assert report.capability_summary == {}


class TestFactories:
    def test_ok_factory(self) -> None:
        check = HealthCheckResult.ok("uia_host", "resident")
        assert check.check_id == "uia_host"
        assert check.status == "ok"
        assert check.detail == "resident"

    def test_fail_factory(self) -> None:
        check = HealthCheckResult.fail("model_endpoint", "connection refused")
        assert check.status == "failed"
        assert check.detail == "connection refused"

    def test_unknown_factory(self) -> None:
        check = HealthCheckResult.unknown("ocr_warmup")
        assert check.status == "unknown"
        assert check.detail is None

    def test_factory_ok_without_detail(self) -> None:
        assert HealthCheckResult.ok("uia_host").detail is None

    def test_factory_check_id_derived_and_unique(self) -> None:
        a = HealthCheckResult.ok("uia host")
        b = HealthCheckResult.fail("model_endpoint", "x")
        assert a.check_id != b.check_id
        assert a.label == "uia host"


class TestConcurrency:
    def test_eight_threads_set_matrix(self) -> None:
        matrix = CapabilityMatrix()
        apps = [f"app_{i}" for i in range(8)]
        capabilities = list(Capability)
        with ThreadPoolExecutor(max_workers=8) as pool:
            futures = [
                pool.submit(matrix.set, apps[i], capabilities[i % len(capabilities)], CapabilityStatus.AVAILABLE)
                for i in range(8)
            ]
            for future in futures:
                future.result(timeout=10)
        assert matrix.apps() == sorted(apps)
        for i in range(8):
            assert matrix.get(apps[i], capabilities[i % len(capabilities)]) is CapabilityStatus.AVAILABLE

    def test_concurrent_reads_and_writes_do_not_crash(self) -> None:
        matrix = CapabilityMatrix()
        errors: list[Exception] = []
        lock = threading.Lock()

        def writer(i: int) -> None:
            for j in range(50):
                matrix.set(f"app_{i}", Capability.OCR, CapabilityStatus.AVAILABLE, notes=str(j))

        def reader() -> None:
            try:
                for _ in range(50):
                    matrix.status_for("app_0")
                    matrix.apps()
            except Exception as exc:  # pragma: no cover - failure path
                with lock:
                    errors.append(exc)

        with ThreadPoolExecutor(max_workers=8) as pool:
            writer_futures = [pool.submit(writer, i) for i in range(4)]
            reader_futures = [pool.submit(reader) for _ in range(4)]
            for future in writer_futures + reader_futures:
                future.result(timeout=30)
        assert errors == []
        assert matrix.get("app_0", Capability.OCR) is CapabilityStatus.AVAILABLE


class TestReportFields:
    def test_report_fields_complete(self) -> None:
        matrix = CapabilityMatrix()
        matrix.set("chrome", Capability.OCR, CapabilityStatus.AVAILABLE)
        checks = [HealthCheckResult.ok("uia_host")]
        report = build_doctor_report(matrix, checks)
        assert isinstance(report, DoctorReport)
        assert report.generated_at_utc
        assert report.checks == (checks[0],)
        assert report.capability_summary == {"chrome": {"ocr": "available"}}
        assert report.verdict == "healthy"

    def test_custom_clock_used(self) -> None:
        def fixed_clock() -> str:
            return "2026-08-13T00:00:00+00:00"

        report = build_doctor_report(CapabilityMatrix(), [], clock=fixed_clock)
        assert report.generated_at_utc == "2026-08-13T00:00:00+00:00"

    def test_checks_are_frozen_tuple(self) -> None:
        report = build_doctor_report(CapabilityMatrix(), [HealthCheckResult.ok("a")])
        assert isinstance(report.checks, tuple)
