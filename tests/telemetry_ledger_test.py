"""Tests for the per-interaction cost ledger (harness gap review L13).

Covers: entry validation, record/get/duplicate rejection, query filters,
summarize fields (tokens, success rate, look ratio, latency p50/p95, failure
top3), JSON persistence round-trip, bad-file rejection, and concurrency.
"""

import dataclasses
import json
import threading

import pytest

from app.telemetry.interaction_ledger import (
    InteractionLedger,
    LedgerDuplicateError,
    LedgerEntry,
    LedgerError,
    LedgerSummary,
)


def make_entry(**overrides):
    base = dict(
        interaction_id="i1",
        started_at_utc="2026-08-13T09:00:00Z",
        ended_at_utc="2026-08-13T09:00:01Z",
        app_name="chrome",
        turns=3,
        tokens_text=100,
        tokens_vision=20,
        stage_latency_ms={"wake": 12.5, "perception": 30.0},
        evidence_layer_hit="L2",
        confidence=0.9,
        used_look=False,
        succeeded=True,
        failure_type=None,
        egress_event_ids=("e1", "e2"),
    )
    base.update(overrides)
    return LedgerEntry(**base)


class TestLedgerEntryValidation:
    def test_requires_nonempty_interaction_id(self) -> None:
        with pytest.raises(ValueError):
            make_entry(interaction_id="")

    def test_requires_nonempty_interaction_id_whitespace(self) -> None:
        with pytest.raises(ValueError):
            make_entry(interaction_id="   ")

    def test_confidence_below_zero_rejected(self) -> None:
        with pytest.raises(ValueError):
            make_entry(confidence=-0.1)

    def test_confidence_above_one_rejected(self) -> None:
        with pytest.raises(ValueError):
            make_entry(confidence=1.1)

    def test_negative_tokens_rejected(self) -> None:
        with pytest.raises(ValueError):
            make_entry(tokens_text=-1)
        with pytest.raises(ValueError):
            make_entry(tokens_vision=-1)

    def test_evidence_layer_out_of_range_rejected(self) -> None:
        with pytest.raises(ValueError):
            make_entry(evidence_layer_hit="L9")
        with pytest.raises(ValueError):
            make_entry(evidence_layer_hit="l2")

    def test_defaults_are_zero_false_empty(self) -> None:
        entry = LedgerEntry(
            interaction_id="x",
            started_at_utc="2026-08-13T09:00:00Z",
            ended_at_utc=None,
            app_name=None,
            turns=0,
        )
        assert entry.tokens_text == 0
        assert entry.tokens_vision == 0
        assert entry.used_look is False
        assert entry.egress_event_ids == ()
        assert entry.confidence is None
        assert entry.succeeded is None
        assert entry.evidence_layer_hit is None

    def test_entry_is_frozen(self) -> None:
        entry = make_entry()
        with pytest.raises(dataclasses.FrozenInstanceError):
            entry.turns = 4


class TestLedgerCore:
    def test_record_and_get_roundtrip_all_fields(self) -> None:
        ledger = InteractionLedger()
        entry = make_entry()
        ledger.record(entry)
        assert ledger.get("i1") == entry

    def test_duplicate_interaction_id_rejected(self) -> None:
        ledger = InteractionLedger()
        ledger.record(make_entry())
        with pytest.raises(LedgerDuplicateError):
            ledger.record(make_entry(succeeded=False))

    def test_get_unknown_id_raises_ledger_error(self) -> None:
        ledger = InteractionLedger()
        with pytest.raises(LedgerError):
            ledger.get("missing")

    def test_query_filters_by_app_name(self) -> None:
        ledger = InteractionLedger()
        ledger.record(make_entry(interaction_id="a", app_name="chrome"))
        ledger.record(make_entry(interaction_id="b", app_name="wechat"))
        assert [e.interaction_id for e in ledger.query(app_name="chrome")] == ["a"]
        assert ledger.query(app_name="nope") == []

    def test_query_filters_by_succeeded(self) -> None:
        ledger = InteractionLedger()
        ledger.record(make_entry(interaction_id="a", succeeded=True))
        ledger.record(make_entry(interaction_id="b", succeeded=False, failure_type="timeout"))
        ledger.record(make_entry(interaction_id="c", succeeded=None, ended_at_utc=None))
        assert [e.interaction_id for e in ledger.query(succeeded=True)] == ["a"]
        assert [e.interaction_id for e in ledger.query(succeeded=False)] == ["b"]
        assert [e.interaction_id for e in ledger.query()] == ["a", "b", "c"]

    def test_query_min_tokens_counts_text_plus_vision(self) -> None:
        ledger = InteractionLedger()
        ledger.record(make_entry(interaction_id="a", tokens_text=100, tokens_vision=20))
        ledger.record(make_entry(interaction_id="b", tokens_text=200, tokens_vision=0))
        assert [e.interaction_id for e in ledger.query(min_tokens=150)] == ["b"]

    def test_query_returns_all_in_insertion_order(self) -> None:
        ledger = InteractionLedger()
        ledger.record(make_entry(interaction_id="c"))
        ledger.record(make_entry(interaction_id="a"))
        ledger.record(make_entry(interaction_id="b"))
        assert [e.interaction_id for e in ledger.query()] == ["c", "a", "b"]


