"""Tests for the PointerBench base (harness gap review L13).

Covers: task/run validation, BackendTag, record with unknown-task and
duplicate rejection, JSON persistence, and honest report generation
(backends with no runs are marked as not collected).
"""

import dataclasses
import json

import pytest

from app.telemetry.pointerbench import (
    BackendTag,
    BenchDuplicateError,
    BenchError,
    BenchReport,
    BenchRun,
    BenchTask,
    BenchUnknownTaskError,
    PointerBench,
)

TASKS = [
    BenchTask("t1", "chrome", "登录表单的提交按钮", "登录 GitHub", "仪表盘可见", "easy"),
    BenchTask("t2", "pdf", "第三页的表格", "表格转 CSV", "CSV 已生成", "medium"),
    BenchTask("t3", "wechat", "聊天输入框", "给文件传输助手发消息", "消息已发送", "hard"),
]


def make_run(**overrides):
    base = dict(
        task_id="t1",
        backend=BackendTag.MAGIC_POINTER,
        succeeded=True,
        e2e_latency_ms=1500.0,
        tokens=800,
        reference_accuracy=1.0,
    )
    base.update(overrides)
    return BenchRun(**base)


class TestBackendTag:
    def test_values(self) -> None:
        assert {b.value for b in BackendTag} == {"magic_pointer", "screen_cua", "human"}

    def test_is_str_enum(self) -> None:
        assert BackendTag("magic_pointer") is BackendTag.MAGIC_POINTER
        assert BackendTag.MAGIC_POINTER == "magic_pointer"


class TestBenchTask:
    def test_rejects_empty_task_id(self) -> None:
        with pytest.raises(ValueError):
            BenchTask("", "chrome", "x", "y", "z", "easy")

    def test_rejects_unknown_difficulty(self) -> None:
        with pytest.raises(ValueError):
            BenchTask("t9", "chrome", "x", "y", "z", "extreme")
        with pytest.raises(ValueError):
            BenchTask("t9", "chrome", "x", "y", "z", "EASY")

    def test_all_difficulties_accepted(self) -> None:
        for difficulty in ("easy", "medium", "hard"):
            task = BenchTask("t9", "chrome", "x", "y", "z", difficulty)
            assert task.difficulty == difficulty


class TestBenchRun:
    def test_rejects_accuracy_below_zero(self) -> None:
        with pytest.raises(ValueError):
            make_run(reference_accuracy=-0.1)

    def test_rejects_accuracy_above_one(self) -> None:
        with pytest.raises(ValueError):
            make_run(reference_accuracy=1.1)

    def test_rejects_negative_tokens(self) -> None:
        with pytest.raises(ValueError):
            make_run(tokens=-5)

    def test_rejects_negative_latency(self) -> None:
        with pytest.raises(ValueError):
            make_run(e2e_latency_ms=-1.0)

    def test_optional_fields_default_to_none(self) -> None:
        run = BenchRun("t1", BackendTag.HUMAN, False)
        assert run.e2e_latency_ms is None
        assert run.tokens is None
        assert run.reference_accuracy is None

    def test_accuracy_bounds_are_inclusive(self) -> None:
        assert make_run(reference_accuracy=0.0).reference_accuracy == 0.0
        assert make_run(reference_accuracy=1.0).reference_accuracy == 1.0


class TestPointerBenchCore:
    def test_record_run_and_report_reflects_it(self) -> None:
        bench = PointerBench(TASKS)
        run = make_run()
        bench.record_run(run)
        report = bench.generate_report()
        mp = report.stats[0]
        assert mp.backend is BackendTag.MAGIC_POINTER
        assert mp.runs == 1
        assert mp.succeeded == 1

    def test_record_unknown_task_rejected(self) -> None:
        bench = PointerBench(TASKS)
        with pytest.raises(BenchUnknownTaskError):
            bench.record_run(make_run(task_id="nope"))
        with pytest.raises(BenchError):
            bench.record_run(make_run(task_id="nope"))

    def test_record_duplicate_task_backend_pair_rejected(self) -> None:
        bench = PointerBench(TASKS)
        bench.record_run(make_run())
        with pytest.raises(BenchDuplicateError):
            bench.record_run(make_run(succeeded=False))

    def test_same_task_allowed_on_different_backends(self) -> None:
        bench = PointerBench(TASKS)
        bench.record_run(make_run())
        bench.record_run(make_run(backend=BackendTag.HUMAN))
        report = bench.generate_report()
        assert report.stats[0].runs == 1
        assert report.stats[2].runs == 1