class TestSummarize:
    def test_empty_ledger_summary_is_honest(self) -> None:
        summary = InteractionLedger().summarize()
        assert isinstance(summary, LedgerSummary)
        assert dataclasses.is_dataclass(summary)
        assert summary.total_interactions == 0
        assert summary.tokens_text_total == 0
        assert summary.tokens_vision_total == 0
        assert summary.success_rate is None
        assert summary.look_ratio is None
        assert summary.latency_p50_ms is None
        assert summary.latency_p95_ms is None
        assert summary.top_failure_types == ()

    def test_token_totals_and_count(self) -> None:
        ledger = InteractionLedger()
        ledger.record(make_entry(interaction_id="a", tokens_text=100, tokens_vision=20))
        ledger.record(make_entry(interaction_id="b", tokens_text=50, tokens_vision=0))
        summary = ledger.summarize()
        assert summary.total_interactions == 2
        assert summary.tokens_text_total == 150
        assert summary.tokens_vision_total == 20

    def test_success_rate_excludes_undecided(self) -> None:
        ledger = InteractionLedger()
        ledger.record(make_entry(interaction_id="a", succeeded=True))
        ledger.record(make_entry(interaction_id="b", succeeded=True))
        ledger.record(make_entry(interaction_id="c", succeeded=False, failure_type="timeout"))
        ledger.record(make_entry(interaction_id="d", succeeded=None, ended_at_utc=None))
        assert ledger.summarize().success_rate == pytest.approx(2 / 3)

    def test_success_rate_none_when_nothing_decided(self) -> None:
        ledger = InteractionLedger()
        ledger.record(make_entry(interaction_id="a", succeeded=None, ended_at_utc=None))
        assert ledger.summarize().success_rate is None

    def test_look_ratio(self) -> None:
        ledger = InteractionLedger()
        ledger.record(make_entry(interaction_id="a", used_look=True))
        ledger.record(make_entry(interaction_id="b", used_look=False))
        ledger.record(make_entry(interaction_id="c", used_look=True))
        assert ledger.summarize().look_ratio == pytest.approx(2 / 3)

    def test_latency_percentiles_exclude_open_entries(self) -> None:
        ledger = InteractionLedger()
        for i, seconds in enumerate([1, 2, 3, 4, 5]):
            ledger.record(
                make_entry(
                    interaction_id=f"l{i}",
                    started_at_utc="2026-08-13T10:00:00Z",
                    ended_at_utc=f"2026-08-13T10:00:{seconds:02d}Z",
                    succeeded=True,
                )
            )
        ledger.record(make_entry(interaction_id="open", ended_at_utc=None, succeeded=None))
        summary = ledger.summarize()
        assert summary.latency_p50_ms == 3000.0
        assert summary.latency_p95_ms == 4800.0

    def test_failure_top3_sorted_by_count_then_name(self) -> None:
        ledger = InteractionLedger()
        for i, ft in enumerate(
            ["timeout", "empty_confirmed", "timeout", "timeout", "empty_confirmed", "other"]
        ):
            ledger.record(make_entry(interaction_id=f"f{i}", succeeded=False, failure_type=ft))
        ledger.record(make_entry(interaction_id="noft", succeeded=False, failure_type=None))
        assert ledger.summarize().top_failure_types == (
            ("timeout", 3),
            ("empty_confirmed", 2),
            ("other", 1),
        )


class TestPersistence:
    def test_save_load_roundtrip(self, tmp_path) -> None:
        ledger = InteractionLedger()
        ledger.record(make_entry(interaction_id="a"))
        ledger.record(make_entry(interaction_id="b", ended_at_utc=None, succeeded=None))
        path = tmp_path / "ledger.json"
        ledger.save(path)
        loaded = InteractionLedger()
        entries = loaded.load(path)
        assert entries == [ledger.get("a"), ledger.get("b")]
        assert loaded.summarize().total_interactions == 2
        assert loaded.get("a") == ledger.get("a")

    def test_load_rejects_bad_json(self, tmp_path) -> None:
        path = tmp_path / "bad.json"
        path.write_text("{not json", encoding="utf-8")
        with pytest.raises(LedgerError):
            InteractionLedger().load(path)

    def test_load_rejects_wrong_schema(self, tmp_path) -> None:
        path = tmp_path / "wrong.json"
        path.write_text(json.dumps({"schema": "other", "version": 1, "entries": []}), encoding="utf-8")
        with pytest.raises(LedgerError):
            InteractionLedger().load(path)

    def test_load_rejects_wrong_version(self, tmp_path) -> None:
        path = tmp_path / "wrongversion.json"
        path.write_text(
            json.dumps({"schema": "interaction_ledger", "version": 99, "entries": []}),
            encoding="utf-8",
        )
        with pytest.raises(LedgerError):
            InteractionLedger().load(path)

    def test_load_rejects_missing_file(self, tmp_path) -> None:
        with pytest.raises(LedgerError):
            InteractionLedger().load(tmp_path / "nope.json")

    def test_load_rejects_entry_missing_field(self, tmp_path) -> None:
        ledger = InteractionLedger()
        ledger.record(make_entry())
        path = tmp_path / "ledger.json"
        ledger.save(path)
        raw = json.loads(path.read_text(encoding="utf-8"))
        del raw["entries"][0]["turns"]
        path.write_text(json.dumps(raw), encoding="utf-8")
        with pytest.raises(LedgerError):
            InteractionLedger().load(path)

    def test_load_rejects_entry_wrong_type(self, tmp_path) -> None:
        ledger = InteractionLedger()
        ledger.record(make_entry())
        path = tmp_path / "ledger.json"
        ledger.save(path)
        raw = json.loads(path.read_text(encoding="utf-8"))
        raw["entries"][0]["turns"] = "three"
        path.write_text(json.dumps(raw), encoding="utf-8")
        with pytest.raises(LedgerError):
            InteractionLedger().load(path)

    def test_load_rejects_duplicate_interaction_ids_in_file(self, tmp_path) -> None:
        ledger = InteractionLedger()
        ledger.record(make_entry(interaction_id="a"))
        path = tmp_path / "ledger.json"
        ledger.save(path)
        raw = json.loads(path.read_text(encoding="utf-8"))
        raw["entries"].append(dict(raw["entries"][0]))
        path.write_text(json.dumps(raw), encoding="utf-8")
        with pytest.raises(LedgerError):
            InteractionLedger().load(path)


class TestConcurrency:
    def test_eight_threads_record_distinct_entries(self) -> None:
        ledger = InteractionLedger()
        barrier = threading.Barrier(8)
        errors = []

        def record(i: int) -> None:
            try:
                barrier.wait(timeout=5)
                ledger.record(make_entry(interaction_id=f"c{i}", succeeded=i % 2 == 0))
            except Exception as exc:  # noqa: BLE001 - any failure must surface
                errors.append(exc)

        threads = [threading.Thread(target=record, args=(i,)) for i in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        assert errors == []
        assert ledger.summarize().total_interactions == 8
        for i in range(8):
            assert ledger.get(f"c{i}").interaction_id == f"c{i}"