class TestPersistence:
    def test_save_load_roundtrip(self, tmp_path) -> None:
        bench = PointerBench(TASKS)
        recorded = [
            make_run(),
            make_run(
                task_id="t2",
                backend=BackendTag.HUMAN,
                e2e_latency_ms=None,
                tokens=None,
                reference_accuracy=None,
            ),
            make_run(task_id="t3", backend=BackendTag.SCREEN_CUA, succeeded=False),
        ]
        for run in recorded:
            bench.record_run(run)
        path = tmp_path / "runs.json"
        bench.save_runs(path)
        fresh = PointerBench(TASKS)
        loaded = fresh.load_runs(path)
        assert loaded == recorded
        with pytest.raises(BenchDuplicateError):
            fresh.record_run(recorded[0])

    def test_load_rejects_bad_json(self, tmp_path) -> None:
        path = tmp_path / "bad.json"
        path.write_text("{not json", encoding="utf-8")
        with pytest.raises(BenchError):
            PointerBench(TASKS).load_runs(path)

    def test_load_rejects_wrong_schema(self, tmp_path) -> None:
        path = tmp_path / "wrong.json"
        path.write_text(json.dumps({"schema": "other", "version": 1, "runs": []}), encoding="utf-8")
        with pytest.raises(BenchError):
            PointerBench(TASKS).load_runs(path)

    def test_load_rejects_missing_file(self, tmp_path) -> None:
        with pytest.raises(BenchError):
            PointerBench(TASKS).load_runs(tmp_path / "nope.json")

    def test_load_rejects_run_for_unknown_task(self, tmp_path) -> None:
        bench = PointerBench(TASKS)
        bench.record_run(make_run(task_id="t3"))
        path = tmp_path / "runs.json"
        bench.save_runs(path)
        subset = PointerBench(TASKS[:2])
        with pytest.raises(BenchError):
            subset.load_runs(path)

    def test_load_rejects_invalid_run_type(self, tmp_path) -> None:
        path = tmp_path / "runs.json"
        path.write_text(
            json.dumps(
                {
                    "schema": "pointerbench_runs",
                    "version": 1,
                    "runs": [{"task_id": "t1", "backend": "magic_pointer", "succeeded": "yes"}],
                }
            ),
            encoding="utf-8",
        )
        with pytest.raises(BenchError):
            PointerBench(TASKS).load_runs(path)


class TestReport:
    def test_metrics_per_backend(self) -> None:
        bench = PointerBench(TASKS)
        bench.record_run(make_run())
        bench.record_run(
            make_run(task_id="t2", succeeded=True, e2e_latency_ms=2500.0, tokens=1200, reference_accuracy=1.0)
        )
        bench.record_run(
            make_run(task_id="t3", succeeded=False, e2e_latency_ms=3000.0, tokens=900, reference_accuracy=0.9)
        )
        bench.record_run(BenchRun("t1", BackendTag.SCREEN_CUA, True, 4000.0, 5000, 0.5))
        bench.record_run(BenchRun("t2", BackendTag.SCREEN_CUA, False, None, 6000, 0.4))
        report = bench.generate_report()
        assert isinstance(report, BenchReport)
        assert report.task_total == 3
        assert [s.backend for s in report.stats] == [
            BackendTag.MAGIC_POINTER,
            BackendTag.SCREEN_CUA,
            BackendTag.HUMAN,
        ]
        mp, sc, hu = report.stats
        assert mp.runs == 3 and mp.succeeded == 2
        assert mp.success_rate == pytest.approx(2 / 3)
        assert mp.latency_p50_ms == 2500.0
        assert mp.latency_p95_ms == pytest.approx(2950.0)
        assert mp.tokens_total == 2900
        assert mp.reference_accuracy_mean == pytest.approx(0.96666666)
        assert sc.runs == 2 and sc.succeeded == 1
        assert sc.success_rate == pytest.approx(0.5)
        assert sc.latency_p50_ms == 4000.0
        assert sc.latency_p95_ms == 4000.0
        assert sc.tokens_total == 11000
        assert sc.reference_accuracy_mean == pytest.approx(0.45)
        assert hu.runs == 0 and hu.succeeded == 0
        assert hu.success_rate is None
        assert hu.latency_p50_ms is None and hu.latency_p95_ms is None
        assert hu.tokens_total == 0
        assert hu.reference_accuracy_mean is None

    def test_missing_backend_honest(self) -> None:
        bench = PointerBench(TASKS)
        bench.record_run(make_run())
        bench.record_run(make_run(task_id="t2", backend=BackendTag.SCREEN_CUA))
        report = bench.generate_report()
        assert report.missing_backends == ("human",)

    def test_empty_runs_all_backends_marked_missing(self) -> None:
        report = PointerBench(TASKS).generate_report()
        assert report.missing_backends == ("magic_pointer", "screen_cua", "human")
        assert all(s.runs == 0 for s in report.stats)
        assert all(s.succeeded == 0 for s in report.stats)
        assert all(s.success_rate is None for s in report.stats)
        assert all(s.latency_p50_ms is None for s in report.stats)
        assert all(s.reference_accuracy_mean is None for s in report.stats)

    def test_accuracy_mean_ignores_runs_without_accuracy(self) -> None:
        bench = PointerBench(TASKS)
        bench.record_run(make_run(reference_accuracy=0.8))
        bench.record_run(make_run(task_id="t2", reference_accuracy=None))
        mp = bench.generate_report().stats[0]
        assert mp.runs == 2
        assert mp.reference_accuracy_mean == pytest.approx(0.8)

    def test_latency_stats_ignore_runs_without_latency(self) -> None:
        bench = PointerBench(TASKS)
        bench.record_run(make_run(e2e_latency_ms=2000.0))
        bench.record_run(make_run(task_id="t2", e2e_latency_ms=None))
        mp = bench.generate_report().stats[0]
        assert mp.runs == 2
        assert mp.latency_p50_ms == 2000.0
        assert mp.latency_p95_ms == 2000.0

    def test_stats_shape_is_frozen(self) -> None:
        bench = PointerBench(TASKS)
        bench.record_run(make_run())
        report = bench.generate_report()
        assert dataclasses.is_dataclass(report)
        with pytest.raises(dataclasses.FrozenInstanceError):
            report.task_total = 99
        with pytest.raises(dataclasses.FrozenInstanceError):
            report.stats[0].runs = 99
